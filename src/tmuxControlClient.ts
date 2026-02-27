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
 * In %output lines newlines inside the data are encoded as the two-char
 * sequence \n, and literal backslashes as \\.
 */

import { EventEmitter } from 'events';
import { ChildProcess, spawn } from 'child_process';

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

interface PendingCommand {
    resolve: (lines: string[]) => void;
    reject: (err: Error) => void;
}

export class TmuxControlClient extends EventEmitter {
    private proc: ChildProcess | null = null;
    private readBuffer = '';
    private responseBuffer: string[] = [];
    private inBlock = false;
    private pendingQueue: PendingCommand[] = [];
    private _connected = false;

    constructor(private readonly sessionName: string) {
        super();
    }

    /** Spawn `tmux -CC new-session -A -s <name>` and wait for the first %end. */
    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const args = [
                '-CC',          // control mode
                'new-session',
                '-A',           // attach to existing session if it exists
                '-s', this.sessionName,
                '-x', '220',    // initial width  (will be resized per pane)
                '-y', '50',     // initial height
            ];

            this.proc = spawn('tmux', args, {
                env: { ...process.env },
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            this.proc.stdout!.on('data', (chunk: Buffer) => {
                this.ingest(chunk.toString('binary'));
            });

            // Some tmux builds write the initial block to stderr.
            this.proc.stderr!.on('data', (chunk: Buffer) => {
                const s = chunk.toString('binary');
                if (s.includes('%begin') || s.includes('%end') || s.includes('%output')) {
                    this.ingest(s);
                }
            });

            this.proc.on('error', (err) => {
                reject(new Error(`tmux spawn error: ${err.message}`));
            });

            this.proc.on('exit', (code, signal) => {
                this._connected = false;
                this.emit('tmux-exit', code, signal);
                for (const cmd of this.pendingQueue) {
                    cmd.reject(new Error('tmux process exited'));
                }
                this.pendingQueue = [];
            });

            const onReady = () => {
                this._connected = true;
                resolve();
            };
            this.once('_ready', onReady);

            const timer = setTimeout(() => {
                this.removeListener('_ready', onReady);
                if (!this._connected) {
                    reject(new Error('Timed out waiting for tmux control mode handshake'));
                }
            }, 10_000);

            this.once('_ready', () => clearTimeout(timer));
        });
    }

    // -----------------------------------------------------------------------
    // Protocol parsing
    // -----------------------------------------------------------------------

    private ingest(raw: string): void {
        this.readBuffer += raw;
        // Process all complete lines, keep the last incomplete fragment.
        const lastNL = this.readBuffer.lastIndexOf('\n');
        if (lastNL === -1) { return; }

        const complete = this.readBuffer.slice(0, lastNL);
        this.readBuffer = this.readBuffer.slice(lastNL + 1);

        for (const line of complete.split('\n')) {
            this.parseLine(line);
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
        } else if (this.inBlock) {
            this.responseBuffer.push(line);
        } else {
            this.parseNotification(line);
        }
    }

    private parseNotification(line: string): void {
        if (line.startsWith('%output ')) {
            // "%output %<id> <escaped-data>"
            const rest = line.slice('%output '.length);
            const sp = rest.indexOf(' ');
            if (sp !== -1) {
                const paneId = rest.slice(0, sp);
                const encoded = rest.slice(sp + 1);
                const data = decodeOutput(encoded);
                this.emit('output', { paneId, data } as TmuxPaneOutput);
            }
        } else if (line.startsWith('%window-add ')) {
            this.emit('window-add', line.slice('%window-add '.length).trim());
        } else if (line.startsWith('%window-close ')) {
            this.emit('window-close', line.slice('%window-close '.length).trim());
        } else if (line.startsWith('%exit')) {
            this.emit('tmux-exit');
        }
        // Other notifications (%sessions-changed, %layout-change, etc.) are
        // intentionally ignored for now.
    }

    // -----------------------------------------------------------------------
    // Commands
    // -----------------------------------------------------------------------

    /** Send a single-line tmux command and return the response lines. */
    sendCommand(command: string): Promise<string[]> {
        return new Promise((resolve, reject) => {
            if (!this.proc?.stdin?.writable) {
                reject(new Error('Not connected to tmux'));
                return;
            }
            this.pendingQueue.push({ resolve, reject });
            this.proc.stdin.write(command + '\n');
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
            try { this.proc.stdin?.write('detach\n'); } catch { /* ignore */ }
            this.proc.kill();
            this.proc = null;
        }
        this._connected = false;
    }

    isConnected(): boolean {
        return this._connected && this.proc !== null;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Decode data from a tmux %output notification.
 * tmux escapes \n → \\n and \\ → \\\\ before writing the line.
 * We reverse that here.
 */
function decodeOutput(encoded: string): string {
    // Replace \n (2 chars: backslash + n) with a real newline,
    // and \\ (2 chars: double backslash) with a single backslash.
    // The regex handles both in a single pass so order is not an issue.
    return encoded.replace(/\\(n|\\)/g, (_, c: string) => (c === 'n' ? '\n' : '\\'));
}

/**
 * Minimal shell-escaping: wrap value in single quotes and escape any
 * single quotes inside it.  Safe for passing to tmux command strings.
 */
function shellescape(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
