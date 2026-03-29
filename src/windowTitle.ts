/**
 * VS Code terminal tab titles from tmux `#{window_name}`.
 *
 * When tmux's per-window **automatic-rename** option is on, the title is still
 * owned by tmux (shell / cwd / format) — we normalize those to `tmux:&lt;n&gt;`
 * and sync with `rename-window`. When automatic-rename is off, the current
 * name is treated as intentional (user or this extension) and shown as-is.
 *
 * This avoids maintaining a list of shell names; tmux already encodes “auto vs fixed”.
 */

/** Interpret `#{automatic-rename}` / `list-windows` field (version-dependent values). */
export function tmuxAutomaticRenameIsOn(value: string | undefined): boolean {
    const v = (value ?? '').trim().toLowerCase();
    return v === '1' || v === 'on' || v === 'yes' || v === 'true';
}

/**
 * @param windowName current `#{window_name}`
 * @param windowIndex zero-based `#{window_index}`
 * @param automaticRename whether tmux is still auto-renaming this window
 */
export function pickTerminalTabTitle(
    windowName: string | undefined,
    windowIndex: number | undefined,
    automaticRename: boolean | undefined,
): string {
    if (automaticRename === true) {
        return windowIndex !== undefined ? `tmux:${windowIndex}` : 'tmux';
    }
    const raw = windowName?.trim();
    if (raw) {
        return raw;
    }
    return windowIndex !== undefined ? `tmux:${windowIndex}` : 'tmux';
}
