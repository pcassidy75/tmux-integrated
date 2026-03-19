## [0.1.3](https://github.com/pcassidy75/tmux-integrated/compare/v0.1.2...v0.1.3) (2026-03-19)
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
