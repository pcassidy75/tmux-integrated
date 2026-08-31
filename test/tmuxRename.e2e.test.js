/**
 * End-to-end rename-sync test against a REAL tmux server.
 *
 * Boots a private tmux server (isolated socket, no config) through the real
 * TmuxControlClient / TmuxGateway control-mode stack, then drives
 * TmuxTerminal exactly the way the extension does and asserts on actual
 * tmux state (`#{window_name}`, `#{automatic-rename}`).
 *
 * Skipped automatically when tmux or a loadable node-pty is unavailable.
 */
const assert = require('node:assert/strict');
const events = require('node:events');
const Module = require('node:module');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function environmentAvailable() {
  try {
    execFileSync('tmux', ['-V'], { stdio: ['ignore', 'pipe', 'ignore'] });
    require('node-pty');
    return true;
  } catch {
    return false;
  }
}

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

const originalLoad = Module._load;
Module._load = function loadMockedModule(request, parent, isMain) {
  if (request === 'vscode') {
    return { Disposable, EventEmitter: VscodeEventEmitter };
  }
  return originalLoad(request, parent, isMain);
};
const { TmuxTerminal } = require('../out/tmuxTerminalProvider.js');
const { TmuxControlClient } = require('../out/tmuxControlClient.js');
Module._load = originalLoad;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(description, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for: ${description}`);
    }
    await sleep(50);
  }
}

test(
  'rename sync end-to-end against a real tmux server',
  { skip: environmentAvailable() ? false : 'tmux or node-pty unavailable' },
  async (t) => {
    // Private server: dedicated socket, no user/system config.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-integrated-e2e-'));
    const wrapper = path.join(tmpDir, 'tmux-wrapper.sh');
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\nexec tmux -f /dev/null -L tmux-int-e2e-${process.pid} "$@"\n`,
      { mode: 0o755 },
    );

    const client = new TmuxControlClient('e2e', wrapper, repoRoot);
    client.setVersion(execFileSync('tmux', ['-V'], { encoding: 'utf8' }));
    t.after(() => {
      // Disconnect before killing the server so the control PTY is still
      // writable when disconnect() sends `detach`.
      try {
        client.disconnect();
      } catch {
        /* already disconnected */
      }
      try {
        execFileSync(wrapper, ['kill-server'], { stdio: 'ignore' });
      } catch {
        /* server already gone */
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    await client.connect({ startDirectory: tmpDir });

    const makeTerminal = (showAutomaticRename) => {
      const pty = new TmuxTerminal(
        client,
        tmpDir,
        {},
        '/bin/bash',
        showAutomaticRename,
        undefined,
        undefined,
        () => true, // never kill-window from close(); the server is torn down in after()
        () => {},
      );
      const titles = [];
      pty.onDidChangeName((name) => titles.push(name));
      return { pty, titles };
    };

    await t.test('default mode: pinning, both rename directions, echo suppression', async () => {
      const { pty, titles } = makeTerminal(false);
      await pty.open(undefined);
      const windowId = pty.getAttachedTmuxWindowId();
      assert.ok(windowId?.startsWith('@'), `expected a window id, got ${windowId}`);

      assert.equal(titles.length, 1);
      const label = titles[0];
      assert.match(label, /^tmux:\d+$/);

      await waitFor(
        'tmux window renamed to the pinned label',
        async () => (await client.getWindowName(windowId)) === label,
      );
      assert.equal(await client.getWindowAutomaticRename(windowId), false);

      // tmux → VS Code: rename from outside the control client (as if the
      // user ran `tmux rename-window` in a shell).
      execFileSync(wrapper, ['rename-window', '-t', windowId, 'renamed-from-tmux']);
      await waitFor(
        'tab title follows the tmux-side rename',
        () => titles[titles.length - 1] === 'renamed-from-tmux',
      );

      // Regression: a keystroke while VS Code still reports the old title
      // must NOT revert the tmux-side rename.
      pty.maybeSyncNameFromVsCode(label);
      await sleep(400);
      assert.equal(
        await client.getWindowName(windowId),
        'renamed-from-tmux',
        'stale VS Code title reverted the tmux-side rename',
      );

      // VS Code → tmux: a genuine user rename propagates.
      pty.maybeSyncNameFromVsCode('renamed-from-vscode');
      await waitFor(
        'tmux window follows the VS Code-side rename',
        async () => (await client.getWindowName(windowId)) === 'renamed-from-vscode',
      );
      // Its echo must not re-emit a title (the tab already shows it).
      await sleep(400);
      assert.ok(!titles.includes('renamed-from-vscode'));

      // Explicit rename command updates both sides, emitting exactly once.
      await pty.renameWindow('cmd-rename');
      await waitFor(
        'tmux window follows the rename command',
        async () => (await client.getWindowName(windowId)) === 'cmd-rename',
      );
      await sleep(400); // let the %window-renamed echo arrive
      assert.equal(titles.filter((name) => name === 'cmd-rename').length, 1);

      pty.close();
    });

    await t.test('showAutomaticRename: tab tracks the foreground process', async () => {
      const { pty, titles } = makeTerminal(true);
      await pty.open(undefined);
      const windowId = pty.getAttachedTmuxWindowId();

      await waitFor('initial automatic name emitted', () => titles.length >= 1);
      // The automatic name is usually the shell ('bash'), but tmux can
      // compute the pane command as 'tmux' if it looks mid-fork, before the
      // shell has exec'd. Both are genuine automatic names; the point is
      // that it is not a pinned tmux:<n> label.
      assert.ok(
        ['bash', 'tmux'].includes(titles[0]),
        `automatic window name expected, got ${titles[0]}`,
      );
      assert.equal(
        await client.getWindowAutomaticRename(windowId),
        true,
        'automatic-rename must be left on',
      );

      // tmux recomputes automatic names from its server event loop, which
      // sleeps while there is no traffic (`yes > /dev/null` produces no pane
      // output). Real sessions always have prompt/program output; in this
      // sterile test server the polling below stands in for that traffic and
      // keeps the loop awake.
      const nudgeTmux = () => client.getWindowName(windowId);

      // Foreground process change → tmux auto-renames → tab follows.
      pty.handleInput('yes > /dev/null\r');
      await waitFor('tab follows the foreground process name', async () => {
        await nudgeTmux();
        return titles[titles.length - 1] === 'yes';
      });

      // Explicit rename pins the window.
      await pty.renameWindow('pinned');
      await waitFor(
        'automatic-rename turned off by the explicit rename',
        async () => (await client.getWindowAutomaticRename(windowId)) === false,
      );
      await waitFor(
        'tmux window renamed',
        async () => (await client.getWindowName(windowId)) === 'pinned',
      );
      // The still-running `yes` must not rename a pinned window.
      await sleep(1500);
      assert.equal(await client.getWindowName(windowId), 'pinned');
      assert.equal(titles[titles.length - 1], 'pinned');

      // Reset hands the name back to tmux; the tab follows again.
      await pty.resetToAutomaticRename();
      await waitFor('tab returns to automatic naming', async () => {
        await nudgeTmux();
        return titles[titles.length - 1] === 'yes';
      });

      pty.handleInput('\x03'); // C-c: foreground back to bash
      await waitFor('tab follows the shell after C-c', async () => {
        await nudgeTmux();
        return titles[titles.length - 1] === 'bash';
      });

      pty.close();
    });
  },
);
