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

## Source layout

| File | Role |
|---|---|
| `src/extension.ts` | Activation, lifecycle, terminal-profile + command registration, autoConnect, status bar, env-var forwarding, start-directory resolution (incl. the multi-root folder pick). |
| `src/tmuxTerminalProvider.ts` | The `vscode.Pseudoterminal` (`TmuxTerminal`). Forwards user input to a tmux pane, renders pane output back into xterm.js, and owns the tab name. |
| `src/windowTitle.ts` | Pure helpers that decide the VS Code tab title from tmux's `#{window_name}` and `#{automatic-rename}`. |
| `src/tmuxControlClient.ts` | High-level typed tmux operations (`newWindow`, `listWindows`, `resizeWindowForClient`, …), node-pty resolution (see *Loading node-pty*) and PTY lifecycle, version gating. Wraps `TmuxGateway`. |
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
   PTY (see *Loading node-pty* below), runs the protocol handshake, and
   resolves once the readiness probe round-trips.
4. Subscribe to `session-window-changed` and `tmux-exit` events.
5. Set `default-terminal xterm-256color` and forward `VSCODE_*` env vars via
   `set-environment -t <session>`.
6. Populate either:
   * `bootstrapWindow` — when the session was *just* created and tmux opened a
     single initial window, OR
   * `windowsToAdopt[]` — when the session already existed; one entry per
     pre-existing tmux window.

## Loading node-pty

`tmux -CC` must run inside a real PTY. Rather than shipping a native
dependency compiled per platform *and* per Electron ABI, the extension
borrows the `node-pty` build that VS Code itself ships — by construction it
matches the extension host's ABI. The catch is that *where* that build lives
has changed several times across VS Code releases, and VS Code 1.129
(re-)introduced ASAR packaging so the package is no longer loadable from a
single directory at all. `requireNodePty()` in `tmuxControlClient.ts`
resolves this in two stages:

1. **Direct require (zero-copy).** Probe `<appRoot>/<root>/<pkg>` for every
   combination of root × package name:
   * roots: `node_modules` (remote server, Cursor, desktop ≤ 1.128),
     `node_modules.asar` (desktop ≥ 1.129 and the older ASAR era: the JS
     lives inside the archive — the extension host is an Electron process,
     so requiring from inside the archive works and Electron transparently
     redirects the native `pty.node` load to `node_modules.asar.unpacked`),
     and `node_modules.asar.unpacked` (builds that unpacked the whole
     module).
   * packages: `node-pty` and `@vscode/node-pty`.
2. **Copy-shim fallback** (`materializeNodePtyShim()`), for layouts that
   ship *no* loadable JavaScript (none exist today; this guards against the
   direction hinted at by VS Code's Copilot extension, which uses the same
   technique). The extension bundles node-pty's JavaScript as a pinned
   dependency (only `package.json` + `lib/**` are packaged into the VSIX —
   see `.vscodeignore`), pairs it with the native files found under the
   installation (`build/Release`, `build/Debug`, or
   `prebuilds/<platform>-<arch>`), and materializes the combined package in
   the extension's **global storage** — not the extension install directory,
   which may be read-only and is replaced on every update. If the copy fails
   but a usable shim is already materialized (typically a second VS Code
   window's extension host holding the previously copied `pty.node` open on
   Windows, so the overwrite raises `EPERM`/`EBUSY`), the existing shim is
   reused.

If both stages fail, the thrown error lists every candidate with its
individual failure reason ("not found" vs. an actual load error such as an
ABI mismatch) so the output channel pinpoints the problem — this is how
issue #33 (VS Code 1.129) was diagnosed.

## Where new terminal tabs come from

There are three doorways into "create a VS Code terminal tab":

1. **Profile provider** (`provideTerminalProfile`). Called by VS Code when a
   user opens a terminal that uses the `tmux-integrated` profile (including
   the case where `terminal.integrated.defaultProfile.<os>` selects it). The
   provider prefers, in order:
   * `bootstrapWindow` (just-created session's first window)
   * the next entry from `windowsToAdopt`
   * `client.newWindow(...)` — i.e. *create a fresh tmux window*.
2. **`tmux-integrated.newTerminal` command**. Always calls `newWindow`.
3. **`tmux-integrated.attachWindow` command**. Pops a quick-pick over
   `listWindows()` minus already-attached windows, then creates a VS Code
   terminal that adopts the chosen window.
4. **`autoConnectExistingSession()`**. After connect, iterates the
   `windowsToAdopt` snapshot and creates one VS Code terminal per remaining
   window via `vscode.window.createTerminal(buildTerminalOptions(w))`.

In a **multi-root workspace**, paths that create a *genuinely new* tmux
window (`provideTerminalProfile` falling through to `newWindow`, and the
`newTerminal` command) first show a quick-pick over the workspace folders
(`pickStartDirectory`) to decide the terminal's start directory — VS Code
does not expose its own folder selection to custom PTY profile providers.
When the connection itself is about to create a brand-new session, the pick
happens *before* connecting so the session starts in the chosen folder.
Adoption and bootstrap paths skip the pick: their windows already have a
working directory.

Whichever path runs, `buildTerminalOptions(existingWindow?, startDirectory?)`
constructs a fresh `TmuxTerminal` and returns it as a
`vscode.ExtensionTerminalOptions`.
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
  |-- query #{automatic-rename}, decide tab label (pickTerminalTabTitle)
  |-- set-option -w automatic-rename off
  |-- emit initial tab name
  |-- if (current name in tmux ≠ chosen label) → rename-window
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

`close()` cleans up the listeners and bookkeeping for the VS Code view without
killing its tmux window. The window, pane, and foreground process remain alive
so the window can be attached or automatically re-adopted later. Conversely,
the `window-close` and `tmux-exit` listeners close the VS Code tab when tmux
owns the lifecycle event.

## Tab title model (`windowTitle.ts`)

A tmux window has both a `#{window_name}` and an `#{automatic-rename}` flag.
When automatic-rename is on, tmux owns the title (it changes to whatever
process is in the foreground — `zsh`, `bash`, `vim`, …). When it is off, the
current name is treated as intentional (set by user or by us) and shown
verbatim.

```text
automatic-rename=on  → label = "tmux:<window_index>"
automatic-rename=off, name non-empty → label = name
automatic-rename=off, name empty     → label = "tmux:<window_index>"
```

After we settle on a label in `open()`, the extension immediately turns
automatic-rename off and (if needed) issues `rename-window` so tmux's notion
of the title matches what VS Code shows.

The bidirectional rename sync works as follows:

* **VS Code → tmux**: a built-in "Rename…" mutates `terminal.name`. The
  `setOnInputCallback` keystroke probe in `extension.ts` notices the
  divergence and calls `pty.syncNameToTmux(newName)`.
* **tmux → VS Code**: `%window-renamed` notifications are processed by
  `windowRenamedListener` and emitted to VS Code via `onDidChangeName`.
* **Explicit command**: `tmux-integrated.renameTerminal` calls
  `pty.renameWindow(newName)` which atomically updates both sides.

`emitNameIfChanged` deduplicates emissions so the bidirectional loop doesn't
echo forever.

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

`TmuxTerminal.open()` registers `windowRenamedListener` early (correct —
we mustn't drop events) and only later issues `set-option -w
automatic-rename off`. tmux can emit `%window-renamed @id zsh` from its own
automatic-rename feature in the gap between those two steps. The listener
processed those events as if they were intentional renames, so the VS Code
tab title became "zsh" / "bash" / whatever the foreground process happened
to be. The race window is sub-millisecond locally but seconds-wide over a
laggy SSH tunnel.

*Mitigations:*

* An `initialNameCommitted` guard suppresses the listener until `open()`
  has settled the title. After commit the listener works normally so
  user-initiated `rename-window` from inside tmux still updates the tab.
* `name` and `automaticRename` are now propagated all the way from
  `listWindows()` into `existingWindow`, so on reconnect we don't need a
  fresh round-trip just to find out what the window is called.

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
