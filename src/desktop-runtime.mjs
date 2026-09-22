import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export async function desktopRuntime(config) {
  const root = path.resolve(config.runtimeRoot || path.join(os.homedir(), '.zcode/server'));
  const runtime = { root, node: path.join(root, 'node'), entry: path.join(root, 'zcode-server.cjs'), cwd: config.home };
  for (const file of [runtime.node, runtime.entry, path.join(root, 'agents/glm/zcode.cjs')]) {
    try { if (!(await fs.stat(file)).isFile()) throw new Error(); }
    catch { throw new Error('Desktop runtime file missing: ' + file + '. Install or repair ZCode Desktop yourself; this plugin never downloads or modifies it.'); }
  }
  return runtime;
}
