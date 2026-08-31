const assert = require('node:assert/strict');
const test = require('node:test');

const {
  pickTerminalTabTitle,
  tmuxAutomaticRenameIsOn,
  TabTitleSync,
} = require('../out/windowTitle.js');

test('tmuxAutomaticRenameIsOn accepts version-dependent truthy values', () => {
  for (const v of ['1', 'on', 'ON', ' yes ', 'true']) {
    assert.equal(tmuxAutomaticRenameIsOn(v), true, `expected "${v}" to read as on`);
  }
  for (const v of ['0', 'off', '', undefined, 'no']) {
    assert.equal(tmuxAutomaticRenameIsOn(v), false, `expected "${v}" to read as off`);
  }
});

test('pickTerminalTabTitle normalizes automatic names to tmux:<n> by default', () => {
  assert.equal(pickTerminalTabTitle('zsh', 3, true, false), 'tmux:3');
  assert.equal(pickTerminalTabTitle('zsh', undefined, true, false), 'tmux');
});

test('pickTerminalTabTitle shows automatic names when showAutomaticRename is on', () => {
  assert.equal(pickTerminalTabTitle('zsh', 3, true, true), 'zsh');
  assert.equal(pickTerminalTabTitle('  vim  ', 3, true, true), 'vim');
  // Empty automatic name still falls back to the index label.
  assert.equal(pickTerminalTabTitle('', 3, true, true), 'tmux:3');
  assert.equal(pickTerminalTabTitle(undefined, undefined, true, true), 'tmux');
});

test('pickTerminalTabTitle shows intentional (non-automatic) names verbatim in both modes', () => {
  for (const show of [false, true]) {
    assert.equal(pickTerminalTabTitle('build server', 2, false, show), 'build server');
    assert.equal(pickTerminalTabTitle('', 2, false, show), 'tmux:2');
    assert.equal(pickTerminalTabTitle(undefined, undefined, false, show), 'tmux');
  }
});

test('TabTitleSync classifies terminal names against emission history', () => {
  const sync = new TabTitleSync();

  // Before anything is emitted, every name is treated as in-sync (no action).
  sync.noteKnownTitle('tmux:0');
  assert.equal(sync.hasEmitted, false);
  assert.equal(sync.classifyTerminalName('tmux:0'), 'in-sync');
  assert.equal(sync.classifyTerminalName('anything'), 'in-sync');

  sync.recordEmission('mywin');
  assert.equal(sync.lastEmittedTitle, 'mywin');
  assert.equal(sync.classifyTerminalName('mywin'), 'in-sync');
  // The creation-options name may still be displayed while VS Code applies
  // the emission — that is not a user rename.
  assert.equal(sync.classifyTerminalName('tmux:0'), 'settling');
  // A never-seen name can only come from the user.
  assert.equal(sync.classifyTerminalName('user-picked'), 'user-rename');
  // Empty / whitespace names are ignored.
  assert.equal(sync.classifyTerminalName(''), 'in-sync');
  assert.equal(sync.classifyTerminalName('   '), 'in-sync');
  assert.equal(sync.classifyTerminalName(undefined), 'in-sync');
});

test('TabTitleSync never re-classifies an older emitted title as a user rename', () => {
  // Regression: a tmux-side rename could be reverted when the user typed
  // before VS Code finished applying the new title, because the (stale)
  // previous title diverged from the last emission and was pushed to tmux.
  const sync = new TabTitleSync();
  sync.recordEmission('tmux:0');
  // ... much later, tmux renames the window ...
  sync.recordEmission('renamed-in-tmux');
  // VS Code still reports the old title for a moment.
  assert.equal(sync.classifyTerminalName('tmux:0'), 'settling');
});

test('TabTitleSync consumes rename echoes exactly once', () => {
  const sync = new TabTitleSync();
  sync.recordRenameSentToTmux('foo');
  assert.equal(sync.consumeRenameEcho('foo'), true);
  assert.equal(sync.consumeRenameEcho('foo'), false, 'echo record must be consumed');
  assert.equal(sync.consumeRenameEcho('bar'), false);
});

test('TabTitleSync matches interleaved echoes from successive renames', () => {
  const sync = new TabTitleSync();
  sync.recordRenameSentToTmux('a');
  sync.recordRenameSentToTmux('b');
  // Echoes may be processed in order; both must be recognised.
  assert.equal(sync.consumeRenameEcho('a'), true);
  assert.equal(sync.consumeRenameEcho('b'), true);
  assert.equal(sync.consumeRenameEcho('a'), false);
});

test('TabTitleSync expires pending rename echoes after the TTL', () => {
  let clock = 0;
  const sync = new TabTitleSync(() => clock);
  sync.recordRenameSentToTmux('foo');
  clock += 60_000;
  assert.equal(
    sync.consumeRenameEcho('foo'),
    false,
    'a %window-renamed long after our command must be treated as external',
  );
});

test('TabTitleSync bounds its remembered-title history', () => {
  const sync = new TabTitleSync();
  sync.recordEmission('first');
  for (let i = 0; i < 500; i++) {
    sync.recordEmission(`title-${i}`);
  }
  // "first" has been evicted; with the current title unaffected.
  assert.equal(sync.classifyTerminalName('first'), 'user-rename');
  assert.equal(sync.classifyTerminalName('title-499'), 'in-sync');
  assert.equal(sync.classifyTerminalName('title-498'), 'settling');
});
