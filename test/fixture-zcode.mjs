#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

if (process.argv.includes('--version')) { console.log('fixture-0.16.9'); process.exit(0); }
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const prompt = value('--prompt');
const cwd = value('--cwd');
const sessionId = process.argv.includes('--resume') ? value('--resume') : 'sess_' + randomUUID();
console.log(JSON.stringify({ type: 'session.started', sessionId }));
if (prompt.includes('[fixture:args]')) {
  await fs.writeFile(path.join(cwd, 'arguments.json'), JSON.stringify(process.argv.slice(2)));
}
if (prompt.includes('[fixture:edit]')) {
  await fs.writeFile(path.join(cwd, 'tracked.txt'), 'edited by fixture\n');
  await fs.writeFile(path.join(cwd, 'new.txt'), 'new file\n');
}
if (prompt.includes('[fixture:child]')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await fs.writeFile(path.join(cwd, 'grandchild.pid'), String(child.pid));
}
const sleep = Number(prompt.match(/\[fixture:sleep=(\d+)\]/)?.[1] || 10);
await new Promise((resolve) => setTimeout(resolve, sleep));
if (prompt.includes('[fixture:fail]')) { console.error('fixture provider failure'); process.exit(7); }
if (prompt.includes('[fixture:nosummary]')) process.exit(0);
console.log(JSON.stringify({
  type: 'result', sessionId, response: 'FIXTURE_OK',
  usage: { inputTokens: 25, outputTokens: 2 },
  projection: { status: 'idle', turnCount: 1 },
}));
