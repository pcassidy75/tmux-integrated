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
 *       %session-changed $<id> <name>
 *       %exit [reason]
 *   • Command responses are wrapped in a begin/end block:
 *       %begin <time> <num> 0
 *       [optional response lines]
 *       %end <time> <num> 0   |   %error <time> <num> 0
 *
 * Architecture (Phase 1 refactor):
 *   TmuxGateway      — protocol parsing, %begin/%end handling, command queuing,
 *                      command flags (TolerateErrors), command batching, write
 *                      queuing (defers writes until %session-changed).
 *   TmuxControlClient — PTY lifecycle, high-level typed commands (newWindow,
 *                       listWindows, …), version gating.
 */

import { EventEmitter } from 'events';
import * as path from 'path';

import { TmuxGateway, CommandFlags } from './tmuxGateway';
import { tmuxAutomaticRenameIsOn } from './windowTitle';

export type { TmuxPaneOutput, TmuxLayoutChange, TmuxWindowPaneChange } from './tmuxGateway';
export { CommandFlags } from './tmuxGateway';

/**
 * Minimal interface for the node-pty `IPty` object.  We load node-pty at
 * runtime from VS Code's bundled copy, so we only declare the subset we use.
 */
interface IPty {
    onData: (callback: (data: string) => void) => { dispose(): void };
    onExit: (callback: (ev: { exitCode: number; signal?: number }) => void) => { dispose(): void };
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    pid: number;
}

export interface TmuxWindow {
    id: string;
    index: number;
    name: string;
    paneId: string;
    active: boolean;
    /** From `#{automatic-rename}` — when true, tmux (not the user) owns the title. */
    automaticRename: boolean;
}

export interface TmuxPaneCursor {
    x: number;
    y: number;
}

export class TmuxControlClient extends EventEmitter {
    private pty: IPty | null = null;
    private gateway: TmuxGateway | null = null;
    private _connected = false;
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
     * Locate VS Code's bundled node-pty.  The exact path varies between local
     * and remote (SSH / WSL / tunnel) installs and across VS Code versions:
     *   • node_modules/node-pty              — older, local installs
     *   • node_modules.asar.unpacked/node-pty — native modules extracted from asar
     *   • node_modules/@vscode/node-pty       — scoped package in recent builds
     *   • node_modules.asar.unpacked/@vscode/node-pty
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private requireNodePty(): any {
        const candidates = [
            path.join(this.appRoot, 'node_modules', 'node-pty'),
            path.join(this.appRoot, 'node_modules.asar.unpacked', 'node-pty'),
            path.join(this.appRoot, 'node_modules', '@vscode', 'node-pty'),
            path.join(this.appRoot, 'node_modules.asar.unpacked', '@vscode', 'node-pty'),
        ];

        for (const candidate of candidates) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                return require(candidate);
            } catch {
                // Try the next candidate.
            }
        }

        throw new Error(
            `node-pty not found in VS Code installation (appRoot: ${this.appRoot}). ` +
            `Searched: ${candidates.join(', ')}`,
        );
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

            const nodePty = this.requireNodePty() as {
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
                cwd: options?.startDirectory || process.env.HOME || process.cwd(),
                env: process.env as Record<string, string>,
            });

            // Create a fresh gateway for this connection.
            const gw = new TmuxGateway();
            this.gateway = gw;

            // Wire the PTY write function into the gateway.
            gw.setWriter((data) => this.pty?.write(data));

            // Forward all gateway events to this client so external listeners
            // (TmuxTerminalProvider, extension.ts) continue to work unchanged.
            const forwardedEvents = [
                'output',
                'window-add',
                'window-close',
                'window-renamed',
                'layout-change',
                'window-pane-changed',
                'session-window-changed',
                'session-renamed',
                'sessions-changed',
                'session-changed',
                'pane-mode-changed',
                'paste-buffer-changed',
                'pause',
                'continue',
                'message',
                'tmux-exit',
                '_initial-handshake',
            ] as const;

            for (const ev of forwardedEvents) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                gw.on(ev, (...args: any[]) => this.emit(ev, ...args));
            }

            // Feed PTY output into the gateway.
            this.pty.onData((data: string) => {
                gw.ingest(data);
            });

            // On PTY exit, drain pending commands and signal disconnection.
            this.pty.onExit(({ exitCode }) => {
                this._connected = false;
                gw.drainOnExit();
                this.emit('tmux-exit', exitCode);
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

            // After the initial %begin/%end handshake the gateway emits
            // '_initial-handshake'.  Only then do we send the readiness probe
            // so that it is the very first command in the write queue and is
            // flushed (along with any other queued commands) once
            // %session-changed arrives.
            this.once('_initial-handshake', () => {
                gw.sendCommand('display-message -p "__tmux_integrated_ready__"')
                    .then((lines) => {
                        if (lines[0]?.trim() === '__tmux_integrated_ready__') {
                            this.emit('_ready');
                            return;
                        }
                        this.emit('_ready-error', new Error(
                            `Unexpected tmux readiness response: ${JSON.stringify(lines)}`,
                        ));
                    })
                    .catch((err) => {
                        this.emit('_ready-error', err instanceof Error ? err : new Error(String(err)));
                    });
            });

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
    // Commands
    // -----------------------------------------------------------------------

    /**
     * Send a single tmux command and return the response lines.
     *
     * Delegates to TmuxGateway, which queues the write if the session is not
     * yet ready and supports the TolerateErrors flag.
     */
    sendCommand(command: string, flags: number = CommandFlags.None): Promise<string[]> {
        if (!this.gateway) {
            return Promise.reject(new Error('Not connected to tmux'));
        }
        return this.gateway.sendCommand(command, flags);
    }

    /**
     * Send multiple tmux commands as a single batched write.
     *
     * Commands are joined with ' ; ' and sent as one line.  tmux generates
     * one %begin/%end response pair per command.  Use this for atomic
     * multi-step operations (e.g. resize + list-windows) to reduce PTY
     * round-trips.
     *
     * Returns a Promise that resolves to an array of response-line arrays,
     * one per input command.
     */
    sendCommandList(commands: string[], flags: number = CommandFlags.None): Promise<string[][]> {
        if (!this.gateway) {
            return Promise.reject(new Error('Not connected to tmux'));
        }
        return this.gateway.sendCommandList(commands, flags);
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

    /** Current tmux window name (e.g. after automatic-rename or manual rename). */
    async getWindowName(windowId: string): Promise<string> {
        const res = await this.sendCommand(`display-message -t ${windowId} -p "#{window_name}"`);
        return (res[0] ?? '').trim();
    }

    /** Whether tmux is auto-renaming this window (`#{automatic-rename}`). Query before turning the option off. */
    async getWindowAutomaticRename(windowId: string): Promise<boolean> {
        const res = await this.sendCommand(`display-message -t ${windowId} -p "#{automatic-rename}"`);
        return tmuxAutomaticRenameIsOn(res[0]);
    }

    /** Zero-based window index (`#{window_index}`) for a window target. */
    async getWindowIndex(windowId: string): Promise<number> {
        const res = await this.sendCommand(`display-message -t ${windowId} -p "#{window_index}"`);
        return Number.parseInt((res[0] ?? '').trim(), 10);
    }

    /** Return the pty path for a pane (e.g. /dev/pts/5). */
    async getPaneTty(paneId: string): Promise<string> {
        const res = await this.sendCommand(`display-message -t ${paneId} -p "#{pane_tty}"`);
        return (res[0] ?? '').trim();
    }

    async resizePane(paneId: string, cols: number, rows: number): Promise<void> {
        await this.sendCommand(`resize-pane -t ${paneId} -x ${cols} -y ${rows}`);
    }

    /**
     * Resize the tmux client to match the VS Code terminal dimensions.
     *
     * Uses only `refresh-client -C` (available since tmux 2.1) to set the
     * control-mode client size.  The underlying control-channel PTY is kept
     * at its initial large size (220 cols) so that tmux protocol lines
     * (which can be very long for complex zsh prompts) are never affected
     * by PTY output processing.
     *
     * iTerm2 similarly relies on `refresh-client -C` for sizing without
     * resizing the control channel PTY to match each pane.
     */
    async resizeWindowForClient(cols: number, rows: number): Promise<void> {
        // refresh-client -C sets the control-mode client size.  Available
        // since tmux 2.1; tolerates errors on truly ancient builds.
        await this.sendCommand(
            `refresh-client -C ${cols},${rows}`,
            CommandFlags.TolerateErrors,
        );
    }

    async killWindow(windowId: string): Promise<void> {
        await this.sendCommand(`kill-window -t ${windowId}`);
    }

    async listWindows(): Promise<TmuxWindow[]> {
        const res = await this.sendCommand(
            'list-windows -F "#{window_id}|#{window_index}|#{window_name}|#{pane_id}|#{window_active}|#{automatic-rename}"',
        );
        return res
            .filter((l) => l.trim())
            .map((l) => {
                const parts = l.split('|');
                const [id, indexStr, name, paneId, active] = parts;
                const autoField = parts[5];
                return {
                    id,
                    index: Number.parseInt(indexStr ?? '0', 10),
                    name,
                    paneId,
                    active: active?.trim() === '1',
                    automaticRename: parts.length >= 6 ? tmuxAutomaticRenameIsOn(autoField) : true,
                };
            })
            .filter((w) => Boolean(w.id?.startsWith('@')));
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
        // compatibility with older tmux versions.
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
     *
     * All set-environment calls are batched into a single PTY write.
     */
    async updateEnvironment(vars: Record<string, string>): Promise<void> {
        const commands = Object.entries(vars).map(
            ([k, v]) =>
                `set-environment -t ${shellescape(this.sessionName)} ${shellescape(k)} ${shellescape(v)}`,
        );
        if (commands.length > 0) {
            await this.sendCommandList(commands, CommandFlags.TolerateErrors);
        }
    }

    disconnect(): void {
        if (this.pty) {
            try { this.pty.write('detach\r'); } catch { /* ignore */ }
            this.pty.kill();
            this.pty = null;
        }
        this._connected = false;
        this.gateway = null;
    }

    isConnected(): boolean {
        return this._connected && this.pty !== null;
    }

    /** Remove the incremental UTF-8 decoder for a closed pane. */
    removePaneDecoder(paneId: string): void {
        this.gateway?.removePaneDecoder(paneId);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal shell-escaping: wrap value in single quotes and escape any
 * single quotes inside it.  Safe for passing to tmux command strings.
 */
export function shellescape(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
