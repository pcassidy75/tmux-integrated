/**
 * TmuxTerminal — a vscode.Pseudoterminal backed by a single tmux pane.
 *
 * Lifecycle:
 *   open()        → creates a new tmux window; subscribes to %output events.
 *   handleInput() → forwards key data through tmux control commands.
 *   setDimensions() → updates the control client window size for the tmux
 *                     window shown in this VS Code terminal.
 *   close()       → removes listeners for this VS Code view while leaving the
 *                   tmux window alive for later attachment or re-adoption.
 */

import * as vscode from 'vscode';
import { TmuxControlClient, TmuxPaneOutput, CommandFlags, shellescape } from './tmuxControlClient';
import { pickTerminalTabTitle, TabTitleSync } from './windowTitle';

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
 * Everything else (`;`, `$`, `#`, `"`, `'`, spaces, etc.) is sent as
 * hex code points or, for non-ASCII printable text, via `send-keys -l`
 * to preserve literal UTF-8 input.
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

/**
 * If `data[start]` begins an ESC sequence that isn't a known multi-byte
 * KEY_MAP entry, return its length.  Otherwise return 0.
 *
 * Recognises:
 *   - CSI:  ESC [ <params> <final 0x40..0x7E>          (e.g. \x1b[24;80R)
 *   - SS3:  ESC O <one-byte-final>                      (e.g. \x1bOA)
 *   - OSC:  ESC ] <text> ST | BEL                       (e.g. \x1b]0;title\x07)
 *   - DCS / SOS / PM / APC:  ESC <P|X|^|_> <text> ST
 *
 * Used by `sendKeysInput` to forward such sequences atomically as a single
 * hex-encoded `send-keys`, so an interactive app inside tmux receives the
 * full sequence in one read() instead of several adjacent writes — see
 * issue #26 (xterm.js's auto CPR reply `\x1b[<r>;<c>R` was being delivered
 * as separate ESC + `[` + params writes and parsed wrongly by `gh`'s prompt
 * library).
 *
 * Returns 0 if `data[start]` is bare ESC followed by nothing or by a
 * recognised KEY_MAP sequence, so the existing key-name path handles those.
 */
function findEscSequenceLength(data: string, start: number): number {
    if (data[start] !== '\x1b' || start + 1 >= data.length) {
        return 0;
    }
    if (SORTED_KEY_SEQUENCES.some((seq) => seq.length > 1 && data.startsWith(seq, start))) {
        return 0;
    }

    const next = data[start + 1];

    if (next === '[') {
        for (let i = start + 2; i < data.length; i++) {
            const cp = data.charCodeAt(i);
            if (cp >= 0x40 && cp <= 0x7e) {
                return i - start + 1;
            }
        }
        return 0;
    }

    if (next === 'O' && start + 2 < data.length) {
        return 3;
    }

    if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
        for (let i = start + 2; i < data.length; i++) {
            if (next === ']' && data.charCodeAt(i) === 0x07) {
                return i - start + 1;
            }
            if (data[i] === '\x1b' && i + 1 < data.length && data[i + 1] === '\\') {
                return i - start + 2;
            }
        }
        return 0;
    }

    return 0;
}

export class TmuxTerminal implements vscode.Pseudoterminal {
    private readonly writeEmitter = new vscode.EventEmitter<string>();
    private readonly closeEmitter = new vscode.EventEmitter<number | void>();
    private readonly nameEmitter = new vscode.EventEmitter<string>();

    readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    readonly onDidClose: vscode.Event<number | void> = this.closeEmitter.event;
    readonly onDidChangeName: vscode.Event<string> = this.nameEmitter.event;

    private paneId: string | null = null;
    private windowId: string | null = null;
    /** tmux window_index for tab labels (`tmux:&lt;n&gt;` when automatic-rename is on). */
    private tabWindowIndex: number | undefined = undefined;
    private readonly existingWindow: {
        windowId: string;
        paneId: string;
        windowIndex?: number;
        name?: string;
        automaticRename?: boolean;
    } | null;
    private readonly lifecycleHooks: {
        onWindowAttached?: (windowId: string) => void;
        onWindowDetached?: (windowId: string) => void;
        onWindowAttachFailed?: (windowId: string) => void;
    };
    private attachedWindowNotified = false;
    private outputListener: ((ev: TmuxPaneOutput) => void) | null = null;
    private windowCloseListener: ((id: string) => void) | null = null;
    private windowRenamedListener: ((payload: { windowId: string; name: string } | null) => void) | null = null;
    private tmuxExitListener: (() => void) | null = null;
    /**
     * Single source of truth for the bidirectional rename sync: which titles
     * this terminal has shown, which rename-window echoes are in flight, and
     * whether a `terminal.name` divergence is a user rename or just VS Code
     * lagging behind our own emission. See windowTitle.ts.
     */
    private titleSync = new TabTitleSync();
    private lastCharWasCR = false;
    private resizeTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly log: (message: string) => void;
    /**
     * Set from `extension.ts` (`registerTerminalRenameSync`).  Invoked at the
     * start of each `handleInput` so the extension can pass the current
     * `terminal.name` to `maybeSyncNameFromVsCode` and push a built-in
     * "Rename…" to tmux.  No VS Code API registers this; it is optional wiring.
     */
    private onInputCallback: (() => void) | null = null;
    /**
     * Becomes true only after open() has settled the initial tab title
     * (queried/disabled automatic-rename, emitted the chosen label, and —
     * if needed — issued our own rename-window). Until then,
     * windowRenamedListener ignores incoming %window-renamed events so
     * that tmux's automatic-rename-driven renames (e.g. to "zsh"/"bash")
     * cannot race ahead of our suppression command on a high-latency
     * link. After commit, the listener works normally so user-initiated
     * renames from inside tmux still update the tab.
     *
     * Not consulted in showAutomaticRename mode: there, automatic renames
     * are exactly what the tab should display, so events are processed
     * from the moment the listener is registered.
     */
    private initialNameCommitted = false;

    /** When true (the `showAutomaticRename` setting), the tab tracks tmux's automatic window names. */
    private readonly showAutomaticRename: boolean;

    constructor(
        private readonly client: TmuxControlClient,
        private readonly startDirectory: string | undefined,
        private readonly extraEnv: Record<string, string>,
        private readonly shell: string | undefined,
        showAutomaticRename?: boolean,
        existingWindow?: {
            windowId: string;
            paneId: string;
            windowIndex?: number;
            name?: string;
            automaticRename?: boolean;
        },
        lifecycleHooks?: {
            onWindowAttached?: (windowId: string) => void;
            onWindowDetached?: (windowId: string) => void;
            onWindowAttachFailed?: (windowId: string) => void;
        },
        log?: (message: string) => void,
    ) {
        this.showAutomaticRename = showAutomaticRename ?? false;
        this.existingWindow = existingWindow ?? null;
        this.lifecycleHooks = lifecycleHooks ?? {};
        this.log = log ?? (() => {});
        // The creation-options name is what VS Code shows until open() emits a
        // title; register it so an early keystroke doesn't classify it as a
        // user rename (see TabTitleSync.classifyTerminalName).
        this.titleSync.noteKnownTitle(this.getInitialTabName());
    }

    /** Tmux window id (`@…`) after `open()` attaches; used to align session active window with VS Code tab focus. */
    getAttachedTmuxWindowId(): string | null {
        return this.windowId;
    }

    /**
     * Name to use in the terminal creation options.  Kept in the `tmux` /
     * `tmux:<n>` shape because `looksLikeTmuxTerminal` in extension.ts
     * matches on it to associate freshly-opened terminals with pending ptys.
     */
    getInitialTabName(): string {
        return this.existingWindow?.windowIndex !== undefined
            ? `tmux:${this.existingWindow.windowIndex}`
            : 'tmux';
    }

    /** True when this terminal was created with the showAutomaticRename setting enabled. */
    isAutomaticRenameMode(): boolean {
        return this.showAutomaticRename;
    }

    /**
     * Rename this tmux window and update the VS Code tab label atomically.
     * Called from the "tmux: Rename Terminal" command — single source of truth,
     * no loop risk since both sides are updated in one place.
     */
    async renameWindow(newName: string): Promise<void> {
        const name = this.normalizeTabLabel(newName);
        if (!name || !this.windowId || !this.client.isConnected()) {
            return;
        }
        this.emitTitle(name);
        await this.pushRenameToTmux(name);
    }

    /**
     * Sync a name that was already applied on the VS Code side (e.g. via the
     * built-in "Rename…" action) to the tmux window.  Updates internal state
     * so the echoed `%window-renamed` event is suppressed.
     */
    async syncNameToTmux(newName: string): Promise<void> {
        const name = this.normalizeTabLabel(newName);
        if (!name || !this.windowId || !this.client.isConnected()) {
            return;
        }
        // The VS Code tab already shows this name; record it (without
        // re-firing onDidChangeName) so dedup and echo handling line up.
        this.titleSync.recordEmission(name);
        await this.pushRenameToTmux(name);
    }

    /**
     * Compare the `terminal.name` VS Code reports with the titles this
     * terminal has produced and, only when it can genuinely be a user rename
     * (built-in "Rename…"), push it to tmux.  Stale names — an older title
     * VS Code has not finished replacing yet — are left alone; previously
     * they were pushed back to tmux, reverting tmux-side renames whenever
     * the user typed before the new title had round-tripped.
     */
    maybeSyncNameFromVsCode(terminalName: string): void {
        if (this.titleSync.classifyTerminalName(terminalName) === 'user-rename') {
            void this.syncNameToTmux(terminalName);
        }
    }

    /**
     * Re-enable tmux's automatic-rename for this window (the inverse of an
     * explicit rename).  tmux recomputes the name shortly afterwards and the
     * resulting %window-renamed updates the tab.  Only offered in
     * showAutomaticRename mode, where the tab actually tracks those names.
     */
    async resetToAutomaticRename(): Promise<void> {
        if (!this.windowId || !this.client.isConnected()) {
            return;
        }
        await this.client
            .sendCommand(`set-option -w -t ${this.windowId} automatic-rename on`, CommandFlags.TolerateErrors)
            .catch(() => {});
    }

    /**
     * See `onInputCallback` field.  Called once per tracked terminal when the
     * extension attaches rename-sync logic.
     */
    setOnInputCallback(cb: () => void): void {
        this.onInputCallback = cb;
    }

    // -----------------------------------------------------------------------
    // Pseudoterminal interface
    // -----------------------------------------------------------------------

    async open(initialDimensions: vscode.TerminalDimensions | undefined): Promise<void> {
        try {
            this.log(`open() called: existingWindow=${JSON.stringify(this.existingWindow)}, dims=${initialDimensions?.columns}x${initialDimensions?.rows}, shell=${this.shell}, clientConnected=${this.client.isConnected()}`);
            let targetWindow: { windowId: string; paneId: string; windowIndex?: number; name?: string; automaticRename?: boolean };
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
                let newWindowTimeout: ReturnType<typeof setTimeout> | undefined;
                const timeoutPromise = new Promise<never>((_, reject) => {
                    newWindowTimeout = setTimeout(
                        () => reject(new Error('Timed out waiting for tmux new-window response (15s)')),
                        15_000,
                    );
                });
                try {
                    targetWindow = await Promise.race([newWindowPromise, timeoutPromise]);
                } finally {
                    clearTimeout(newWindowTimeout);
                }
                this.log(`open(): new window created: ${JSON.stringify(targetWindow)}`);
            }
            const { windowId, paneId } = targetWindow;
            let windowIndex: number | undefined = 'windowIndex' in targetWindow
                ? (targetWindow as { windowIndex: number }).windowIndex
                : this.existingWindow?.windowIndex;
            if (windowIndex === undefined || Number.isNaN(windowIndex)) {
                const got = await this.client.getWindowIndex(windowId).catch(() => NaN);
                if (!Number.isNaN(got)) {
                    windowIndex = got;
                }
            }
            this.tabWindowIndex = windowIndex;
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

            // When the tmux window disappears (e.g. the shell exited
            // or `tmux kill-window`), close the VS Code terminal tab.
            this.windowCloseListener = (id: string) => {
                if (id === this.windowId) {
                    this.cleanup();
                    this.closeEmitter.fire(0);
                }
            };
            this.client.on('window-close', this.windowCloseListener);

            this.windowRenamedListener = (payload) => {
                if (!payload || payload.windowId !== this.windowId) {
                    return;
                }
                const name = (payload.name ?? '').trim();
                // Echo of a rename this extension sent (open() normalization,
                // renameWindow, or syncNameToTmux): the tab already shows the
                // right title. Consuming it here also prevents a stale echo
                // from flickering the tab through an older name when two
                // renames were issued in quick succession.
                if (this.titleSync.consumeRenameEcho(name)) {
                    return;
                }
                // Drop any %window-renamed event that arrives while open()
                // is still settling the initial title. Without this guard,
                // tmux's automatic-rename feature can fire e.g.
                // %window-renamed @5 zsh in the brief window between our
                // listener registration and our `set-option ... off`
                // command landing — long enough on a laggy SSH tunnel that
                // the tab title flips to "zsh"/"bash"/whatever. In
                // showAutomaticRename mode those events are wanted, so the
                // guard is bypassed.
                if (!this.initialNameCommitted && !this.showAutomaticRename) {
                    return;
                }
                this.emitTitle(
                    pickTerminalTabTitle(name || undefined, this.tabWindowIndex, false, this.showAutomaticRename),
                );
            };
            this.client.on('window-renamed', this.windowRenamedListener);

            // When the entire tmux session exits, close the VS Code tab
            // (mirrors the window-close handler above).
            this.tmuxExitListener = () => {
                this.cleanup();
                this.closeEmitter.fire(0);
            };
            this.client.on('tmux-exit', this.tmuxExitListener);

            try {
                // Decide whether tmux is currently auto-renaming this
                // window so we can pick the right starting label. Prefer
                // the metadata carried in from list-windows / new-window
                // so we don't burn a round-trip on a high-latency link.
                let automaticRename: boolean | undefined =
                    this.existingWindow?.automaticRename ?? targetWindow.automaticRename;
                if (automaticRename === undefined) {
                    if (this.existingWindow) {
                        // Adoption path with no metadata (older caller):
                        // query before we change anything.
                        automaticRename = await this.client
                            .getWindowAutomaticRename(windowId)
                            .catch(() => undefined);
                    } else {
                        // Brand-new window: tmux's default is
                        // automatic-rename on, so treat it as such even
                        // without a round-trip.
                        automaticRename = true;
                    }
                }
                if (automaticRename === undefined) {
                    automaticRename = false;
                }

                if (!this.showAutomaticRename) {
                    // Disable auto-rename so foreground-process changes
                    // don't keep flipping the title. Doing this *before* we
                    // emit the label means tmux's own auto-rename can no
                    // longer race past us, and the listener guard
                    // (initialNameCommitted) catches anything already in
                    // flight. In showAutomaticRename mode the option is
                    // left untouched: tmux keeps owning the name and the
                    // tab tracks it.
                    await this.client
                        .sendCommand(
                            `set-option -w -t ${windowId} automatic-rename off`,
                            CommandFlags.TolerateErrors,
                        )
                        .catch(() => {});
                }

                let candidate = (this.existingWindow?.name ?? targetWindow.name ?? '').trim();
                if (!candidate) {
                    candidate = (await this.client.getWindowName(windowId).catch(() => '')).trim();
                }
                const label = pickTerminalTabTitle(
                    candidate || undefined,
                    windowIndex,
                    automaticRename,
                    this.showAutomaticRename,
                );

                // In showAutomaticRename mode a %window-renamed processed
                // during the awaits above may already have emitted a fresher
                // title; don't clobber it with the stale candidate.
                if (!this.titleSync.hasEmitted) {
                    this.emitTitle(label);
                }

                if (!this.showAutomaticRename) {
                    const current = (await this.client.getWindowName(windowId).catch(() => '')).trim();
                    if (current !== label) {
                        this.titleSync.recordRenameSentToTmux(label);
                        await this.client
                            .sendCommand(
                                `rename-window -t ${windowId} ${shellescape(label)}`,
                                CommandFlags.TolerateErrors,
                            )
                            .catch(() => {});
                    }
                }
            } finally {
                // From here on, %window-renamed events represent real
                // renames (user typed `tmux rename-window foo` from a
                // shell, or this extension's renameWindow command) and
                // must update the VS Code tab.
                this.initialNameCommitted = true;
            }

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

    /**
     * `vscode.Pseudoterminal` — invoked by the VS Code extension host when the
     * user types or pastes in this terminal (xterm forwards UTF-8 chunks here).
     * You will not find call sites in this repo: the host calls it on the `pty`
     * object passed to `vscode.window.createTerminal({ pty })`.
     */
    handleInput(data: string): void {
        if (!this.paneId) { return; }
        this.onInputCallback?.();
        // Defence-in-depth: drop any DSR / DA / CPR replies that xterm.js
        // still emits on its onData channel (e.g. for queries we didn't
        // catch in normalizeTerminalOutput). These can never come from a
        // human keyboard, so dropping them in input is safe.
        //   CSI <private?> <params> R   → CPR response
        //   CSI <private?> <params> n   → DSR response
        //   CSI <private?> <params> c   → DA response
        const filtered = data.replace(/\x1b\[[?>=<]?[\d;]*[Rnc]/g, '');
        if (filtered.length === 0) { return; }
        this.sendKeysInput(filtered);
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
        // Closing the VS Code pseudoterminal only detaches its view. The tmux
        // window, pane, and foreground process remain alive for re-adoption.
        this.cleanup();
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /**
     * Maps VS Code terminal input to tmux `send-keys`.  Entry point is only
     * `handleInput` above (not dead code — grep does not see the host caller).
     *
     * Send input to the tmux pane using the iTerm2 hybrid strategy:
     *   - Unknown ESC sequences (CSI, SS3, OSC, DCS, …) → single hex
     *     `send-keys -t <pane> 0x1b 0x5b …` so the whole sequence is
     *     written to the pane's pty atomically (see issue #26).
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
            // 1. Forward unknown ESC sequences (CSI, SS3, OSC, DCS, …) atomically
            //    as a single hex-encoded `send-keys`.  This is critical for
            //    terminal protocol responses such as the cursor-position report
            //    (`\x1b[<row>;<col>R`) that xterm.js auto-replies with: if we
            //    instead split the sequence across multiple `send-keys` commands
            //    (Escape + 0x5b + literals + …), tmux performs separate writes
            //    to the pane's pty and the foreground app's input parser reads
            //    them as separate chunks, often dropping the leading bytes —
            //    leaving fragments like `;<col>R` to land in stdin (issue #26).
            const escLen = findEscSequenceLength(data, index);
            if (escLen > 0) {
                const hexCodes: string[] = [];
                for (let i = 0; i < escLen; i++) {
                    const buf = Buffer.from(data[index + i], 'utf8');
                    for (const b of buf) {
                        hexCodes.push(`0x${b.toString(16).padStart(2, '0')}`);
                    }
                }
                commands.push(`send-keys -t ${paneId} ${hexCodes.join(' ')}`);
                index += escLen;
                continue;
            }

            // 2. Check for known escape sequences (function keys, arrows, etc.)
            const sequence = SORTED_KEY_SEQUENCES.find((candidate) => data.startsWith(candidate, index));
            if (sequence) {
                commands.push(`send-keys -t ${paneId} ${KEY_MAP[sequence]}`);
                index += sequence.length;
                continue;
            }

            const char = data[index];

            // 3. Bare \n → Enter
            if (char === '\n') {
                commands.push(`send-keys -t ${paneId} Enter`);
                index += 1;
                continue;
            }

            // 4. Control characters (< 0x20) → C-x key names
            if (char.charCodeAt(0) < 0x20) {
                const letter = String.fromCharCode(char.charCodeAt(0) + 64).toLowerCase();
                commands.push(`send-keys -t ${paneId} C-${letter}`);
                index += 1;
                continue;
            }

            // 5. Collect a run of printable characters.  Classify each as
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
            } else if (cp > 0x7f) {
                // Non-ASCII printable text should be forwarded literally so
                // tmux receives the original UTF-8 input instead of ASCII-only
                // hex key codes.
                let textEnd = index + 1;
                while (textEnd < data.length) {
                    const nextCp = data.charCodeAt(textEnd);
                    if (nextCp < 0x20 || nextCp <= 0x7f || canSendAsLiteral(nextCp)) { break; }
                    if (SORTED_KEY_SEQUENCES.some((s) => data.startsWith(s, textEnd))) { break; }
                    textEnd++;
                }
                const run = data.slice(index, textEnd);
                commands.push(`send-keys -l -t ${paneId} ${shellescape(run)}`);
                index = textEnd;
            } else {
                // Collect consecutive hex characters (anything not safe-literal
                // and not a control char or escape sequence).
                const hexCodes: string[] = [];
                let hexEnd = index;
                while (hexEnd < data.length) {
                    const nextCp = data.charCodeAt(hexEnd);
                    if (nextCp < 0x20 || nextCp > 0x7f) { break; }
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
     *   2. Strip terminal-status queries (DSR `\x1b[…n`, DA `\x1b[…c`) that
     *      tmux itself already replies to from the pane's virtual screen
     *      state (see tmux's input.c INPUT_CSI_DSR / INPUT_CSI_DA handlers).
     *      Without this, xterm.js sees the query, emits its OWN cursor/DA
     *      reply via onData, and that reply rides back through send-keys to
     *      land in the program's stdin a moment after tmux's own reply —
     *      leaking fragments like `;145R;56R` into the next `gh` prompt
     *      (issue #26). default-terminal is `xterm-256color`, so programs
     *      assume DSR works and query freely; the workaround of switching
     *      TERM to tmux-256color avoids the queries but loses xterm-style
     *      capabilities, hence we filter here instead.
     *   3. Ensure bare LF is preceded by CR (xterm.js requirement).
     */
    private normalizeTerminalOutput(data: string): string {
        // Strip \ek<text>\e\\ — screen/tmux hardstatus title sequence.
        data = data.replace(/\x1bk[^\x1b]*\x1b\\/g, '');

        // Strip DSR / DA queries that tmux already answers internally so
        // xterm.js doesn't generate duplicate auto-responses on top.
        //   CSI <private?> <params> n   → DSR (status / cursor position)
        //   CSI <private?> <params> c   → DA  (device attributes)
        // Final bytes 'n' and 'c' are exclusively query/response per
        // ECMA-48; stripping them never affects rendered output.
        data = data.replace(/\x1b\[[?>=<]?[\d;]*[nc]/g, '');

        // Ensure bare LF is preceded by CR (xterm.js requirement).
        // Use a single regex pass
        let result : string;
        if(this.lastCharWasCR) {
            // Previous chunk ended with \r - first \n in this chunk is already
            // preceded by CR, so skip it in the replacement
            const firstLF = data.indexOf('\n');
            if(firstLF === 0) {
                result = data.substring(1).replace(/(?<!\r)\n/g, '\r\n');
                result = '\n' + result;
            } else {
                result = data.replace(/(?<!\r)\n/g, '\r\n');
            }
        } else {
            result = data.replace(/(?<!\r)\n/g, '\r\n');
        }
        // Track whether this chunk ends with \r for the next call
        this.lastCharWasCR = data.length > 0 && data[data.length - 1] === '\r';
        return result;
    }

    private normalizeTabLabel(label: string): string {
        return label.trim();
    }

    /** Emit a tab title to VS Code, deduplicated against the last emission. */
    private emitTitle(title: string): void {
        const normalized = this.normalizeTabLabel(title);
        if (!normalized || normalized === this.titleSync.lastEmittedTitle) {
            return;
        }
        this.titleSync.recordEmission(normalized);
        this.nameEmitter.fire(normalized);
    }

    /**
     * Apply an explicit (user-chosen) name to the tmux window: pin the name
     * by turning automatic-rename off, then rename.  Batched into a single
     * PTY write so the two commands cannot interleave with others.  The
     * rename is recorded first so its %window-renamed echo is recognised.
     */
    private async pushRenameToTmux(name: string): Promise<void> {
        if (!this.windowId) {
            return;
        }
        this.titleSync.recordRenameSentToTmux(name);
        await this.client
            .sendCommandList(
                [
                    `set-option -w -t ${this.windowId} automatic-rename off`,
                    `rename-window -t ${this.windowId} ${shellescape(name)}`,
                ],
                CommandFlags.TolerateErrors,
            )
            .catch(() => {});
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

        if (this.windowRenamedListener) {
            this.client.removeListener('window-renamed', this.windowRenamedListener);
            this.windowRenamedListener = null;
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
        this.tabWindowIndex = undefined;
        this.titleSync = new TabTitleSync();
        this.titleSync.noteKnownTitle(this.getInitialTabName());
        this.initialNameCommitted = false;

        if (this.windowId && this.attachedWindowNotified) {
            this.lifecycleHooks.onWindowDetached?.(this.windowId);
            this.attachedWindowNotified = false;
        }
    }
}
