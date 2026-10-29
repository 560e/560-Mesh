import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(await readFile(join(root, 'sources.lock.json'), 'utf8'));
const patch = join(root, 'patches/headplane-560.patch');
if (createHash('sha256').update(await readFile(patch)).digest('hex') !== lock.headplane.patchSha256) throw new Error('Patch checksum differs from source lock');
await mkdir(join(root, 'sources'), { recursive: true });
for (const name of ['headscale', 'headplane']) {
  const path = join(root, 'sources', name);
  const exists = await access(path).then(() => true, () => false);
  if (!exists) execFileSync('git', ['clone', '--depth', '1', '--branch', `v${lock[name].version}`, lock[name].repository, path], { stdio: 'inherit' });
  const git = (...args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (git('rev-parse', 'HEAD').trim() !== lock[name].commit) throw new Error(`${name}: HEAD differs; refusing to reset an existing checkout`);
  if (name === 'headplane') {
    if (!git('remote').split(/\s+/).includes('upstream')) git('remote', 'add', 'upstream', lock[name].repository);
    const applied = spawnSync('git', ['-C', path, 'apply', '--reverse', '--check', patch], { stdio: 'ignore' }).status === 0;
    if (!applied) {
      if (git('status', '--porcelain').trim()) throw new Error('Headplane has unrelated changes; refusing to overwrite');
      git('switch', '-c', 'codex/560-mesh');
      git('apply', '--check', patch);
      git('apply', '--intent-to-add', patch);
    }
  } else if (git('status', '--porcelain').trim()) throw new Error('Official Headscale source has modifications');
  console.log(`${name}: v${lock[name].version}, ${lock[name].commit}`);
}
