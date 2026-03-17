/**
 * TmuxTerminal — a vscode.Pseudoterminal backed by a single tmux pane.
 *
 * Lifecycle:
 *   open()        → creates a new tmux window; subscribes to %output events.
*   handleInput() → forwards key data through tmux control commands.
 *   setDimensions() → updates the control client window size for the tmux
 *                     window shown in this VS Code terminal.
 *   close()       → kills the tmux window (unless VS Code is shutting down,
 *                   in which case the window survives for later re-adoption).
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
    private readonly nameEmitter = new vscode.EventEmitter<string>();

    readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    readonly onDidClose: vscode.Event<number | void> = this.closeEmitter.event;
    readonly onDidChangeName: vscode.Event<string> = this.nameEmitter.event;

    private paneId: string | null = null;
    private windowId: string | null = null;
    private windowClosedByTmux = false;
    private readonly existingWindow: { windowId: string; paneId: string; windowIndex?: number } | null;
    private readonly isDeactivating: () => boolean;
    private readonly lifecycleHooks: {
        onWindowAttached?: (windowId: string) => void;
        onWindowDetached?: (windowId: string) => void;
        onWindowAttachFailed?: (windowId: string) => void;
    };
    private attachedWindowNotified = false;
    private outputListener: ((ev: TmuxPaneOutput) => void) | null = null;
    private windowCloseListener: ((id: string) => void) | null = null;
    private tmuxExitListener: (() => void) | null = null;
    private previousChunkEndedWithCarriageReturn = false;
    private pendingCarriageReturnCount = 0;
    private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
    private lastInputTime = 0;

    constructor(
        private readonly client: TmuxControlClient,
        private readonly startDirectory: string | undefined,
        private readonly extraEnv: Record<string, string>,
        private readonly shell: string | undefined,
        existingWindow?: { windowId: string; paneId: string; windowIndex?: number },
        lifecycleHooks?: {
            onWindowAttached?: (windowId: string) => void;
            onWindowDetached?: (windowId: string) => void;
            onWindowAttachFailed?: (windowId: string) => void;
        },
        isDeactivating?: () => boolean,
    ) {
        this.existingWindow = existingWindow ?? null;
        this.isDeactivating = isDeactivating ?? (() => false);
        this.lifecycleHooks = lifecycleHooks ?? {};
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
            const windowIndex = 'windowIndex' in targetWindow
                ? (targetWindow as { windowIndex: number }).windowIndex
                : this.existingWindow?.windowIndex;
            if (windowIndex !== undefined) {
                this.nameEmitter.fire(`tmux:${windowIndex}`);
            }
            this.windowId = windowId;
            this.paneId = paneId;
            this.lifecycleHooks.onWindowAttached?.(windowId);
            this.attachedWindowNotified = true;

            // Register event listeners BEFORE any async operations so that
            // notifications arriving during awaits are not lost.

            // Forward pane output to the VS Code terminal renderer.
            this.outputListener = ({ paneId: id, data }: TmuxPaneOutput) => {
                if (id === this.paneId) {
                    this.writeEmitter.fire(this.normalizeTerminalOutput(data));
                    this.scheduleReconciliation();
                }
            };
            this.client.on('output', this.outputListener);

            // When the tmux window disappears (e.g. the shell exited),
            // leave the VS Code tab open so the session is not torn down.
            // The user can dismiss the "hung" tab with the trash-can icon.
            this.windowCloseListener = (id: string) => {
                if (id === this.windowId) {
                    this.windowClosedByTmux = true;
                    this.cleanup();
                    this.writeEmitter.fire('\r\n[Process completed]\r\n');
                }
            };
            this.client.on('window-close', this.windowCloseListener);

            // When the entire tmux session exits, show a notice but keep the
            // VS Code tab open so the user can see what happened.
            this.tmuxExitListener = () => {
                this.cleanup();
                this.writeEmitter.fire('\r\n[tmux session ended]\r\n');
            };
            this.client.on('tmux-exit', this.tmuxExitListener);

            // Disable automatic-rename so the tab name stays stable.
            await this.client.sendCommand(`set-option -w -t ${windowId} automatic-rename off`).catch(() => {});

            if (initialDimensions && this.windowId) {
                await this.client.resizeWindowForClient(
                    initialDimensions.columns,
                    initialDimensions.rows,
                );
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
            if (this.existingWindow?.windowId) {
                this.lifecycleHooks.onWindowAttachFailed?.(this.existingWindow.windowId);
            }
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
        this.cleanup();

        // Never kill the tmux window.  Whether the user clicked the
        // trash-can icon or VS Code is shutting down, we leave the tmux
        // window alive so it can be re-adopted on next launch.
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

        if (this.tmuxExitListener) {
            this.client.removeListener('tmux-exit', this.tmuxExitListener);
            this.tmuxExitListener = null;
        }
        this.pendingCarriageReturnCount = 0;
        this.previousChunkEndedWithCarriageReturn = false;

        if (this.windowId && this.attachedWindowNotified) {
            this.lifecycleHooks.onWindowDetached?.(this.windowId);
            this.attachedWindowNotified = false;
        }
    }
}
