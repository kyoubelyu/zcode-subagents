import { setTimeout as sleep } from 'node:timers/promises';
import { TERMINAL, WAIT_TIMEOUT } from './common.mjs';

const realtime = {
  now: () => performance.now(), wall: () => Date.now(),
  sleep: (ms, signal) => sleep(ms, undefined, { signal }),
};

// Every call owns its watch list and deadline. No shared cursor, workflow-wide
// subscription, or consumed completion event can interfere with another caller.
// The injected clock lets tests cover the actual ten-minute boundary instantly.
export async function waitForTasks(readStatus, taskIds, { signal, clock = realtime } = {}) {
  if (!Array.isArray(taskIds) || !taskIds.length) throw new Error('A non-empty task_ids list is required.');
  const ids = [...new Set(taskIds)];
  const started = clock.now();
  const deadline = new Date(clock.wall() + WAIT_TIMEOUT).toISOString();
  for (;;) {
    signal?.throwIfAborted();
    // Read all IDs even if one is already complete: invalid IDs must not hide
    // behind an early result for another task.
    const tasks = await Promise.all(ids.map(readStatus));
    const completed = tasks.filter((task) => TERMINAL.has(task.status)).map((task) => task.task_id);
    const pending = tasks.filter((task) => !TERMINAL.has(task.status)).map((task) => task.task_id);
    const elapsed = Math.max(0, clock.now() - started);
    if (completed.length || elapsed >= WAIT_TIMEOUT) return {
      task_ids: ids, completed_task_ids: completed, pending_task_ids: pending,
      ready: completed.length > 0, timed_out: completed.length === 0,
      timeout_ms: WAIT_TIMEOUT, elapsed_ms: Math.floor(elapsed), deadline, tasks,
      instruction: pending.length ? 'Tasks continue independently. To wait again, pass only pending_task_ids as task_ids.' : 'All selected tasks ended. Inspect their results.',
    };
    await clock.sleep(Math.min(200, WAIT_TIMEOUT - elapsed), signal);
  }
}
