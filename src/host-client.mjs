import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from './client.mjs';
import { privateDir, delay } from './common.mjs';

export const hostConfig = (config) => ({ ...config, socket: path.join(config.home, 'host.sock') });
export const hostCall = (config, method, params = {}) => request(hostConfig(config), method, params);
export const hostHealth = (config) => request(hostConfig(config), null, null, true);
export async function ensureHost(config) {
  let health;
  try { health = await hostHealth(config); } catch {}
  if (health) {
    if (health.protocol !== 2) throw new Error('Incompatible app-server adapter; finish active tasks before replacing it.');
    if (health.runtimeRoot !== config.runtimeRoot) throw new Error('Existing Host uses another runtime root. Finish tasks before changing the root.');
    return health;
  }
  await privateDir(config.home);
  const log = openSync(path.join(config.home, 'host.log'), 'a', 0o600);
  try {
    const child = spawn('flock', ['--exclusive', '--nonblock', '--close', path.join(config.home, 'host.flock'),
      process.execPath, fileURLToPath(new URL('./host.mjs', import.meta.url))], {
      detached: true, stdio: ['ignore', log, log], env: { ...process.env,
        ZCODE_SUBAGENTS_HOME: config.home, ZCODE_SUBAGENTS_RUNTIME_ROOT: config.runtimeRoot, ZCODE_SUBAGENTS_HOST_LOCKED: '1' },
    });
    child.on('error', () => {}); child.unref();
  } finally { closeSync(log); }
  for (let i = 0; i < 220; i++) {
    await delay(100);
    try { health = await hostHealth(config); } catch { continue; }
    if (health.protocol !== 2 || health.runtimeRoot !== config.runtimeRoot) throw new Error('An incompatible Host adapter is already running. Finish tasks before replacing it.');
    return health;
  }
  throw new Error('Desktop Host did not start. Inspect ' + path.join(config.home, 'host.log'));
}
