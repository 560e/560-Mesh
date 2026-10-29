import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { initialize } from '../../head-docker/platform/initialize.mjs';
import { checkHealth } from '../../head-docker/platform/healthcheck.mjs';
import { supervise } from '../../head-docker/platform/supervisor.mjs';

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'hs560-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const options = { publicUrl: 'https://hs.example.com', baseDomain: 'tailnet.example.com' };

test('initialization writes matching URLs, a 32-character secret, and preserves official options', async (t) => {
  const root = await workspace(t);
  await initialize({ root, ...options });
  const hs = await readFile(join(root, 'config/headscale/config.yaml'), 'utf8');
  const hp = await readFile(join(root, 'config/headplane/config.yaml'), 'utf8');
  assert.match(hs, /server_url: "https:\/\/hs.example.com"/);
  assert.match(hs, /listen_addr: 0\.0\.0\.0:8080/);
  assert.match(hs, /write_ahead_log: true/);
  assert.match(hs, /mode: database/);
  assert.match(hs, /base_domain: "tailnet.example.com"/);
  assert.match(hp, /cookie_secret: "[0-9a-f]{32}"/);
  assert.match(hp, /base_url: "https:\/\/hs.example.com"/);
  assert.match(hp, /url: "http:\/\/127\.0\.0\.1:8080"/);
});
test('reinitialization and partial initialization never replace an existing secret or configuration', async (t) => {
  const root = await workspace(t);
  await initialize({ root, ...options });
  const path = join(root, 'config/headplane/config.yaml');
  const original = await readFile(path, 'utf8');
  await rm(join(root, 'config/headscale/config.yaml'));
  await initialize({ root, ...options });
  assert.equal(await readFile(path, 'utf8'), original);
  await initialize({ root, ...options });
  assert.equal(await readFile(path, 'utf8'), original);
});
test('a different requested domain is rejected without changing the existing files', async (t) => {
  const root = await workspace(t);
  await initialize({ root, ...options });
  const path = join(root, 'config/headscale/config.yaml');
  const before = await readFile(path, 'utf8');
  await assert.rejects(initialize({ root, ...options, publicUrl: 'https://other.example.com' }));
  assert.equal(await readFile(path, 'utf8'), before);
});
for (const publicUrl of ['http://hs.example.com', 'https://hs.example.com/adminis', 'https://user:pass@hs.example.com', 'https://hs.example.com?x=1']) {
  test(`rejects an invalid public URL before writing: ${publicUrl}`, async (t) => {
    const root = await workspace(t);
    await assert.rejects(initialize({ root, ...options, publicUrl }));
    await assert.rejects(readFile(join(root, 'config/headscale/config.yaml')));
  });
}
test('does not follow symlinks while writing configuration', { skip: process.platform === 'win32' }, async (t) => {
  const { symlink } = await import('node:fs/promises');
  const root = await workspace(t);
  const outside = await workspace(t);
  await symlink(outside, join(root, 'config'));
  await assert.rejects(initialize({ root, ...options }));
});

async function endpoint(t, status) {
  const server = createServer((_req, res) => { res.statusCode = status; res.end('health'); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  return `http://127.0.0.1:${server.address().port}/health`;
}
test('combined health requires both services to answer successfully', async (t) => {
  const good = await endpoint(t, 200);
  const bad = await endpoint(t, 503);
  assert.equal(await checkHealth({ headscaleUrl: good, headplaneUrl: good }), true);
  assert.equal(await checkHealth({ headscaleUrl: good, headplaneUrl: bad }), false);
  assert.equal(await checkHealth({ headscaleUrl: 'http://127.0.0.1:1', headplaneUrl: good }), false);
});

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function fixture(name, marker, extra = {}) {
  const port = await freePort();
  return { name, command: process.execPath,
    args: [resolve('tests/fixtures/service.mjs'), JSON.stringify({ name, marker, port, ...extra })],
    healthUrl: `http://127.0.0.1:${port}/health` };
}
async function waitForText(path, text) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readFile(path, 'utf8').catch(() => '')).includes(text)) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.fail(`Timed out waiting for ${text}`);
}
const supervisorOptions = { pollIntervalMs: 15, readyTimeoutMs: 1500, stopTimeoutMs: 500, log: () => {} };
test('waits for control readiness, stops the peer on failure, and exits unsuccessfully', async (t) => {
  const root = await workspace(t);
  const marker = join(root, 'processes');
  const first = await fixture('headscale', marker, { delayReady: 150 });
  const second = await fixture('headplane', marker, { exitAfter: 150 });
  const pending = supervise([first, second], supervisorOptions);
  await waitForText(marker, 'headscale:start');
  assert.doesNotMatch(await readFile(marker, 'utf8'), /headplane:start/);
  assert.equal(await pending, 1);
  const content = await readFile(marker, 'utf8');
  for (const match of content.matchAll(/start:(\d+)/g)) {
    assert.throws(() => process.kill(Number(match[1]), 0));
  }
});
test('startup timeout does not start the management process', async (t) => {
  const root = await workspace(t);
  const marker = join(root, 'processes');
  const first = await fixture('headscale', marker, { delayReady: 10000 });
  const second = await fixture('headplane', marker);
  assert.equal(await supervise([first, second], { ...supervisorOptions, readyTimeoutMs: 200 }), 1);
  assert.doesNotMatch(await readFile(marker, 'utf8'), /headplane:start/);
});
test('shutdown during startup cancels readiness and never starts the next service', async (t) => {
  const root = await workspace(t);
  const marker = join(root, 'processes');
  const signal = new AbortController();
  const first = await fixture('headscale', marker, { delayReady: 10000 });
  const second = await fixture('headplane', marker);
  const pending = supervise([first, second], { ...supervisorOptions, signal: signal.signal });
  await waitForText(marker, 'headscale:start');
  signal.abort();
  assert.equal(await pending, 0);
  assert.doesNotMatch(await readFile(marker, 'utf8'), /headplane:start/);
});
test('missing executable fails without hanging or starting the next service', async (t) => {
  const root = await workspace(t);
  const marker = join(root, 'processes');
  const second = await fixture('headplane', marker);
  assert.equal(await supervise([
    { name: 'missing', command: join(root, 'missing-executable'), args: [], healthUrl: 'http://127.0.0.1:1' }, second,
  ], supervisorOptions), 1);
  await assert.rejects(readFile(marker));
});
