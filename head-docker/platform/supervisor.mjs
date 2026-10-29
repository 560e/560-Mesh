import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe } from './healthcheck.mjs';
import { ensureApiKey } from './api-key.mjs';

async function stopChildren(records, timeoutMs) {
  const live = records.filter((record) => !record.exited);
  for (const record of [...live].reverse()) record.child.kill('SIGTERM');
  let timer;
  await Promise.race([
    Promise.all(live.map((record) => record.closed)),
    new Promise((done) => { timer = setTimeout(done, timeoutMs); }),
  ]);
  clearTimeout(timer);
  for (const record of live.filter((item) => !item.exited)) record.child.kill('SIGKILL');
  await Promise.all(live.map((record) => record.closed));
}

export async function supervise(services, {
  pollIntervalMs = 250, readyTimeoutMs = 60000, stopTimeoutMs = 10000,
  signal, onReady, log = (message) => console.log(`[supervisor] ${message}`),
} = {}) {
  const records = [];
  const controller = new AbortController();
  let stopping = false;
  let exitCode = 0;
  let resolveStop;
  const stopped = new Promise((done) => { resolveStop = done; });
  const requestStop = (code, reason) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    log(reason);
    controller.abort();
    resolveStop();
  };
  const onSignal = () => requestStop(0, 'Shutdown requested');
  signal?.addEventListener('abort', onSignal, { once: true });
  if (signal?.aborted) onSignal();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    for (const service of services) {
      if (stopping) break;
      await service.beforeStart?.(controller.signal);
      if (stopping) break;
      log(`Starting ${service.name}`);
      const child = spawn(service.command, service.args ?? [], { cwd: service.cwd, stdio: 'inherit' });
      const record = { child, exited: false, closed: undefined };
      record.closed = new Promise((done) => {
        child.once('error', () => requestStop(1, `${service.name} could not start`));
        child.once('exit', () => requestStop(1, `${service.name} exited unexpectedly`));
        child.once('close', () => { record.exited = true; done(); });
      });
      records.push(record);
      const deadline = Date.now() + readyTimeoutMs;
      while (!stopping) {
        if (await probe(service.healthUrl, Math.min(2000, readyTimeoutMs))) {
          if (!stopping) log(`${service.name} is ready`);
          break;
        }
        if (Date.now() >= deadline) {
          requestStop(1, `${service.name} readiness timed out`);
          break;
        }
        await delay(pollIntervalMs, undefined, { signal: controller.signal }).catch(() => {});
      }
    }
    if (!stopping) { log('All services started'); await onReady?.(); }
    await stopped;
  } catch {
    requestStop(1, 'Service supervision failed');
  } finally {
    await stopChildren(records, stopTimeoutMs);
    signal?.removeEventListener('abort', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  }
  return exitCode;
}


export async function supervisePlatform(services, {
  runtime, signal, settingsPollMs = 1000, log = (message) => console.log('[supervisor] ' + message),
  ...options
} = {}) {
  let shuttingDown = signal?.aborted ?? false;
  let stopCurrent;
  const stop = () => { shuttingDown = true; stopCurrent?.abort(); };
  signal?.addEventListener('abort', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const previousConfig = process.env.HEADSCALE_CONFIG;
  try {
    while (!shuttingDown) {
      let candidate;
      try { candidate = await runtime.prepare(); }
      catch (error) {
        if (await runtime.rejectPending(error instanceof Error ? error.message : '配置预检失败')) {
          log('新 网络配置预检失败，恢复上次可用配置');
          continue;
        }
        throw error;
      }
      if (shuttingDown) return 0;
      process.env.HEADSCALE_CONFIG = candidate.configPath;
      stopCurrent = new AbortController();
      let reload = false, ready = false, checking = false;
      const timer = setInterval(async () => {
        if (checking || shuttingDown || reload) return;
        checking = true;
        try {
          if (await runtime.revision() !== candidate.requestedRevision) {
            reload = true;
            log('检测到 网络设置更新，受控重新启动应用进程');
            stopCurrent.abort();
          }
        } catch { log('网络设置文件暂不可读，保留当前运行配置'); }
        finally { checking = false; }
      }, settingsPollMs);
      let code;
      try {
        code = await supervise(typeof services === 'function' ? services() : services, {
          ...options, log, signal: stopCurrent.signal,
          onReady: async () => { await runtime.healthy(candidate); ready = true; },
        });
      } finally { clearInterval(timer); }
      if (shuttingDown) return 0;
      if (reload) continue;
      if (!ready && candidate.pending) {
        await runtime.failed(candidate, '新配置启动失败，已恢复上次可用配置。');
        log('新 网络配置未通过启动检查，恢复上次可用配置');
        continue;
      }
      return code;
    }
    return 0;
  } finally {
    if (previousConfig === undefined) delete process.env.HEADSCALE_CONFIG;
    else process.env.HEADSCALE_CONFIG = previousConfig;
    signal?.removeEventListener('abort', stop);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

export function platformServices(gatewayEnabled=process.env.PLATFORM_CONTROL_GATEWAY==="1"){
  return [
    {name:"headscale",command:"/usr/local/bin/headscale",args:["serve"],healthUrl:gatewayEnabled?"http://127.0.0.1:8081/health":"http://127.0.0.1:8080/health"},
    ...(gatewayEnabled?[{name:"gateway",command:process.execPath,args:["/opt/560-platform/control-gateway.mjs"],healthUrl:"http://127.0.0.1:8080/health"}]:[]),
    {name:"headplane",command:process.execPath,args:["/app/build/server/index.js"],cwd:"/app",beforeStart:signal=>ensureApiKey({signal}),healthUrl:"http://127.0.0.1:3000/adminis/healthz"},
  ];
}

async function cli() {
  const args = process.argv.slice(2);
  if (args[0] === 'init') {
    const { initializeCli } = await import('./initialize.mjs');
    await initializeCli(args.slice(1));
    return;
  }
  if (args[0] === 'headscale') {
    const child = spawn('/usr/local/bin/headscale', args.slice(1), { stdio: 'inherit' });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
    process.exitCode = await new Promise((done) => {
      child.once('error', () => done(1));
      child.once('exit', (code) => done(code ?? 1));
    });
    return;
  }
  if (args.length) throw new Error('Supported commands: init, headscale');
  const { platformRuntimeController } = await import('/app/build/platform/network-runtime.mjs');
  process.exitCode = await supervisePlatform(()=>platformServices(),{runtime:platformRuntimeController()});
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
