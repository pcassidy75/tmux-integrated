/**
 * Integration tests for the bidirectional tab-rename sync in TmuxTerminal,
 * driven through a fake TmuxControlClient (no real tmux, no real VS Code).
 *
 * Covers both directions and the races that used to corrupt names:
 *   - tmux → VS Code: %window-renamed updates the tab; echoes of our own
 *     rename-window commands are suppressed.
 *   - VS Code → tmux: user renames are pushed to tmux; *stale* titles that
 *     VS Code merely has not repainted yet are never pushed back (they used
 *     to revert tmux-side renames).
 *   - showAutomaticRename mode: the tab tracks tmux's automatic names.
 */
const assert = require('node:assert/strict');
const events = require('node:events');
const Module = require('node:module');
const test = require('node:test');

class Disposable {
  dispose() {}
}

class VscodeEventEmitter {
  constructor() {
    this.emitter = new events.EventEmitter();
    this.event = (listener) => {
      this.emitter.on('event', listener);
      return new Disposable();
    };
  }

  fire(value) {
    this.emitter.emit('event', value);
  }
}

// tmuxTerminalProvider only needs vscode.EventEmitter at runtime.
const vscodeMock = { Disposable, EventEmitter: VscodeEventEmitter };
const originalLoad = Module._load;
Module._load = function loadMockedModule(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeMock;
  }
  return originalLoad(request, parent, isMain);
};
const { TmuxTerminal } = require('../out/tmuxTerminalProvider.js');
Module._load = originalLoad;

/**
 * Minimal in-memory stand-in for TmuxControlClient. Records every command
 * and keeps a window "name" that rename-window commands update, so open()'s
 * current-name checks behave like the real thing.
 */
class FakeTmuxClient extends events.EventEmitter {
  constructor({ name = 'zsh' } = {}) {
    super();
    this.commands = [];
    this.name = name;
    this.windowNameGate = null;
  }

  isConnected() {
    return true;
  }

  async sendCommand(command) {
    this.record(command);
    return [];
  }

  async sendCommandList(commands) {
    for (const command of commands) {
      this.record(command);
    }
    return commands.map(() => []);
  }

  record(command) {
    this.commands.push(command);
    const renamed = /^rename-window -t \S+ '(.*)'$/.exec(command);
    if (renamed) {
      this.name = renamed[1];
    }
  }

  async newWindow() {
    return { windowId: '@7', paneId: '%9', windowIndex: 5 };
  }

  async getWindowIndex() {
    return 5;
  }

  async getWindowName() {
    if (this.windowNameGate) {
      await this.windowNameGate;
    }
    return this.name;
  }

  async getWindowAutomaticRename() {
    return true;
  }

  async resizeWindowForClient() {}

  async capturePane() {
    return '';
  }

  async getPaneCursor() {
    return { x: 0, y: 0 };
  }

  removePaneDecoder() {}
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeTerminal(client, { showAutomaticRename = false, existingWindow } = {}) {
  const pty = new TmuxTerminal(
    client,
    undefined,
    {},
    '/bin/bash',
    showAutomaticRename,
    existingWindow,
    undefined,
    () => true,
    () => {},
  );
  const titles = [];
  pty.onDidChangeName((name) => titles.push(name));
  return { pty, titles };
}

test('default mode: new window is normalized to tmux:<n> and pinned', async () => {
  const client = new FakeTmuxClient();
  const { pty, titles } = makeTerminal(client);

  await pty.open(undefined);

  assert.deepEqual(titles, ['tmux:5']);
  assert.ok(client.commands.includes('set-option -w -t @7 automatic-rename off'));
  assert.ok(client.commands.includes(`rename-window -t @7 'tmux:5'`));
  assert.equal(client.name, 'tmux:5', 'tmux window renamed to match the tab');

  // The %window-renamed echo of our own normalization must not re-emit.
  client.emit('window-renamed', { windowId: '@7', name: 'tmux:5' });
  assert.deepEqual(titles, ['tmux:5']);
});

test('default mode: external tmux renames update the tab; other windows are ignored', async () => {
  const client = new FakeTmuxClient();
  const { pty, titles } = makeTerminal(client);
  await pty.open(undefined);

  client.emit('window-renamed', { windowId: '@99', name: 'not-ours' });
  client.emit('window-renamed', { windowId: '@7', name: 'deploy' });
  assert.deepEqual(titles, ['tmux:5', 'deploy']);
});

test('stale terminal.name is never pushed back to tmux (rename-revert regression)', async () => {
  const client = new FakeTmuxClient();
  const { pty, titles } = makeTerminal(client);
  await pty.open(undefined);

  // A rename made on the tmux side...
  client.name = 'renamed-in-tmux';
  client.emit('window-renamed', { windowId: '@7', name: 'renamed-in-tmux' });
  assert.deepEqual(titles, ['tmux:5', 'renamed-in-tmux']);

  // ...while VS Code still reports the old title (onDidChangeName applies
  // asynchronously). The keystroke probe used to push 'tmux:5' back to tmux
  // here, reverting the rename.
  const before = client.commands.length;
  pty.maybeSyncNameFromVsCode('tmux:5');
  await tick();
  assert.equal(client.commands.length, before, 'no command may be sent for a stale title');
  assert.equal(client.name, 'renamed-in-tmux');
});

test('user rename in VS Code is pushed to tmux once, echo suppressed', async () => {
  const client = new FakeTmuxClient();
  const { pty, titles } = makeTerminal(client);
  await pty.open(undefined);

  pty.maybeSyncNameFromVsCode('user-picked');
  await tick();
  assert.ok(client.commands.includes(`rename-window -t @7 'user-picked'`));
  assert.equal(client.name, 'user-picked');

  // The echo must not re-emit (the tab already shows the name), and a second
  // probe with the same name must not send anything again.
  client.emit('window-renamed', { windowId: '@7', name: 'user-picked' });
  assert.deepEqual(titles, ['tmux:5'], 'no extra emission for our own rename');
  const before = client.commands.length;
  pty.maybeSyncNameFromVsCode('user-picked');
  await tick();
  assert.equal(client.commands.length, before);
});

test('adoption: fixed window names are shown and the creation name never syncs back', async () => {
  const client = new FakeTmuxClient({ name: 'mywin' });
  const { pty, titles } = makeTerminal(client, {
    existingWindow: {
      windowId: '@3',
      paneId: '%4',
      windowIndex: 3,
      name: 'mywin',
      automaticRename: false,
    },
  });

  await pty.open(undefined);

  assert.deepEqual(titles, ['mywin']);
  assert.ok(
    !client.commands.some((c) => c.startsWith('rename-window')),
    'no rename needed when the tmux name already matches',
  );

  // Until VS Code applies 'mywin', terminal.name is still the creation-options
  // name 'tmux:3'. A keystroke in that window must not rename the tmux window.
  const before = client.commands.length;
  pty.maybeSyncNameFromVsCode('tmux:3');
  await tick();
  assert.equal(client.commands.length, before);
  assert.equal(client.name, 'mywin');
});

test('rapid successive renames do not flicker through stale echoes', async () => {
  const client = new FakeTmuxClient();
  const { pty, titles } = makeTerminal(client);
  await pty.open(undefined);

  await pty.renameWindow('first');
  await pty.renameWindow('second');
  assert.deepEqual(titles, ['tmux:5', 'first', 'second']);

  // Late echoes arrive in order; neither may re-emit (the old code re-emitted
  // 'first', flicking the tab backwards).
  client.emit('window-renamed', { windowId: '@7', name: 'first' });
  client.emit('window-renamed', { windowId: '@7', name: 'second' });
  assert.deepEqual(titles, ['tmux:5', 'first', 'second']);
});

test('showAutomaticRename: tab tracks tmux automatic names, tmux options untouched', async () => {
  const client = new FakeTmuxClient({ name: 'zsh' });
  const { pty, titles } = makeTerminal(client, { showAutomaticRename: true });

  await pty.open(undefined);

  assert.deepEqual(titles, ['zsh'], 'automatic name shown instead of tmux:<n>');
  assert.ok(
    !client.commands.some((c) => c.includes('automatic-rename')),
    'automatic-rename option must not be touched',
  );
  assert.ok(!client.commands.some((c) => c.startsWith('rename-window')));

  // Foreground process changes flow straight to the tab.
  client.emit('window-renamed', { windowId: '@7', name: 'vim' });
  assert.deepEqual(titles, ['zsh', 'vim']);

  // A stale probe with the previous automatic name must not pin the window.
  const before = client.commands.length;
  pty.maybeSyncNameFromVsCode('zsh');
  await tick();
  assert.equal(client.commands.length, before);
});

test('showAutomaticRename: explicit rename pins the window; reset returns it to tmux', async () => {
  const client = new FakeTmuxClient({ name: 'zsh' });
  const { pty, titles } = makeTerminal(client, { showAutomaticRename: true });
  await pty.open(undefined);

  await pty.renameWindow('pinned');
  assert.deepEqual(titles, ['zsh', 'pinned']);
  assert.ok(client.commands.includes('set-option -w -t @7 automatic-rename off'));
  assert.ok(client.commands.includes(`rename-window -t @7 'pinned'`));
  client.emit('window-renamed', { windowId: '@7', name: 'pinned' });
  assert.deepEqual(titles, ['zsh', 'pinned'], 'echo suppressed');

  await pty.resetToAutomaticRename();
  assert.ok(client.commands.includes('set-option -w -t @7 automatic-rename on'));
  // tmux recomputes the name and notifies us.
  client.emit('window-renamed', { windowId: '@7', name: 'bash' });
  assert.deepEqual(titles, ['zsh', 'pinned', 'bash']);
});

test('showAutomaticRename: a rename arriving during open() is not clobbered', async () => {
  const client = new FakeTmuxClient({ name: 'zsh' });
  let release;
  client.windowNameGate = new Promise((resolve) => {
    release = resolve;
  });
  const { pty, titles } = makeTerminal(client, { showAutomaticRename: true });

  const opening = pty.open(undefined);
  await tick();
  // While open() awaits getWindowName, tmux's automatic-rename fires.
  client.emit('window-renamed', { windowId: '@7', name: 'vim' });
  release();
  await opening;

  assert.deepEqual(titles, ['vim'], 'the fresher name wins; the stale candidate is dropped');
});

test('default mode: automatic-rename events during open() cannot hijack the title', async () => {
  const client = new FakeTmuxClient({ name: 'zsh' });
  let release;
  client.windowNameGate = new Promise((resolve) => {
    release = resolve;
  });
  const { pty, titles } = makeTerminal(client);

  const opening = pty.open(undefined);
  await tick();
  // tmux's automatic-rename racing ahead of our set-option ... off command.
  client.emit('window-renamed', { windowId: '@7', name: 'zsh' });
  release();
  await opening;

  assert.deepEqual(titles, ['tmux:5']);
});
