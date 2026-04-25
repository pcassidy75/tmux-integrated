/**
 * TmuxGateway — low-level tmux control-mode protocol parser and command dispatcher.
 *
 * Modelled on iTerm2's TmuxGateway design, this class cleanly separates
 * the protocol parsing layer from higher-level business logic (TmuxControlClient).
 *
 * Responsibilities:
 *   - Parse %begin/%end/%error response blocks and dispatch to the command queue.
 *   - Parse asynchronous %notifications and emit them as events.
 *   - Support command flags:
 *       • TolerateErrors — resolve with [] on %error instead of rejecting.
 *   - Support command batching (sendCommandList) to reduce PTY round-trips:
 *       commands are joined with ' ; ' and sent as a single write, with one
 *       pending-queue entry per command to match the individual responses.
 *   - Write queuing: all outgoing writes are deferred until %session-changed is
 *       received, preventing races during the tmux control-mode init sequence.
 *       A setImmediate fallback ensures compatibility with tmux < 2.6, which
 *       does not emit %session-changed.
 */

import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';

// ---------------------------------------------------------------------------
// Command flags
// ---------------------------------------------------------------------------

/** Bit flags controlling per-command gateway behaviour. */
export const CommandFlags = {
    None: 0,
    /**
     * When set, a %error response resolves the promise with an empty array
     * instead of rejecting it.  Use for fire-and-forget operations where
     * failure is expected and the caller wants to proceed regardless.
     */
    TolerateErrors: 1 << 0,
} as const;

/** Union of all valid CommandFlags values. */
export type CommandFlagsValue = typeof CommandFlags[keyof typeof CommandFlags];

// ---------------------------------------------------------------------------
// Shared types (re-exported so callers don't need to import from two places)
// ---------------------------------------------------------------------------

export interface TmuxPaneOutput {
    paneId: string;
    data: string;
}

export interface TmuxLayoutChange {
    windowId: string;
    layout: string;
    visibleLayout: string;
    flags: string;
}

export interface TmuxWindowPaneChange {
    windowId: string;
    paneId: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingCommand {
    flags: number;
    resolve: (lines: string[]) => void;
    reject: (err: Error) => void;
}

// The control-mode parser works on raw bytes so %output payloads are not
// decoded as UTF-8 before pane-level boundary handling. Keep the repeated
// byte markers/prefixes named to make the framing logic readable.
const BYTE_LF = 0x0a;
const BYTE_CR = 0x0d;
const BYTE_ESC = 0x1b;
const BYTE_P = 0x50;
const BYTE_L = 0x6c;
const BYTE_SPACE = 0x20;
const BYTE_BACKSLASH = 0x5c;
const BYTE_COLON = 0x3a;

const OUTPUT_PREFIX = Buffer.from('%output ', 'ascii');
const EXTENDED_OUTPUT_PREFIX = Buffer.from('%extended-output ', 'ascii');
const WINDOW_ADD_PREFIX = '%window-add ';
const WINDOW_CLOSE_PREFIX = '%window-close ';
const UNLINKED_WINDOW_CLOSE_PREFIX = '%unlinked-window-close ';
const WINDOW_RENAMED_PREFIX = '%window-renamed ';
const LAYOUT_CHANGE_PREFIX = '%layout-change ';
const WINDOW_PANE_CHANGED_PREFIX = '%window-pane-changed ';
const SESSION_WINDOW_CHANGED_PREFIX = '%session-window-changed ';
const SESSION_RENAMED_PREFIX = '%session-renamed ';
const SESSION_CHANGED_PREFIX = '%session-changed ';
const PANE_MODE_CHANGED_PREFIX = '%pane-mode-changed ';
const PAUSE_PREFIX = '%pause ';
const CONTINUE_PREFIX = '%continue ';
const MESSAGE_PREFIX = '%message ';

function stripDcsWrapper(line: Buffer): Buffer {
    let stripped = line;

    if (stripped.length >= 2 && stripped[0] === BYTE_ESC && stripped[1] === BYTE_P) {
        let scan = 2;
        while (scan < stripped.length && stripped[scan] !== BYTE_L) {
            scan++;
        }
        if (scan < stripped.length) {
            stripped = stripped.subarray(scan + 1);
        }
    }

    if (
        stripped.length >= 2
        && stripped[stripped.length - 2] === BYTE_ESC
        && stripped[stripped.length - 1] === BYTE_BACKSLASH
    ) {
        stripped = stripped.subarray(0, stripped.length - 2);
    }

    return stripped;
}

function hasPrefix(line: Buffer, prefix: Buffer): boolean {
    return line.length >= prefix.length && line.subarray(0, prefix.length).equals(prefix);
}

// ---------------------------------------------------------------------------
// TmuxGateway
// ---------------------------------------------------------------------------

export class TmuxGateway extends EventEmitter {
    // Raw-data accumulation buffer.
    private readBuffer = Buffer.alloc(0);

    // Lines accumulated inside a %begin…%end block.
    private responseBuffer: string[] = [];

    // True when we are inside a %begin…%end or %begin…%error block.
    private inBlock = false;

    // FIFO of in-flight commands waiting for %begin/%end pairs.
    private pendingQueue: PendingCommand[] = [];

    // Writes buffered before %session-changed (or the fallback flush).
    private writeQueue: string[] = [];

    // Becomes true once the write queue has been flushed.
    private sessionReady = false;

    // Set to true after the first %end with an empty pending queue.
    private handshakeDone = false;

    // Function used to write bytes to the underlying PTY.
    private writer: ((data: string) => void) | null = null;

    // Per-pane incremental UTF-8 decoders, keyed by pane ID.
    private readonly paneDecoders = new Map<string, StringDecoder>();

    // -----------------------------------------------------------------------
    // Public API — setup
    // -----------------------------------------------------------------------

    /**
     * Supply the function used to write bytes to the underlying PTY.
     * Must be called before any commands are sent.
     */
    setWriter(fn: (data: string) => void): void {
        this.writer = fn;
    }

    // -----------------------------------------------------------------------
    // Public API — data ingestion
    // -----------------------------------------------------------------------

    /**
     * Feed raw PTY data into the parser.
     * Call this from the PTY onData callback.
     */
    ingest(raw: string | Uint8Array): void {
        const chunk = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
        this.readBuffer = this.readBuffer.length === 0
            ? chunk
            : Buffer.concat([this.readBuffer, chunk]);

        let lineEnd = this.readBuffer.indexOf(BYTE_LF);
        while (lineEnd !== -1) {
            let line = this.readBuffer.subarray(0, lineEnd);
            this.readBuffer = this.readBuffer.subarray(lineEnd + 1);
            if (line.length > 0 && line[line.length - 1] === BYTE_CR) {
                line = line.subarray(0, line.length - 1);
            }
            this.parseLine(line);
            lineEnd = this.readBuffer.indexOf(BYTE_LF);
        }
    }

    // -----------------------------------------------------------------------
    // Public API — command dispatch
    // -----------------------------------------------------------------------

    /**
     * Send a single tmux command and return the response lines.
     *
     * If the write queue has not yet been flushed (session not ready), the
     * PTY write is deferred and the returned promise will not resolve until
     * %session-changed triggers the flush.
     */
    sendCommand(command: string, flags: number = CommandFlags.None): Promise<string[]> {
        return new Promise((resolve, reject) => {
            this.pendingQueue.push({ flags, resolve, reject });
            this.write(command + '\r');
        });
    }

    /**
     * Send multiple tmux commands as a single batched write.
     *
     * Commands are joined with ' ; ' and sent as one line.  tmux generates
     * one %begin/%end response pair per command, so N entries are pushed to
     * the pending queue and matched in order as responses arrive.
     *
     * Returns a Promise that resolves to an array of response-line arrays,
     * one per input command, when all responses have been received.
     */
    sendCommandList(commands: string[], flags: number = CommandFlags.None): Promise<string[][]> {
        if (commands.length === 0) {
            return Promise.resolve([]);
        }

        const combined = commands.join(' ; ');
        const promises = commands.map(
            () => new Promise<string[]>((resolve, reject) => {
                this.pendingQueue.push({ flags, resolve, reject });
            }),
        );

        this.write(combined + '\r');
        return Promise.all(promises);
    }

    /**
     * Reject all pending commands.
     * Call this when the underlying PTY process exits.
     */
    drainOnExit(): void {
        const queue = this.pendingQueue.splice(0);
        for (const cmd of queue) {
            cmd.reject(new Error('tmux process exited'));
        }
    }

    /** Remove the incremental UTF-8 decoder for a closed pane. */
    removePaneDecoder(paneId: string): void {
        this.paneDecoders.delete(paneId);
    }

    // -----------------------------------------------------------------------
    // Private — write queuing
    // -----------------------------------------------------------------------

    private write(data: string): void {
        if (!this.sessionReady) {
            this.writeQueue.push(data);
            return;
        }
        this.writer?.(data);
    }

    /**
     * Flush the write queue and mark the session as ready.
     * Idempotent — safe to call multiple times (subsequent calls are no-ops).
     */
    private flushWriteQueue(): void {
        if (this.sessionReady) {
            return;
        }
        this.sessionReady = true;
        const queue = this.writeQueue.splice(0);
        for (const item of queue) {
            this.writer?.(item);
        }
    }

    // -----------------------------------------------------------------------
    // Private — protocol parsing
    // -----------------------------------------------------------------------

    private parseLine(line: Buffer): void {
        if (line.length === 0) { return; }

        line = stripDcsWrapper(line);
        if (line.length === 0) {
            return;
        }

        if (hasPrefix(line, OUTPUT_PREFIX)) {
            this.parseOutput(line);
            return;
        }
        if (hasPrefix(line, EXTENDED_OUTPUT_PREFIX)) {
            this.parseExtendedOutput(line);
            return;
        }

        this.parseControlLine(line.toString('utf8'));
    }

    private parseControlLine(line: string): void {
        if (line.startsWith('%begin')) {
            this.inBlock = true;
            this.responseBuffer = [];
        } else if (line.startsWith('%end')) {
            this.inBlock = false;
            const cmd = this.pendingQueue.shift();
            if (cmd) {
                cmd.resolve(this.responseBuffer.slice());
            } else if (!this.handshakeDone) {
                // The very first %end with no pending command signals that
                // tmux control mode is alive.  Emit the handshake event so
                // TmuxControlClient can now safely queue the readiness probe.
                this.handshakeDone = true;
                this.emit('_initial-handshake');
                // Fallback flush for tmux < 2.6, which does not emit
                // %session-changed.  flushWriteQueue is idempotent, so if
                // %session-changed fires first (in the same ingest call) the
                // setImmediate becomes a no-op.
                setImmediate(() => this.flushWriteQueue());
            }
            this.responseBuffer = [];
        } else if (line.startsWith('%error')) {
            this.inBlock = false;
            const cmd = this.pendingQueue.shift();
            if (cmd) {
                if (cmd.flags & CommandFlags.TolerateErrors) {
                    cmd.resolve([]);
                } else {
                    cmd.reject(new Error(this.responseBuffer.join('\n') || line));
                }
            }
            this.responseBuffer = [];
        } else if (this.inBlock && line.startsWith('%')) {
            // Asynchronous notifications that arrive while a command block is
            // in flight must be processed as notifications, not swallowed as
            // response text.
            this.parseNotification(line);
        } else if (this.inBlock) {
            this.responseBuffer.push(line);
        } else {
            this.parseNotification(line);
        }
    }

    private parseNotification(line: string): void {
        if (line.startsWith(WINDOW_ADD_PREFIX)) {
            this.emit('window-add', line.slice(WINDOW_ADD_PREFIX.length).trim());
        } else if (line.startsWith(WINDOW_CLOSE_PREFIX) || line.startsWith(UNLINKED_WINDOW_CLOSE_PREFIX)) {
            const prefix = line.startsWith(WINDOW_CLOSE_PREFIX) ? WINDOW_CLOSE_PREFIX : UNLINKED_WINDOW_CLOSE_PREFIX;
            const windowId = line.slice(prefix.length).trim().split(/\s+/u)[0];
            this.emit('window-close', windowId);
        } else if (line.startsWith(WINDOW_RENAMED_PREFIX)) {
            this.emit('window-renamed', parseWindowRenamed(line));
        } else if (line.startsWith(LAYOUT_CHANGE_PREFIX)) {
            const layoutChange = parseLayoutChange(line);
            if (layoutChange) {
                this.emit('layout-change', layoutChange);
            }
        } else if (line.startsWith(WINDOW_PANE_CHANGED_PREFIX)) {
            const paneChange = parseWindowPaneChange(line);
            if (paneChange) {
                this.emit('window-pane-changed', paneChange);
            }
        } else if (line.startsWith(SESSION_WINDOW_CHANGED_PREFIX)) {
            this.emit('session-window-changed', parseSessionWindowChanged(line));
        } else if (line.startsWith(SESSION_RENAMED_PREFIX)) {
            this.emit('session-renamed', line.slice(SESSION_RENAMED_PREFIX.length));
        } else if (line.startsWith('%sessions-changed')) {
            this.emit('sessions-changed');
        } else if (line.startsWith(SESSION_CHANGED_PREFIX)) {
            // %session-changed $N name — the session is now fully initialised.
            // Flush the write queue so deferred commands reach tmux.
            this.flushWriteQueue();
            this.emit('session-changed', line.slice(SESSION_CHANGED_PREFIX.length).trim());
        } else if (line.startsWith(PANE_MODE_CHANGED_PREFIX)) {
            this.emit('pane-mode-changed', line.slice(PANE_MODE_CHANGED_PREFIX.length).trim());
        } else if (line.startsWith('%paste-buffer-changed')) {
            this.emit('paste-buffer-changed');
        } else if (line.startsWith(PAUSE_PREFIX)) {
            this.emit('pause', line.slice(PAUSE_PREFIX.length).trim());
        } else if (line.startsWith(CONTINUE_PREFIX)) {
            this.emit('continue', line.slice(CONTINUE_PREFIX.length).trim());
        } else if (line.startsWith(MESSAGE_PREFIX)) {
            this.emit('message', line.slice(MESSAGE_PREFIX.length));
        } else if (line.startsWith('%exit')) {
            this.emit('tmux-exit');
        }
    }

    private parseOutput(line: Buffer): void {
        const rest = line.subarray(OUTPUT_PREFIX.length);
        const sp = rest.indexOf(BYTE_SPACE);
        if (sp === -1) {
            return;
        }

        const paneId = rest.subarray(0, sp).toString('utf8');
        const encoded = rest.subarray(sp + 1);
        const data = this.decodePaneOutput(paneId, encoded);
        this.emit('output', { paneId, data } as TmuxPaneOutput);
    }

    private parseExtendedOutput(line: Buffer): void {
        const rest = line.subarray(EXTENDED_OUTPUT_PREFIX.length);
        const firstSpace = rest.indexOf(BYTE_SPACE);
        if (firstSpace === -1) {
            return;
        }

        const paneId = rest.subarray(0, firstSpace).toString('utf8');
        if (!paneId.startsWith('%')) {
            return;
        }

        const colonIndex = rest.indexOf(BYTE_COLON);
        if (colonIndex === -1) {
            return;
        }

        let encoded = rest.subarray(colonIndex + 1);
        if (encoded.length > 0 && encoded[0] === BYTE_SPACE) {
            encoded = encoded.subarray(1);
        }

        const data = this.decodePaneOutput(paneId, encoded);
        this.emit('output', { paneId, data } as TmuxPaneOutput);
    }

    private decodePaneOutput(paneId: string, encoded: Buffer): string {
        let decoder = this.paneDecoders.get(paneId);
        if (!decoder) {
            decoder = new StringDecoder('utf8');
            this.paneDecoders.set(paneId, decoder);
        }

        return decoder.write(decodeOutput(encoded));
    }

}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Decode data from a tmux %output or %extended-output notification.
 *
 * Modelled on iTerm2's `decodeEscapedOutput:` (TmuxGateway.m), but
 * deliberately more conservative about which bare bytes it drops:
 *   - tmux octal-encodes control bytes in the %output payload, but in
 *     practice bare control bytes can still appear (e.g. when tmux passes
 *     through certain terminal protocol responses).  The original iTerm2
 *     guard skipped *all* bytes < 0x20, which strips the leading ESC of
 *     responses like a cursor-position report (`ESC[<row>;<col>R`) and
 *     leaves the visible tail in the terminal — see issue #26.
 *   - The only documented case the guard was actually targeting is the
 *     bare `\r` that the PTY line driver "sprinkles in at its pleasure"
 *     (e.g. ONLCR converting `\n` → `\r\n`).  We restrict the filter to
 *     that single case and let every other byte — most importantly ESC
 *     (0x1b) — pass through so terminal protocol sequences arrive intact.
 *   - Within an octal escape (\NNN), bare `\r` is similarly ignored,
 *     matching iTerm2's comment: "Ignore \r's that the line driver
 *     sprinkles in at its pleasure."
 */
function decodeOutput(encoded: Buffer): Buffer {
    const bytes: number[] = [];

    for (let index = 0; index < encoded.length; ) {
        const code = encoded[index];

        // Drop bare CR injected by the PTY line driver. Other control
        // bytes (notably ESC 0x1b) must be preserved so that terminal
        // protocol responses such as CPR are not truncated.
        if (code === BYTE_CR) {
            index++;
            continue;
        }

        if (code === BYTE_BACKSLASH) {
            // Try to read exactly 3 octal digits, skipping any bare \r
            // characters the line driver may have inserted.
            let value = 0;
            let digits = 0;
            let scan = index + 1;
            while (digits < 3 && scan < encoded.length) {
                const ch = encoded[scan];
                if (ch === BYTE_CR) {     // bare \r — skip
                    scan++;
                    continue;
                }
                if (ch === undefined || ch < 0x30 || ch > 0x37) {  // not '0'..'7'
                    break;
                }
                value = value * 8 + (ch - 0x30);
                digits++;
                scan++;
            }
            if (digits === 3) {
                bytes.push(value);
                index = scan;
                continue;
            }
            // Not a valid octal escape — fall through and emit '\' as-is.
        }

        bytes.push(code);
        index++;
    }

    return Buffer.from(bytes);
}

function parseLayoutChange(line: string): TmuxLayoutChange | null {
    const match = /^%layout-change\s+(@\S+)\s+(\S+)\s+(\S+)\s*(.*)$/u.exec(line);
    if (!match) {
        return null;
    }

    const [, windowId, layout, visibleLayout, flags] = match;
    return { windowId, layout, visibleLayout, flags: flags.trim() };
}

function parseWindowPaneChange(line: string): TmuxWindowPaneChange | null {
    const match = /^%window-pane-changed\s+(@\S+)\s+(%\S+)$/u.exec(line);
    if (!match) {
        return null;
    }

    const [, windowId, paneId] = match;
    return { windowId, paneId };
}

function parseWindowRenamed(line: string): { windowId: string; name: string } | null {
    const match = /^%window-renamed\s+(@\S+)\s+(.*)$/u.exec(line);
    if (!match) {
        return null;
    }

    const [, windowId, name] = match;
    return { windowId, name };
}

function parseSessionWindowChanged(line: string): { sessionId: string; windowId: string } | null {
    const match = /^%session-window-changed\s+(\$\S+)\s+(@\S+)$/u.exec(line);
    if (!match) {
        return null;
    }

    const [, sessionId, windowId] = match;
    return { sessionId, windowId };
}
