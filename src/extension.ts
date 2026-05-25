/**
 * Extension entry point for tmux-integrated.
 *
 * On activation the extension:
 *   1. Verifies that tmux ≥ 2.0 is installed.
 *   2. Connects to a per-workspace tmux session using control mode (-CC).
 *   3. Updates the session environment with the current VS Code IPC variables
 *      so that `code <file>` works in new tmux windows.
 *   4. Registers a "tmux" terminal profile and two commands.
 *
 * Each VS Code terminal tab maps 1:1 to a tmux window (like iTerm2's tmux
 * integration).  Closing a tab kills the corresponding window.  When VS Code
 * exits, the session persists so windows can be re-adopted on next launch.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { TmuxControlClient, CommandFlags } from './tmuxControlClient';
import { TmuxTerminal } from './tmuxTerminalProvider';

interface AttachWindowItem extends vscode.QuickPickItem {
    windowId: string;
    paneId: string;
    windowIndex: number;
    name: string;
    automaticRename: boolean;
}

let client: TmuxControlClient | null = null;
let statusBar: vscode.StatusBarItem | null = null;
let outputChannel: vscode.OutputChannel | null = null;
let tmuxVersion: string | null = null;
let currentSessionName = 'vscode';
let tmuxBinaryPath: string | null = null;
let extensionRootPath = process.cwd();
let defaultStartDirectory = process.cwd();
interface AdoptableWindow {
    windowId: string;
    paneId: string;
    windowIndex: number;
    name?: string;
    automaticRename?: boolean;
}
let bootstrapWindow: AdoptableWindow | null = null;
let windowsToAdopt: AdoptableWindow[] = [];
let disposing = false;
/**
 * In-flight ensureClientConnected promise.
 *
 * Multiple call-sites (autoConnect on activation, provideTerminalProfile on
 * VS Code restoring tabs, the user opening a terminal) can race to connect
 * during a high-latency reattach. Without serialisation a second caller
 * would see _connected=false (the handshake has not finished) and execute
 * `client = new TmuxControlClient(...)`, orphaning the in-flight PTY and
 * spawning a duplicate tmux process. Memoising the promise makes every
 * concurrent caller wait for the same attempt.
 */
let inFlightConnect: Promise<boolean> | null = null;
const attachedWindowIds = new Set<string>();
const terminalPtyByTerminal = new Map<vscode.Terminal, TmuxTerminal>();
const pendingTerminalPtys: TmuxTerminal[] = [];
let activeTmuxWindowId: string | null = null;
let pendingUserTerminalFocus: boolean = false;

// ---------------------------------------------------------------------------
// Activation / deactivation
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    outputChannel = vscode.window.createOutputChannel('tmux-integrated');
    context.subscriptions.push(outputChannel);

    extensionRootPath = context.extensionPath;
    defaultStartDirectory = resolveStartDirectory(context.extensionPath);
    currentSessionName = resolveSessionName();

    log(`Activating: extensionPath=${extensionRootPath}, appRoot=${vscode.env.appRoot}, startDir=${defaultStartDirectory}`);

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'tmux-integrated.attachWindow';
    statusBar.show();
    context.subscriptions.push(statusBar);
    setStatus('$(terminal) tmux-integrated: idle', 'Connects when you open or attach a tmux terminal');

    registerTerminalRenameSync(context);
    registerTerminalProfile(context);
    registerCommands(context);

    // --- Clean up when the extension host shuts down ----------------------
    // Note: we do NOT disconnect from tmux — we want sessions to outlive VS Code.
    context.subscriptions.push({
        dispose: () => {
            disposing = true;
            terminalPtyByTerminal.clear();
            pendingTerminalPtys.length = 0;
            activeTmuxWindowId = null;
            inFlightConnect = null;
            client?.disconnect();
            client = null;
        },
    });

    // --- Auto-connect to existing tmux session on workspace open ----------
    const cfg = vscode.workspace.getConfiguration('tmux-integrated');
    if (cfg.get<boolean>('autoConnect', true)) {
        const sessionName = resolveSessionName();
        const tmuxPath = resolveTmuxBinaryPathSafe();
        if (tmuxPath && tmuxSessionExists(tmuxPath, sessionName)) {
            autoConnectExistingSession();
        }
    }
}

export function deactivate(): void {
    disposing = true;
    terminalPtyByTerminal.clear();
    pendingTerminalPtys.length = 0;
    activeTmuxWindowId = null;
    inFlightConnect = null;
    client?.disconnect();
    client = null;
}

function registerTerminalRenameSync(context: vscode.ExtensionContext): void {
    const trackTerminal = (terminal: vscode.Terminal): TmuxTerminal | null => {
        let pty = terminalPtyByTerminal.get(terminal) ?? getTmuxPtyFromTerminal(terminal);
        if (!pty && looksLikeTmuxTerminal(terminal)) {
            pty = takeNextPendingTerminalPty();
        }
        if (!pty) {
            return null;
        }

        terminalPtyByTerminal.set(terminal, pty);
        // Detect built-in "Rename…" the instant the user types in this terminal.
        pty.setOnInputCallback(() => {
            const lastEmitted = pty!.getLastEmittedName();
            if (lastEmitted !== null && terminal.name !== lastEmitted) {
                void pty!.syncNameToTmux(terminal.name);
            }
        });
        return pty;
    };

    const untrackTerminal = (terminal: vscode.Terminal): void => {
        terminalPtyByTerminal.delete(terminal);
    };

    const syncActiveTerminalToTmuxWindow = async (terminal: vscode.Terminal | undefined): Promise<void> => {
        if (!terminal || !client?.isConnected()) {
            return;
        }

        const pty = trackTerminal(terminal);
        if (!pty) {
            return;
        }

        const windowId = pty.getAttachedTmuxWindowId();
        if (!windowId || windowId === activeTmuxWindowId) {
            return;
        }

        await client.sendCommand(`select-window -t ${windowId}`, CommandFlags.TolerateErrors).catch((err) => {
            log(`window sync warning (non-fatal): ${err}`);
        });
    };

    // Track already-open terminals on reload before listening for new ones.
    for (const terminal of vscode.window.terminals) {
        trackTerminal(terminal);
    }

    context.subscriptions.push(
        vscode.window.onDidOpenTerminal((terminal) => {
            trackTerminal(terminal);
            // VS Code may not focus terminal when it is opened
            if(pendingUserTerminalFocus && looksLikeTmuxTerminal(terminal)) {
                terminal.show();
                pendingUserTerminalFocus = false;
            }
        }),
        vscode.window.onDidCloseTerminal(untrackTerminal),
        vscode.window.onDidChangeActiveTerminal((terminal) => {
            void syncActiveTerminalToTmuxWindow(terminal);
        }),
    );
}

function getTmuxPtyFromTerminal(terminal: vscode.Terminal): TmuxTerminal | null {
    const options = terminal.creationOptions as vscode.TerminalOptions | vscode.ExtensionTerminalOptions;
    if (!options || !('pty' in options)) {
        return null;
    }
    const pty = (options as vscode.ExtensionTerminalOptions).pty;
    return pty instanceof TmuxTerminal ? pty : null;
}

function looksLikeTmuxTerminal(terminal: vscode.Terminal): boolean {
    return terminal.name === 'tmux' || terminal.name.startsWith('tmux:');
}

function registerPendingTerminalPty(pty: TmuxTerminal): void {
    pendingTerminalPtys.push(pty);
}

function takeNextPendingTerminalPty(): TmuxTerminal | null {
    while (pendingTerminalPtys.length > 0) {
        const candidate = pendingTerminalPtys.shift()!;
        if (![...terminalPtyByTerminal.values()].includes(candidate)) {
            return candidate;
        }
    }
    return null;
}

function registerTerminalProfile(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.window.registerTerminalProfileProvider('tmux-integrated.terminal', {
            async provideTerminalProfile(): Promise<vscode.TerminalProfile> {
                try {
                    log('provideTerminalProfile called');
                    pendingUserTerminalFocus = true;
                    const connected = await ensureClientConnected();
                    if (!connected) {
                        throw new Error('tmux-integrated: Could not connect to tmux. See Output > tmux-integrated for details.');
                    }

                // Reuse the bootstrap window from a freshly-created session.
                const bootstrap = takeBootstrapWindow();
                if (bootstrap) {
                    log(`provideTerminalProfile: using bootstrap window ${bootstrap.windowId}`);
                    return buildTerminalProfile(bootstrap);
                }

                // On reconnection, adopt one pre-existing window for this tab
                // and schedule the rest to appear as additional tabs.
                const adopted = adoptNextWindow();
                if (adopted) {
                    log(`provideTerminalProfile: adopting window ${adopted.windowId}`);
                    return buildTerminalProfile(adopted);
                }

                // Already connected and everything adopted — create a new window.
                log('provideTerminalProfile: creating new terminal (no bootstrap/adopt)');
                return buildTerminalProfile();
                } catch (err) {
                    pendingUserTerminalFocus = false;
                    log(`provideTerminalProfile error: ${err}`);
                    throw err;
                }
            },
        }),
    );
}

function registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('tmux-integrated.newTerminal', async () => {
            const connected = await ensureClientConnected();
            if (!connected) { return; }
            const terminal = vscode.window.createTerminal(
                buildTerminalOptions(),
            );
            terminal.show();
        }),

        vscode.commands.registerCommand('tmux-integrated.attachWindow', async () => {
            const connected = await ensureClientConnected();
            if (!connected) { return; }
            await showAttachWindowPicker(currentSessionName);
        }),

        vscode.commands.registerCommand('tmux-integrated.renameTerminal', async () => {
            const terminal = vscode.window.activeTerminal;
            if (!terminal) { return; }
            const pty = terminalPtyByTerminal.get(terminal) ?? getTmuxPtyFromTerminal(terminal);
            if (!pty) {
                vscode.window.showWarningMessage('tmux-integrated: active terminal is not a tmux window.');
                return;
            }
            const newName = await vscode.window.showInputBox({
                prompt: 'New tmux window / VS Code tab name',
                value: terminal.name,
                validateInput: (v) => v.trim() ? null : 'Name cannot be empty',
            });
            if (newName === undefined) { return; }
            await pty.renameWindow(newName);
        }),
    );
}

async function ensureClientConnected(): Promise<boolean> {
    if (inFlightConnect) {
        return inFlightConnect;
    }
    inFlightConnect = ensureClientConnectedImpl();
    try {
        return await inFlightConnect;
    } finally {
        inFlightConnect = null;
    }
}

async function ensureClientConnectedImpl(): Promise<boolean> {
    if (client?.isConnected()) {
        // Verify the control-mode connection is actually alive.
        try {
            const probe = await Promise.race([
                client.sendCommand('display-message -p "__ping__"'),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('health-check timeout')), 5_000),
                ),
            ]);
            if (probe[0]?.trim() === '__ping__') {
                return true;
            }
            log(`Health check unexpected response: ${JSON.stringify(probe)}`);
        } catch (err) {
            log(`Health check failed (${err}), reconnecting…`);
        }
        // Connection is stale — tear it down and reconnect below.
        client.disconnect();
        client = null;
    }

    setStatus('$(sync~spin) tmux-integrated: connecting…');

    // --- Check tmux is available ------------------------------------------
    try {
        tmuxBinaryPath = resolveTmuxBinaryPath();
        tmuxVersion = execFileSync(tmuxBinaryPath, ['-V'], { encoding: 'utf8' }).trim();
        log(`tmux found: ${tmuxBinaryPath} (${tmuxVersion})`);
    } catch (err) {
        log(`tmux not found: ${err}`);
        setStatus('$(error) tmux-integrated: dependency missing');
        const choice = await vscode.window.showErrorMessage(
            'tmux-integrated: tmux is not installed or not in PATH. You can set an absolute path via the tmux-integrated.tmuxPath settings.',
            'Show tmux install instructions',
            'Open Settings',
        );
        if (choice === 'Show tmux install instructions') {
            vscode.env.openExternal(
                vscode.Uri.parse('https://github.com/tmux/tmux/wiki/Installing'),
            );
        } else if (choice === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'tmux-integrated.tmuxPath');
        }
        return false;
    }

    // --- Determine session name and connect ---------------------------------
    currentSessionName = resolveSessionName();
    const sessionAlreadyExists = tmuxSessionExists(tmuxBinaryPath!, currentSessionName);
    log(`Connecting to session "${currentSessionName}" (exists=${sessionAlreadyExists}, appRoot=${vscode.env.appRoot})`);
    client = new TmuxControlClient(
        currentSessionName,
        tmuxBinaryPath!,
        vscode.env.appRoot,
    );

    // Feed the version string so the client can gate features accordingly
    // (e.g. the -e flag on new-window requires tmux ≥ 3.0).
    client.setVersion(tmuxVersion!);

    if (!client.versionAtLeast(2, 1)) {
        setStatus('$(warning) tmux-integrated: unsupported version');
        vscode.window.showWarningMessage(
            `tmux-integrated: tmux ${tmuxVersion} may not work correctly. Version 2.1 or later is recommended.`,
        );
    }

    client.on('tmux-exit', () => setStatus('$(error) tmux-integrated: disconnected'));
    client.on('session-window-changed', (ev: { sessionId: string; windowId: string } | null) => {
        if (ev?.windowId) {
            activeTmuxWindowId = ev.windowId;
        }
    });

    try {
        await client.connect({ startDirectory: defaultStartDirectory });
        log('Connected to tmux successfully');
    } catch (err) {
        log(`Connection failed: ${err}`);
        setStatus('$(error) tmux-integrated: failed');
        vscode.window.showErrorMessage(`tmux-integrated: Could not connect to tmux: ${err}`);
        return false;
    }

    bootstrapWindow = null;
    windowsToAdopt = [];
    if (!sessionAlreadyExists) {
        try {
            const windows = await client.listWindows();
            log(`New session — found ${windows.length} bootstrap window(s)`);
            if (windows.length === 1) {
                bootstrapWindow = {
                    windowId: windows[0].id,
                    paneId: windows[0].paneId,
                    windowIndex: windows[0].index,
                    name: windows[0].name,
                    // In a new session always set the name
                    automaticRename: true,
                };
            }
        } catch (err) {
            log(`bootstrap window lookup failed: ${err}`);
        }
    } else {
        try {
            const windows = await client.listWindows();
            log(`Existing session — found ${windows.length} window(s) to adopt`);
            // Carry name + automaticRename through so TmuxTerminal.open()
            // does not need fresh round-trips on a high-latency link.
            windowsToAdopt = windows.map(w => ({
                windowId: w.id,
                paneId: w.paneId,
                windowIndex: w.index,
                name: w.name,
                automaticRename: w.automaticRename,
            }));
        } catch (err) {
            log(`window enumeration failed: ${err}`);
        }
    }
    setStatus(`$(terminal) tmux-integrated: ${currentSessionName}`, tmuxVersion);

    // Tell tmux to use xterm-256color inside panes so that programs (less,
    // vim, etc.) query the same terminfo as a normal VS Code terminal.  The
    // default (screen-256color / tmux-256color) advertises a different
    // capability set that can cause subtle rendering differences.
    await client.sendCommand(
        'set-option -s default-terminal xterm-256color',
        CommandFlags.TolerateErrors,
    ).catch(() => {});

    // Push the current VS Code IPC variables into the session environment so
    // that `code <file>` and git credential helpers work in tmux windows.
    const envSnapshot = collectVscodeEnvVars();
    if (Object.keys(envSnapshot).length) {
        await client.updateEnvironment(envSnapshot).catch(
            (err) => console.error(`tmux-integrated: set-environment error: ${err}`),
        );
    }
    return true;
}

// ---------------------------------------------------------------------------
// Helpers — terminal creation
// ---------------------------------------------------------------------------

function buildTerminalOptions(
    existingWindow?: AdoptableWindow,
): vscode.ExtensionTerminalOptions {
    const cfg = vscode.workspace.getConfiguration('tmux-integrated');
    const shell = (cfg.get<string>('shell') || process.env.SHELL || '/bin/bash') || undefined;

    const pty = new TmuxTerminal(
        client!,
        defaultStartDirectory,
        collectVscodeEnvVars(),
        shell || undefined,
        existingWindow,
        {
            onWindowAttached: (windowId) => {
                attachedWindowIds.add(windowId);
            },
            onWindowDetached: (windowId) => {
                attachedWindowIds.delete(windowId);
            },
        },
        () => disposing,
        log,
    );
    registerPendingTerminalPty(pty);

    return {
        name: existingWindow?.windowIndex !== undefined ? `tmux:${existingWindow.windowIndex}` : 'tmux',
        pty,
    };
}

function buildTerminalProfile(
    existingWindow?: AdoptableWindow,
): vscode.TerminalProfile {
    return new vscode.TerminalProfile(buildTerminalOptions(existingWindow));
}

function takeBootstrapWindow(): AdoptableWindow | undefined {
    const bw = bootstrapWindow;
    bootstrapWindow = null;
    return bw ?? undefined;
}

/**
 * Pop one pre-existing window off the adoption queue, skipping any entries
 * already claimed by a concurrent caller.
 *
 * Each call hands back a single window so that N concurrent
 * provideTerminalProfile invocations (e.g. when VS Code restores N tabs at
 * once on a Remote-SSH reconnect) each adopt one window instead of the
 * first call clearing the tail and forcing the rest into "create a fresh
 * tmux window" fallback. autoConnectExistingSession() mops up whatever is
 * left after a short grace period.
 */
function adoptNextWindow(): AdoptableWindow | undefined {
    while (windowsToAdopt.length > 0) {
        const next = windowsToAdopt.shift()!;
        if (!attachedWindowIds.has(next.windowId)) {
            return next;
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Helpers — attach window picker
// ---------------------------------------------------------------------------

async function showAttachWindowPicker(sessionName: string): Promise<void> {
    let windows;
    try {
        windows = await client!.listWindows();
    } catch (err) {
        vscode.window.showErrorMessage(`tmux-integrated: Failed to list tmux windows: ${err}`);
        return;
    }

    const unattached = windows.filter(w => !attachedWindowIds.has(w.id));
    if (!unattached.length) {
        vscode.window.showInformationMessage(
            windows.length
                ? 'tmux-integrated: All windows are already open in VS Code tabs.'
                : `tmux-integrated: No windows found in session "${sessionName}".`,
        );
        return;
    }

    const items: AttachWindowItem[] = unattached.map((w) => ({
        label: `$(terminal) ${w.name}`,
        description: w.active ? '(active)' : '',
        detail: `Window ${w.id} • Active pane ${w.paneId}`,
        windowId: w.id,
        paneId: w.paneId,
        windowIndex: w.index,
        name: w.name,
        automaticRename: w.automaticRename,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a tmux window to open in VS Code',
        title: `tmux-integrated session: ${sessionName}`,
    });

    if (picked) {
        const terminal = vscode.window.createTerminal(buildTerminalOptions({
            windowId: picked.windowId,
            paneId: picked.paneId,
            windowIndex: picked.windowIndex,
            name: picked.name,
            automaticRename: picked.automaticRename,
        }));
        terminal.show();
    }
}

// ---------------------------------------------------------------------------
// Helpers — misc
// ---------------------------------------------------------------------------

function setStatus(text: string, tooltip?: string): void {
    if (!statusBar) { return; }
    statusBar.text = text;
    if (tooltip) { statusBar.tooltip = tooltip; }
}

/**
 * Derive a deterministic tmux session name from the workspace folder or the
 * setting override.  tmux session names may not contain periods or colons.
 */
function resolveSessionName(): string {
    const cfg = vscode.workspace.getConfiguration('tmux-integrated');
    const override = cfg.get<string>('sessionName');
    if (override) { return sanitizeName(override); }

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
        return sanitizeName(path.basename(folder.uri.fsPath)) || 'vscode';
    }
    return sanitizeName(path.basename(defaultStartDirectory)) || 'vscode';
}

function resolveStartDirectory(extensionPath: string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // 1. tmux-integrated.cwd
    const cfg = vscode.workspace.getConfiguration('tmux-integrated');
    const cwdSetting = cfg.get<string>('cwd');
    if (cwdSetting) {
        return resolveVariables(cwdSetting, workspaceFolder, extensionPath);
    }

    // 2. terminal.integrated.cwd
    const termCwd = vscode.workspace.getConfiguration('terminal.integrated').get<string>('cwd');
    if (termCwd) {
        return resolveVariables(termCwd, workspaceFolder, extensionPath);
    }

    // 3. Workspace folder
    return workspaceFolder || extensionPath;
}

/**
 * Resolve common VS Code predefined variables in a string value.
 * See https://code.visualstudio.com/docs/editor/variables-reference
 */
function resolveVariables(value: string, workspaceFolder: string | undefined, fallbackDir: string): string {
    const vars: Record<string, string | undefined> = {
        workspaceFolder,
        workspaceFolderBasename: workspaceFolder ? path.basename(workspaceFolder) : undefined,
        userHome: process.env.HOME ?? process.env.USERPROFILE,
        pathSeparator: path.sep,
    };
    return value.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
        return vars[name] ?? fallbackDir;
    });
}

function sanitizeName(name: string): string {
    // tmux session names: no spaces, periods, colons, or leading dashes.
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^-+/, '').substring(0, 32);
}

function resolveTmuxBinaryPath(): string {
    // Check for a platform-specific path override in the configuration.
    const cfg = vscode.workspace.getConfiguration('tmux-integrated');
    const platformKey =
        process.platform === 'darwin' ? 'tmuxPath.osx' :
        process.platform === 'win32'  ? 'tmuxPath.windows' :
                                        'tmuxPath.linux';  // Linux, FreeBSD, etc.
    const configuredPath = cfg.get<string>(platformKey)?.trim();

    const candidate = configuredPath || 'tmux';
    execFileSync(candidate, ['-V'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    return candidate;
}

function log(message: string): void {
    outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

/**
 * Like resolveTmuxBinaryPath but returns null instead of throwing
 * when tmux is not found.
 */
function resolveTmuxBinaryPathSafe(): string | null {
    try {
        return resolveTmuxBinaryPath();
    } catch {
        return null;
    }
}

/**
 * Auto-connect to the existing tmux session for this workspace and
 * open each existing tmux window as a VS Code terminal tab.
 *
 * VS Code may also restore previously-open `tmux-integrated` profile tabs
 * by calling provideTerminalProfile during/after activation. To avoid
 * double-creating tabs (which on a high-latency reconnect would otherwise
 * spawn fresh tmux windows alongside the adopted ones), we yield to those
 * restore calls for a short grace period before mopping up whatever
 * windows are still un-claimed.
 */
const AUTO_CONNECT_GRACE_MS = 750;
async function autoConnectExistingSession(): Promise<void> {
    log('Auto-connect: existing tmux session detected, connecting…');
    const connected = await ensureClientConnected();
    if (!connected) {
        log('Auto-connect: connection failed');
        return;
    }

    if (windowsToAdopt.length === 0) {
        log('Auto-connect: connected but no windows to adopt');
        return;
    }

    log(`Auto-connect: ${windowsToAdopt.length} window(s) to adopt — yielding ${AUTO_CONNECT_GRACE_MS}ms for VS Code restore`);
    setTimeout(() => {
        const remaining = windowsToAdopt.splice(0);
        if (remaining.length === 0) {
            log('Auto-connect: queue drained by VS Code restore — no extra tabs needed');
            return;
        }
        log(`Auto-connect: creating tabs for ${remaining.length} unclaimed window(s)`);
        for (const w of remaining) {
            if (!attachedWindowIds.has(w.windowId)) {
                vscode.window.createTerminal(buildTerminalOptions(w));
            }
        }
    }, AUTO_CONNECT_GRACE_MS);
}

function tmuxSessionExists(binaryPath: string, sessionName: string): boolean {
    try {
        execFileSync(binaryPath, ['has-session', '-t', sessionName], {
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Collect the VS Code environment variables that should be forwarded into
 * every new tmux window so that editor-integration commands keep working.
 *
 * • VSCODE_IPC_HOOK_CLI  — lets `code <file>` talk to the running VS Code.
 * • GIT_ASKPASS / VSCODE_GIT_* — git credential and signing helpers.
 */
function collectVscodeEnvVars(): Record<string, string> {
    const keys = [
        'VSCODE_IPC_HOOK_CLI',
        'GIT_ASKPASS',
        'VSCODE_GIT_ASKPASS_NODE',
        'VSCODE_GIT_ASKPASS_MAIN',
        'VSCODE_GIT_ASKPASS_EXTRA_ARGS',
        'VSCODE_GIT_IPC_HANDLE',
    ];

    const vars: Record<string, string> = {};
    for (const k of keys) {
        const v = process.env[k];
        if (v) { vars[k] = v; }
    }
    return vars;
}
