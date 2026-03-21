# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.8] - 2026-03-21

### Changed

- Update Node.js to 22 for release workflow.

## [0.1.7] - 2026-03-21

### Added

- Phase 1 — extract TmuxGateway, add command flags, batching, and write queuing.

## [0.1.6] - 2026-03-21

### Added

- vscode terminal tab closes when tmux window exits
- exiting vscode terminal tab kills tmux window
- tmux-integrated.autoConnect option. Connect to windows when opening workspace (default: true)
- Update node version from 18 to 20 to enable auto publish workflow

## [0.1.5] - 2026-03-20

### Fixed

- bash '$;' bug modify send-keys
- zsh echo bug strip escapes

## [0.1.4] - 2026-03-20

### Fixed

- Removed dependency on tmux 3.x+ features allowing tmux 2.x to work
- Fixed scrolling
- Fixed resizing

## [0.1.3] - 2026-03-19

### Added

- GitHub Actions publish workflow for automated VS Code Marketplace and GitHub releases.

## [0.1.2] - 2025-03-18

### Added

- Github / VSCode Marketplace publish workflow

- Fixed persistence issue where tmux sessions were not properly maintained across reconnects.

## [0.1.1] - 2025-03-17

### Fixed

- Fixed persistence issue where tmux sessions were not properly maintained across reconnects.

### Removed

- Removed `tmux_pty_bridge.py` — PTY allocation now uses the native `script` command (macOS/Linux).

## [0.1.0] - 2025-03-16

### Added

- Initial release.
- Seamless tmux control-mode integration for VS Code terminals.
- Persistent terminal sessions that survive window reloads and reconnects.
- `code` command support from within tmux sessions.
- Copilot compatibility in tmux-backed terminals.
