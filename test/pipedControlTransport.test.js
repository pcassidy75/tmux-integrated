/**
 * Tests for the Windows control-mode transport.
 *
 * On Windows node-pty means ConPTY, which re-renders the child's output and
 * corrupts the control-mode protocol (the handshake never completes). There
 * the client talks to tmux over plain stdio pipes instead. These tests drive
 * the real TmuxControlClient.connect() over that transport against a fake
 * tmux that greets the way psmux does: DCS opener, an unsolicited
 * %begin/%end pair, then %session-changed.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { TmuxControlClient, spawnPipedControlProcess } = require('../out/tmuxControlClient.js');

const FAKE_TMUX = `#!/usr/bin/env node
let n = 1;
const out = (s) => process.stdout.write(s);
out('\\x1bP1000p%begin 1 1 0\\n%end 1 1 0\\n');
out('%sessions-changed\\n%session-changed $0 fake\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let m;
  // Commands are terminated with \\r (like a tty client would send).
  while ((m = /[\\r\\n]/.exec(buf))) {
    const line = buf.slice(0, m.index).trim();
    buf = buf.slice(m.index + 1);
    if (!line) continue;
    if (line === 'detach') { process.exit(0); }
    n += 1;
    out('%begin 1 ' + n + ' 1\\n');
    if (line.startsWith('display-message')) out('__tmux_integrated_ready__\\n');
    out('%end 1 ' + n + ' 1\\n');
  }
});
`;

const SILENT_TMUX = `#!/usr/bin/env node
process.stdout.write('not control mode\\n');
setInterval(() => {}, 1000);
`;

function writeScript(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  return Promise.resolve()
    .then(fn)
    .finally(() => Object.defineProperty(process, 'platform', original));
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-integrated-pipe-'));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('connect() completes the handshake over pipes on win32', { skip: process.platform === 'win32' }, async () => {
  const fakeTmux = writeScript(tmpDir, 'fake-tmux', FAKE_TMUX);
  const client = new TmuxControlClient('fake', fakeTmux, '/nonexistent-app-root');
  await withPlatform('win32', async () => {
    // appRoot is bogus, so reaching the ready state proves node-pty was
    // never loaded.
    await client.connect({ startDirectory: tmpDir });
  });
  assert.equal(client.isConnected(), true);
  client.disconnect();
});

test('handshake timeout reports the bytes tmux sent', { skip: process.platform === 'win32' }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const silentTmux = writeScript(tmpDir, 'silent-tmux', SILENT_TMUX);
  const client = new TmuxControlClient('fake', silentTmux, '/nonexistent-app-root');
  await withPlatform('win32', async () => {
    const connecting = client.connect({ startDirectory: tmpDir });
    // Wait for the fake's output to arrive before firing the timeout.
    await new Promise((resolve) => client.pty.onData(() => resolve()));
    t.mock.timers.tick(10_000);
    await assert.rejects(connecting, /Timed out.*not control mode/s);
  });
  client.disconnect();
});

test('spawnPipedControlProcess reports exit and survives writes after exit', { skip: process.platform === 'win32' }, async () => {
  const script = writeScript(tmpDir, 'exit-fast', '#!/usr/bin/env node\nprocess.stdout.write("bye\\n");\n');
  const proc = spawnPipedControlProcess(script, [], tmpDir, process.env);
  const chunks = [];
  proc.onData((d) => chunks.push(Buffer.from(d)));
  const { exitCode } = await new Promise((resolve) => proc.onExit(resolve));
  assert.equal(exitCode, 0);
  assert.equal(Buffer.concat(chunks).toString(), 'bye\n');
  proc.write('late write\r');
});

test('spawnPipedControlProcess reports a missing binary as an exit, not a throw', { skip: process.platform === 'win32' }, async () => {
  const proc = spawnPipedControlProcess(path.join(tmpDir, 'does-not-exist'), [], tmpDir, process.env);
  const { exitCode } = await new Promise((resolve) => proc.onExit(resolve));
  assert.equal(exitCode, -1);
});
