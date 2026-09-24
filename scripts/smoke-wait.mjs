// Real Codex -> installed plugin -> supervisor transport test, no model calls.
// Takes ten minutes by default. --quick checks the >60-second completion path.
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { atomicJson, now, newId, processIdentity, readJson, sameProcess, delay } from '../src/common.mjs';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zsa-wait-live-'));
const tasks = [newId(), newId(), newId(), newId()];
for (const [i, id] of tasks.entries()) {
  const dir = path.join(home, 'tasks', id);
  await atomicJson(path.join(dir, 'spec.json'), { id, workflowId: 'wait-test-' + i, requestKey: id,
    kind: 'analysis', cwd: home, createdAt: now(), prompt: 'Transport test fixture; never submitted to a model.' });
  await atomicJson(path.join(dir, 'runtime.json'), { status: 'running', startedAt: now(), workspace: home });
  await atomicJson(path.join(dir, 'owner.json'), { pid: process.pid, identity: await processIdentity(process.pid) });
}
const child = spawn('codex', ['app-server'], {
  env: { ...process.env, ZCODE_SUBAGENTS_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
});
// Keep local diagnostics private; do not print other plugins' startup messages.
const log = await fs.open(path.join(home, 'codex.stderr.log'), 'a', 0o600);
child.stderr.on('data', (chunk) => { void log.write(chunk); });
let serial = 0;
const pending = new Map();
createInterface({ input: child.stdout }).on('line', (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id); clearTimeout(request.timer);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
});
const rpc = (method, params, timeout = 680000) => new Promise((resolve, reject) => {
  const id = ++serial;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out in test harness')); }, timeout);
  pending.set(id, { resolve, reject, timer });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
child.once('exit', () => {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex test app-server exited')); }
  pending.clear();
});
const timers = [];
try {
  await rpc('initialize', { clientInfo: { name: 'zcode_wait_smoke', version: '1' }, capabilities: { experimentalApi: true } }, 60000);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
  const threads = await Promise.all([1, 2].map(() => rpc('thread/start', {
    cwd: home, ephemeral: true, approvalPolicy: 'never', sandbox: 'danger-full-access', experimentalRawEvents: false,
  }, 60000)));
  const call = async (thread, tool, args) => {
    const result = await rpc('mcpServer/tool/call', { threadId: thread.thread.id,
      server: 'zcode-subagents', tool: 'zcode_' + tool, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result));
    const value = result.structuredContent || JSON.parse(result.content.find((item) => item.type === 'text').text);
    return value;
  };
  // This read must find only the isolated fixture. Never submit model work.
  assert.equal((await call(threads[0], 'status', { task_id: tasks[0] })).workspace, home);
  console.log('NATIVE_WAITS_STARTED', JSON.stringify({ home, started_at: now(), full_timeout: !process.argv.includes('--quick') }));
  const started = performance.now();
  const finish = (id) => atomicJson(path.join(home, 'tasks', id, 'runtime.json'), {
    status: 'succeeded', startedAt: now(), finishedAt: now(), workspace: home, response: 'Transport fixture complete',
  });
  timers.push(setTimeout(() => { void finish(tasks[2]); }, 1000)); // Unlisted completion must not wake either wait.
  timers.push(setTimeout(() => { void finish(tasks[1]); }, 65000));
  const [one, two, expired] = await Promise.all([
    call(threads[0], 'wait', { task_ids: [tasks[0], tasks[1]] }).then((value) => {
      console.log('ANY_COMPLETION', JSON.stringify({ elapsed_ms: value.elapsed_ms, ready: value.ready, completed: value.completed_task_ids, pending: value.pending_task_ids }));
      assert.ok(performance.now() - started >= 65000);
      return value;
    }),
    call(threads[1], 'wait', { task_ids: [tasks[1]] }),
    process.argv.includes('--quick') ? undefined : call(threads[1], 'wait', { task_ids: [tasks[3]] }).then((value) => {
      console.log('TEN_MINUTE_TIMEOUT', JSON.stringify({ elapsed_ms: value.elapsed_ms, ready: value.ready, timed_out: value.timed_out }));
      return value;
    }),
  ]);
  assert.deepEqual(one.completed_task_ids, [tasks[1]]); assert.deepEqual(one.pending_task_ids, [tasks[0]]);
  assert.deepEqual(two.completed_task_ids, [tasks[1]]);
  if (expired) {
    assert.equal(expired.timed_out, true); assert.equal(expired.ready, false);
    assert.ok(expired.elapsed_ms >= 600000 && expired.elapsed_ms < 610000);
    assert.equal((await call(threads[1], 'status', { task_id: tasks[3] })).status, 'running');
  }
  console.log('NATIVE_CODEX_WAIT_PASSED', JSON.stringify({ full_timeout: Boolean(expired), home }));
} finally {
  timers.forEach(clearTimeout);
  for (const id of tasks) await atomicJson(path.join(home, 'tasks', id, 'runtime.json'), { status: 'cancelled', finishedAt: now() });
  child.kill('SIGTERM');
  const owner = await readJson(path.join(home, 'supervisor.lock/owner.json'));
  if (await sameProcess(owner)) process.kill(owner.pid, 'SIGTERM');
  await delay(200); await log.close();
}
