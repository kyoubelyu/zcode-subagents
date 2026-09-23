import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { delay, readJson, sameProcess } from '../src/common.mjs';
import { hostHealth } from '../src/host-client.mjs';
export async function fixtureRuntime(home) {
  const root = path.join(home, 'desktop');
  await fs.mkdir(path.join(root, 'agents/glm'), { recursive: true });
  await fs.symlink(process.execPath, path.join(root, 'node'));
  await fs.symlink(fileURLToPath(new URL('./fixture-host.cjs', import.meta.url)), path.join(root, 'zcode-server.cjs'));
  await fs.writeFile(path.join(root, 'agents/glm/zcode.cjs'), '// Installed app-server fixture marker\n');
  return root;
}
export async function stopHost(config) {
  const owner = await readJson(path.join(config.home, 'host-owner.json'));
  if (await sameProcess(owner)) process.kill(owner.pid, 'SIGTERM');
  for (let i = 0; i < 80 && await sameProcess(owner); i++) await delay(100);
}

export async function legacyHost(config) {
  const source = fileURLToPath(new URL('../src', import.meta.url));
  const legacy = path.join(config.home, 'legacy-plugin');
  await fs.cp(source, legacy, { recursive: true });
  const entry = path.join(legacy, 'host.mjs');
  const text = await fs.readFile(entry, 'utf8');
  await fs.writeFile(entry, text.replace('capabilities: { workspaceRelease: true }', 'capabilities: {}'));
  const child = spawn('flock', ['--exclusive', '--nonblock', '--close', path.join(config.home, 'host.flock'), process.execPath, entry], {
    stdio: 'ignore', env: { ...process.env, ZCODE_SUBAGENTS_HOME: config.home,
      ZCODE_SUBAGENTS_RUNTIME_ROOT: config.runtimeRoot, ZCODE_SUBAGENTS_HOST_LOCKED: '1' },
  });
  child.unref();
  for (let i = 0; i < 100; i++) {
    try { return await hostHealth(config); } catch { await delay(100); }
  }
  throw new Error('Legacy fixture adapter did not start');
}
