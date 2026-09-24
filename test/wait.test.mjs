import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForTasks } from '../src/wait.mjs';
import { validate } from '../src/schemas.mjs';
import { WAIT_TIMEOUT } from '../src/common.mjs';

const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const c = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function clock() {
  let elapsed = 0;
  return { now: () => elapsed, wall: () => 0, sleep: async (ms) => { elapsed += ms; } };
}

test('wait requires explicit non-empty UUID task IDs and rejects old continuation/options', () => {
  for (const input of [{}, { task_ids: [] }, { task_ids: ['bad'] }, { wait_id: a },
    { task_ids: [a], mode: 'all' }, { task_ids: [a], timeout_ms: 20 }]) assert.throws(() => validate('zcode_wait', input));
  assert.deepEqual(validate('zcode_wait', { task_ids: [a, b] }), { task_ids: [a, b] });
});

test('one call passes the former slice/transport limits and returns for any selected task', async () => {
  const time = clock(), watched = new Set();
  const result = await waitForTasks(async (id) => {
    watched.add(id);
    return { task_id: id, status: id === b && time.now() >= 65000 ? 'succeeded' : 'running' };
  }, [a, b, a], { clock: time });
  assert.equal(result.elapsed_ms, 65000); assert.equal(result.timeout_ms, 600000);
  assert.equal(result.ready, true); assert.equal(result.timed_out, false);
  assert.deepEqual(result.task_ids, [a, b]);
  assert.deepEqual(result.completed_task_ids, [b]); assert.deepEqual(result.pending_task_ids, [a]);
  assert.deepEqual([...watched], [a, b]); assert.equal(result.wait_id, undefined);
});

test('a complete ten-minute wait times out without changing task state', async () => {
  const state = { task_id: a, status: 'running' };
  const result = await waitForTasks(async () => state, [a], { clock: clock() });
  assert.equal(result.elapsed_ms, WAIT_TIMEOUT);
  assert.equal(result.deadline, '1970-01-01T00:10:00.000Z');
  assert.equal(result.ready, false); assert.equal(result.timed_out, true);
  assert.deepEqual(result.completed_task_ids, []); assert.deepEqual(result.pending_task_ids, [a]);
  assert.equal(state.status, 'running');
});

test('success, failure, cancellation and interruption already present return immediately', async () => {
  for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted']) {
    const result = await waitForTasks(async (id) => ({ task_id: id, status }), [a], { clock: clock() });
    assert.equal(result.elapsed_ms, 0); assert.equal(result.ready, true); assert.equal(result.tasks[0].status, status);
  }
});

test('all IDs are validated even when another ID is already complete', async () => {
  await assert.rejects(waitForTasks(async (id) => {
    if (id === b) throw new Error('Task not found');
    return { task_id: id, status: 'succeeded' };
  }, [a, b]), /Task not found/);
});

test('simultaneous overlapping waits observe completion independently', async () => {
  const time1 = clock(), time2 = clock();
  const reader = (time) => async (id) => ({ task_id: id, status: id === b && time.now() >= 1200 ? 'failed' : 'running' });
  const [first, second] = await Promise.all([
    waitForTasks(reader(time1), [a, b], { clock: time1 }),
    waitForTasks(reader(time2), [b, c], { clock: time2 }),
  ]);
  assert.deepEqual(first.completed_task_ids, [b]); assert.deepEqual(second.completed_task_ids, [b]);
  assert.deepEqual(first.pending_task_ids, [a]); assert.deepEqual(second.pending_task_ids, [c]);
});

test('aborting a wait releases its timer without cancelling the task', async () => {
  const controller = new AbortController();
  const state = { task_id: a, status: 'running' };
  const pending = waitForTasks(async () => state, [a], { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(state.status, 'running');
});
