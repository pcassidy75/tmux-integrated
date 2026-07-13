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
import { TmuxTerminal, WindowNameSyncDirection } from './tmuxTerminalProvider';

interface AttachWindowItem extends vscode.QuickPickItem {
    windowId: string;
    paneId: string;
    windowIndex: number;
    name: string;
}

interface NewTerminalCommandArgs {
    command?: string;
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
const pendingWindowAddIds = new Set<string>();
const terminalPtyByTerminal = new Map<vscode.Terminal, TmuxTerminal>();
const lastObservedTerminalNames = new Map<vscode.Terminal, string>();
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
            lastObservedTerminalNames.clear();
            pendingTerminalPtys.length = 0;
            pendingWindowAddIds.clear();
            activeTmuxWindowId = null;
            inFlightConnect = null;
            client?.disconnect();
            client = null;
        },
    });

    // The workbench can spawn an OS-default shell terminal (`/bin/zsh -il`
    // on macOS, etc.) before any extension is activated, even when
    // `terminal.integrated.defaultProfile.<os>` resolves to a
    // contributed profile like `tmux-integrated`. The window between
    // workbench-launch and our `registerTerminalProfileProvider` call
    // is wider on Cursor than on stock VS Code but exists on both —
    // see upstream microsoft/vscode#123188 / #263504. There is no
    // activation event that fires *before* the workbench starts
    // populating the terminal panel, so the only remedy from inside
    // an extension is to detect and dispose the stray.
    //
    // Gated on:
    //   - `tmux-integrated.closeStrayShellsOnActivation` (default true)
    //   - `terminal.integrated.defaultProfile.<os>` === `tmux-integrated`
    //     (so users who deliberately mix profiles are never affected)
    //
    // Any tab that does not look like one of ours (`tmux` or `tmux:N`)
    // is treated as a stray when both gates are satisfied. Restored
    // tmux-backed tabs go through `provideTerminalProfile` and acquire
    // a TmuxTerminal pty, so they are never disposed here.
    const stray = vscode.window.terminals.filter((t) => !looksLikeTmuxTerminal(t));
    if (stray.length > 0) {
        const cfgRoot = vscode.workspace.getConfiguration('tmux-integrated');
        const closeStray = cfgRoot.get<boolean>('closeStrayShellsOnActivation', true);
        const names = stray.map((t) => t.name).join(', ');
        if (closeStray && isTmuxIntegratedDefaultProfile()) {
            log(`Disposing ${stray.length} stray non-tmux terminal(s) at activation: [${names}] ` +
                `(defaultProfile.<os>=tmux-integrated, closeStrayShellsOnActivation=true). ` +
                `See README "Stray default-shell tab on launch" for context.`);
            for (const t of stray) {
                try { t.dispose(); } catch (err) { log(`stray dispose warning: ${err}`); }
            }
        } else {
            log(`Non-tmux terminals already present at activation: [${names}]. ` +
                `Auto-close skipped (closeStrayShellsOnActivation=${closeStray}, ` +
                `defaultProfile.<os>=${currentPlatformDefaultProfile() ?? '<unset>'}). ` +
                `See README "Stray default-shell tab on launch" for context.`);
        }
    }

    // --- Auto-connect to existing tmux session on workspace open ----------
    //
    // Defer the synchronous tmux probe (execFileSync of `tmux -V` and
    // `has-session`) so that eager activation doesn't briefly block the
    // workbench during startup. Whether this runs before or after panel
    // restore doesn't matter for correctness — autoConnectExistingSession
    // already yields a grace period to provideTerminalProfile (see
    // AUTO_CONNECT_GRACE_MS) and adoptNextWindow is race-safe.
    const cfg = vscode.workspace.getConfiguration('tmux-integrated');
    if (cfg.get<boolean>('autoConnect', true)) {
        setImmediate(() => {
            const sessionName = resolveSessionName();
            const tmuxPath = resolveTmuxBinaryPathSafe();
            if (tmuxPath && tmuxSessionExists(tmuxPath, sessionName)) {
                autoConnectExistingSession();
            }
        });
    }
}

export function deactivate(): void {
    disposing = true;
    terminalPtyByTerminal.clear();
    lastObservedTerminalNames.clear();
    pendingTerminalPtys.length = 0;
    pendingWindowAddIds.clear();
    activeTmuxWindowId = null;
    inFlightConnect = null;
    client?.disconnect();
    client = null;
}

function getWindowNameSyncDirection(): WindowNameSyncDirection {
    const value = vscode.workspace
        .getConfiguration('tmux-integrated')
        .get<string>('syncWindowNames', 'bidirectional');
    if (value === 'tmuxToVscode' || value === 'vscodeToTmux' || value === 'off') {
        return value;
    }
    return 'bidirectional';
}

function shouldSyncWindowCreation(): boolean {
    return vscode.workspace
        .getConfiguration('tmux-integrated')
        .get<boolean>('syncWindowCreation', true);
}

function registerTerminalRenameSync(context: vscode.ExtensionContext): void {
    const syncTerminalNameToTmux = (terminal: vscode.Terminal, pty: TmuxTerminal): void => {
        const direction = getWindowNameSyncDirection();
        if (direction !== 'bidirectional' && direction !== 'vscodeToTmux') {
            return;
        }
        const lastEmitted = pty.getLastEmittedName();
        if (lastEmitted !== null && terminal.name !== lastEmitted) {
            void pty.syncNameToTmux(terminal.name);
        }
    };

    const trackTerminal = (terminal: vscode.Terminal): TmuxTerminal | null => {
        let pty = terminalPtyByTerminal.get(terminal) ?? getTmuxPtyFromTerminal(terminal);
        if (!pty && looksLikeTmuxTerminal(terminal)) {
            pty = takeNextPendingTerminalPty();
        }
        if (!pty) {
            return null;
        }

        terminalPtyByTerminal.set(terminal, pty);
        if (!lastObservedTerminalNames.has(terminal)) {
            lastObservedTerminalNames.set(terminal, terminal.name);
        }
        return pty;
    };

    const untrackTerminal = (terminal: vscode.Terminal): void => {
        terminalPtyByTerminal.delete(terminal);
        lastObservedTerminalNames.delete(terminal);
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

    // VS Code has no event for its built-in terminal Rename action. Poll only
    // the small set of tracked tmux terminals so names propagate promptly.
    const nameSyncTimer = setInterval(() => {
        for (const [terminal, pty] of terminalPtyByTerminal) {
            if (lastObservedTerminalNames.get(terminal) === terminal.name) {
                continue;
            }
            lastObservedTerminalNames.set(terminal, terminal.name);
            syncTerminalNameToTmux(terminal, pty);
        }
    }, 250);

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
        { dispose: () => clearInterval(nameSyncTimer) },
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
        vscode.commands.registerCommand('tmux-integrated.newTerminal', async (args?: NewTerminalCommandArgs) => {
            const connected = await ensureClientConnected();
            if (!connected) { return; }
            const initialCommand = typeof args?.command === 'string' ? args.command.trim() : '';
            const terminal = vscode.window.createTerminal(
                buildTerminalOptions(undefined, initialCommand || undefined),
            );
            terminal.show();
            await maybePinTerminal(terminal);
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
            'tmux-integrated: tmux is not installed or not in PATH.',
            'Show tmux install instructions',
        );
        if (choice) {
            vscode.env.openExternal(
                vscode.Uri.parse('https://github.com/tmux/tmux/wiki/Installing'),
            );
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

    const connectedClient = client;
    connectedClient.on('window-add', (windowId: string) => {
        if (!shouldSyncWindowCreation() || !windowId.startsWith('@') || pendingWindowAddIds.has(windowId)) {
            return;
        }
        pendingWindowAddIds.add(windowId);
        // A window created by TmuxTerminal.open() emits %window-add before its
        // new-window response resolves. Reconcile on the next event-loop turn
        // so that path can claim the ID before we treat it as external.
        setImmediate(() => void adoptAddedTmuxWindow(connectedClient, windowId));
    });

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
                };
            }
        } catch (err) {
            log(`bootstrap window lookup failed: ${err}`);
        }
    } else {
        try {
            const windows = await client.listWindows();
            log(`Existing session — found ${windows.length} window(s) to adopt`);
            // Carry the name through so the initial VS Code terminal options
            // can use it before TmuxTerminal.open() refreshes it from tmux.
            windowsToAdopt = windows.map(w => ({
                windowId: w.id,
                paneId: w.paneId,
                windowIndex: w.index,
                name: w.name,
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
    initialCommand?: string,
): vscode.ExtensionTerminalOptions {
    const cfg = vscode.workspace.getConfiguration('tmux-integrated');
    const shell = (cfg.get<string>('shell') || process.env.SHELL || '/bin/bash') || undefined;

    const pty = new TmuxTerminal(
        client!,
        defaultStartDirectory,
        collectVscodeEnvVars(),
        shell || undefined,
        initialCommand,
        getWindowNameSyncDirection,
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

    const options: vscode.ExtensionTerminalOptions = {
        name: existingWindow?.name?.trim()
            || (existingWindow?.windowIndex !== undefined ? `tmux:${existingWindow.windowIndex}` : 'tmux'),
        pty,
    };

    // Read the terminalLocation setting and set location accordingly.
    // When 'editor', VS Code's TerminalEditorService.openEditor() hardcodes pinned: true.
    const location = cfg.get<string>('terminalLocation', 'panel');
    if (location === 'editor') {
        options.location = vscode.TerminalLocation.Editor;
    }

    return options;
}

/**
 * Pin a terminal's editor tab if terminalLocation is 'editor' and pinTerminals is enabled.
 * VS Code's TerminalEditorService already sets pinned:true on openEditor, but this is a
 * safety net for cases where the pin doesn't take effect (e.g. timing races on reconnect).
 *
 * The VS Code pinEditor command targets the currently active editor tab, so we must
 * focus the terminal (which makes its editor tab active) before pinning. A small delay
 * after show() ensures the editor service has processed the focus change.
 */
async function maybePinTerminal(terminal: vscode.Terminal): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('tmux-integrated');
    const location = cfg.get<string>('terminalLocation', 'panel');
    const pin = cfg.get<boolean>('pinTerminals', true);
    if (location === 'editor' && pin) {
        // Focus the terminal so its editor tab becomes the active editor
        terminal.show();
        // Wait for the editor service to process the focus change.
        // Without this delay, pinEditor can target the wrong tab (e.g. the
        // previously active editor) when multiple terminals are created in
        // quick succession (e.g. auto-connect restoring several windows).
        await new Promise<void>(resolve => setTimeout(resolve, 100));
        await vscode.commands.executeCommand('workbench.action.pinEditor');
    }
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

async function adoptAddedTmuxWindow(sourceClient: TmuxControlClient, windowId: string): Promise<void> {
    try {
        if (!shouldSyncWindowCreation() || disposing || client !== sourceClient || attachedWindowIds.has(windowId)) {
            return;
        }
        if (bootstrapWindow?.windowId === windowId || windowsToAdopt.some((w) => w.windowId === windowId)) {
            return;
        }

        const windows = await sourceClient.listWindows();
        if (!shouldSyncWindowCreation() || disposing || client !== sourceClient || attachedWindowIds.has(windowId)) {
            return;
        }
        if (bootstrapWindow?.windowId === windowId || windowsToAdopt.some((w) => w.windowId === windowId)) {
            return;
        }
        const added = windows.find((w) => w.id === windowId);
        if (!added) {
            return;
        }

        log(`tmux created window ${windowId}; creating matching VS Code terminal`);
        const terminal = vscode.window.createTerminal(buildTerminalOptions({
            windowId: added.id,
            paneId: added.paneId,
            windowIndex: added.index,
            name: added.name,
        }));
        terminal.show(true);
        await maybePinTerminal(terminal);
    } catch (err) {
        log(`window-add sync warning for ${windowId}: ${err}`);
    } finally {
        pendingWindowAddIds.delete(windowId);
    }
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
        }));
        terminal.show();
        await maybePinTerminal(terminal);
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
    // Just use 'tmux' and let the OS resolve it from PATH.
    // Verify it's actually callable.
    execFileSync('tmux', ['-V'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    return 'tmux';
}

function log(message: string): void {
    outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

/**
 * Read `terminal.integrated.defaultProfile.<os>` for the current platform.
 * Returns `null` if unset. Used to gate the stray-shell auto-close so we
 * never dispose user-opened terminals when the default profile isn't ours.
 */
function currentPlatformDefaultProfile(): string | null {
    const key = process.platform === 'darwin' ? 'osx'
        : process.platform === 'win32' ? 'windows'
        : 'linux';
    const v = vscode.workspace
        .getConfiguration('terminal.integrated')
        .get<string>(`defaultProfile.${key}`);
    return v && v.length > 0 ? v : null;
}

function isTmuxIntegratedDefaultProfile(): boolean {
    return currentPlatformDefaultProfile() === 'tmux-integrated';
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
 * double-creating tabs (which would spawn fresh tmux windows alongside
 * the adopted ones), we yield to those restore calls before mopping up
 * whatever windows are still un-claimed.
 *
 * Two timing knobs:
 *
 * - `AUTO_CONNECT_INITIAL_GRACE_MS` is the worst-case wait we'll tolerate
 *   if VS Code never starts restoring (e.g. fresh launch with no prior
 *   tabs, or `terminal.integrated.enablePersistentSessions=false`). With
 *   eager activation (`activationEvents: ["*"]`) workbench restore can
 *   start well after autoConnect, especially on Reload Window — see
 *   commit history for the regression that introduced this longer wait.
 *
 * - `AUTO_CONNECT_QUIET_GRACE_MS` is the wait between successive restore
 *   events. Each tmux-named terminal opening resets the timer, so a
 *   restore that drains windows one at a time keeps the wait alive until
 *   it's done. Quiet expiry means "VS Code has stopped restoring",
 *   adopt the rest.
 */
const AUTO_CONNECT_INITIAL_GRACE_MS = 3000;
const AUTO_CONNECT_QUIET_GRACE_MS = 750;
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

    log(`Auto-connect: ${windowsToAdopt.length} window(s) to adopt — waiting up to ${AUTO_CONNECT_INITIAL_GRACE_MS}ms for VS Code restore`);

    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let disposable: vscode.Disposable | null = null;

    const finalize = async (reason: string) => {
        graceTimer = null;
        disposable?.dispose();
        disposable = null;
        const remaining = windowsToAdopt.splice(0);
        if (remaining.length === 0) {
            log(`Auto-connect: ${reason} — queue drained by VS Code restore, no extra tabs needed`);
            return;
        }
        log(`Auto-connect: ${reason} — creating tabs for ${remaining.length} unclaimed window(s)`);
        for (const w of remaining) {
            if (!attachedWindowIds.has(w.windowId)) {
                const terminal = vscode.window.createTerminal(buildTerminalOptions(w));
                terminal.show();
                await maybePinTerminal(terminal);
            }
        }
    };

    const armTimer = (ms: number, reason: string) => {
        if (graceTimer) { clearTimeout(graceTimer); }
        graceTimer = setTimeout(() => finalize(reason), ms);
    };

    // Each restore-triggered tmux terminal open resets the timer to the
    // shorter quiet grace, so a slow drip-feed of restores keeps the
    // wait alive until the workbench is done. We only reset while there
    // is still something to adopt — otherwise the listener does nothing
    // and we exit on the initial grace.
    disposable = vscode.window.onDidOpenTerminal((terminal) => {
        if (windowsToAdopt.length > 0 && looksLikeTmuxTerminal(terminal)) {
            armTimer(AUTO_CONNECT_QUIET_GRACE_MS, 'quiet grace expired after VS Code restore');
        }
    });

    armTimer(AUTO_CONNECT_INITIAL_GRACE_MS, 'initial grace expired with no VS Code restore');
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
