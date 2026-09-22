import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { settings, delay, readJson, sameProcess } from '../src/common.mjs';
import { request, ensureDaemon } from '../src/client.mjs';
import { hostHealth } from '../src/host-client.mjs';
import { fixtureRuntime, stopHost } from './helpers.mjs';

const execute = promisify(execFile);
const client = fileURLToPath(new URL('../dist/control.mjs', import.meta.url));
test('bundled command clients reconnect; jobs and Host survive client exit and supervisor restart', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zsa-client-'));
  const env = { ...process.env, ZCODE_SUBAGENTS_HOME: home, ZCODE_SUBAGENTS_RUNTIME_ROOT: await fixtureRuntime(home) };
  const config = settings(env);
  let serial = 0;
  const run = async (command, input = {}) => {
    const file = path.join(home, 'request-' + (++serial) + '.json'); await fs.writeFile(file, JSON.stringify(input));
    const { stdout } = await execute(process.execPath, [client, command, '--json-file', file], { env });
    return JSON.parse(stdout);
  };
  t.after(async () => {
    const owner = await readJson(path.join(home, 'supervisor.lock/owner.json'));
    if (await sameProcess(owner)) process.kill(owner.pid, 'SIGTERM');
    await stopHost(config); await delay(500); await fs.rm(home, { recursive: true, force: true });
  });
  const doctor = await run('doctor');
  assert.equal(doctor.appServer.available, true);
  assert.equal(doctor.concurrency, 12);
  const task = await run('spawn', { workflow_id: 'cli-client-test', request_key: 'one', cwd: home,
    prompt: '[fixture:sleep=3000]', model: 'default' });
  let running;
  for (let i = 0; i < 80; i++) { running = await run('status', { task_id: task.task_id }); if (running.status === 'running') break; await delay(100); }
  assert.equal(running.status, 'running');
  const before = await hostHealth(config);
  const waiter = spawn(process.execPath, [client, 'wait', '--stdin'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
  waiter.stdin.end(JSON.stringify({ task_ids: [task.task_id] }));
  await delay(200); waiter.kill('SIGTERM');
  const health = await request(config, null, null, true); process.kill(health.pid, 'SIGTERM');
  await delay(400); await ensureDaemon(config);
  const result = await run('wait', { task_ids: [task.task_id] });
  assert.equal(result.tasks[0].status, 'succeeded');
  assert.equal((await hostHealth(config)).hostPid, before.hostPid);
  const invalid = spawn(process.execPath, [client, 'spawn', '--stdin'], { env, stdio: ['pipe', 'ignore', 'pipe'] });
  invalid.stdin.end('{}');
  assert.equal(await new Promise((resolve) => invalid.once('exit', resolve)), 1);
});

test('missing desktop runtime reports actionable error without installing anything', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zsa-missing-'));
  const config = settings({ ZCODE_SUBAGENTS_HOME: home, ZCODE_SUBAGENTS_RUNTIME_ROOT: path.join(home, 'absent') });
  t.after(async () => { const owner = await readJson(path.join(home, 'supervisor.lock/owner.json')); if (await sameProcess(owner)) process.kill(owner.pid, 'SIGTERM'); await delay(400); await fs.rm(home, { recursive: true, force: true }); });
  await ensureDaemon(config);
  const doctor = await request(config, 'zcode_doctor', {});
  assert.equal(doctor.appServer.available, false);
  assert.match(doctor.appServer.error, /never downloads or modifies/);
  await assert.rejects(fs.access(config.runtimeRoot));
});
