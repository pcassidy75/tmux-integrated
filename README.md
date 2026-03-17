# tmux-integrated

Seamless [tmux](https://github.com/tmux/tmux) integration for VS Code terminals.

## Why?

VS Code terminals are lost the moment you close your laptop or lose a remote
connection.  tmux solves the persistence problem but using it naively inside a
VS Code terminal breaks:

| Problem | What breaks |
|---|---|
| Run `tmux` directly in the terminal | VS Code shell integration (Copilot) stops working |
| Run `tmux` directly in the terminal | `code <file>` no longer opens files in VS Code |
| tmux mouse mode | Interferes with VS Code's own mouse handling |

**tmux-integrated** solves all three by using tmux's **control mode** (`-CC`),
exactly as iTerm2 does.  tmux runs in the background as a session manager;
VS Code owns the visual layer.

```
VS Code terminal tab  ←→  tmux-integrated extension  ←→  tmux -CC  ←→  your shell
```

Each VS Code terminal tab corresponds to one tmux window.  Closing the tab
**does not kill the tmux window** — the process keeps running.  When you
reconnect you can open a new terminal and continue where you left off.

## Features

- **Persistent sessions** — one tmux session per workspace, named after the
  workspace folder.
- **New terminal = new tmux window** — each terminal tab gets its own window in
  the session.
- **`code <file>` works** — the `VSCODE_IPC_HOOK_CLI` socket is forwarded into
  every new window so the `code` CLI can talk to the running VS Code instance.
- **Copilot / shell integration compatible** — VS Code's shell integration
  sequences are passed through transparently; tmux never renders them.
- **No mouse-mode conflicts** — tmux is driven via control mode; it never
  renders a TUI inside the VS Code terminal pane.
- **Status bar item** — shows the active session name; click to pick an
  existing window.

## Requirements

- tmux ≥ 2.0 (control mode was introduced in 2.0; 3.x recommended)
- Linux or macOS

## Local testing in VS Code

If you want to test the extension locally without publishing it, use VS Code's
Extension Development Host.

1. In this repo, run `npm install` once if dependencies are not already installed.
2. Press `F5` in VS Code.
3. Choose **Run tmux-integrated**.
4. A second VS Code window opens. This is the test window.
5. In the test window, open the command palette and run **tmux: New tmux Terminal**.
6. If prompted by macOS, allow terminal-related permissions for VS Code and tmux.

If you plan to make code changes while testing, choose **Run tmux-integrated (watch)**
instead. That keeps TypeScript compiling in the background.

### Quick sanity checks

In the test window, verify these in order:

1. The status bar shows the active tmux session name.
2. Running `pwd` works in the tmux-backed terminal.
3. Close the terminal tab, then run **tmux: Attach to tmux Window** and reopen it.
4. Start a long-running command like `sleep 30`, close the tab, reattach, and confirm it is still running.
5. Run `code README.md` inside the tmux terminal and confirm VS Code opens the file.

## Usage

1. Install the extension.
2. Open the command palette → **tmux: New tmux Terminal** (or set the
   `"tmux"` profile as your default terminal profile in settings).
3. Every terminal opened through the profile creates a new window in the
   workspace's tmux session.

### Set as the default terminal profile

```json
// settings.json
{
  "terminal.integrated.defaultProfile.linux": "tmux",
  "terminal.integrated.defaultProfile.osx":  "tmux"
}
```

### Reconnect after a disconnect

All your processes are still running inside tmux. Use **tmux: Attach to tmux
Window** to reopen an existing tmux window in VS Code; the extension restores
the current visible pane contents and resumes live output. **tmux: New tmux
Terminal** still creates a fresh tmux window in the same session.

## Extension settings

| Setting | Default | Description |
|---|---|---|
| `tmux-integrated.sessionName` | *(workspace folder name)* | Override the tmux session name |
| `tmux-integrated.shell` | `$SHELL` or `/bin/bash` | Shell to run inside each tmux pane |

## Commands

| Command | Description |
|---|---|
| `tmux: New tmux Terminal` | Open a new terminal backed by a new tmux window |
| `tmux: Attach to tmux Window` | Pick an existing tmux window from the session |

## How it works

The extension spawns `tmux -CC new-session -A -s <session>` as a child
process. In control mode tmux outputs structured protocol messages instead of
rendering a TUI. The extension parses `%output` and `%extended-output`
notifications, decodes tmux's octal-escaped byte stream, and forwards the
result to the VS Code terminal renderer (xterm.js), which handles
ANSI/VT100/OSC sequences — including VS Code's own shell integration sequences
(OSC 633) that Copilot relies on.

The tmux control client itself is attached through a bundled PTY bridge so
`tmux -CC` behaves like a terminal client instead of a plain pipe consumer.
Pane output still flows through tmux control-mode notifications into the VS
Code pseudoterminal.

Window sizing is synchronized with tmux control mode using `refresh-client -C`
for the tmux window shown in each VS Code terminal, rather than mutating pane
layout with `resize-pane`.

## Differences from existing solutions

| | [wenbo.io approach](https://www.wenbo.io/en-US/Tools/Persistent-VSCode-Remote-Terminals) | **tmux-integrated** |
|---|---|---|
| tmux version required | > 3.2 | ≥ 2.0 |
| Requires custom tmux.conf | Yes | No |
| Copilot compatible | Partial | Yes |
| `code` command works | No | Yes |
| Mouse-mode free | No | Yes |

## License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0-only)**.
See [LICENSE](LICENSE) for the full license text.

The GPL was chosen because the control-mode integration approach is closely
inspired by the technique pioneered by [iTerm2](https://iterm2.com/) (GPL-2.0+)
and tmux itself is released under the ISC / BSD license family.  Using GPL-3.0
ensures derivative work obligations are clear and that the project remains free
and open for everyone.
