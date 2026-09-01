const assert = require('node:assert/strict');
const events = require('node:events');
const Module = require('node:module');
const test = require('node:test');

class Disposable {
  dispose() {}
}

class EventEmitter {
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

class FakeClient extends events.EventEmitter {
  constructor(windowName = 'persisted') {
    super();
    this.windowName = windowName;
    this.commands = [];
    this.removedPaneDecoders = [];
  }

  isConnected() {
    return true;
  }

  async sendCommand(command) {
    this.commands.push(command);
    return [];
  }

  async getWindowName() {
    return this.windowName;
  }

  async capturePane() {
    return '';
  }

  async getPaneCursor() {
    return { x: 0, y: 0 };
  }

  removePaneDecoder(paneId) {
    this.removedPaneDecoders.push(paneId);
  }
}

function loadTmuxTerminal() {
  const vscode = { EventEmitter };
  const originalLoad = Module._load;
  Module._load = function loadMockedModule(request, parent, isMain) {
    if (request === 'vscode') {
      return vscode;
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    return require('../out/tmuxTerminalProvider.js').TmuxTerminal;
  } finally {
    Module._load = originalLoad;
  }
}

function createTerminal(TmuxTerminal, client, windowId, paneId, onDetached = () => {}) {
  return new TmuxTerminal(
    client,
    '/workspace',
    {},
    '/bin/sh',
    {
      windowId,
      paneId,
      windowIndex: 1,
      name: client.windowName,
      automaticRename: false,
    },
    { onWindowDetached: onDetached },
  );
}

test('user-driven close cleans up listeners without sending destructive tmux commands', async () => {
  const TmuxTerminal = loadTmuxTerminal();
  const client = new FakeClient();
  const detached = [];
  const terminal = createTerminal(TmuxTerminal, client, '@1', '%1', (id) => detached.push(id));

  await terminal.open(undefined);
  assert.equal(client.listenerCount('output'), 1);
  assert.equal(client.listenerCount('window-close'), 1);
  assert.equal(client.listenerCount('window-renamed'), 1);
  assert.equal(client.listenerCount('tmux-exit'), 1);

  terminal.close();

  assert.deepEqual(detached, ['@1']);
  assert.deepEqual(client.removedPaneDecoders, ['%1']);
  assert.equal(client.listenerCount('output'), 0);
  assert.equal(client.listenerCount('window-close'), 0);
  assert.equal(client.listenerCount('window-renamed'), 0);
  assert.equal(client.listenerCount('tmux-exit'), 0);
  assert.equal(
    client.commands.some((command) => /\bkill-(?:window|session|server)\b/u.test(command)),
    false,
  );
});

test('tmux window-close still closes the corresponding pseudoterminal', async () => {
  const TmuxTerminal = loadTmuxTerminal();
  const client = new FakeClient();
  const terminal = createTerminal(TmuxTerminal, client, '@2', '%2');
  const closeCodes = [];
  terminal.onDidClose((code) => closeCodes.push(code));

  await terminal.open(undefined);
  client.emit('window-close', '@unrelated');
  assert.deepEqual(closeCodes, []);

  client.emit('window-close', '@2');
  assert.deepEqual(closeCodes, [0]);
  assert.equal(client.listenerCount('window-close'), 0);
  assert.deepEqual(client.removedPaneDecoders, ['%2']);
});
