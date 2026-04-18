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

### tmux not found when launching VS Code from the macOS Dock

When VS Code is launched from the Dock (rather than a terminal), it inherits a
minimal `PATH` from launchd that may not include Homebrew (`/opt/homebrew/bin`).
If you see an error like _"tmux is not installed or not in PATH"_ but tmux works
fine in your terminal, set the absolute path to the tmux binary:

```jsonc
// settings.json
{
  "tmux-integrated.tmuxPath.osx": "/opt/homebrew/bin/tmux"
}
```

An alternative fix is to add the following to your `~/.zprofile` so that
Homebrew's `shellenv` initialises the PATH for GUI apps (use the path that
matches your Mac's architecture — `/opt/homebrew` for Apple Silicon,
`/usr/local` for Intel):

```sh
eval "$(/opt/homebrew/bin/brew shellenv)"   # Apple Silicon
# eval "$(/usr/local/bin/brew shellenv)"    # Intel
```

## Extension settings

| Setting | Default | Description |
|---|---|---|
| `tmux-integrated.sessionName` | *(workspace folder name)* | Override the tmux session name |
| `tmux-integrated.shell` | `$SHELL` or `/bin/bash` | Shell to run inside each tmux pane |
| `tmux-integrated.cwd` | *(workspace folder)* | Starting directory for new tmux terminals. Supports `${workspaceFolder}`. If unset, falls back to `terminal.integrated.cwd`, then the workspace folder. |
| `tmux-integrated.autoConnect` | `true` | Automatically connect to existing tmux sessions associated with the workspace when VS Code opens. |
| `tmux-integrated.tmuxPath.osx` | *(empty — use PATH)* | Absolute path to the tmux binary on macOS (e.g. `/opt/homebrew/bin/tmux`). Useful when VS Code is launched from the Dock and does not inherit your shell PATH. |
| `tmux-integrated.tmuxPath.linux` | *(empty — use PATH)* | Absolute path to the tmux binary on Linux (e.g. `/usr/local/bin/tmux`). |
| `tmux-integrated.tmuxPath.windows` | *(empty — use PATH)* | Absolute path to the tmux binary on Windows/WSL (e.g. `/usr/bin/tmux`). |

## Commands

| Command | Description |
|---|---|
| `tmux: New tmux Terminal` | Open a new terminal backed by a new tmux window |
| `tmux: Attach to tmux Window` | Pick an existing tmux window from the session |

## How it works

The extension uses tmux's **control mode** (`-CC`) — the same approach used by
[iTerm2](https://iterm2.com/).  In control mode tmux manages sessions and
windows in the background while VS Code handles all rendering.  This means
shell integration, Copilot, mouse support, and the `code` CLI all continue to
work exactly as they do in a normal VS Code terminal.

## Contributing

Contributions are welcome — open an issue or submit a pull request.

## License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0-only)**.
See [LICENSE](LICENSE) for the full license text.
