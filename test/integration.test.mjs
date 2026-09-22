import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Supervisor } from '../src/supervisor.mjs';
import { settings, TERMINAL, delay, processIdentity, atomicJson } from '../src/common.mjs';
import { OutputParser } from '../src/output.mjs';
import { validate } from '../src/schemas.mjs';

const execute = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixture-zcode.mjs', import.meta.url));
await fs.chmod(fixture, 0o755);
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error('Condition timed out');
}
async function setup(t, concurrency = 12) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zsa-test-'));
  const workspace = path.join(home, 'project');
  await fs.mkdir(workspace);
  const config = { home, concurrency, binary: fixture };
  let supervisor = new Supervisor(config);
  await supervisor.init();
  t.after(async () => {
    for (const task of await supervisor.list()) if (!TERMINAL.has(task.status)) await supervisor.cancel(task.task_id);
    await until(async () => (await supervisor.list()).every((task) => TERMINAL.has(task.status)));
    await supervisor.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  return { home, workspace, config, get manager() { return supervisor; },
    async restart() { await supervisor.close(); supervisor = new Supervisor(config); await supervisor.init(); } };
}
const input = (ctx, key, prompt = 'test', kind = 'analysis') => validate('zcode_spawn', {
  workflow_id: 'test-workflow', request_key: key, cwd: ctx.workspace, prompt, kind,
});
const done = (ctx, id) => until(async () => {
  const result = await ctx.manager.status(id);
  return TERMINAL.has(result.status) && result;
});

test('12 jobs execute, the 13th queues, cancellation releases a slot, request retries are idempotent', async (t) => {
  const ctx = await setup(t);
  const tasks = [];
  for (let i = 0; i < 13; i++) tasks.push(await ctx.manager.spawn(input(ctx, 'job-' + i, '[fixture:sleep=20000]')));
  const duplicate = await ctx.manager.spawn(input(ctx, 'job-0', '[fixture:sleep=20000]'));
  assert.equal(duplicate.task_id, tasks[0].task_id);
  await assert.rejects(ctx.manager.spawn(input(ctx, 'job-0', 'different')), /different request/);
  await until(async () => (await ctx.manager.list()).filter((task) => task.status === 'running').length === 12);
  assert.equal((await ctx.manager.status(tasks[12].task_id)).status, 'queued');
  assert.equal((await ctx.manager.list()).length, 13);
  await ctx.manager.cancel(tasks[0].task_id);
  assert.equal((await done(ctx, tasks[0].task_id)).status, 'cancelled');
  await until(async () => (await ctx.manager.status(tasks[12].task_id)).status === 'running');
});

test('workers survive supervisor restart and queued followups reuse the session', async (t) => {
  const ctx = await setup(t, 2);
  const parent = await ctx.manager.spawn(input(ctx, 'parent', '[fixture:sleep=1800]'));
  await until(async () => (await ctx.manager.status(parent.task_id)).status === 'running');
  const next = await ctx.manager.followup(validate('zcode_followup', {
    task_id: parent.task_id, request_key: 'followup', prompt: 'continue',
  }));
  await assert.rejects(ctx.manager.followup({ task_id: parent.task_id, request_key: 'sibling', prompt: 'branch' }), /already has a followup/);
  await ctx.restart();
  const first = await done(ctx, parent.task_id);
  const second = await done(ctx, next.task_id);
  assert.equal(first.status, 'succeeded');
  assert.equal(second.status, 'succeeded');
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(first.workspace, second.workspace);
});

test('edit worktrees isolate main checkout and collect tracked and untracked changes', async (t) => {
  const ctx = await setup(t);
  await execute('git', ['init', ctx.workspace]);
  await execute('git', ['-C', ctx.workspace, 'config', 'user.name', 'Test']);
  await execute('git', ['-C', ctx.workspace, 'config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(ctx.workspace, 'tracked.txt'), 'original\n');
  await execute('git', ['-C', ctx.workspace, 'add', '.']);
  await execute('git', ['-C', ctx.workspace, 'commit', '-m', 'fixture']);
  const task = await ctx.manager.spawn(input(ctx, 'edit', '[fixture:edit]', 'edit'));
  const result = await done(ctx, task.task_id);
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.notEqual(result.workspace, ctx.workspace);
  assert.equal(await fs.readFile(path.join(ctx.workspace, 'tracked.txt'), 'utf8'), 'original\n');
  assert.match(await fs.readFile(result.changes.patchPath, 'utf8'), /edited by fixture/);
  assert.deepEqual(result.changes.untrackedFiles, ['new.txt']);
  await fs.writeFile(path.join(ctx.workspace, 'dirty.txt'), 'keep me');
  await assert.rejects(ctx.manager.spawn(input(ctx, 'dirty', 'edit', 'edit')), /clean source/);
  assert.equal(await fs.readFile(path.join(ctx.workspace, 'dirty.txt'), 'utf8'), 'keep me');
});

test('cancel terminates the model process group including a spawned child', async (t) => {
  const ctx = await setup(t);
  const task = await ctx.manager.spawn(input(ctx, 'child', '[fixture:child] [fixture:sleep=30000]'));
  const pid = await until(async () => {
    try { return Number(await fs.readFile(path.join(ctx.workspace, 'grandchild.pid'), 'utf8')); } catch { return false; }
  });
  assert.ok(await processIdentity(pid));
  await ctx.manager.cancel(task.task_id);
  assert.equal((await done(ctx, task.task_id)).status, 'cancelled');
  await until(async () => !await processIdentity(pid));
});

test('wait deadlines survive slices, do not stop tasks, and runtime deadlines are separate', async (t) => {
  const ctx = await setup(t);
  const task = await ctx.manager.spawn(input(ctx, 'wait', '[fixture:sleep=10000]'));
  const first = await ctx.manager.wait({ task_ids: [task.task_id] }, 10);
  assert.equal(first.ready, false);
  assert.equal(first.timed_out, false);
  const second = await ctx.manager.wait({ wait_id: first.wait_id }, 10);
  assert.equal(second.deadline, first.deadline);
  await atomicJson(path.join(ctx.home, 'waits', first.wait_id + '.json'), {
    ids: [task.task_id], mode: 'all', deadline: Date.now() - 1,
  });
  assert.equal((await ctx.manager.wait({ wait_id: first.wait_id }, 10)).timed_out, true);
  assert.ok(!TERMINAL.has((await ctx.manager.status(task.task_id)).status));
  const timeout = await ctx.manager.spawn({ ...input(ctx, 'execution-timeout', '[fixture:sleep=10000]'), run_timeout_ms: 1000 });
  const result = await done(ctx, timeout.task_id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /deadline/);
});

test('failed exits and missing result frames are never reported as success; shell input is literal', async (t) => {
  const ctx = await setup(t);
  const fail = await ctx.manager.spawn(input(ctx, 'fail', '[fixture:fail]'));
  const noSummary = await ctx.manager.spawn(input(ctx, 'no-summary', '[fixture:nosummary]'));
  assert.equal((await done(ctx, fail.task_id)).exitCode, 7);
  assert.equal((await done(ctx, noSummary.task_id)).status, 'failed');
  const sentinel = path.join(ctx.workspace, 'should-not-exist');
  const prompt = '[fixture:args] $(touch ' + sentinel + ') ; echo bad';
  const literal = await ctx.manager.spawn(input(ctx, 'literal', prompt));
  assert.equal((await done(ctx, literal.task_id)).status, 'succeeded');
  const args = JSON.parse(await fs.readFile(path.join(ctx.workspace, 'arguments.json'), 'utf8'));
  assert.ok(args[args.indexOf('--prompt') + 1].includes(prompt));
  assert.ok(args[args.indexOf('--disallowed-tools') + 1].split(',').includes('Bash'));
  await assert.rejects(fs.access(sentinel));
});

test('a crashed worker is marked interrupted and its live child is cleaned up without replay', async (t) => {
  const ctx = await setup(t);
  const task = await ctx.manager.spawn(input(ctx, 'crash', '[fixture:sleep=30000]'));
  await until(async () => (await ctx.manager.status(task.task_id)).status === 'running');
  const dir = path.join(ctx.home, 'tasks', task.task_id);
  const owner = JSON.parse(await fs.readFile(path.join(dir, 'owner.json'), 'utf8'));
  const child = JSON.parse(await fs.readFile(path.join(dir, 'child.json'), 'utf8'));
  process.kill(owner.pid, 'SIGKILL');
  const result = await done(ctx, task.task_id);
  assert.equal(result.status, 'interrupted');
  assert.equal(await processIdentity(child.pid), undefined);
  assert.equal((await ctx.manager.list()).length, 1);
});

test('stream parser handles fragmented JSON and ignores non-JSON diagnostics', () => {
  const parser = new OutputParser();
  parser.accept('diagnostic\n{"session');
  parser.accept('Id":"sess_test","type":"event"}\n{"type":"result","response":"ok",');
  parser.accept('"sessionId":"sess_test","usage":{"inputTokens":5}}\n');
  parser.finish();
  assert.equal(parser.summary.response, 'ok');
  assert.equal(parser.sessionId, 'sess_test');
  assert.equal(parser.summary.usage.inputTokens, 5);
});

test('configuration rejects exceeding 12, traversal and invalid wait windows', () => {
  assert.throws(() => settings({ ZCODE_SUBAGENTS_CONCURRENCY: '13' }), /1 to 12/);
  assert.throws(() => validate('zcode_status', { task_id: '../../secret' }));
  assert.throws(() => validate('zcode_wait', { task_ids: [], timeout_ms: 1 }));
});
