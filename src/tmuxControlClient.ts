/**
 * TmuxControlClient
 *
 * Connects to a tmux server using control mode (`tmux -CC`).  In control mode
 * tmux does not render any UI to the terminal; instead it sends structured
 * protocol messages on stdout and accepts commands on stdin.  This lets the
 * extension own the visual layer (VS Code terminals) while tmux provides
 * session persistence and process management.
 *
 * Protocol summary (https://man.openbsd.org/tmux.1#CONTROL_MODE):
 *   • Unsolicited notifications start with %:
 *       %output %<pane> <escaped-data>
 *       %window-add @<id>
 *       %window-close @<id>
 *       %sessions-changed
 *       %exit [reason]
 *   • Command responses are wrapped in a begin/end block:
 *       %begin <time> <num> 0
 *       [optional response lines]
 *       %end <time> <num> 0   |   %error <time> <num> 0
 *
 * In control mode, pane output is escaped inline. tmux encodes non-printable
 * bytes and literal backslashes as octal sequences such as \033.
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';

/**
 * Minimal interface for the node-pty `IPty` object.  We load node-pty at
 * runtime from VS Code's bundled copy, so we only declare the subset we use.
 */
interface IPty {
    onData: (callback: (data: string) => void) => { dispose(): void };
    onExit: (callback: (ev: { exitCode: number; signal?: number }) => void) => { dispose(): void };
    write(data: string): void;
    kill(signal?: string): void;
    pid: number;
}

export interface TmuxPaneOutput {
    paneId: string;
    data: string;
}

export interface TmuxWindow {
    id: string;
    index: number;
    name: string;
    paneId: string;
    active: boolean;
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

export interface TmuxPaneCursor {
    x: number;
    y: number;
}

interface PendingCommand {
    resolve: (lines: string[]) => void;
    reject: (err: Error) => void;
}

export class TmuxControlClient extends EventEmitter {
    private pty: IPty | null = null;
    private readBuffer = '';
    private responseBuffer: string[] = [];
    private inBlock = false;
    private pendingQueue: PendingCommand[] = [];
    private _connected = false;
    private readonly paneDecoders = new Map<string, StringDecoder>();
    private _version: { major: number; minor: number } | null = null;

    constructor(
        private readonly sessionName: string,
        private readonly tmuxBinaryPath: string,
        private readonly appRoot: string,
    ) {
        super();
    }

    /**
     * Parse a tmux version string (e.g. "tmux 3.4") and store the result.
     * Call this after resolving the tmux binary so that version-gated
     * features (like `new-window -e`) can be checked at runtime.
     */
    setVersion(versionString: string): void {
        const match = /(\d+)\.(\d+)/u.exec(versionString);
        if (match) {
            this._version = { major: Number(match[1]), minor: Number(match[2]) };
        }
    }

    /** Return the parsed tmux version, or null if not yet resolved. */
    get version(): { major: number; minor: number } | null {
        return this._version;
    }

    /** True when the running tmux is at least the given major.minor. */
    versionAtLeast(major: number, minor: number): boolean {
        if (!this._version) { return false; }
        return this._version.major > major ||
            (this._version.major === major && this._version.minor >= minor);
    }

    /**
     * Spawn tmux -CC inside a real PTY using node-pty (bundled with VS Code).
     * This gives tmux the tty it requires without any external dependency.
     */
    connect(options?: { startDirectory?: string }): Promise<void> {
        return new Promise((resolve, reject) => {
            const tmuxArgs = [
                '-CC',
                'new-session',
                '-A',           // attach to existing session if it exists
                '-s', this.sessionName,
                '-x', '220',    // initial width  (will be resized per pane)
                '-y', '50',     // initial height
            ];

            if (options?.startDirectory) {
                tmuxArgs.push('-c', options.startDirectory);
            }

            // node-pty is bundled with VS Code but not on the default
            // require path for extensions.  Resolve it from VS Code's app root.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const nodePty = require(path.join(this.appRoot, 'node_modules', 'node-pty')) as {
                spawn(
                    file: string,
                    args: string[],
                    options: { name?: string; cols?: number; rows?: number; cwd?: string; env?: Record<string, string> },
                ): IPty;
            };

            this.pty = nodePty.spawn(this.tmuxBinaryPath, tmuxArgs, {
                name: 'xterm-256color',
                cols: 220,
                rows: 50,
                cwd: process.cwd(),
                env: process.env as Record<string, string>,
            });

            this.pty.onData((data: string) => {
                this.ingest(data);
            });

            this.pty.onExit(({ exitCode }) => {
                this._connected = false;
                this.emit('tmux-exit', exitCode);
                for (const cmd of this.pendingQueue) {
                    cmd.reject(new Error('tmux process exited'));
                }
                this.pendingQueue = [];
                this.pty = null;
            });

            const onReady = () => {
                this._connected = true;
                resolve();
            };
            const onReadyError = (err: Error) => {
                this.removeListener('_ready', onReady);
                reject(err);
            };

            this.once('_ready', onReady);
            this.once('_ready-error', onReadyError);

            setTimeout(() => {
                if (!this.pty) {
                    this.emit('_ready-error', new Error('tmux process exited before handshake'));
                    return;
                }
                this.sendCommand('display-message -p "__tmux_integrated_ready__"')
                    .then((lines) => {
                        if (lines[0]?.trim() === '__tmux_integrated_ready__') {
                            this.emit('_ready');
                            return;
                        }
                        this.emit('_ready-error', new Error('Unexpected tmux readiness response'));
                    })
                    .catch((err) => {
                        this.emit('_ready-error', err instanceof Error ? err : new Error(String(err)));
                    });
            }, 50);

            const timer = setTimeout(() => {
                this.removeListener('_ready', onReady);
                this.removeListener('_ready-error', onReadyError);
                if (!this._connected) {
                    reject(new Error('Timed out waiting for tmux control mode handshake'));
                }
            }, 10_000);

            const clearReadyTimer = () => clearTimeout(timer);
            this.once('_ready', clearReadyTimer);
            this.once('_ready-error', clearReadyTimer);
        });
    }

    // -----------------------------------------------------------------------
    // Protocol parsing
    // -----------------------------------------------------------------------

    private ingest(raw: string): void {
        this.readBuffer += raw;

        let lineEnd = this.readBuffer.indexOf('\n');
        while (lineEnd !== -1) {
            const line = this.readBuffer.slice(0, lineEnd).replace(/\r$/u, '');
            this.readBuffer = this.readBuffer.slice(lineEnd + 1);
            this.parseLine(line);
            lineEnd = this.readBuffer.indexOf('\n');
        }
    }

    private parseLine(line: string): void {
        if (!line) { return; }

        // Strip DCS wrapper (\x1bP...l … \x1b\\) emitted when tmux detects a tty.
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
            } else if (!this._connected) {
                // The very first %end signals that tmux is ready.
                this.emit('_ready');
            }
            this.responseBuffer = [];
        } else if (line.startsWith('%error')) {
            this.inBlock = false;
            const cmd = this.pendingQueue.shift();
            if (cmd) {
                cmd.reject(new Error(this.responseBuffer.join('\n') || line));
            }
            this.responseBuffer = [];
        } else if (this.inBlock && line.startsWith('%')) {
            // tmux may emit asynchronous notifications while a command block
            // is in flight. These must still be processed as notifications
            // rather than being swallowed as command response text.
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
        } else if (line.startsWith('%pane-mode-changed ')) {
            this.emit('pane-mode-changed', line.slice('%pane-mode-changed '.length).trim());
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
        const match = /^%extended-output\s+(%\S+)\s+(\d+)\s+(?:.*?\s+)?:\s?(.*)$/u.exec(line);
        if (!match) {
            return;
        }

        const [, paneId, , encoded] = match;
        const data = this.decodePaneOutput(paneId, encoded);
        this.emit('output', { paneId, data } as TmuxPaneOutput);
    }

    // -----------------------------------------------------------------------
    // Commands
    // -----------------------------------------------------------------------

    /** Send a single-line tmux command and return the response lines. */
    sendCommand(command: string): Promise<string[]> {
        return new Promise((resolve, reject) => {
            if (!this.pty) {
                reject(new Error('Not connected to tmux'));
                return;
            }
            this.pendingQueue.push({ resolve, reject });
            this.pty.write(command + '\r');
        });
    }

    /** Create a new window in the current session. Returns its window and pane IDs. */
    async newWindow(options: {
        name?: string;
        startDirectory?: string;
        cols?: number;
        rows?: number;
        shell?: string;
        env?: Record<string, string>;
    } = {}): Promise<{ windowId: string; paneId: string; windowIndex: number }> {
        let cmd = 'new-window -P -F "#{window_id} #{pane_id} #{window_index}"';

        if (options.name) {
            cmd += ` -n ${shellescape(options.name)}`;
        }
        if (options.startDirectory) {
            cmd += ` -c ${shellescape(options.startDirectory)}`;
        }
        // Per-window environment via -e is intentionally disabled for
        // compatibility with older tmux versions. New windows inherit the
        // session environment set through updateEnvironment.
        void options.env;
        if (options.shell) {
            cmd += ` ${shellescape(options.shell)}`;
        }

        const result = await this.sendCommand(cmd);
        const parts = (result[0] ?? '').trim().split(' ');
        if (parts.length < 3 || !parts[0].startsWith('@') || !parts[1].startsWith('%')) {
            throw new Error(`Unexpected new-window response: ${result[0] ?? '(empty)'}`);
        }
        return { windowId: parts[0], paneId: parts[1], windowIndex: Number.parseInt(parts[2] ?? '0', 10) };
    }

    /** Return the pty path for a pane (e.g. /dev/pts/5). */
    async getPaneTty(paneId: string): Promise<string> {
        const res = await this.sendCommand(`display-message -t ${paneId} -p "#{pane_tty}"`);
        return (res[0] ?? '').trim();
    }

    async resizePane(paneId: string, cols: number, rows: number): Promise<void> {
        await this.sendCommand(`resize-pane -t ${paneId} -x ${cols} -y ${rows}`);
    }

    async resizeWindowForClient(cols: number, rows: number): Promise<void> {
        await this.sendCommand(`refresh-client -C ${cols}x${rows}`);
    }

    async killWindow(windowId: string): Promise<void> {
        await this.sendCommand(`kill-window -t ${windowId}`);
    }

    async listWindows(): Promise<TmuxWindow[]> {
        const res = await this.sendCommand(
            'list-windows -F "#{window_id}|#{window_index}|#{window_name}|#{pane_id}|#{window_active}"',
        );
        return res
            .filter((l) => l.trim())
            .map((l) => {
                const [id, indexStr, name, paneId, active] = l.split('|');
                return { id, index: Number.parseInt(indexStr ?? '0', 10), name, paneId, active: active?.trim() === '1' };
            });
    }

    async respawnPane(paneId: string, options: {
        startDirectory?: string;
        shell?: string;
        env?: Record<string, string>;
    } = {}): Promise<void> {
        let cmd = `respawn-pane -k -t ${paneId}`;

        if (options.startDirectory) {
            cmd += ` -c ${shellescape(options.startDirectory)}`;
        }
        // Per-pane respawn environment via -e is intentionally disabled for
        // compatibility with older tmux versions. Respawned panes inherit the
        // session environment set through updateEnvironment.
        void options.env;
        if (options.shell) {
            cmd += ` ${shellescape(options.shell)}`;
        }

        await this.sendCommand(cmd);
    }

    async capturePane(paneId: string, options: {
        includeEscapeSequences?: boolean;
        includePendingOnly?: boolean;
        alternateScreen?: boolean;
        startLine?: number | '-';
    } = {}): Promise<string> {
        let cmd = `capture-pane -p -t ${paneId}`;

        if (options.includeEscapeSequences) {
            cmd += ' -e';
        }
        if (options.includePendingOnly) {
            cmd += ' -P';
        }
        if (options.alternateScreen) {
            cmd += ' -a';
        }
        if (options.startLine !== undefined) {
            cmd += ` -S ${options.startLine}`;
        }

        const res = await this.sendCommand(cmd);
        // With node-pty, response lines are already proper UTF-8 strings.
        return res.join('\n');
    }

    async getPaneCursor(paneId: string): Promise<TmuxPaneCursor> {
        const res = await this.sendCommand(
            `display-message -p -t ${paneId} "#{cursor_x} #{cursor_y}"`,
        );
        const [xText, yText] = (res[0] ?? '').trim().split(/\s+/u);
        return {
            x: Number.parseInt(xText ?? '0', 10) || 0,
            y: Number.parseInt(yText ?? '0', 10) || 0,
        };
    }

    /**
     * Update environment variables in the session so that new windows inherit
     * them (e.g. VSCODE_IPC_HOOK_CLI for the `code` CLI command).
     *
     * Uses `-t` to scope changes to this session rather than `-g` (global),
     * which would leak variables into every tmux session on the machine.
     */
    async updateEnvironment(vars: Record<string, string>): Promise<void> {
        for (const [k, v] of Object.entries(vars)) {
            await this.sendCommand(
                `set-environment -t ${shellescape(this.sessionName)} ${shellescape(k)} ${shellescape(v)}`,
            );
        }
    }

    disconnect(): void {
        if (this.pty) {
            try { this.pty.write('detach\r'); } catch { /* ignore */ }
            this.pty.kill();
            this.pty = null;
        }
        this._connected = false;
        this.paneDecoders.clear();
    }

    isConnected(): boolean {
        return this._connected && this.pty !== null;
    }

    /** Remove the incremental UTF-8 decoder for a closed pane. */
    removePaneDecoder(paneId: string): void {
        this.paneDecoders.delete(paneId);
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
// Helpers
// ---------------------------------------------------------------------------

/** Decode data from a tmux %output or %extended-output notification. */
function decodeOutput(encoded: string): Buffer {
    const bytes: number[] = [];

    for (let index = 0; index < encoded.length; index++) {
        const char = encoded[index];
        if (char === '\\' && index + 3 < encoded.length) {
            const octal = encoded.slice(index + 1, index + 4);
            if (/^[0-7]{3}$/u.test(octal)) {
                bytes.push(parseInt(octal, 8));
                index += 3;
                continue;
            }
        }

        // Encode the character as UTF-8 bytes.  With node-pty, tmux may
        // pass printable multi-byte characters (e.g. Nerd Font glyphs)
        // un-escaped — Buffer.from handles them correctly, whereas the
        // old charCodeAt(0) approach only worked for single-byte chars.
        const buf = Buffer.from(char, 'utf8');
        for (const b of buf) {
            bytes.push(b);
        }
    }

    return Buffer.from(bytes);
}

/**
 * Minimal shell-escaping: wrap value in single quotes and escape any
 * single quotes inside it.  Safe for passing to tmux command strings.
 */
export function shellescape(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
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
