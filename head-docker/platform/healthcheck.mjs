import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function probe(url, timeoutMs = 2000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    await response.body?.cancel();
    return response.status === 200;
  } catch { return false; }
}
export async function checkHealth({
  headscaleUrl = 'http://127.0.0.1:8080/health',
  headplaneUrl = 'http://127.0.0.1:3000/adminis/healthz',
} = {}) {
  return (await Promise.all([probe(headscaleUrl), probe(headplaneUrl)])).every(Boolean);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await checkHealth() ? 0 : 1;
}
