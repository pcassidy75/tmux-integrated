const assert = require('node:assert/strict');
const events = require('node:events');
const Module = require('node:module');
const test = require('node:test');

const folders = [
  { name: 'resume', index: 0, uri: { fsPath: '/workspace/resume' } },
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

/**
 * Run activate() + provideTerminalProfile() against a mocked vscode /
 * child_process and report which tmux binary the extension used.
 *
 * @param {object} opts
 * @param {string} [opts.tmuxPath]  value of the tmux-integrated.tmuxPath setting
 * @param {boolean} [opts.tmuxMissing]  make every tmux invocation fail (ENOENT)
 */
async function runExtension({ tmuxPath = '', tmuxMissing = false } = {}) {
  const execCalls = [];
  const clientConstructorArgs = [];
  const errorMessages = [];

  class FakeTmuxControlClient extends events.EventEmitter {
    constructor(...args) {
      super();
      clientConstructorArgs.push(args);
    }

    setVersion() {}

    versionAtLeast() {
      return true;
    }

    isConnected() {
      return true;
    }

    async connect() {}

    async listWindows() {
      return [{ id: '@1', paneId: '%1', index: 0, name: 'tmux:0', automaticRename: true }];
    }

    async sendCommand(command) {
      return command.includes('__ping__') ? ['__ping__'] : [];
    }

    async updateEnvironment() {}
  }

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
            if (section === 'tmux-integrated' && key === 'tmuxPath') {
              return tmuxPath;
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
      showErrorMessage: async (message) => {
        errorMessages.push(message);
        return undefined;
      },
      showWarningMessage() {},
      onDidOpenTerminal: () => new Disposable(),
      onDidCloseTerminal: () => new Disposable(),
      onDidChangeActiveTerminal: () => new Disposable(),
    },
    commands: { registerCommand: () => new Disposable(), executeCommand: async () => {} },
  };

  const originalLoad = Module._load;
  Module._load = function loadMockedModule(request, parent, isMain) {
    if (request === 'vscode') {
      return vscode;
    }
    if (request === 'child_process') {
      return {
        execFileSync(file, args) {
          execCalls.push({ file, args });
          if (tmuxMissing) {
            throw new Error(`spawn ${file} ENOENT`);
          }
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

    const profilePromise = profileProvider.provideTerminalProfile({ isCancellationRequested: false });
    return { result: await profilePromise.then(
      (profile) => ({ profile }),
      (error) => ({ error }),
    ), execCalls, clientConstructorArgs, errorMessages };
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../out/extension.js')];
  }
}

test('empty tmuxPath setting resolves tmux from PATH', async () => {
  const { result, execCalls, clientConstructorArgs } = await runExtension({ tmuxPath: '' });

  assert.ok(result.profile, 'terminal profile was created');
  assert.ok(execCalls.length > 0, 'tmux was probed');
  for (const call of execCalls) {
    assert.equal(call.file, 'tmux');
  }
  assert.equal(clientConstructorArgs.length, 1);
  assert.equal(clientConstructorArgs[0][1], 'tmux');
});

test('tmuxPath setting overrides the tmux binary everywhere', async () => {
  const configured = '/opt/homebrew/bin/tmux';
  const { result, execCalls, clientConstructorArgs } = await runExtension({ tmuxPath: configured });

  assert.ok(result.profile, 'terminal profile was created');
  assert.ok(execCalls.length > 0, 'tmux was probed');
  for (const call of execCalls) {
    assert.equal(call.file, configured);
  }
  assert.equal(clientConstructorArgs.length, 1);
  assert.equal(clientConstructorArgs[0][1], configured);
});

test('whitespace-only tmuxPath falls back to PATH resolution', async () => {
  const { result, execCalls } = await runExtension({ tmuxPath: '   ' });

  assert.ok(result.profile, 'terminal profile was created');
  for (const call of execCalls) {
    assert.equal(call.file, 'tmux');
  }
});

test('error mentions the configured tmuxPath when the binary is missing', async () => {
  const configured = '/nonexistent/tmux';
  const { result, errorMessages } = await runExtension({
    tmuxPath: configured,
    tmuxMissing: true,
  });

  assert.ok(result.error, 'profile creation failed');
  assert.equal(errorMessages.length, 1);
  assert.match(errorMessages[0], /\/nonexistent\/tmux/);
  assert.match(errorMessages[0], /tmux-integrated\.tmuxPath/);
});

test('error suggests the tmuxPath setting when tmux is missing from PATH', async () => {
  const { result, errorMessages } = await runExtension({ tmuxMissing: true });

  assert.ok(result.error, 'profile creation failed');
  assert.equal(errorMessages.length, 1);
  assert.match(errorMessages[0], /not installed or not in PATH/);
  assert.match(errorMessages[0], /tmux-integrated\.tmuxPath/);
});
