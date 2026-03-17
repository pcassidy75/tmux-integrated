/**
 * TmuxTerminal — a vscode.Pseudoterminal backed by a single tmux pane.
 *
 * Lifecycle:
 *   open()        → creates a new tmux window; subscribes to %output events.
*   handleInput() → forwards key data through tmux control commands.
 *   setDimensions() → updates the control client window size for the tmux
 *                     window shown in this VS Code terminal.
 *   close()       → unsubscribes from output; intentionally does NOT kill the
 *                   tmux window so the process persists across reconnects.
 */

import * as vscode from 'vscode';
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
    private readonly existingWindow: { windowId: string; paneId: string } | null;
    private readonly closeWindowOnOpen: string | undefined;
    private outputListener: ((ev: TmuxPaneOutput) => void) | null = null;
    private windowCloseListener: ((id: string) => void) | null = null;
    private previousChunkEndedWithCarriageReturn = false;
    private pendingCarriageReturnCount = 0;
    private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
    private lastInputTime = 0;

    constructor(
        private readonly client: TmuxControlClient,
        private readonly startDirectory: string | undefined,
        private readonly extraEnv: Record<string, string>,
        private readonly shell: string | undefined,
        existingWindow?: { windowId: string; paneId: string },
        closeWindowOnOpen?: string,
    ) {
        this.existingWindow = existingWindow ?? null;
        this.closeWindowOnOpen = closeWindowOnOpen;
    }

    // -----------------------------------------------------------------------
    // Pseudoterminal interface
    // -----------------------------------------------------------------------

    async open(initialDimensions: vscode.TerminalDimensions | undefined): Promise<void> {
        try {
            const targetWindow = this.existingWindow ?? await this.client.newWindow({
                startDirectory: this.startDirectory,
                cols: initialDimensions?.columns,
                rows: initialDimensions?.rows,
                env: this.extraEnv,
                shell: this.shell,
            });
            const { windowId, paneId } = targetWindow;
            this.windowId = windowId;
            this.paneId = paneId;

            if (initialDimensions && this.windowId) {
                await this.client.resizeWindowForClient(
                    initialDimensions.columns,
                    initialDimensions.rows,
                );
            }

            // Forward pane output to the VS Code terminal renderer.
            this.outputListener = ({ paneId: id, data }: TmuxPaneOutput) => {
                if (id === this.paneId) {
                    this.writeEmitter.fire(this.normalizeTerminalOutput(data));
                    this.scheduleReconciliation();
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

            if (this.closeWindowOnOpen && this.closeWindowOnOpen !== windowId) {
                await this.client.killWindow(this.closeWindowOnOpen).catch((err) => {
                    console.error(`tmux-integrated: bootstrap window cleanup failed: ${err}`);
                });
            }

            if (this.existingWindow) {
                // Seed the renderer with the current visible pane contents.
                const snapshot = await this.client.capturePane(paneId, {
                    includeEscapeSequences: true,
                });
                const cursor = await this.client.getPaneCursor(paneId);
                if (snapshot) {
                    this.writeEmitter.fire(snapshot.replace(/\n/g, '\r\n'));
                }
                this.writeEmitter.fire(`\x1b[${cursor.y + 1};${cursor.x + 1}H`);
            }

        } catch (err) {
            this.writeEmitter.fire(`\r\ntmux-integrated: error creating tmux window: ${err}\r\n`);
            this.closeEmitter.fire(1);
        }
    }

    handleInput(data: string): void {
        if (!this.paneId) { return; }

        this.lastInputTime = Date.now();
        this.sendKeysInput(data);
    }

    setDimensions(dimensions: vscode.TerminalDimensions): void {
        if (this.windowId) {
            this.client
                .resizeWindowForClient(dimensions.columns, dimensions.rows)
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
     * Maps known escape sequences to tmux key names and sends any remaining
     * literal text with `send-keys -l`.
     */
    private sendKeysInput(data: string): void {
        if (!this.paneId) { return; }

        const paneId = this.paneId;
        const send = (cmd: string) =>
            this.client
                .sendCommand(cmd)
                .catch((err) => console.error(`tmux-integrated: send-keys error: ${err}`));

        const knownSequences = Object.keys(KEY_MAP).sort((left, right) => right.length - left.length);
        let index = 0;

        while (index < data.length) {
            const sequence = knownSequences.find((candidate) => data.startsWith(candidate, index));
            if (sequence) {
                send(`send-keys -t ${paneId} "${KEY_MAP[sequence]}"`);
                index += sequence.length;
                continue;
            }

            const char = data[index];
            if (char === '\n') {
                send(`send-keys -t ${paneId} "Enter"`);
                index += 1;
                continue;
            }

            if (char.charCodeAt(0) < 0x20) {
                const letter = String.fromCharCode(char.charCodeAt(0) + 64).toLowerCase();
                send(`send-keys -t ${paneId} "C-${letter}"`);
                index += 1;
                continue;
            }

            let literalEnd = index + 1;
            while (literalEnd < data.length) {
                const nextChar = data[literalEnd];
                if (nextChar === '\n' || nextChar.charCodeAt(0) < 0x20) {
                    break;
                }
                if (knownSequences.some((candidate) => data.startsWith(candidate, literalEnd))) {
                    break;
                }
                literalEnd += 1;
            }

            const literal = data.slice(index, literalEnd);
            const escaped = literal.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            send(`send-keys -t ${paneId} -l "${escaped}"`);
            index = literalEnd;
        }
    }

    // -----------------------------------------------------------------------
    // Post-input reconciliation
    // -----------------------------------------------------------------------

    /** How long to wait after the last %output before reconciling (ms). */
    private static readonly RECONCILE_DEBOUNCE_MS = 80;

    /** Only reconcile if user input was sent within this window (ms). */
    private static readonly RECONCILE_INPUT_WINDOW_MS = 500;

    /**
     * Schedule a debounced screen reconciliation.  Only fires when the user
     * recently sent input — avoids flicker during pure output streaming
     * (e.g. long-running build output).
     */
    private scheduleReconciliation(): void {
        if (Date.now() - this.lastInputTime > TmuxTerminal.RECONCILE_INPUT_WINDOW_MS) {
            return;
        }

        if (this.reconcileTimer) {
            clearTimeout(this.reconcileTimer);
        }

        this.reconcileTimer = setTimeout(() => {
            this.reconcileTimer = null;
            this.reconcile();
        }, TmuxTerminal.RECONCILE_DEBOUNCE_MS);
    }

    /**
     * Reconcile the VS Code terminal with tmux's authoritative screen state.
     * Runs capture-pane to get the fully-composed visible screen, then clears
     * and rewrites the terminal to eliminate echo/redraw artifacts.
     */
    private async reconcile(): Promise<void> {
        if (!this.paneId) { return; }

        try {
            const [snapshot, cursor] = await Promise.all([
                this.client.capturePane(this.paneId, { includeEscapeSequences: true }),
                this.client.getPaneCursor(this.paneId),
            ]);

            // Clear the visible screen and rewrite from the authoritative snapshot.
            // capture-pane output is clean screen state — convert \n → \r\n
            // directly instead of running through normalizeTerminalOutput
            // (which tracks CR state across incremental %output chunks).
            this.writeEmitter.fire('\x1b[H\x1b[2J');

            if (snapshot) {
                this.writeEmitter.fire(snapshot.replace(/\n/g, '\r\n'));
            }

            this.writeEmitter.fire(`\x1b[${cursor.y + 1};${cursor.x + 1}H`);
        } catch {
            // Reconciliation is best-effort; don't crash on transient errors.
        }
    }

    private normalizeTerminalOutput(data: string): string {
        let normalized = '';

        for (const char of data) {
            if (char === '\r') {
                this.pendingCarriageReturnCount += 1;
                this.previousChunkEndedWithCarriageReturn = true;
                continue;
            }

            if (char === '\n') {
                normalized += '\r\n';
                this.pendingCarriageReturnCount = 0;
                this.previousChunkEndedWithCarriageReturn = false;
                continue;
            }

            if (this.pendingCarriageReturnCount > 0) {
                normalized += '\r'.repeat(this.pendingCarriageReturnCount);
                this.pendingCarriageReturnCount = 0;
            }

            if (char !== '\n' || !this.previousChunkEndedWithCarriageReturn) {
                normalized += char;
            }

            this.previousChunkEndedWithCarriageReturn = char === '\r';
        }

        return normalized;
    }

    private cleanup(): void {
        if (this.reconcileTimer) {
            clearTimeout(this.reconcileTimer);
            this.reconcileTimer = null;
        }
        if (this.outputListener) {
            this.client.removeListener('output', this.outputListener);
            this.outputListener = null;
        }
        if (this.windowCloseListener) {
            this.client.removeListener('window-close', this.windowCloseListener);
            this.windowCloseListener = null;
        }
        this.pendingCarriageReturnCount = 0;
        this.previousChunkEndedWithCarriageReturn = false;
    }
}
