# tmux-integrated

Seamless [tmux](https://github.com/tmux/tmux) integration for VS Code terminals.

## Why?

VS Code terminals are lost the moment you close your laptop or lose a remote
connection.  tmux solves the persistence problem but using it naively inside a
VS Code terminal breaks things:

| Problem | What breaks |
|---|---|
| Run `tmux` directly in the terminal | VS Code shell integration (Copilot) stops working |
| Run `tmux` directly in the terminal | `code <file>` no longer opens files in VS Code |
| tmux mouse mode | Interferes with VS Code's own mouse handling |

**tmux-integrated** solves all three.  tmux runs in the background as a session
manager; VS Code owns the visual layer.  Each VS Code terminal tab corresponds
to one tmux window.  Closing the tab **does not kill the tmux window** — the
process keeps running.  When you reconnect you can open a new terminal and
continue where you left off.

## Features

- **Persistent sessions** — one tmux session per workspace, named after the
  workspace folder.
- **Smart reconnect** — opening the `tmux-integrated` terminal profile
  reattaches to an existing window when available; otherwise it creates a new
  window.
- **Explicit new window command** — **tmux: New tmux Terminal** always creates
  a fresh window in the session.
- **`code <file>` works** — the VS Code CLI socket is forwarded into every
  tmux window so the `code` command opens files in your running VS Code
  instance.
- **Copilot / shell integration compatible** — VS Code's shell integration is
  passed through transparently so Copilot and other terminal features keep
  working.
- **No mouse-mode conflicts** — tmux never draws its own interface inside your
  VS Code terminal, so there are no mouse or scrolling issues.
- **Status bar item** — shows the active session name; click to pick an
  existing window.

## Requirements

- tmux ≥ 2.1 on the machine where your terminal runs (3.x recommended for
  full feature support including per-window environment variables).
  tmux is available on Linux, macOS, and Windows via WSL.
- If you use VS Code on Windows with **Remote - SSH** or **WSL**, tmux only
  needs to be installed on the remote or WSL side.

## Getting started

1. Install the extension.
2. Open the command palette and run **tmux: New tmux Terminal** (or set
   `"tmux-integrated"` as your default terminal profile — see below).
3. That's it. Terminals opened through the profile automatically reattach to
   existing windows when possible.

### Set as the default terminal profile

In your VS Code **settings.json**, set the default profile for the platform
where your terminal runs:

```jsonc
// settings.json — use whichever platform applies to you
{
  "terminal.integrated.defaultProfile.linux": "tmux-integrated",
  "terminal.integrated.defaultProfile.osx": "tmux-integrated",
  "terminal.integrated.defaultProfile.windows": "tmux-integrated"  // WSL
}
```

> **Tip:** If you connect to a remote host via **Remote - SSH**, apply this
> setting in **Remote Settings (JSON)** on the remote side, and make sure the
> extension is installed in that remote extension host.

### Reconnect after a disconnect

All your processes are still running inside tmux.  Use **tmux: Attach to tmux
Window** to reopen an existing tmux window in VS Code — the extension restores
visible output and resumes live updates.  **tmux: New tmux Terminal** creates a
fresh tmux window in the same session.

### Troubleshooting default profile selection

If your default terminal opens plain tmux instead of the extension (often with
an unexpected session name), VS Code is probably picking a shell profile named
`tmux` rather than the extension profile.

Make sure the profile name is exactly `"tmux-integrated"` in your settings,
then reload the VS Code window.

### Stray default-shell tab on launch

VS Code's workbench can spawn an OS-default shell terminal (`/bin/zsh -il`,
`bash`, `pwsh`, …) on startup *before* any extension has a chance to
register a terminal-profile provider, even when
`terminal.integrated.defaultProfile.<os>` resolves to a contributed profile
like `tmux-integrated`. The race is editor-side — see upstream
[microsoft/vscode#123188](https://github.com/microsoft/vscode/issues/123188)
and [#263504](https://github.com/microsoft/vscode/issues/263504). It is
wider in Cursor than in stock VS Code, but exists on both.

There is no activation event that fires before the workbench starts
populating the terminal panel, so the only remedy from inside an extension
is to detect the stray and dispose it. The extension does that
automatically at activation when **both** of the following are true:

- `tmux-integrated.closeStrayShellsOnActivation` is `true` (the default).
- `terminal.integrated.defaultProfile.<os>` for your platform is exactly
  `"tmux-integrated"`.

When these gates are not satisfied (e.g. you deliberately mix profiles)
the extension only logs the stray to the `tmux-integrated` Output channel
and leaves it untouched.

If you ever want to keep the stray (for example because your workflow
relies on having a non-tmux fallback terminal handy on launch), disable
the auto-close:

```jsonc
{
  "tmux-integrated.closeStrayShellsOnActivation": false
}
```

Belt-and-braces option for users who don't need the workbench's own
terminal session restoration on top of tmux's persistence:

```jsonc
{
  "terminal.integrated.enablePersistentSessions": false
}
```

tmux already preserves your work across reloads, so VS Code's session
restore is largely redundant when this extension is your default profile.

The extension's Output channel ("tmux-integrated") logs which terminals
were disposed (or skipped, and why) at each activation.

## Editor-area terminals

By default, tmux-integrated opens terminals in the terminal panel.  You can
instead open them as **editor tabs** (alongside your code files) — useful when
you want terminals in the editor grid, pinned alongside files.

```jsonc
{
  "tmux-integrated.terminalLocation": "editor",
  "tmux-integrated.pinTerminals": true
}
```

When `terminalLocation` is `"editor"`, VS Code's `TerminalEditorService`
opens each tmux terminal as an editor tab with `pinned: true` by default.
The `pinTerminals` setting (default: `true`) additionally fires VS Code's
`workbench.action.pinEditor` command after each terminal is created as a
safety net — useful when multiple terminals are restored in quick
succession during SSH reconnect.

> **Note:** Pinning relies on VS Code's `pinEditor` command, which targets
> the currently active editor tab.  When multiple terminals are created
> simultaneously (e.g. auto-connect restoring several tmux windows), the
> extension focuses each terminal before pinning it, but there may be
> timing races where the first terminal is pinned correctly and
> subsequent ones are not.  If you experience this, you can manually pin
> tabs with **Ctrl+K Shift+Enter** or right-click → Pin.

### Recommended Remote-SSH settings

```jsonc
{
  "terminal.integrated.defaultProfile.linux": "tmux-integrated",
  "tmux-integrated.terminalLocation": "editor",
  "tmux-integrated.pinTerminals": true,
  "terminal.integrated.enablePersistentSessions": false
}
```

`enablePersistentSessions: false` prevents VS Code's built-in session
restore from interfering — tmux already handles persistence, and VS Code's
restore can revive terminals with the wrong profile (see
[microsoft/vscode#263504](https://github.com/microsoft/vscode/issues/263504)).

## Release channels

tmux-integrated ships on two channels:

- **Stable** — the default. Tested, recommended for everyday use.
- **Beta (pre-release)** — early access to upcoming changes. Newer, less
  battle-tested.

Both are published to the VS Code Marketplace and to
[Open VSX](https://open-vsx.org/) (used by Cursor, VSCodium, and others).

### Switching channels in VS Code or Cursor

The editor has this built in — no special download required:

1. Open the **Extensions** view and select **tmux-integrated**.
2. On the extension page, click **Switch to Pre-Release Version** to opt into
   the beta channel (the button reads **Switch to Release Version** to go back).
3. The editor installs the newest build for the channel you chose and keeps it
   updated automatically.

Following the
[VS Code convention](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#prerelease-extensions),
stable releases use **even** minor versions (`0.2.x`, `0.4.x`, …) and beta
releases use **odd** minor versions (`0.3.x`, `0.5.x`, …).

### Manual install

Every release also attaches a `.vsix` to its
[GitHub release](https://github.com/pcassidy75/tmux-integrated/releases)
(beta builds are marked as pre-releases). Download it and run
**Extensions: Install from VSIX…** from the command palette.

## Extension settings

| Setting | Default | Description |
|---|---|---|
| `tmux-integrated.sessionName` | *(workspace folder name)* | Override the tmux session name |
| `tmux-integrated.shell` | `$SHELL` or `/bin/bash` | Shell to run inside each tmux pane |
| `tmux-integrated.cwd` | *(workspace folder)* | Starting directory for new tmux terminals. Supports `${workspaceFolder}`. If unset, falls back to `terminal.integrated.cwd`, then the workspace folder. |
| `tmux-integrated.autoConnect` | `true` | Automatically connect to existing tmux sessions associated with the workspace when VS Code opens. |
| `tmux-integrated.syncWindowNames` | `bidirectional` | Synchronize tmux window names and VS Code tab names. Options: `bidirectional`, `tmuxToVscode`, `vscodeToTmux`, or `off`. |
| `tmux-integrated.syncWindowCreation` | `true` | Automatically open a matching VS Code terminal when a window is created externally in tmux. |
| `tmux-integrated.terminalLocation` | `panel` | Where to open tmux terminal tabs: `panel` (terminal panel) or `editor` (editor area as tabs). |
| `tmux-integrated.pinTerminals` | `true` | When `terminalLocation` is `editor`, pin terminal tabs via VS Code's `pinEditor` command. |

## Commands

| Command | Description |
|---|---|
| `tmux: New tmux Terminal` | Open a new terminal backed by a new tmux window |
| `tmux: Attach to tmux Window` | Pick an existing tmux window from the session |

`tmux-integrated.newTerminal` accepts an optional `command` argument for
keybindings that should launch a program after creating the tmux window:

```jsonc
{
  "key": "ctrl+shift+o",
  "command": "tmux-integrated.newTerminal",
  "args": {
    "command": "opencode"
  }
}
```

## How it works

The extension uses tmux's **control mode** (`-CC`) — the same approach used by
[iTerm2](https://iterm2.com/).  In control mode tmux manages sessions and
windows in the background while VS Code handles all rendering.  This means
shell integration, Copilot, mouse support, and the `code` CLI all continue to
work exactly as they do in a normal VS Code terminal.

## Contributing

Contributions are welcome — open an issue or submit a pull request.

Maintainers: see [doc/RELEASE.md](doc/RELEASE.md) for version bumps, changelog generation, and marketplace publish.

## License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0-only)**.
See [LICENSE](LICENSE) for the full license text.
