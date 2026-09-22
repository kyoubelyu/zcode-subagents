import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { delay, readJson, sameProcess } from '../src/common.mjs';
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
