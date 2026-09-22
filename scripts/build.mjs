import { build } from 'esbuild';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/server.mjs', 'src/control.mjs', 'src/daemon.mjs', 'src/worker.mjs', 'src/host.mjs'],
  outdir: 'dist', outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node',
  format: 'esm', target: 'node22', minify: false, sourcemap: false,
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  legalComments: 'eof', metafile: true,
});
const notices = [];
const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const index = input.lastIndexOf('node_modules/');
  if (index < 0) continue;
  const parts = input.slice(index + 'node_modules/'.length).split('/');
  packages.add(parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
}
for (const name of [...packages].sort()) {
  const dir = path.join(root, 'node_modules', name);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  const filename = (await fs.readdir(dir)).find((name) => /^licen[cs]e($|\.)/i.test(name));
  if (!filename) throw new Error('Missing license for ' + name);
  notices.push(name + '@' + manifest.version + '\n\n' + await fs.readFile(path.join(dir, filename), 'utf8'));
}
await fs.writeFile(path.join(root, 'dist', 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n---\n\n'));
console.log('Built standalone plugin runtime in dist/.');
