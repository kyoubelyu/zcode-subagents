import http from 'node:http';
import { spawn } from 'node:child_process';
import { openSync, closeSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings, privateDir, delay, VERSION, readJson, sameProcess, WAIT_TRANSPORT_TIMEOUT } from './common.mjs';

async function supervisorFilesExist(health) {
  let entry = health.entry;
  if (!entry) {
    // Older 0.2 supervisors did not advertise their entry path.
    try { entry = (await fs.readFile('/proc/' + health.pid + '/cmdline', 'utf8')).split('\0')[1]; }
    catch { return false; }
  }
  if (!entry || path.basename(entry) !== 'daemon.mjs') throw new Error('Cannot verify the existing supervisor entry path.');
  try { await fs.access(entry); await fs.access(path.join(path.dirname(entry), 'worker.mjs')); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function request(config, method, params, health = false, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: config.socket, path: health ? '/health' : '/rpc',
      method: health ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 8 * 1024 * 1024) res.destroy(new Error('Supervisor response too large.'));
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.error) reject(new Error(data.error));
          else resolve(health ? data : data.result);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(method === 'zcode_wait' ? WAIT_TRANSPORT_TIMEOUT : 55000,
      () => req.destroy(new Error('Supervisor request timed out. Query task status before retrying a mutation.')));
    req.on('error', reject);
    req.end(health ? undefined : JSON.stringify({ method, params }));
  });
}
export async function ensureDaemon(config = settings()) {
  if (process.env.ZCODE_SUBAGENTS_CHILD === '1') throw new Error('Recursive ZCode delegation is disabled.');
  let health;
  try { health = await request(config, undefined, undefined, true); } catch {}
  if (health) {
    if (health.version !== VERSION) throw new Error('A different supervisor version is running. Finish tasks and stop it before upgrading.');
    if (health.concurrency !== config.concurrency) throw new Error('The shared supervisor has a different concurrency setting. Finish tasks and stop it before reconfiguring.');
    if (await supervisorFilesExist(health)) return config;
    const entry = fileURLToPath(new URL('./daemon.mjs', import.meta.url));
    try { await fs.access(entry); } catch { throw new Error('This plugin cache was removed. Reconnect using the updated installed plugin. Existing tasks are retained.'); }
    const owner = await readJson(path.join(config.home, 'supervisor.lock/owner.json'));
    if (owner?.pid !== health.pid) throw new Error('Supervisor changed during cache recovery; query again.');
    // Only replace our stale task supervisor. Detached workers and the shared
    // desktop Host remain alive; the new supervisor rediscovers their state.
    if (await sameProcess(owner)) { try { process.kill(owner.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    for (let i = 0; i < 100 && await sameProcess(owner); i++) await delay(50);
    if (await sameProcess(owner)) throw new Error('Old plugin supervisor is still stopping. Existing work is retained; query again shortly.');
  }
  await privateDir(config.home);
  const log = openSync(path.join(config.home, 'supervisor.log'), 'a', 0o600);
  try {
    const daemon = spawn('flock', ['--exclusive', '--nonblock', '--close',
      path.join(config.home, 'supervisor.flock'), process.execPath,
      fileURLToPath(new URL('./daemon.mjs', import.meta.url))], {
      detached: true, stdio: ['ignore', log, log],
      env: { ...process.env, ZCODE_SUBAGENTS_HOME: config.home,
        ZCODE_SUBAGENTS_RUNTIME_ROOT: config.runtimeRoot, ZCODE_SUBAGENTS_CONCURRENCY: String(config.concurrency),
        ZCODE_SUBAGENTS_LOCKED: '1' },
    });
    daemon.on('error', () => {});
    daemon.unref();
  } finally { closeSync(log); }
  for (let i = 0; i < 50; i++) {
    await delay(100);
    try {
      health = await request(config, undefined, undefined, true);
      if (health.version !== VERSION || health.concurrency !== config.concurrency) {
        throw new Error('Supervisor configuration mismatch.');
      }
      return config;
    } catch {}
  }
  throw new Error('Supervisor did not start. Inspect ' + path.join(config.home, 'supervisor.log'));
}
export async function call(method, params = {}, options) {
  return request(await ensureDaemon(), method, params, false, options);
}
