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
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';

export interface TmuxPaneOutput {
    paneId: string;
    data: string;
}

export interface TmuxWindow {
    id: string;
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
    private proc: ChildProcessWithoutNullStreams | null = null;
    private readBuffer = '';
    private responseBuffer: string[] = [];
    private inBlock = false;
    private pendingQueue: PendingCommand[] = [];
    private _connected = false;
    private readonly paneDecoders = new Map<string, StringDecoder>();

    constructor(
        private readonly sessionName: string,
        private readonly tmuxBinaryPath: string,
        private readonly pythonBinaryPath: string,
        private readonly ptyBridgePath: string,
    ) {
        super();
    }

    /** Spawn tmux -CC through a PTY bridge so tmux sees a real pseudo-terminal. */
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

            this.proc = spawn(this.pythonBinaryPath, [this.ptyBridgePath, this.tmuxBinaryPath, ...tmuxArgs], {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    TMUX_INTEGRATED_PTY_COLS: '220',
                    TMUX_INTEGRATED_PTY_ROWS: '50',
                },
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            this.proc.stdout.on('data', (chunk: Buffer) => {
                this.ingest(chunk.toString('latin1'));
            });

            this.proc.stderr.on('data', (chunk: Buffer) => {
                const data = chunk.toString('latin1');
                if (data.includes('%begin') || data.includes('%end') || data.includes('%output')) {
                    this.ingest(data);
                }
            });

            this.proc.on('error', (err) => {
                reject(new Error(`tmux spawn error: ${err.message}`));
            });

            this.proc.on('exit', (exitCode, signal) => {
                this._connected = false;
                this.emit('tmux-exit', exitCode, signal);
                for (const cmd of this.pendingQueue) {
                    cmd.reject(new Error('tmux process exited'));
                }
                this.pendingQueue = [];
                this.proc = null;
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
                if (!this.proc) {
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
        } else if (line.startsWith('%window-close ')) {
            const windowId = line.slice('%window-close '.length).trim().split(/\s+/u)[0];
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
            if (!this.proc) {
                reject(new Error('Not connected to tmux'));
                return;
            }
            this.pendingQueue.push({ resolve, reject });
            this.proc.stdin.write(command + '\r');
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
    } = {}): Promise<{ windowId: string; paneId: string }> {
        let cmd = 'new-window -P -F "#{window_id} #{pane_id}"';

        if (options.name) {
            cmd += ` -n ${shellescape(options.name)}`;
        }
        if (options.startDirectory) {
            cmd += ` -c ${shellescape(options.startDirectory)}`;
        }
        if (options.env) {
            for (const [k, v] of Object.entries(options.env)) {
                cmd += ` -e ${shellescape(`${k}=${v}`)}`;
            }
        }
        if (options.shell) {
            cmd += ` ${shellescape(options.shell)}`;
        }

        const result = await this.sendCommand(cmd);
        const parts = (result[0] ?? '').trim().split(' ');
        if (parts.length < 2 || !parts[0].startsWith('@') || !parts[1].startsWith('%')) {
            throw new Error(`Unexpected new-window response: ${result[0] ?? '(empty)'}`);
        }
        return { windowId: parts[0], paneId: parts[1] };
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
            'list-windows -F "#{window_id}|#{window_name}|#{pane_id}|#{window_active}"',
        );
        return res
            .filter((l) => l.trim())
            .map((l) => {
                const [id, name, paneId, active] = l.split('|');
                return { id, name, paneId, active: active?.trim() === '1' };
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
        if (options.env) {
            for (const [key, value] of Object.entries(options.env)) {
                cmd += ` -e ${shellescape(`${key}=${value}`)}`;
            }
        }
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
        // Command responses are ingested as latin1 (byte-transparent) for
        // binary-safe %output parsing.  Re-encode to UTF-8 for text results
        // so multi-byte characters (e.g. powerline glyphs) survive.
        return res.map(l => Buffer.from(l, 'latin1').toString('utf8')).join('\n');
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
     */
    async updateEnvironment(vars: Record<string, string>): Promise<void> {
        for (const [k, v] of Object.entries(vars)) {
            await this.sendCommand(`set-environment -g ${shellescape(k)} ${shellescape(v)}`);
        }
    }

    disconnect(): void {
        if (this.proc) {
            try { this.proc.stdin.write('detach\r'); } catch { /* ignore */ }
            this.proc.kill();
            this.proc = null;
        }
        this._connected = false;
        this.paneDecoders.clear();
    }

    isConnected(): boolean {
        return this._connected && this.proc !== null;
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

        bytes.push(char.charCodeAt(0));
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
