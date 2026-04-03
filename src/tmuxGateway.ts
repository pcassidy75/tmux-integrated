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


// ---------------------------------------------------------------------------
// TmuxGateway
// ---------------------------------------------------------------------------

export class TmuxGateway extends EventEmitter {
    // Raw-data accumulation buffer.
    private readBuffer = '';

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
    ingest(raw: string): void {
        this.readBuffer += raw;

        let lineEnd = this.readBuffer.indexOf('\n');
        while (lineEnd !== -1) {
            const line = this.readBuffer.slice(0, lineEnd).replace(/\r$/u, '');
            this.readBuffer = this.readBuffer.slice(lineEnd + 1);
            this.parseLine(line);
            lineEnd = this.readBuffer.indexOf('\n');
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

    private parseLine(line: string): void {
        if (!line) { return; }

        // Strip DCS wrapper (\x1bP…l … \x1b\\) emitted when tmux detects a tty.
        if (line.startsWith('\x1bP')) {
            line = line.replace(/^\x1bP[^l]*l/, '').replace(/\x1b\\$/, '');
        }

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
        if (line.startsWith('%output ')) {
            this.parseOutput(line);
        } else if (line.startsWith('%extended-output ')) {
            this.parseExtendedOutput(line);
        } else if (line.startsWith('%window-add ')) {
            this.emit('window-add', line.slice('%window-add '.length).trim());
        } else if (line.startsWith('%window-close ') || line.startsWith('%unlinked-window-close ')) {
            const prefix = line.startsWith('%window-close ') ? '%window-close ' : '%unlinked-window-close ';
            const windowId = line.slice(prefix.length).trim().split(/\s+/u)[0];
            this.emit('window-close', windowId);
        } else if (line.startsWith('%window-renamed ')) {
            this.emit('window-renamed', parseWindowRenamed(line));
        } else if (line.startsWith('%layout-change ')) {
            const layoutChange = parseLayoutChange(line);
            if (layoutChange) {
                this.emit('layout-change', layoutChange);
            }
        } else if (line.startsWith('%window-pane-changed ')) {
            const paneChange = parseWindowPaneChange(line);
            if (paneChange) {
                this.emit('window-pane-changed', paneChange);
            }
        } else if (line.startsWith('%session-window-changed ')) {
            this.emit('session-window-changed', parseSessionWindowChanged(line));
        } else if (line.startsWith('%session-renamed ')) {
            this.emit('session-renamed', line.slice('%session-renamed '.length));
        } else if (line.startsWith('%sessions-changed')) {
            this.emit('sessions-changed');
        } else if (line.startsWith('%session-changed')) {
            // %session-changed $N name — the session is now fully initialised.
            // Flush the write queue so deferred commands reach tmux.
            this.flushWriteQueue();
            this.emit('session-changed', line.slice('%session-changed '.length).trim());
        } else if (line.startsWith('%pane-mode-changed ')) {
            this.emit('pane-mode-changed', line.slice('%pane-mode-changed '.length).trim());
        } else if (line.startsWith('%paste-buffer-changed')) {
            this.emit('paste-buffer-changed');
        } else if (line.startsWith('%pause ')) {
            this.emit('pause', line.slice('%pause '.length).trim());
        } else if (line.startsWith('%continue ')) {
            this.emit('continue', line.slice('%continue '.length).trim());
        } else if (line.startsWith('%message ')) {
            this.emit('message', line.slice('%message '.length));
        } else if (line.startsWith('%exit')) {
            this.emit('tmux-exit');
        }
    }

    private parseOutput(line: string): void {
        const rest = line.slice('%output '.length);
        const sp = rest.indexOf(' ');
        if (sp === -1) {
            return;
        }

        const paneId = rest.slice(0, sp);
        const encoded = rest.slice(sp + 1);
        const data = this.decodePaneOutput(paneId, encoded);
        this.emit('output', { paneId, data } as TmuxPaneOutput);
    }

    private parseExtendedOutput(line: string): void {
        const rest = line.slice('%extended-output '.length);
        const firstSpace = rest.indexOf(' ');
        if (firstSpace === -1) {
            return;
        }

        const paneId = rest.slice(0, firstSpace);
        if (!paneId.startsWith('%')) {
            return;
        }

        const colonIndex = rest.indexOf(':');
        if (colonIndex === -1) {
            return;
        }

        let encoded = rest.slice(colonIndex + 1);
        if (encoded.startsWith(' ')) {
            encoded = encoded.slice(1);
        }

        const data = this.decodePaneOutput(paneId, encoded);
        this.emit('output', { paneId, data } as TmuxPaneOutput);
    }

    private decodePaneOutput(paneId: string, encoded: string): string {
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
 * Matches iTerm2's `decodeEscapedOutput:` (TmuxGateway.m):
 *   - Bare control characters (< 0x20) are silently skipped.  tmux always
 *     octal-encodes control bytes; bare ones are artefacts injected by the
 *     PTY line driver (e.g. ONLCR converting \n → \r\n).
 *   - Within an octal escape (\NNN), bare \r characters added by the line
 *     driver are ignored, matching iTerm2's comment: "Ignore \r's that the
 *     line driver sprinkles in at its pleasure."
 */
function decodeOutput(encoded: string): Buffer {
    const bytes: number[] = [];

    for (let index = 0; index < encoded.length;) {
        const code = encoded.charCodeAt(index);

        // Skip bare (un-escaped) control characters — same as iTerm2's
        // `if (c < ' ') { continue; }` guard.
        if (code < 0x20) {
            index++;
            continue;
        }

        if (encoded[index] === '\\') {
            // Try to read exactly 3 octal digits, skipping any bare \r
            // characters the line driver may have inserted.
            let value = 0;
            let digits = 0;
            let scan = index + 1;
            while (digits < 3 && scan < encoded.length) {
                const ch = encoded.charCodeAt(scan);
                if (ch === 0x0d) {     // bare \r — skip
                    scan++;
                    continue;
                }
                if (ch < 0x30 || ch > 0x37) {  // not '0'..'7'
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

        // Printable character (or multi-byte UTF-8 glyph from tmux).
        const codePoint = encoded.codePointAt(index);
        const width = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
        const buf = Buffer.from(encoded.slice(index, index + width), 'utf8');
        for (const b of buf) {
            bytes.push(b);
        }
        index += width;
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
