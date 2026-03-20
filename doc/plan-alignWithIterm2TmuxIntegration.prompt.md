## Plan: Align tmux-integrated with iTerm2's tmux integration

After a deep analysis of iTerm2's tmux integration — `TmuxGateway` (~1250 lines) + `TmuxController` (~3700 lines) + supporting classes like `TmuxWindowOpener`, `iTermTmuxBufferSizeMonitor`, `iTermTmuxClientTracker` — vs. this extension's ~1500 lines across 3 files, here are the gaps, prioritized by impact.

---

### Phase 1: Architecture & Protocol Hardening

1. **Separate Gateway from Controller** — iTerm2 cleanly separates `TmuxGateway` (protocol parsing, `%begin/%end` handling, command queuing) from `TmuxController` (business logic, window management). Currently `TmuxControlClient` conflates both roles. Extract a `TmuxGateway` class.
   - New `src/tmuxGateway.ts`, refactor `src/tmuxControlClient.ts` - **DONE**

2. **Command flags & error tolerance** — iTerm2's gateway supports `kTmuxGatewayCommandShouldTolerateErrors` (callback still runs on error with `nil`), `kTmuxGatewayCommandWantsData` (receive raw `NSData` not `NSString`), and `kTmuxGatewayCommandOfferToDetachIfLaggyDuplicate`. Currently all errors reject the promise and kill the flow.
   - `src/tmuxControlClient.ts` - **DONE**

3. **Command batching (`sendCommandList`)** — iTerm2 joins commands with `;` and sends as one line, tracking which responses belong to the same list. Used for atomic multi-step operations (resize + list-windows, split + list-panes). tmux-integrated sends commands one-at-a-time.
   - `src/tmuxControlClient.ts` - **DONE**

4. **Write queuing** — iTerm2 defers all writes until `%session-changed` is received, preventing races during init. tmux-integrated sends immediately after the initial handshake.
   - `src/tmuxControlClient.ts` - **DONE**

5. **Remove reconciliation mechanism** — The post-input reconciliation (`scheduleReconciliation` / `reconcile`) clears the VS Code terminal with `\x1b[H\x1b[2J` and rewrites it from a `capture-pane` snapshot every ~80ms after user input. In xterm.js, `\x1b[2J` pushes the current visible content into the scrollback buffer before blanking, so every reconciliation cycle duplicates the visible screen into scrollback. When the user scrolls up, the same lines repeat in a loop. iTerm2 does not reconcile — it trusts its VT100 parser to stay in sync with tmux `%output`. Remove reconciliation entirely and trust xterm.js the same way.
   - `src/tmuxTerminalProvider.ts` — **DONE**

### Phase 2: Version Detection & Compatibility

5. **Sophisticated version detection** — iTerm2 probes multiple commands to bracket the version between `minimumServerVersion`/`maximumServerVersion`, handling OpenBSD variants (`openbsd-7.1` → 3.4), `next-X.Y` prefixes, letter suffixes (`2.9a` → 2.91), and RC builds. tmux-integrated only parses `tmux -V` with a simple regex (`/(\d+)\.(\d+)/`).
   - `src/tmuxControlClient.ts` or new version detector

6. **Option validation** — iTerm2 validates that `aggressive-resize` is off and checks `status`, `focus-events`, `set-titles`, `default-terminal` options on connect. tmux-integrated does no validation.
   - `src/extension.ts`

### Phase 3: Window & Session Management

7. **Session management UI** — iTerm2 supports listing sessions, switching (`attach-session`), renaming, creating, and killing sessions via a dashboard. tmux-integrated is locked to one session per workspace.
   - `src/extension.ts`, new commands in `package.json`

8. **Window affinities** — iTerm2 persists which tmux windows should group together via `@affinities` session option (using `EquivalenceClassSet`), so tab grouping survives reconnects. tmux-integrated has no grouping concept.
   - `src/extension.ts`, `src/tmuxControlClient.ts`

9. **Hidden/buried windows** — iTerm2 lets users hide windows without killing them (`@hidden` session option), bury them in other terminal windows, and restore from a dashboard. tmux-integrated shows all-or-nothing.
   - `src/extension.ts`

10. **Double-attach detection** — iTerm2 stores `@iterm2_id` on the session to detect if another instance is already attached, preventing two clients from controlling the same session simultaneously.
    - `src/extension.ts`, `src/tmuxControlClient.ts`

### Phase 4: Split Pane Support

11. **Split pane support** — The biggest feature gap. iTerm2 fully handles `split-pane`, `move-pane`, `swap-pane`, `break-pane`, and processes `%layout-change` to update its split view. tmux-integrated maps 1 VS Code tab = 1 tmux window with no split support.
    - **Constraint**: VS Code's `Pseudoterminal` API has no split-pane abstraction. Options: (a) use VS Code's built-in terminal split (limited, only side-by-side), (b) webview renderer, (c) accept limitation. **Recommendation**: accept the 1:1 limitation but add a command to split the tmux window and open a new VS Code tab for the new pane.

12. **Per-window variable sizing (tmux 2.9+)** — iTerm2 uses `refresh-client -C @win:WxH` (tmux 3.4+) for per-window sizes. tmux-integrated uses one global client size. *Depends on step 5.*
    - `src/tmuxControlClient.ts`, `src/tmuxTerminalProvider.ts`

### Phase 5: Flow Control & Resilience

13. **Pause mode (tmux 3.2+)** — iTerm2 enables `refresh-client -fpause-after=N` for flow control with `iTermTmuxBufferSizeMonitor`. Without this, commands like `yes` produce unbounded output that can overwhelm the client.
    - New buffer monitor, `src/tmuxControlClient.ts`

14. **Unresponsiveness detection** — iTerm2 tracks command timestamps and detects when tmux hasn't responded within 5s, offering force-detach. tmux-integrated has a one-shot health check but no ongoing monitoring.
    - `src/tmuxControlClient.ts`

15. **Latency tracking** — iTerm2 parses latency from `%extended-output` timestamps for adaptive flow control. tmux-integrated ignores the latency field.
    - `src/tmuxControlClient.ts`

### Phase 6: Clipboard, Keys & Extras

16. **Paste buffer sync** — iTerm2 monitors `%paste-buffer-changed` and copies tmux buffers to system clipboard.

17. **Key binding import** — iTerm2 loads tmux key bindings via `list-keys` and maps them to native shortcuts. Could populate VS Code keybindings.

18. **Send keys as code points** — iTerm2 sends `send -lt %N <literal>` and `send -t %N 0xHH 0xHH` with max 1024-byte chunks (>1024 crashes tmux 1.8). tmux-integrated sends per-key `send-keys` commands, which is chattier and less efficient.

19. **Subscriptions (tmux 3.2+)** — `refresh-client -B 'name:target:format'` for efficient state monitoring.

20. **OSC 52 clipboard queries (tmux 3.6+)** — Low priority.

21. **Scrollback history capture** — Use `capture-pane -S -` (full history) instead of just the visible screen when adopting windows. — **DONE** (adoption in `open()` now uses `startLine: '-'`)

---

### Verification

1. `npm run compile` — no build errors after each phase
2. Test reconnection to existing sessions (window adoption flow)
3. Test with tmux 2.1, 2.9, 3.2, 3.4 to verify version-gated features
4. High-output stress test (`yes`, `find /`) after pause mode is implemented
5. Two VS Code windows attaching to the same tmux session (double-attach guard)

### Decisions

- Split pane support is fundamentally limited by VS Code's terminal API — recommend accepting the 1:1 mapping and documenting it
- Phases 1-2 are foundational and unblock everything else
- Phase 5 (flow control) is the highest-impact reliability improvement
- Phase 6 items are polish — nice-to-have but not critical

### Further Considerations

1. **Remote SSH support** — iTerm2's tmux integration works transparently over SSH. Does the extension work when VS Code is connected to a remote host? The `node-pty` resolution logic suggests yes, but pause mode becomes more important due to network latency. Recommend testing and documenting.
2. **tmux 3.4+ per-window sizing** — Should this be opt-in (setting) or automatic? iTerm2 auto-enables when tmux ≥ 2.9 and an advanced setting is on. Recommend auto-enable with a setting to disable.
