import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureApiKey } from '../../head-docker/platform/api-key.mjs';

test('creates a private server key once, captures its output and preserves it on restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs560-key-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'headscale-api.key');
  const marker = join(root, 'called');
  const options = { path, command: process.execPath,
    args: ['-e', `require('fs').appendFileSync(${JSON.stringify(marker)},'called'); console.log(JSON.stringify('test-prefix.test-server-only-key'))`],
  };
  assert.deepEqual(await ensureApiKey(options), { created: true });
  assert.equal((await readFile(path, 'utf8')).trim(), 'test-prefix.test-server-only-key');
  assert.deepEqual(await ensureApiKey(options), { created: false });
  assert.equal(await readFile(marker, 'utf8'), 'called');
  assert.equal((await readFile(`${path}.metadata.json`, 'utf8')).includes('test-server-only-key'), false);
});
test('a malformed CLI result is never persisted as a key', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs560-key-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'headscale-api.key');
  await assert.rejects(ensureApiKey({ path, command: process.execPath, args: ['-e', "console.log('not JSON')"] }));
  await assert.rejects(readFile(path));
});
