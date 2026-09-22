import { promises as fs, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson, privateDir, newId, taskDir, now, digest, sameProcess,
  TERMINAL, WAIT_DEFAULT, WAIT_MIN, WAIT_MAX, delay, processIdentity } from './common.mjs';
import { inspectWorkspace } from './workspace.mjs';
import { hostCall } from './host-client.mjs';
import { runningConversation } from './conversation.mjs';

const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const active = (state) => ['starting', 'preparing', 'running', 'cleanup_pending'].includes(state);

export class Supervisor {
  constructor(config) {
    this.config = config;
    this.tickBusy = false;
    this.mutations = Promise.resolve();
  }
  async init() {
    await privateDir(path.join(this.config.home, 'tasks'));
    await privateDir(path.join(this.config.home, 'waits'));
    await this.tick();
    this.timer = setInterval(() => { this.tick().catch((e) => console.error(e.message)); }, 300);
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    while (this.tickBusy) await delay(10);
  }
  mutate(fn) {
    const next = this.mutations.then(fn);
    this.mutations = next.catch(() => {});
    return next;
  }
  async ids() {
    return (await fs.readdir(path.join(this.config.home, 'tasks'))).filter((id) => /^[a-f0-9-]{36}$/.test(id));
  }
  async task(id) {
    const dir = taskDir(this.config, id);
    const spec = await readJson(path.join(dir, 'spec.json'));
    if (!spec) throw new Error('Task not found: ' + id);
    const state = await readJson(path.join(dir, 'runtime.json'), { status: 'queued' });
    return { spec, state, dir };
  }
  async status(id) {
    const { spec, state, dir } = await this.task(id);
    return {
      task_id: id, workflow_id: spec.workflowId, kind: spec.kind, parent_task_id: spec.parentTaskId,
      created_at: spec.createdAt, ...state,
      artifacts: { directory: dir, worker: path.join(dir, 'worker.log'),
        ...(state.backend === 'desktop-app-server' ? { progress: path.join(dir, 'progress.jsonl') } :
          { stdout: path.join(dir, 'stdout.log'), stderr: path.join(dir, 'stderr.log') }), result: path.join(dir, 'result.json') },
    };
  }
  async list(workflowId) {
    const rows = [];
    for (const id of await this.ids()) {
      const row = await this.status(id);
      if (!workflowId || row.workflow_id === workflowId) rows.push(row);
    }
    return rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  async spawn(input) {
    return this.mutate(async () => {
      const requestHash = digest(input);
      for (const id of await this.ids()) {
        const { spec } = await this.task(id);
        if (spec.workflowId === input.workflow_id && spec.requestKey === input.request_key) {
          if (spec.requestHash !== requestHash) throw new Error('request_key already belongs to a different request.');
          return this.status(id);
        }
      }
      const context = await inspectWorkspace(input.cwd, input.kind);
      const id = newId();
      const spec = {
        id, workflowId: input.workflow_id, requestKey: input.request_key, requestHash,
        prompt: input.prompt, kind: input.kind, runTimeoutMs: input.run_timeout_ms || 0, model: input.model,
        createdAt: now(), ...context,
      };
      await atomicJson(path.join(taskDir(this.config, id), 'spec.json'), spec);
      return this.status(id);
    });
  }
  async followup(input) {
    return this.mutate(async () => {
      const parent = await this.task(input.task_id);
      const requestHash = digest(input);
      for (const id of await this.ids()) {
        const { spec } = await this.task(id);
        if (spec.workflowId === parent.spec.workflowId && spec.requestKey === input.request_key) {
          if (spec.requestHash !== requestHash) throw new Error('request_key already belongs to a different request.');
          return this.status(id);
        }
      }
      // Resume creates a linear conversation. Reject sibling followups that
      // could resume the same session concurrently or out of order.
      for (const id of await this.ids()) {
        if ((await this.task(id)).spec.parentTaskId === input.task_id) {
          throw new Error('This task already has a followup. Continue from that task instead.');
        }
      }
      const id = newId();
      const spec = {
        ...parent.spec, id, parentTaskId: input.task_id, requestKey: input.request_key, requestHash,
        prompt: input.prompt, createdAt: now(), sessionId: undefined, workspace: undefined,
        runTimeoutMs: input.run_timeout_ms || 0,
        model: input.model,
      };
      await atomicJson(path.join(taskDir(this.config, id), 'spec.json'), spec);
      return this.status(id);
    });
  }
  async cancel(id) {
    const task = await this.task(id);
    if (TERMINAL.has(task.state.status)) return this.status(id);
    await atomicJson(path.join(task.dir, 'cancel.json'), { reason: 'Cancelled by caller', at: now() });
    // The scheduler is the sole owner of queued-state transitions.
    await this.tick();
    return this.status(id);
  }
  async tick() {
    if (this.closed || this.tickBusy) return;
    this.tickBusy = true;
    try {
      const tasks = await Promise.all((await this.ids()).map((id) => this.task(id)));
      let count = 0;
      const busyWorkspaces = new Set();
      for (const task of tasks) {
        if (!active(task.state.status)) continue;
        const owner = await readJson(path.join(task.dir, 'owner.json'));
        if (await sameProcess(owner) || (!owner && Date.now() - Date.parse(task.state.startedAt) < 10000)) {
          count++;
          if (task.state.workspace) busyWorkspaces.add(task.state.workspace);
        } else {
          // The worker can commit its final state and exit after this tick read
          // the initial snapshot. Re-read only after confirming the owner died.
          // Otherwise cleanup would overwrite a successful result as interrupted.
          task.state = (await this.task(task.spec.id)).state;
          if (!active(task.state.status)) continue;
          if (task.state.appServer) {
            // App-server is shared. Stop only this session, never its Host process.
            const host = task.state.appServer;
            if (await sameProcess({ pid: host.hostPid, identity: host.hostIdentity })) {
              try {
                const params = { instance: host.instance, workspacePath: task.state.workspace, sessionId: task.state.sessionId };
                await hostCall(this.config, 'stop', params);
                const snapshot = await hostCall(this.config, 'snapshot', params);
                if (runningConversation(snapshot)) { count++; continue; }
              } catch {
                count++;
                if (task.state.status !== 'cleanup_pending') await atomicJson(path.join(task.dir, 'runtime.json'), {
                  ...task.state, status: 'cleanup_pending', error: 'Worker stopped; waiting to confirm its app-server session has stopped.',
                });
                continue;
              }
            }
          }
          // A dead worker may have left its model process alive. Keep its slot
          // occupied until that exact process exits; never blindly replay work.
          const child = await readJson(path.join(task.dir, 'child.json'));
          if (await sameProcess(child)) {
            task.state.orphanedAt ||= now();
            await atomicJson(path.join(task.dir, 'runtime.json'), task.state);
            const signal = Date.now() - Date.parse(task.state.orphanedAt) > 8000 ? 'SIGKILL' : 'SIGTERM';
            try { process.kill(-child.pid, signal); } catch {}
            count++;
            continue;
          }
          if (child?.pid && !await processIdentity(child.pid)) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch {}
          }
          task.state = { ...task.state, status: 'interrupted', finishedAt: now(),
            error: task.state.error || 'Worker exited without a final result. Inspect artifacts before explicitly retrying.' };
          await atomicJson(path.join(task.dir, 'runtime.json'), task.state);
        }
      }
      tasks.sort((a, b) => a.spec.createdAt.localeCompare(b.spec.createdAt));
      for (const task of tasks) {
        if (task.state.status !== 'queued') continue;
        if (await readJson(path.join(task.dir, 'cancel.json'))) {
          await atomicJson(path.join(task.dir, 'runtime.json'), { status: 'cancelled', finishedAt: now() });
          continue;
        }
        if (count >= this.config.concurrency) continue;
        if (task.spec.parentTaskId) {
          const parent = await this.task(task.spec.parentTaskId);
          if (!TERMINAL.has(parent.state.status)) continue;
          if (!parent.state.sessionId || !parent.state.workspace) {
            await atomicJson(path.join(task.dir, 'runtime.json'), {
              status: 'failed', finishedAt: now(), error: 'Parent task has no resumable session.',
            });
            continue;
          }
          task.spec.sessionId = parent.state.sessionId;
          task.spec.workspace = parent.state.workspace;
          task.spec.model ??= parent.state.effectiveModel || parent.spec.model;
          await atomicJson(path.join(task.dir, 'spec.json'), task.spec);
        }
        if (task.spec.workspace && busyWorkspaces.has(task.spec.workspace)) continue;
        await atomicJson(path.join(task.dir, 'runtime.json'), {
          status: 'starting', startedAt: now(), workspace: task.spec.workspace,
        });
        const log = openSync(path.join(task.dir, 'worker.log'), 'a', 0o600);
        try {
          const worker = spawn(process.execPath, [workerPath, task.spec.id], {
            env: { ...process.env, ZCODE_SUBAGENTS_HOME: this.config.home,
              ZCODE_SUBAGENTS_RUNTIME_ROOT: this.config.runtimeRoot },
            stdio: ['ignore', log, log], detached: true,
          });
          worker.once('error', (error) => {
            atomicJson(path.join(task.dir, 'runtime.json'), {
              status: 'failed', error: error.message, finishedAt: now(),
            }).catch(console.error);
          });
          worker.unref();
        } finally { closeSync(log); }
        count++;
        if (task.spec.workspace) busyWorkspaces.add(task.spec.workspace);
      }
    } finally { this.tickBusy = false; }
  }
  async wait(input, sliceMs = 20000) {
    let wait;
    let id = input.wait_id;
    if (id) {
      wait = await readJson(path.join(this.config.home, 'waits', validWaitId(id) + '.json'));
      if (!wait) throw new Error('Wait not found.');
    } else {
      if (!input.task_ids?.length) throw new Error('task_ids is required for a new wait.');
      const timeout = input.timeout_ms ?? WAIT_DEFAULT;
      if (timeout < WAIT_MIN || timeout > WAIT_MAX) throw new Error('Wait timeout must be 10–30 minutes.');
      for (const taskId of input.task_ids) await this.task(taskId);
      id = newId();
      wait = { ids: input.task_ids, mode: input.mode || 'all', deadline: Date.now() + timeout };
      await atomicJson(path.join(this.config.home, 'waits', id + '.json'), wait);
    }
    const sliceEnd = Math.min(Date.now() + Math.min(sliceMs, 50000), wait.deadline);
    let tasks;
    let ready;
    do {
      tasks = await Promise.all(wait.ids.map((taskId) => this.status(taskId)));
      ready = wait.mode === 'any' ? tasks.some((t) => TERMINAL.has(t.status)) : tasks.every((t) => TERMINAL.has(t.status));
      if (ready || Date.now() >= sliceEnd) break;
      await delay(Math.min(200, sliceEnd - Date.now()));
    } while (true);
    return { wait_id: id, deadline: new Date(wait.deadline).toISOString(),
      ready, timed_out: !ready && Date.now() >= wait.deadline, tasks,
      instruction: ready ? 'Inspect task results.' : 'Tasks continue running. Call zcode_wait with the same wait_id to preserve the deadline.' };
  }
}

function validWaitId(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid wait ID.');
  return id;
}
