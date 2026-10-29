import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants, lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const execute = promisify(execFile);
const keyPattern = /^[A-Za-z0-9._-]{16,256}$/;
export async function ensureApiKey({
  path = '/var/lib/headplane/headscale-api.key',
  command = '/usr/local/bin/headscale',
  args = ['apikeys', 'create', '--expiration', '90d', '--output', 'json'],
  signal, rotate = false,
} = {}) {
  const existing = await lstat(path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Server key path is not a regular private file');
    if (!keyPattern.test((await readFile(path, 'utf8')).trim())) throw new Error('Existing server key is malformed; explicit rotation required');
    if (!rotate) return { created: false };
  }
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Unsafe server key directory');
  await access(dirname(path), constants.W_OK);
  let stdout;
  try { ({ stdout } = await execute(command, args, { signal, timeout: 15000, maxBuffer: 65536, encoding: 'utf8' })); }
  catch { throw new Error('Could not create the Headscale server API key; inspect control-service health and permissions'); }
  let key;
  try { key = JSON.parse(stdout); } catch { throw new Error('Headscale did not return a JSON API key'); }
  if (typeof key !== 'string' || !keyPattern.test(key)) throw new Error('Headscale returned an invalid API key');
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${key}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    const now = Date.now();
    await writeFile(`${path}.metadata.json`, `${JSON.stringify({
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 90 * 86400000).toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
  } finally { await unlink(temporary).catch(() => {}); }
  return { created: true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--rotate') throw new Error('Explicit --rotate is required for manual key rotation');
  ensureApiKey({ rotate: true }).then(() => console.log('服务器 API Key 已更新，请重启平台；旧 Key 请在确认后吊销。'))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
