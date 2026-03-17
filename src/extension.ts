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
import { execFileSync, execSync } from 'child_process';

import { TmuxControlClient } from './tmuxControlClient';
import { TmuxTerminal } from './tmuxTerminalProvider';

interface AttachWindowItem extends vscode.QuickPickItem {
    windowId: string;
    paneId: string;
}

let client: TmuxControlClient | null = null;
let statusBar: vscode.StatusBarItem | null = null;
let tmuxVersion: string | null = null;
let currentSessionName = 'vscode';
let tmuxBinaryPath: string | null = null;
let pythonBinaryPath: string | null = null;
let extensionRootPath = process.cwd();
let defaultStartDirectory = process.cwd();
let bootstrapWindow: { windowId: string; paneId: string; name?: string } | null = null;
let windowsToAdopt: { windowId: string; paneId: string; name?: string }[] = [];
let disposing = false;
const attachedWindowIds = new Set<string>();

// ---------------------------------------------------------------------------
// Activation / deactivation
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    extensionRootPath = context.extensionPath;
    defaultStartDirectory = resolveStartDirectory(context.extensionPath);
    currentSessionName = resolveSessionName();

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'tmux-integrated.attachWindow';
    statusBar.show();
    context.subscriptions.push(statusBar);
    setStatus('$(terminal) tmux-integrated: idle', 'Connects when you open or attach a tmux terminal');

    registerTerminalProfile(context);
    registerCommands(context);

    // --- Clean up when the extension host shuts down ----------------------
    // Note: we do NOT disconnect from tmux — we want sessions to outlive VS Code.
    context.subscriptions.push({
        dispose: () => {
            disposing = true;
            client?.disconnect();
            client = null;
        },
    });
}

export function deactivate(): void {
    disposing = true;
    client?.disconnect();
    client = null;
}

function registerTerminalProfile(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.window.registerTerminalProfileProvider('tmux-integrated.terminal', {
            async provideTerminalProfile(): Promise<vscode.TerminalProfile> {
                const connected = await ensureClientConnected();
                if (!connected) {
                    throw new Error('tmux-integrated: Could not connect to tmux.');
                }

                // Reuse the bootstrap window from a freshly-created session.
                const bootstrap = takeBootstrapWindow();
                if (bootstrap) {
                    return buildTerminalProfile(bootstrap);
                }

                // On reconnection, adopt one pre-existing window for this tab
                // and schedule the rest to appear as additional tabs.
                const adopted = adoptNextWindow();
                if (adopted) {
                    return buildTerminalProfile(adopted);
                }

                // Already connected and everything adopted — create a new window.
                return buildTerminalProfile();
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
                buildExtensionTerminalOptions(),
            );
            terminal.show();
        }),

        vscode.commands.registerCommand('tmux-integrated.attachWindow', async () => {
            const connected = await ensureClientConnected();
            if (!connected) { return; }
            await showAttachWindowPicker(currentSessionName);
        }),
    );
}

async function ensureClientConnected(): Promise<boolean> {
    if (client?.isConnected()) {
        return true;
    }

    setStatus('$(sync~spin) tmux-integrated: connecting…');

    // --- Check tmux is available ------------------------------------------
    try {
        tmuxBinaryPath = resolveTmuxBinaryPath();
        pythonBinaryPath = resolvePythonBinaryPath();
        tmuxVersion = execFileSync(tmuxBinaryPath, ['-V'], { encoding: 'utf8' }).trim();
    } catch {
        setStatus('$(error) tmux-integrated: dependency missing');
        const choice = await vscode.window.showErrorMessage(
            'tmux-integrated: tmux or python3 is not installed or not in PATH.',
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
    client = new TmuxControlClient(
        currentSessionName,
        tmuxBinaryPath!,
        pythonBinaryPath!,
        path.join(extensionRootPath, 'tmux_pty_bridge.py'),
    );

    client.on('tmux-exit', () => setStatus('$(error) tmux-integrated: disconnected'));

    try {
        await client.connect({ startDirectory: defaultStartDirectory });
    } catch (err) {
        setStatus('$(error) tmux-integrated: failed');
        vscode.window.showErrorMessage(`tmux-integrated: Could not connect to tmux: ${err}`);
        return false;
    }

    bootstrapWindow = null;
    windowsToAdopt = [];
    if (!sessionAlreadyExists) {
        try {
            const windows = await client.listWindows();
            if (windows.length === 1) {
                bootstrapWindow = { windowId: windows[0].id, paneId: windows[0].paneId, name: windows[0].name };
            }
        } catch (err) {
            console.error(`tmux-integrated: bootstrap window lookup failed: ${err}`);
        }
    } else {
        try {
            const windows = await client.listWindows();
            windowsToAdopt = windows.map(w => ({ windowId: w.id, paneId: w.paneId, name: w.name }));
        } catch (err) {
            console.error(`tmux-integrated: window enumeration failed: ${err}`);
        }
    }
    setStatus(`$(terminal) tmux-integrated: ${currentSessionName}`, tmuxVersion);

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

function buildExtensionTerminalOptions(
    existingWindow?: { windowId: string; paneId: string; name?: string },
): vscode.ExtensionTerminalOptions {
    return buildTerminalOptions(existingWindow);
}

function buildTerminalOptions(
    existingWindow?: { windowId: string; paneId: string; name?: string },
): vscode.ExtensionTerminalOptions {
    const cfg = vscode.workspace.getConfiguration('tmux-integrated');
    const shell = (cfg.get<string>('shell') || process.env.SHELL || '/bin/bash') || undefined;

    return {
        name: existingWindow?.name || 'tmux',
        pty: new TmuxTerminal(
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
        ),
    };
}

function buildTerminalProfile(
    existingWindow?: { windowId: string; paneId: string; name?: string },
): vscode.TerminalProfile {
    return new vscode.TerminalProfile(buildExtensionTerminalOptions(existingWindow));
}

function takeBootstrapWindow(): { windowId: string; paneId: string; name?: string } | undefined {
    const bw = bootstrapWindow;
    bootstrapWindow = null;
    return bw ?? undefined;
}

/**
 * Claim the next pre-existing window for re-adoption.  The first call returns
 * the window to use for the current provideTerminalProfile request; any
 * remaining windows are scheduled to appear as additional VS Code tabs.
 */
function adoptNextWindow(): { windowId: string; paneId: string; name?: string } | undefined {
    if (windowsToAdopt.length === 0) { return undefined; }
    const next = windowsToAdopt.shift()!;

    if (windowsToAdopt.length > 0) {
        const remaining = windowsToAdopt;
        windowsToAdopt = [];
        setTimeout(() => {
            for (const w of remaining) {
                if (!attachedWindowIds.has(w.windowId)) {
                    vscode.window.createTerminal(buildTerminalOptions(w));
                }
            }
        }, 100);
    }

    return next;
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
    }));

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a tmux window to open in VS Code',
        title: `tmux-integrated session: ${sessionName}`,
    });

    if (picked) {
        const terminal = vscode.window.createTerminal(buildTerminalOptions({
            windowId: picked.windowId,
            paneId: picked.paneId,
            name: picked.label.replace(/^\$\(terminal\)\s*/, ''),
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
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || extensionPath;
}

function sanitizeName(name: string): string {
    // tmux session names: no spaces, periods, colons, or leading dashes.
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^-+/, '').substring(0, 32);
}

function resolveTmuxBinaryPath(): string {
    const candidates = [
        '/opt/homebrew/bin/tmux',
        '/usr/local/bin/tmux',
        '/usr/bin/tmux',
        '/snap/bin/tmux',
        '/home/linuxbrew/.linuxbrew/bin/tmux',
    ];

    for (const candidate of candidates) {
        try {
            execFileSync(candidate, ['-V'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            return candidate;
        } catch {
            // Try the next candidate.
        }
    }

    const resolved = execSync('command -v tmux || which tmux', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (!resolved) {
        throw new Error('tmux binary not found');
    }

    return resolved.split(/\r?\n/u, 1)[0];
}

function resolvePythonBinaryPath(): string {
    const candidates = [
        '/opt/homebrew/bin/python3',
        '/usr/local/bin/python3',
        '/usr/bin/python3',
        '/home/linuxbrew/.linuxbrew/bin/python3',
    ];

    for (const candidate of candidates) {
        try {
            execFileSync(candidate, ['-c', 'import sys'], { stdio: ['ignore', 'ignore', 'ignore'] });
            return candidate;
        } catch {
            // Try the next candidate.
        }
    }

    const resolved = execSync('command -v python3 || which python3', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (!resolved) {
        throw new Error('python3 binary not found');
    }

    return resolved.split(/\r?\n/u, 1)[0];
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
