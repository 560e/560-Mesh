import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, chown, chmod } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function validateAddress(publicUrl, baseDomain = "", magicDNS = Boolean(baseDomain)) {
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:' || !domainPattern.test(url.hostname) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || (url.port && url.port !== '443')) {
    throw new Error('Public URL must be an HTTPS domain origin on port 443 without a path or credentials');
  }
  if (typeof baseDomain !== 'string' || typeof magicDNS !== 'boolean' || (baseDomain && !domainPattern.test(baseDomain)) ||
      (magicDNS && (!baseDomain || baseDomain.toLowerCase() === url.hostname.toLowerCase() || url.hostname.toLowerCase().endsWith('.' + baseDomain.toLowerCase())))) {
    throw new Error('MagicDNS base domain must be valid and different from the public control domain');
  }
  return url.origin;
}

async function stat(path) {
  return lstat(path).catch((error) => { if (error.code === 'ENOENT') return undefined; throw error; });
}
async function ownNew(path, mode) {
  await chmod(path, mode);
  if (process.getuid?.() === 0) await chown(path, 65532, 65532);
}
async function directory(path) {
  const existing = await stat(path);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`Not a safe directory: ${path}`);
    return;
  }
  await mkdir(path, { mode: 0o700 });
  await ownNew(path, 0o700);
}

export async function initialize({ root, publicUrl, baseDomain = '', magicDNS = Boolean(baseDomain), templates = resolve(here, '../config') }) {
  const origin = validateAddress(publicUrl, baseDomain, magicDNS);
  root = resolve(root);
  // Validate both existing files and all directories before creating either configuration.
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Project root must not be a symlink');
  for (const path of ['config', 'config/headscale', 'config/headplane', 'data', 'data/headscale', 'data/headplane']) {
    await directory(join(root, path));
  }
  const specs = [
    { service: 'headscale', urlField: 'server_url' },
    { service: 'headplane', urlField: 'base_url' },
  ];
  const pending = [];
  for (const { service, urlField } of specs) {
    const target = join(root, 'config', service, 'config.yaml');
    const existing = await stat(target);
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`Not a safe config file: ${target}`);
      const text = await readFile(target, 'utf8');
      const line = text.split(/\r?\n/).find((value) => value.trimStart().startsWith(`${urlField}:`));
      const value = line?.trim().slice(urlField.length + 1).trim();
      if (![origin, JSON.stringify(origin), `'${origin}'`].includes(value)) {
        throw new Error(`${service} already exists with a different or unrecognized public URL; edit it explicitly`);
      }
      continue;
    }
    let text = await readFile(join(templates, service, 'config.example.yaml'), 'utf8');
    text = text.replaceAll('__PUBLIC_URL__', JSON.stringify(origin))
      .replaceAll('__BASE_DOMAIN__', JSON.stringify(baseDomain.toLowerCase()))
      .replaceAll('__MAGIC_DNS__', String(magicDNS));
    if (service === 'headplane') text = text.replaceAll('__COOKIE_SECRET__', JSON.stringify(randomBytes(16).toString('hex')));
    if (/__[A-Z_]+__/.test(text)) throw new Error('Unresolved configuration placeholder');
    pending.push({ target, text });
  }
  const created = [];
  for (const { target, text } of pending) {
    // wx also protects against another initializer winning a race. Never truncate an existing file.
    await writeFile(target, text, { flag: 'wx', mode: 0o600 });
    await ownNew(target, 0o600);
    created.push(target);
  }
  return { created };
}

export async function initializeCli(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    root: { type: 'string', default: '/workspace' },
    url: { type: 'string' },
    'base-domain': { type: 'string', default: '' },
    'magic-dns': { type: 'string' },
  } });
  if (!values.url) throw new Error('Required: --url https://your-control-domain');
  if(values['magic-dns'] !== undefined && !['true','false'].includes(values['magic-dns'])) throw new Error('--magic-dns must be true or false');
  const magicDNS = values['magic-dns'] === undefined ? Boolean(values['base-domain']) : values['magic-dns'] === 'true';
  const result = await initialize({ root: values.root, publicUrl: values.url, baseDomain: values['base-domain'], magicDNS });
  console.log(`Configuration initialized: ${result.created.length} new files; existing files preserved. Secrets were not printed.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  initializeCli().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
