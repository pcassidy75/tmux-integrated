/**
 * TmuxTerminal — a vscode.Pseudoterminal backed by a single tmux pane.
 *
 * Lifecycle:
 *   open()        → creates a new tmux window; subscribes to %output events.
 *   handleInput() → forwards raw key data straight to the pane's pty device
 *                   (falling back to `send-keys` if direct write fails).
 *   setDimensions() → resizes the tmux pane to match VS Code's terminal size.
 *   close()       → unsubscribes from output; intentionally does NOT kill the
 *                   tmux window so the process persists across reconnects.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { TmuxControlClient, TmuxPaneOutput } from './tmuxControlClient';

/** Map of raw terminal escape sequences to tmux key names. */
const KEY_MAP: Record<string, string> = {
    '\r':       'Enter',
    '\x7f':     'BSpace',
    '\x03':     'C-c',
    '\x04':     'C-d',
    '\x1a':     'C-z',
    '\x1b':     'Escape',
    '\t':       'Tab',
    '\x1b[A':   'Up',
    '\x1b[B':   'Down',
    '\x1b[C':   'Right',
    '\x1b[D':   'Left',
    '\x1b[H':   'Home',
    '\x1b[F':   'End',
    '\x1b[5~':  'PageUp',
    '\x1b[6~':  'PageDown',
    '\x1b[3~':  'DC',
    '\x1b[2~':  'IC',
    '\x1bOP':   'F1',
    '\x1bOQ':   'F2',
    '\x1bOR':   'F3',
    '\x1bOS':   'F4',
    '\x1b[15~': 'F5',
    '\x1b[17~': 'F6',
    '\x1b[18~': 'F7',
    '\x1b[19~': 'F8',
    '\x1b[20~': 'F9',
    '\x1b[21~': 'F10',
    '\x1b[23~': 'F11',
    '\x1b[24~': 'F12',
};

export class TmuxTerminal implements vscode.Pseudoterminal {
    private readonly writeEmitter = new vscode.EventEmitter<string>();
    private readonly closeEmitter = new vscode.EventEmitter<number | void>();

    readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    readonly onDidClose: vscode.Event<number | void> = this.closeEmitter.event;

    private paneId: string | null = null;
    private windowId: string | null = null;
    /** File descriptor for direct writes to the pane's pty slave. */
    private ttyFd: number | null = null;
    private outputListener: ((ev: TmuxPaneOutput) => void) | null = null;
    private windowCloseListener: ((id: string) => void) | null = null;

    constructor(
        private readonly client: TmuxControlClient,
        private readonly startDirectory: string | undefined,
        private readonly extraEnv: Record<string, string>,
        private readonly shell: string | undefined,
    ) {}

    // -----------------------------------------------------------------------
    // Pseudoterminal interface
    // -----------------------------------------------------------------------

    async open(initialDimensions: vscode.TerminalDimensions | undefined): Promise<void> {
        try {
            const { windowId, paneId } = await this.client.newWindow({
                startDirectory: this.startDirectory,
                cols: initialDimensions?.columns,
                rows: initialDimensions?.rows,
                env: this.extraEnv,
                shell: this.shell,
            });
            this.windowId = windowId;
            this.paneId = paneId;

            // Try to open the pane's pty for direct input writes.
            const ttyPath = await this.client.getPaneTty(paneId);
            if (ttyPath) {
                try {
                    this.ttyFd = fs.openSync(
                        ttyPath,
                        fs.constants.O_WRONLY | fs.constants.O_NOCTTY,
                    );
                } catch {
                    // Non-fatal — fall back to send-keys.
                }
            }

            // Forward pane output to the VS Code terminal renderer.
            this.outputListener = ({ paneId: id, data }: TmuxPaneOutput) => {
                if (id === this.paneId) {
                    this.writeEmitter.fire(data);
                }
            };
            this.client.on('output', this.outputListener);

            // Close the VS Code terminal if the tmux window disappears
            // (e.g. the shell process exited).
            this.windowCloseListener = (id: string) => {
                if (id === this.windowId) {
                    this.cleanup();
                    this.closeEmitter.fire(0);
                }
            };
            this.client.on('window-close', this.windowCloseListener);

        } catch (err) {
            this.writeEmitter.fire(`\r\ntmux-integrated: error creating tmux window: ${err}\r\n`);
            this.closeEmitter.fire(1);
        }
    }

    handleInput(data: string): void {
        if (!this.paneId) { return; }

        if (this.ttyFd !== null) {
            try {
                // Write raw bytes directly to the pane's pty — this handles
                // all input types correctly without any encoding gymnastics.
                fs.writeSync(this.ttyFd, Buffer.from(data, 'binary'));
                return;
            } catch {
                // pty may have closed; fall back to send-keys.
                try { fs.closeSync(this.ttyFd); } catch { /* ignore */ }
                this.ttyFd = null;
            }
        }

        this.sendKeysInput(data);
    }

    setDimensions(dimensions: vscode.TerminalDimensions): void {
        if (this.paneId) {
            this.client
                .resizePane(this.paneId, dimensions.columns, dimensions.rows)
                .catch((err) => console.error(`tmux-integrated: resize error: ${err}`));
        }
    }

    close(): void {
        // The tmux window is intentionally left running so the session persists.
        this.cleanup();
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /**
     * Fall-back input path when the pty fd is unavailable.
     * Maps known escape sequences to tmux key names; sends everything else
     * with `send-keys -l` (literal mode, no key-name interpretation).
     */
    private sendKeysInput(data: string): void {
        if (!this.paneId) { return; }

        const paneId = this.paneId;
        const send = (cmd: string) =>
            this.client
                .sendCommand(cmd)
                .catch((err) => console.error(`tmux-integrated: send-keys error: ${err}`));

        if (KEY_MAP[data]) {
            send(`send-keys -t ${paneId} "${KEY_MAP[data]}"`);
            return;
        }

        if (data.length === 1 && data.charCodeAt(0) < 0x20) {
            // Ctrl+A … Ctrl+Z
            const letter = String.fromCharCode(data.charCodeAt(0) + 64).toLowerCase();
            send(`send-keys -t ${paneId} "C-${letter}"`);
            return;
        }

        // Literal text — escape backslash and double-quote for the tmux command.
        const escaped = data.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        send(`send-keys -t ${paneId} -l "${escaped}"`);
    }

    private cleanup(): void {
        if (this.outputListener) {
            this.client.removeListener('output', this.outputListener);
            this.outputListener = null;
        }
        if (this.windowCloseListener) {
            this.client.removeListener('window-close', this.windowCloseListener);
            this.windowCloseListener = null;
        }
        if (this.ttyFd !== null) {
            try { fs.closeSync(this.ttyFd); } catch { /* ignore */ }
            this.ttyFd = null;
        }
    }
}
