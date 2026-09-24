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
import { fixtureRuntime, stopHost, legacyHost } from './helpers.mjs';
import { hostHealth, hostCall } from '../src/host-client.mjs';
import { Frames, frame } from '../src/host-wire.mjs';
import { validate } from '../src/schemas.mjs';
import { SnapshotAssembly } from '../src/conversation.mjs';
import { crc32 } from 'node:zlib';

const execute = promisify(execFile);

async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error('Condition timed out');
}
async function setup(t, concurrency = 12) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zsa-test-'));
  const workspace = path.join(home, 'project');
  await fs.mkdir(workspace);
  const config = settings({ ZCODE_SUBAGENTS_HOME: home, ZCODE_SUBAGENTS_CONCURRENCY: String(concurrency), ZCODE_SUBAGENTS_RUNTIME_ROOT: await fixtureRuntime(home) });
  let supervisor = new Supervisor(config);
  await supervisor.init();
  t.after(async () => {
    for (const task of await supervisor.list()) if (!TERMINAL.has(task.status)) await supervisor.cancel(task.task_id);
    await until(async () => (await supervisor.list()).every((task) => TERMINAL.has(task.status)));
    await supervisor.close();
    await stopHost(config);
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
const released = (ctx, id) => until(async () => {
  const result = await ctx.manager.status(id);
  return result.resourceCleanup?.status === 'released' && result;
});

test('idle workspace runtimes are released; cold followups retain session, files, model and Host', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.manager.spawn({ ...input(ctx, 'cold-parent'),
    model: { providerId: 'fixture', modelId: 'explicit', options: { reasoningLevel: 'low' } } });
  const first = await released(ctx, a.task_id);
  assert.equal(first.status, 'succeeded');
  assert.equal(first.resourceCleanup.historyRetained, true);
  await assert.rejects(hostCall(ctx.config, 'identity', { workspacePath: ctx.workspace }), /runtime identity is unavailable/);
  await fs.writeFile(path.join(ctx.workspace, 'keep.txt'), 'retained');
  const b = await ctx.manager.followup(validate('zcode_followup', {
    task_id: a.task_id, request_key: 'cold-followup', prompt: 'continue',
  }));
  const second = await released(ctx, b.task_id);
  assert.equal(second.status, 'succeeded');
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.workspace, first.workspace);
  assert.deepEqual(second.effectiveModel, first.effectiveModel);
  assert.notEqual(second.runtimeIdentity.identity, first.runtimeIdentity.identity);
  assert.equal((await hostHealth(ctx.config)).hostPid, first.appServer.hostPid);
  assert.equal(await fs.readFile(path.join(ctx.workspace, 'keep.txt'), 'utf8'), 'retained');
  await assert.rejects(hostCall(ctx.config, 'identity', { workspacePath: ctx.workspace }), /runtime identity is unavailable/);
});

test('release waits for every task in a workspace and leaves other workspaces running', async (t) => {
  const ctx = await setup(t);
  const otherWorkspace = path.join(ctx.home, 'other');
  await fs.mkdir(otherWorkspace);
  const a = await ctx.manager.spawn(input(ctx, 'short'));
  const b = await ctx.manager.spawn(input(ctx, 'long', '[fixture:sleep=5000]'));
  const c = await ctx.manager.spawn({ ...input(ctx, 'other-long', '[fixture:sleep=30000]'), cwd: otherWorkspace });
  const first = await done(ctx, a.task_id);
  assert.equal(first.status, 'succeeded');
  await delay(500);
  assert.equal((await ctx.manager.status(a.task_id)).resourceCleanup, undefined);
  assert.equal((await hostCall(ctx.config, 'identity', { workspacePath: ctx.workspace })).identity, first.runtimeIdentity.identity);
  await released(ctx, b.task_id);
  await released(ctx, a.task_id);
  assert.equal((await ctx.manager.status(c.task_id)).status, 'running');
  assert.ok(await hostCall(ctx.config, 'identity', { workspacePath: otherWorkspace }));
  await ctx.manager.cancel(c.task_id);
  assert.equal((await released(ctx, c.task_id)).status, 'cancelled');
  await assert.rejects(hostCall(ctx.config, 'identity', { workspacePath: otherWorkspace }), /runtime identity is unavailable/);
});

test('a mismatched runtime identity cannot dispose a replacement process', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.manager.spawn(input(ctx, 'identity-guard', '[fixture:sleep=30000]'));
  const running = await until(async () => {
    const state = await ctx.manager.status(a.task_id);
    return state.status === 'running' && state;
  });
  assert.deepEqual(await hostCall(ctx.config, 'releaseWorkspace', {
    instance: running.appServer.instance, workspacePath: ctx.workspace, identities: ['stale-identity'],
  }), { released: false, reason: 'runtime-changed' });
  assert.deepEqual(await hostCall(ctx.config, 'identity', { workspacePath: ctx.workspace }), running.runtimeIdentity);
});

test('a workspace runtime exit fails its task without restarting the process for cleanup', async (t) => {
  const ctx = await setup(t);
  const task = await ctx.manager.spawn(input(ctx, 'runtime-exit', '[fixture:runtime-exit]'));
  const result = await released(ctx, task.task_id);
  assert.equal(result.status, 'failed');
  assert.equal(result.resourceCleanup.reason, 'already-absent');
  assert.equal((await hostHealth(ctx.config)).hostPid, result.appServer.hostPid);
  await assert.rejects(hostCall(ctx.config, 'identity', { workspacePath: ctx.workspace }), /runtime identity is unavailable/);
});

test('an old adapter drains active tasks before replacement and then dispatches retained queued work', async (t) => {
  const ctx = await setup(t);
  const old = await legacyHost(ctx.config);
  const short = await ctx.manager.spawn(input(ctx, 'old-short'));
  const long = await ctx.manager.spawn(input(ctx, 'old-long', '[fixture:sleep=4500]'));
  await done(ctx, short.task_id);
  await until(() => ctx.manager.resources.upgrade?.status === 'draining');
  const queued = await ctx.manager.spawn(input(ctx, 'new-queued'));
  await delay(500);
  assert.equal((await ctx.manager.status(queued.task_id)).status, 'queued');
  assert.equal((await ctx.manager.status(long.task_id)).status, 'running');
  assert.equal((await hostHealth(ctx.config)).hostPid, old.hostPid);
  assert.equal((await done(ctx, long.task_id)).status, 'succeeded');
  assert.equal((await released(ctx, short.task_id)).status, 'succeeded');
  const result = await released(ctx, queued.task_id);
  assert.equal(result.status, 'succeeded');
  assert.notEqual(result.appServer.hostPid, old.hostPid);
  assert.equal((await hostHealth(ctx.config)).capabilities.workspaceRelease, true);
  assert.equal(ctx.manager.resources.upgrade, undefined);
});

test('a workspace removed while queued fails before contacting the shared Host', async (t) => {
  const ctx = await setup(t, 1);
  const busy = await ctx.manager.spawn(input(ctx, 'occupy-slot', '[fixture:sleep=2000]'));
  await until(async () => (await ctx.manager.status(busy.task_id)).status === 'running');
  const before = await hostHealth(ctx.config);
  const removed = path.join(ctx.home, 'temporary-checkout');
  await fs.mkdir(removed);
  const stale = await ctx.manager.spawn({ ...input(ctx, 'removed-queued-workspace'), cwd: removed });
  await fs.rm(removed, { recursive: true });
  const result = await done(ctx, stale.task_id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Workspace no longer exists/);
  assert.equal(result.appServer, undefined);
  assert.equal((await done(ctx, busy.task_id)).status, 'succeeded');
  assert.equal((await hostHealth(ctx.config)).hostPid, before.hostPid);
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

test('cancel stops only its session; another task and the shared Host survive', async (t) => {
  const ctx = await setup(t);
  const task = await ctx.manager.spawn(input(ctx, 'cancel', '[fixture:sleep=30000]'));
  const other = await ctx.manager.spawn(input(ctx, 'other', '[fixture:sleep=2000]'));
  await until(async () => (await ctx.manager.status(task.task_id)).status === 'running');
  const before = await hostHealth(ctx.config);
  await ctx.manager.cancel(task.task_id);
  assert.equal((await done(ctx, task.task_id)).status, 'cancelled');
  assert.equal((await done(ctx, other.task_id)).status, 'succeeded');
  assert.equal((await hostHealth(ctx.config)).hostPid, before.hostPid);
});

test('execution deadlines still stop tasks independently of waiting', async (t) => {
  const ctx = await setup(t);
  const timeout = await ctx.manager.spawn({ ...input(ctx, 'execution-timeout', '[fixture:sleep=10000]'), run_timeout_ms: 1000 });
  const result = await done(ctx, timeout.task_id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /deadline/);
});

test('model validation, provider errors, and literal prompt transport', async (t) => {
  const ctx = await setup(t);
  const fail = await ctx.manager.spawn(input(ctx, 'fail', '[fixture:fail]'));
  assert.equal((await done(ctx, fail.task_id)).status, 'failed');
  const bad = await ctx.manager.spawn({ ...input(ctx, 'bad'), model: { providerId: 'fixture', modelId: 'missing' } });
  const badResult = await done(ctx, bad.task_id);
  assert.match(badResult.error, /unavailable/);
  assert.equal(badResult.sessionId, undefined);
  const invalidReasoning = await ctx.manager.spawn({ ...input(ctx, 'bad-reasoning'), model: { providerId: 'fixture', modelId: 'default', options: { reasoningLevel: 'bogus' } } });
  assert.match((await done(ctx, invalidReasoning.task_id)).error, /reasoning-level-not-supported/);
  const sentinel = path.join(ctx.workspace, 'should-not-exist');
  const prompt = '[fixture:args] $(touch ' + sentinel + ') ; echo bad';
  const literal = await ctx.manager.spawn(input(ctx, 'literal', prompt));
  assert.equal((await done(ctx, literal.task_id)).status, 'succeeded');
  const args = JSON.parse(await fs.readFile(path.join(ctx.workspace, 'arguments.json'), 'utf8'));
  assert.ok(args.envelope.payload.text.includes(prompt));
  assert.ok(args.create.toolDenylist.includes('Bash'));
  assert.ok(args.create.toolAllowlist.includes('Read'));
  assert.ok(!args.create.toolAllowlist.includes('Write'));
  assert.ok(!args.create.toolAllowlist.includes('Agent'));
  assert.equal(args.envelope.payload.planEnabled, true);
  await assert.rejects(fs.access(sentinel));
});

test('default routing, explicit override, followup inheritance and Host reuse', async (t) => {
  const ctx = await setup(t);
  const a = await ctx.manager.spawn(input(ctx, 'default'));
  const first = await done(ctx, a.task_id);
  assert.equal(first.effectiveModel.modelId, 'default');
  const b = await ctx.manager.spawn({ ...input(ctx, 'explicit'), model: { providerId: 'fixture', modelId: 'explicit', options: { reasoningLevel: 'low' } } });
  const second = await done(ctx, b.task_id);
  assert.equal(second.effectiveModel.modelId, 'explicit');
  assert.equal(second.observedModel.modelId, 'explicit');
  assert.equal(second.appServer.instance, first.appServer.instance);
  const c = await ctx.manager.followup(validate('zcode_followup', { task_id: b.task_id, request_key: 'continue', prompt: 'continue' }));
  const third = await done(ctx, c.task_id);
  assert.deepEqual(third.effectiveModel, second.effectiveModel);
  assert.equal(third.sessionId, second.sessionId);
  const d = await ctx.manager.followup(validate('zcode_followup', { task_id: c.task_id, request_key: 'reset-default', prompt: 'continue', model: 'default' }));
  assert.equal((await done(ctx, d.task_id)).effectiveModel.modelId, 'default');
  assert.equal((await hostCall(ctx.config, 'models')).defaultModel.modelId, 'default');
});

test('a crashed worker stops its session without killing the shared Host or replaying', async (t) => {
  const ctx = await setup(t);
  const task = await ctx.manager.spawn(input(ctx, 'crash', '[fixture:sleep=30000]'));
  await until(async () => (await ctx.manager.status(task.task_id)).status === 'running');
  const dir = path.join(ctx.home, 'tasks', task.task_id);
  const owner = JSON.parse(await fs.readFile(path.join(dir, 'owner.json'), 'utf8'));
  const before = await hostHealth(ctx.config);
  process.kill(owner.pid, 'SIGKILL');
  const result = await done(ctx, task.task_id);
  assert.equal(result.status, 'interrupted');
  await released(ctx, task.task_id);
  await assert.rejects(hostCall(ctx.config, 'identity', { workspacePath: ctx.workspace }), /runtime identity is unavailable/);
  assert.equal((await hostHealth(ctx.config)).hostPid, before.hostPid);
  assert.equal((await ctx.manager.list()).length, 1);
});

test('worker exit between scheduler reads preserves the committed terminal result', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zsa-exit-race-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const config = settings({ ZCODE_SUBAGENTS_HOME: home });
  const manager = new Supervisor(config);
  const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const dir = path.join(home, 'tasks', id);
  const spec = { id, createdAt: new Date().toISOString() };
  await atomicJson(path.join(dir, 'spec.json'), spec);
  const final = { status: 'succeeded', response: 'Committed before worker exit' };
  await atomicJson(path.join(dir, 'runtime.json'), final);
  const original = manager.task.bind(manager);
  let reads = 0;
  manager.task = async (taskId) => ++reads === 1 ? { spec, dir, state: { status: 'running', startedAt: '2000-01-01T00:00:00Z' } } : original(taskId);
  await manager.tick();
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'runtime.json'), 'utf8')), final);
});

test('Host framing accepts fragmented and concatenated messages and rejects oversized frames', () => {
  const frames = new Frames(); const values = [];
  const msg = frame([201, 7], { text: '中文', count: 4 });
  frames.accept(msg.subarray(0, 8), (...v) => values.push(v));
  assert.equal(values.length, 0);
  frames.accept(Buffer.concat([msg.subarray(8), msg]), (...v) => values.push(v));
  assert.deepEqual(values, [[[201, 7], { text: '中文', count: 4 }], [[201, 7], { text: '中文', count: 4 }]]);
  const invalid = Buffer.alloc(13); invalid.writeUInt32BE(32 * 1024 * 1024, 9);
  assert.throws(() => frames.accept(invalid, () => {}), /too large/);
});

test('a Host crash fails accepted work without replay and the next task starts a new Host', async (t) => {
  const ctx = await setup(t);
  const task = await ctx.manager.spawn(input(ctx, 'host-crash', '[fixture:crash]'));
  const result = await done(ctx, task.task_id);
  assert.equal(result.status, 'failed');
  const next = await ctx.manager.spawn(input(ctx, 'after-host-crash'));
  const recovered = await done(ctx, next.task_id);
  assert.equal(recovered.status, 'succeeded');
  assert.notEqual(recovered.appServer.instance, result.appServer.instance);
  assert.equal((await ctx.manager.list()).length, 2);
});

test('V4 snapshot assembly verifies fragmented payloads, identity and checksum', () => {
  const topic = 'conversation/test', subscriptionId = 'sub1';
  const frame = { topic, subscriptionId, toSeq: 3, payload: { kind: 'snapshot', snapshot: { protocolVersion: 1, seq: 3, control: {}, rows: { window: [] } } } };
  const bytes = Buffer.from(JSON.stringify(frame));
  const base = { topic, subscriptionId, wireVersion: 3, kind: 'fragment', deliveryKind: 'initial', logicalFrameId: 'f1', fragmentCount: 2,
    logicalBytes: bytes.length, checksum: { algorithm: 'crc32', value: crc32(bytes).toString(16).padStart(8, '0') } };
  const assembly = new SnapshotAssembly(topic);
  assert.equal(assembly.accept({ ...base, fragmentIndex: 1, dataBase64: bytes.subarray(50).toString('base64') }), undefined);
  assert.equal(assembly.accept({ ...base, fragmentIndex: 0, dataBase64: bytes.subarray(0, 50).toString('base64') }).snapshot.seq, 3);
  assert.throws(() => new SnapshotAssembly(topic).accept({ ...base, fragmentCount: 1, fragmentIndex: 0, checksum: { algorithm: 'crc32', value: '00000000' }, dataBase64: bytes.toString('base64') }), /checksum/);
});

test('configuration rejects exceeding 12, traversal and invalid wait windows', () => {
  assert.throws(() => settings({ ZCODE_SUBAGENTS_CONCURRENCY: '13' }), /1 to 12/);
  assert.throws(() => validate('zcode_status', { task_id: '../../secret' }));
  assert.throws(() => validate('zcode_wait', { task_ids: [], timeout_ms: 1 }));
});
