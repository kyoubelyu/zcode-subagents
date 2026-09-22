import http from 'node:http';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings, privateDir, delay, VERSION } from './common.mjs';

export function request(config, method, params, health = false) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: config.socket, path: health ? '/health' : '/rpc',
      method: health ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
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
    req.setTimeout(55000, () => req.destroy(new Error('Supervisor request timed out. Query task status before retrying a mutation.')));
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
    return config;
  }
  await privateDir(config.home);
  const log = openSync(path.join(config.home, 'supervisor.log'), 'a', 0o600);
  try {
    const daemon = spawn('flock', ['--exclusive', '--nonblock', '--close',
      path.join(config.home, 'supervisor.flock'), process.execPath,
      fileURLToPath(new URL('./daemon.mjs', import.meta.url))], {
      detached: true, stdio: ['ignore', log, log],
      env: { ...process.env, ZCODE_SUBAGENTS_HOME: config.home,
        ZCODE_SUBAGENTS_BIN: config.binary, ZCODE_SUBAGENTS_CONCURRENCY: String(config.concurrency),
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
export async function call(method, params = {}) {
  return request(await ensureDaemon(), method, params);
}
