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
 * Each VS Code terminal opened through the "tmux" profile (or the command)
 * creates a new tmux window in the session.  When the terminal tab is closed
 * the window is left running — this is the key persistence feature.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { execSync } from 'child_process';

import { TmuxControlClient } from './tmuxControlClient';
import { TmuxTerminal } from './tmuxTerminalProvider';

let client: TmuxControlClient | null = null;
let statusBar: vscode.StatusBarItem | null = null;

// ---------------------------------------------------------------------------
// Activation / deactivation
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext): Promise<void> {

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'tmux-integrated.attachWindow';
    statusBar.show();
    context.subscriptions.push(statusBar);
    setStatus('$(sync~spin) connecting…');

    // --- Check tmux is available ------------------------------------------
    let tmuxVersion: string;
    try {
        tmuxVersion = execSync('tmux -V', { encoding: 'utf8' }).trim();
    } catch {
        setStatus('$(error) tmux: not found');
        const choice = await vscode.window.showErrorMessage(
            'tmux-integrated: tmux is not installed or not in PATH.',
            'Show install instructions',
        );
        if (choice) {
            vscode.env.openExternal(
                vscode.Uri.parse('https://github.com/tmux/tmux/wiki/Installing'),
            );
        }
        return;
    }

    // --- Determine session name and connect ---------------------------------
    const sessionName = resolveSessionName();
    client = new TmuxControlClient(sessionName);

    client.on('tmux-exit', () => setStatus('$(error) tmux: disconnected'));

    try {
        await client.connect();
    } catch (err) {
        setStatus('$(error) tmux: failed');
        vscode.window.showErrorMessage(`tmux-integrated: Could not connect to tmux: ${err}`);
        return;
    }

    setStatus(`$(terminal) tmux: ${sessionName}`, tmuxVersion);

    // Push the current VS Code IPC variables into the session environment so
    // that `code <file>` and git credential helpers work in tmux windows.
    const envSnapshot = collectVscodeEnvVars();
    if (Object.keys(envSnapshot).length) {
        await client.updateEnvironment(envSnapshot).catch(
            (err) => console.error(`tmux-integrated: set-environment error: ${err}`),
        );
    }

    // --- Terminal profile -------------------------------------------------
    context.subscriptions.push(
        vscode.window.registerTerminalProfileProvider('tmux-integrated.terminal', {
            provideTerminalProfile(): vscode.ProviderResult<vscode.TerminalProfile> {
                return buildTerminalProfile();
            },
        }),
    );

    // --- Commands ---------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('tmux-integrated.newTerminal', () => {
            if (!assertConnected()) { return; }
            const terminal = vscode.window.createTerminal(buildExtensionTerminalOptions());
            terminal.show();
        }),

        vscode.commands.registerCommand('tmux-integrated.attachWindow', async () => {
            if (!assertConnected()) { return; }
            await showAttachWindowPicker(sessionName);
        }),
    );

    // --- Clean up when the extension host shuts down ----------------------
    // Note: we do NOT disconnect from tmux — we want sessions to outlive VS Code.
    context.subscriptions.push({
        dispose: () => {
            client?.disconnect();
            client = null;
        },
    });
}

export function deactivate(): void {
    client?.disconnect();
    client = null;
}

// ---------------------------------------------------------------------------
// Helpers — terminal creation
// ---------------------------------------------------------------------------

function buildExtensionTerminalOptions(): vscode.ExtensionTerminalOptions {
    const cfg = vscode.workspace.getConfiguration('tmux-integrated');
    const shell = (cfg.get<string>('shell') || process.env.SHELL || '/bin/bash') || undefined;

    return {
        name: 'tmux',
        pty: new TmuxTerminal(
            client!,
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            collectVscodeEnvVars(),
            shell || undefined,
        ),
    };
}

function buildTerminalProfile(): vscode.TerminalProfile {
    return new vscode.TerminalProfile(buildExtensionTerminalOptions());
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

    if (!windows.length) {
        vscode.window.showInformationMessage(
            `tmux-integrated: No windows found in session "${sessionName}".`,
        );
        return;
    }

    const items = windows.map((w) => ({
        label: `$(terminal) ${w.id}: ${w.name}`,
        description: w.active ? '(active)' : '',
        detail: `Pane ${w.paneId}`,
        windowId: w.id,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a tmux window to open in VS Code',
        title: `tmux session: ${sessionName}`,
    });

    if (picked) {
        // Open a fresh VS Code terminal window pointing at the same session.
        // Full re-attachment to an existing pane (reading its scrollback) is a
        // future enhancement — for now we create a new window in the session.
        const terminal = vscode.window.createTerminal(buildExtensionTerminalOptions());
        terminal.show();
    }
}

// ---------------------------------------------------------------------------
// Helpers — misc
// ---------------------------------------------------------------------------

function assertConnected(): boolean {
    if (client?.isConnected()) { return true; }
    vscode.window.showErrorMessage('tmux-integrated: Not connected to a tmux session.');
    return false;
}

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
    return 'vscode';
}

function sanitizeName(name: string): string {
    // tmux session names: no spaces, periods, colons, or leading dashes.
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^-+/, '').substring(0, 32);
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
