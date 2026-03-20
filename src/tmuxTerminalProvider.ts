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

/**
 * Characters that can be sent safely via `send-keys -lt` (literal mode)
 * without tmux's command parser interpreting them.  Matches iTerm2's
 * `canSendAsLiteralCharacter:` in TmuxGateway.m — only alphanumerics
 * and a handful of punctuation known to be safe.
 *
 * Everything else (`;`, `$`, `#`, `"`, `'`, spaces, etc.) must be sent
 * as hex code points via `send-keys -t … 0xNN` to bypass the parser.
 */
function canSendAsLiteral(codePoint: number): boolean {
    if (codePoint >= 0x30 && codePoint <= 0x39) { return true; }   // 0-9
    if (codePoint >= 0x41 && codePoint <= 0x5a) { return true; }   // A-Z
    if (codePoint >= 0x61 && codePoint <= 0x7a) { return true; }   // a-z
    // Same safe punctuation as iTerm2: + / ) : , _
    return codePoint === 0x2b  // +
        || codePoint === 0x2f  // /
        || codePoint === 0x29  // )
        || codePoint === 0x3a  // :
        || codePoint === 0x2c  // ,
        || codePoint === 0x5f; // _
}
const SORTED_KEY_SEQUENCES: string[] =
    Object.keys(KEY_MAP).sort((a, b) => b.length - a.length);

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
    private lastCharWasCR = false;
    private resizeTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly log: (message: string) => void;

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
        log?: (message: string) => void,
    ) {
        this.existingWindow = existingWindow ?? null;
        this.isDeactivating = isDeactivating ?? (() => false);
        this.lifecycleHooks = lifecycleHooks ?? {};
        this.log = log ?? (() => {});
    }

    // -----------------------------------------------------------------------
    // Pseudoterminal interface
    // -----------------------------------------------------------------------

    async open(initialDimensions: vscode.TerminalDimensions | undefined): Promise<void> {
        try {
            this.log(`open() called: existingWindow=${JSON.stringify(this.existingWindow)}, dims=${initialDimensions?.columns}x${initialDimensions?.rows}, shell=${this.shell}, clientConnected=${this.client.isConnected()}`);
            let targetWindow: { windowId: string; paneId: string; windowIndex?: number };
            if (this.existingWindow) {
                targetWindow = this.existingWindow;
                this.log(`open(): reusing existing window ${targetWindow.windowId}`);
            } else {
                this.log('open(): creating new tmux window...');
                const newWindowPromise = this.client.newWindow({
                    startDirectory: this.startDirectory,
                    cols: initialDimensions?.columns,
                    rows: initialDimensions?.rows,
                    env: this.extraEnv,
                    shell: this.shell,
                });
                const timeoutPromise = new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Timed out waiting for tmux new-window response (15s)')), 15_000),
                );
                targetWindow = await Promise.race([newWindowPromise, timeoutPromise]);
                this.log(`open(): new window created: ${JSON.stringify(targetWindow)}`);
            }
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
                ).catch((err) => this.log(`resize warning (non-fatal): ${err}`));
            }



            if (this.existingWindow) {
                // Seed the renderer with the full scrollback + visible pane
                // contents so the user can scroll up through prior history.
                const snapshot = await this.client.capturePane(paneId, {
                    includeEscapeSequences: true,
                    startLine: '-',
                });
                const cursor = await this.client.getPaneCursor(paneId);
                if (snapshot) {
                    this.writeEmitter.fire(snapshot.replace(/\n/g, '\r\n'));
                }
                this.writeEmitter.fire(`\x1b[${cursor.y + 1};${cursor.x + 1}H`);
            }

        } catch (err) {
            this.log(`open() ERROR: ${err}`);
            if (this.existingWindow?.windowId) {
                this.lifecycleHooks.onWindowAttachFailed?.(this.existingWindow.windowId);
            }
            this.writeEmitter.fire(`\r\ntmux-integrated: error creating tmux window: ${err}\r\n`);
            this.closeEmitter.fire(1);
        }
    }

    handleInput(data: string): void {
        if (!this.paneId) { return; }
        this.sendKeysInput(data);
    }

    setDimensions(dimensions: vscode.TerminalDimensions): void {
        if (this.windowId) {
            // Debounce rapid resize events (e.g. during window drag) to avoid
            // flooding tmux with resize commands.
            if (this.resizeTimer) {
                clearTimeout(this.resizeTimer);
            }
            this.resizeTimer = setTimeout(() => {
                this.resizeTimer = null;
                this.log(`setDimensions: ${dimensions.columns}x${dimensions.rows} for window ${this.windowId}`);
                this.client
                    .resizeWindowForClient(dimensions.columns, dimensions.rows)
                    .catch((err) => this.log(`resize error: ${err}`));
            }, 100);
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
     * Send input to the tmux pane using the iTerm2 hybrid strategy:
     *   - Known escape sequences → `send-keys -t <pane> <KeyName>`
     *   - Safe literal runs     → `send-keys -lt <pane> <chars>`
     *   - Everything else       → `send-keys -t <pane> 0xNN 0xNN …`
     *
     * Multiple commands are batched into a single `sendCommandList` call
     * (joined with ` ; `) to reduce PTY round-trips, matching iTerm2.
     */
    private sendKeysInput(data: string): void {
        if (!this.paneId) { return; }

        const paneId = this.paneId;
        const commands: string[] = [];

        let index = 0;

        while (index < data.length) {
            // 1. Check for known escape sequences (function keys, arrows, etc.)
            const sequence = SORTED_KEY_SEQUENCES.find((candidate) => data.startsWith(candidate, index));
            if (sequence) {
                commands.push(`send-keys -t ${paneId} ${KEY_MAP[sequence]}`);
                index += sequence.length;
                continue;
            }

            const char = data[index];

            // 2. Bare \n → Enter
            if (char === '\n') {
                commands.push(`send-keys -t ${paneId} Enter`);
                index += 1;
                continue;
            }

            // 3. Control characters (< 0x20) → C-x key names
            if (char.charCodeAt(0) < 0x20) {
                const letter = String.fromCharCode(char.charCodeAt(0) + 64).toLowerCase();
                commands.push(`send-keys -t ${paneId} C-${letter}`);
                index += 1;
                continue;
            }

            // 4. Collect a run of printable characters.  Classify each as
            //    "safe literal" or "needs hex".  Build runs of the same kind.
            const cp = char.charCodeAt(0);
            if (canSendAsLiteral(cp)) {
                // Collect consecutive safe-literal characters.
                let litEnd = index + 1;
                while (litEnd < data.length) {
                    const nextCp = data.charCodeAt(litEnd);
                    if (nextCp < 0x20 || !canSendAsLiteral(nextCp)) { break; }
                    if (SORTED_KEY_SEQUENCES.some((s) => data.startsWith(s, litEnd))) { break; }
                    litEnd++;
                }
                const run = data.slice(index, litEnd);
                commands.push(`send-keys -lt ${paneId} ${run}`);
                index = litEnd;
            } else {
                // Collect consecutive hex characters (anything not safe-literal
                // and not a control char or escape sequence).
                const hexCodes: string[] = [];
                let hexEnd = index;
                while (hexEnd < data.length) {
                    const nextCp = data.charCodeAt(hexEnd);
                    if (nextCp < 0x20) { break; }
                    if (canSendAsLiteral(nextCp)) { break; }
                    if (SORTED_KEY_SEQUENCES.some((s) => data.startsWith(s, hexEnd))) { break; }
                    // Encode as UTF-8 bytes in hex.
                    const buf = Buffer.from(data[hexEnd], 'utf8');
                    for (const b of buf) {
                        hexCodes.push(`0x${b.toString(16).padStart(2, '0')}`);
                    }
                    hexEnd++;
                }
                if (hexCodes.length > 0) {
                    commands.push(`send-keys -t ${paneId} ${hexCodes.join(' ')}`);
                }
                index = hexEnd;
            }
        }

        if (commands.length > 0) {
            this.client
                .sendCommandList(commands, 0)
                .catch((err) => console.error(`tmux-integrated: send input error: ${err}`));
        }
    }

    /**
     * Normalise decoded tmux pane output for xterm.js:
     *   1. Strip screen/tmux title sequences (\ek…\e\\) that xterm.js doesn't
     *      understand.  oh-my-zsh's termsupport.zsh emits these in preexec and
     *      precmd when TERM matches screen* or tmux*.  xterm.js treats \ek as
     *      an unknown two-char escape and prints the enclosed text as visible
     *      characters, producing the "command echo" effect.
     *   2. Ensure bare LF is preceded by CR (xterm.js requirement).
     */
    private normalizeTerminalOutput(data: string): string {
        // Strip \ek<text>\e\\ — screen/tmux hardstatus title sequence.
        data = data.replace(/\x1bk[^\x1b]*\x1b\\/g, '');

        let result = '';

        for (let i = 0; i < data.length; i++) {
            const ch = data[i];
            if (ch === '\n' && !this.lastCharWasCR) {
                result += '\r\n';
            } else {
                result += ch;
            }
            this.lastCharWasCR = (ch === '\r');
        }

        return result;
    }

    private cleanup(): void {
        if (this.resizeTimer) {
            clearTimeout(this.resizeTimer);
            this.resizeTimer = null;
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

        // Free the incremental UTF-8 decoder for this pane so the map in
        // TmuxControlClient doesn't grow unboundedly over time.
        if (this.paneId) {
            this.client.removePaneDecoder(this.paneId);
        }

        this.lastCharWasCR = false;

        if (this.windowId && this.attachedWindowNotified) {
            this.lifecycleHooks.onWindowDetached?.(this.windowId);
            this.attachedWindowNotified = false;
        }
    }
}
