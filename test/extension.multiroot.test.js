const assert = require('node:assert/strict');
const events = require('node:events');
const Module = require('node:module');
const test = require('node:test');

const folders = [
  { name: 'resume', index: 0, uri: { fsPath: '/workspace/resume' } },
  { name: 'Applications', index: 1, uri: { fsPath: '/workspace/Applications' } },
];

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

class FakeTmuxControlClient extends events.EventEmitter {
  static instances = [];

  constructor() {
    super();
    this.connected = false;
    this.disconnectCount = 0;
    FakeTmuxControlClient.instances.push(this);
  }

  setVersion() {}

  versionAtLeast() {
    return true;
  }

  isConnected() {
    return this.connected;
  }

  async connect() {
    this.connected = true;
  }

  disconnect() {
    this.disconnectCount += 1;
    this.connected = false;
  }

  async listWindows() {
    return [{ id: '@1', paneId: '%1', index: 0, name: 'tmux:0', automaticRename: true }];
  }

  async sendCommand(command) {
    return command.includes('__ping__') ? ['__ping__'] : [];
  }

  async updateEnvironment() {}
}

test('uses the selected workspace folder as a new tmux terminal cwd', async () => {
  let profileProvider;
  const vscode = {
    Disposable,
    EventEmitter,
    StatusBarAlignment: { Left: 1 },
    TerminalProfile: class {
      constructor(options) {
        this.options = options;
      }
    },
    Uri: { parse: (value) => ({ value }) },
    env: { appRoot: '/mock/vscode', openExternal() {} },
    workspace: {
      workspaceFolders: folders,
      getConfiguration(section) {
        return {
          get(key, fallback) {
            if (section === 'tmux-integrated' && key === 'autoConnect') {
              return false;
            }
            return fallback;
          },
        };
      },
    },
    window: {
      terminals: [],
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {}, text: '', command: '' }),
      registerTerminalProfileProvider(_id, provider) {
        profileProvider = provider;
        return new Disposable();
      },
      showQuickPick: async (items) => items.find((item) => item.workspaceFolder?.index === 1),
      showErrorMessage: async () => undefined,
      showWarningMessage() {},
      onDidOpenTerminal: () => new Disposable(),
      onDidCloseTerminal: () => new Disposable(),
      onDidChangeActiveTerminal: () => new Disposable(),
    },
    commands: { registerCommand: () => new Disposable() },
  };

  const originalLoad = Module._load;
  Module._load = function loadMockedModule(request, parent, isMain) {
    if (request === 'vscode') {
      return vscode;
    }
    if (request === 'child_process') {
      return {
        execFileSync(_file, args) {
          if (args[0] === '-V') {
            return 'tmux 3.5a\n';
          }
          if (args[0] === 'has-session') {
            throw new Error('missing session');
          }
          return '';
        },
      };
    }
    if (request.endsWith('/tmuxControlClient') || request === './tmuxControlClient') {
      return {
        TmuxControlClient: FakeTmuxControlClient,
        CommandFlags: { None: 0, TolerateErrors: 1 },
        shellescape: (value) => value,
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const extension = require('../out/extension.js');
    await extension.activate({
      extensionPath: '/extension',
      globalStorageUri: { fsPath: '/extension-storage' },
      subscriptions: [],
    });
    assert.ok(profileProvider, 'profile provider was registered');

    const profile = await profileProvider.provideTerminalProfile({ isCancellationRequested: false });

    assert.equal(profile.options.pty.startDirectory, '/workspace/Applications');
    assert.equal(FakeTmuxControlClient.instances.length, 1);

    extension.deactivate();
    assert.equal(FakeTmuxControlClient.instances[0].disconnectCount, 1,
      'deactivation must use the safe control-client disconnect path');
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../out/extension.js')];
  }
});
