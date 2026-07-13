# tmux-integrated — Architecture

This document describes how `tmux-integrated` is wired together so that future
contributors (and future-us) can navigate the codebase quickly. It is meant to
be read alongside the source files; the goal is to explain the *why* and the
control flow, not to duplicate code-level documentation.

## Big picture

`tmux-integrated` is a VS Code extension that gives every VS Code terminal tab
a persistent backing store via tmux **control mode** (`tmux -CC`).

```
                +-----------------------+
                |  VS Code Terminal Tab |  (xterm.js renderer)
                +----------+------------+
                           |
                  vscode.Pseudoterminal
                           |
                +----------v-------------+
                |     TmuxTerminal       |   src/tmuxTerminalProvider.ts
                |  (one per VS Code tab) |
                +----------+-------------+
                           |
                           |  emits/listens through:
                           v
                +------------------------+
                |   TmuxControlClient    |   src/tmuxControlClient.ts
                | (one per workspace)    |
                +----------+-------------+
                           |
                           |  ingest()/sendCommand()/events
                           v
                +------------------------+
                |      TmuxGateway       |   src/tmuxGateway.ts
                |  protocol parser/queue |
                +----------+-------------+
                           |
                       node-pty
                           |
                           v
                +------------------------+
                |   tmux server (-CC)    |
                | one session per WS dir |
                +------------------------+
```

* **One session per workspace folder.** Session name defaults to the basename
  of the workspace folder (sanitised) and may be overridden via
  `tmux-integrated.sessionName`.
* **One tmux window per VS Code terminal tab** (1:1 mapping, like iTerm2).
* **One tmux pane per window.** Splits are not supported — VS Code's terminal
  API has no split-pane abstraction.
* **Window creation is synchronized.** A tmux `%window-add` notification creates
  a matching VS Code terminal unless that window is already attached or queued
  for adoption. This can be disabled with
  `tmux-integrated.syncWindowCreation`.

## Source layout

| File | Role |
|---|---|
| `src/extension.ts` | Activation, lifecycle, terminal-profile + command registration, autoConnect, status bar, env-var forwarding. |
| `src/tmuxTerminalProvider.ts` | The `vscode.Pseudoterminal` (`TmuxTerminal`). Forwards user input to a tmux pane, renders pane output back into xterm.js, and owns the tab name. |
| `src/windowTitle.ts` | Pure helper that chooses the VS Code tab title from tmux's `#{window_name}`. |
| `src/tmuxControlClient.ts` | High-level typed tmux operations (`newWindow`, `listWindows`, `resizeWindowForClient`, …), node-pty lifecycle, version gating. Wraps `TmuxGateway`. |
| `src/tmuxGateway.ts` | Low-level control-mode protocol parser. Frames lines, handles `%begin/%end/%error`, manages the pending-command queue, defers writes until `%session-changed`, decodes `%output`/`%extended-output` payloads. |

## Activation flow

```
activate()
  |-- create OutputChannel + StatusBar
  |-- registerTerminalRenameSync()    // wire onDidOpen/Close/ChangeActive
  |-- registerTerminalProfile()       // contributes "tmux-integrated" profile
  |-- registerCommands()              // newTerminal / attachWindow / renameTerminal
  |-- if autoConnect && session exists:
        autoConnectExistingSession()  // fire-and-forget
```

`autoConnectExistingSession()` calls `ensureClientConnected()` (which may do a
full `tmux -CC` spawn + protocol handshake), then drains
`windowsToAdopt` and creates a VS Code terminal tab for every existing tmux
window so that prior work re-appears.

## `ensureClientConnected()` — the connection state machine

Every code path that needs a live tmux client funnels through here:

* `provideTerminalProfile` (when VS Code asks for a `tmux-integrated` terminal)
* `tmux-integrated.newTerminal` command
* `tmux-integrated.attachWindow` command
* `autoConnectExistingSession` on activation

Behaviour:

1. If `client.isConnected()` already returns true, perform a 5-second
   `display-message "__ping__"` health check. If it answers correctly, reuse
   the connection; otherwise tear it down and reconnect.
2. Resolve `tmux` binary, exec `tmux -V`, gate features by version.
3. `new TmuxControlClient(...)` and `client.connect({ startDirectory })`.
   Internally this spawns `tmux -CC new-session -A -s <name>` in a node-pty
   PTY, runs the protocol handshake, and resolves once the readiness probe
   round-trips.
4. Subscribe to `session-window-changed` and `tmux-exit` events.
5. Set `default-terminal xterm-256color` and forward `VSCODE_*` env vars via
   `set-environment -t <session>`.
6. Populate either:
   * `bootstrapWindow` — when the session was *just* created and tmux opened a
     single initial window, OR
   * `windowsToAdopt[]` — when the session already existed; one entry per
     pre-existing tmux window.

## Where new terminal tabs come from

There are three doorways into "create a VS Code terminal tab":

1. **Profile provider** (`provideTerminalProfile`). Called by VS Code when a
   user opens a terminal that uses the `tmux-integrated` profile (including
   the case where `terminal.integrated.defaultProfile.<os>` selects it). The
   provider prefers, in order:
   * `bootstrapWindow` (just-created session's first window)
   * the next entry from `windowsToAdopt`
   * `client.newWindow(...)` — i.e. *create a fresh tmux window*.
2. **`tmux-integrated.newTerminal` command**. Always calls `newWindow`. An
   optional keybinding `command` argument is sent after the pane is ready.
3. **`tmux-integrated.attachWindow` command**. Pops a quick-pick over
   `listWindows()` minus already-attached windows, then creates a VS Code
   terminal that adopts the chosen window.
4. **`autoConnectExistingSession()`**. After connect, iterates the
   `windowsToAdopt` snapshot and creates one VS Code terminal per remaining
   window via `vscode.window.createTerminal(buildTerminalOptions(w))`.

Whichever path runs, `buildTerminalOptions(existingWindow?)` constructs a
fresh `TmuxTerminal` and returns it as a `vscode.ExtensionTerminalOptions`.
The pty is also pushed onto `pendingTerminalPtys` so that
`registerTerminalRenameSync` can later associate the resulting
`vscode.Terminal` with its `TmuxTerminal` instance (used to detect built-in
"Rename…" actions and to align the tmux active window with the VS Code tab
focus).

## `TmuxTerminal.open()` — what happens when a tab is created

```
open(initialDimensions)
  |-- decide targetWindow:
  |     * existingWindow if provided   (adoption path)
  |     * else: client.newWindow(...)  (creation path)
  |-- record windowId, paneId, tabWindowIndex
  |-- subscribe: 'output' / 'window-close' / 'window-renamed' / 'tmux-exit'
  |-- query #{window_name} and emit it unchanged
  |-- emit initial tab name
  |-- resizeWindowForClient(initialDimensions)
  |-- if adoption: capture-pane snapshot + restore cursor position
```

`handleInput()` is implemented via `send-keys` using the same hybrid strategy
iTerm2 uses: hex-encode unknown ESC sequences atomically (so e.g. xterm.js's
auto cursor-position reply isn't fragmented on the way to the tmux pane),
named keys for known sequences, `send-keys -lt` for safe literal runs, and
`send-keys -l` for non-ASCII text.

`setDimensions()` debounces resize events (100 ms) and forwards via
`refresh-client -C <cols>,<rows>` (no per-pane resize — see
`resizeWindowForClient` for the rationale).

`close()` either lets tmux own the lifecycle (when it was tmux that closed
the window) or, after a 300 ms grace period, sends `kill-window` — but only
if the extension isn't deactivating. On VS Code shutdown the windows are
explicitly preserved so they can be re-adopted next launch.

## Tab title model (`windowTitle.ts`)

A tmux window's `#{window_name}` is authoritative and is shown verbatim in VS Code:

```text
name non-empty → label = name
name empty     → label = "tmux:<window_index>"
```

The extension does not change tmux's `automatic-rename` option. OSC 0/2 title
changes are read back from tmux's `#{pane_title}`, promoted to the tmux window
name, and then reflected in VS Code through the normal `%window-renamed`
notification.

The bidirectional rename sync works as follows:

* **VS Code → tmux**: a built-in "Rename…" mutates `terminal.name`. VS Code
  exposes no name-change event, so a 250 ms observer over tracked tmux
  terminals notices the divergence and calls `pty.syncNameToTmux(newName)`.
* **tmux → VS Code**: `%window-renamed` notifications are processed by
  `windowRenamedListener` and emitted to VS Code via `onDidChangeName`.
* **Explicit command**: `tmux-integrated.renameTerminal` calls
  `pty.renameWindow(newName)` which atomically updates both sides.

`emitNameIfChanged` deduplicates emissions so the bidirectional loop doesn't
echo forever. `tmux-integrated.syncWindowNames` can restrict synchronization to
either direction or disable it. OSC 0/2 controls are removed from renderer
output after tmux parses them so xterm.js cannot bypass that direction setting.

## Protocol layer (`tmuxGateway.ts`)

The gateway is byte-oriented (the PTY is opened with `encoding: null`) so
that:

* `%output` payloads can be octal-decoded as bytes and passed through a
  per-pane `StringDecoder` to preserve UTF-8 boundaries that span chunks.
* Bare `\r` injected by the PTY line driver is dropped, but **all other**
  control bytes (notably ESC = 0x1b) are preserved so that terminal protocol
  responses such as cursor-position reports are not truncated (see
  `decodeOutput` for the long-form rationale, and issue #26).

Write-queue invariants:

* `sendCommand(cmd)` returns a `Promise<string[]>` with the response lines.
* `sendCommandList(cmds)` joins commands with ` ; ` so they hit tmux as a
  single PTY write but produce one `%begin/%end` per command. The pending
  queue holds one entry per command and they are matched in order.
* All writes are buffered until `%session-changed` is received (or a
  `setImmediate` fallback fires after the first `%end` for tmux < 2.6).
* `CommandFlags.TolerateErrors` resolves with `[]` instead of rejecting on
  `%error` — used for fire-and-forget options like `set-option`.

## Connection lifecycle / reconnection

* Disconnect on extension dispose: `client.disconnect()` writes `detach\r`,
  kills the PTY. The tmux server keeps running and the session keeps its
  windows.
* `deactivate()` sets `disposing = true` so that `TmuxTerminal.close()` does
  not kill its window during shutdown.
* On the *next* activation, if `tmuxSessionExists()` returns true,
  `autoConnectExistingSession()` re-attaches to the same session and
  re-creates VS Code tabs from `listWindows()` output.
* For Remote-SSH/WSL: the extension declares `extensionKind: "workspace"` so
  tmux always runs on the same host as the user's processes.

## Latency hazards (and how we guard against them)

Two reported failure modes were traced to races that high-latency Remote-SSH
sessions amplify. Both are documented here so we don't regress them.

### "A fresh tmux window appears every time VS Code reconnects"

Three things compound:

1. **Concurrent `ensureClientConnected()` calls overwrote the in-flight
   client.** `autoConnectExistingSession()` is fire-and-forget from
   `activate()`. While `connect()` is mid-handshake, `client.isConnected()`
   returns `false` (the `_connected` flag is only set on `_ready`). Any
   second caller — typically `provideTerminalProfile` triggered by VS Code
   restoring a tab — would fall through and execute
   `client = new TmuxControlClient(...)`, orphaning the original PTY.
   *Mitigation:* `ensureClientConnected()` now memoises an in-flight promise
   so all callers await the same attempt.
2. **`windowsToAdopt` was a global queue that two paths raced to drain.**
   `autoConnect` snapshotted-and-cleared the queue, while
   `adoptNextWindow()` `shift()`-ed one and then cleared the rest. Whoever
   ran first won; the loser saw an empty queue and fell through to
   `client.newWindow(...)` — a fresh tmux window. *Mitigation:*
   `adoptNextWindow()` now only shifts a single entry and never clears the
   tail. `autoConnectExistingSession()` waits a short grace period after
   connect so that any `provideTerminalProfile` calls VS Code makes during
   restore get first dibs; only the leftover windows are then adopted by
   autoConnect.
3. **`adoptNextWindow()` cleared the queue after the first shift.** Even
   without autoConnect in the picture, if VS Code restored N profile-based
   tabs concurrently it would call `provideTerminalProfile` N times in
   quick succession; only the first found something to adopt. *Mitigation:*
   covered by the "shift one, never clear the tail" change above.

### "Tabs get renamed to 'zsh' or 'bash' on reconnect"

`TmuxTerminal.open()` registers `windowRenamedListener` before querying the
current name. tmux can emit `%window-renamed` while that query is in flight,
especially over a laggy SSH tunnel.

*Mitigations:*

* An `initialNameCommitted` guard suppresses the listener until `open()` has
  completed its authoritative `#{window_name}` query. After commit the listener
  works normally so subsequent tmux renames update the tab.

## Things that are intentionally absent

* **Splits.** Mapping `split-window` onto `vscode.Pseudoterminal` is not
  workable; we accept the 1:1 limitation.
* **Per-window environment via `new-window -e`.** Disabled for tmux 2.x
  compatibility — environment is propagated through `set-environment -t`.
* **Reconciliation / capture-pane polling.** Removed in Phase 1 — we trust
  xterm.js to stay in sync with `%output` and only `capture-pane` once on
  adoption to populate scrollback.
* **Pause-mode / extended-output latency tracking.** Listed in
  `doc/plan-alignWithIterm2TmuxIntegration.prompt.md` as future work.
