import { promises as fs, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson, privateDir, newId, taskDir, now, digest, sameProcess,
  TERMINAL, delay, processIdentity } from './common.mjs';
import { inspectWorkspace } from './workspace.mjs';
import { hostCall } from './host-client.mjs';
import { runningConversation } from './conversation.mjs';
import { ResourceReaper, activeTask, workspaceFor } from './resources.mjs';
import { waitForTasks } from './wait.mjs';
import { readTask, taskStatus } from './task-state.mjs';

const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const active = activeTask;

export class Supervisor {
  constructor(config) {
    this.config = config;
    this.tickBusy = false;
    this.mutations = Promise.resolve();
    this.resources = new ResourceReaper(config);
  }
  async init() {
    await privateDir(path.join(this.config.home, 'tasks'));
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
    return readTask(this.config, id);
  }
  async status(id) {
    return taskStatus(this.config, id);
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
          busyWorkspaces.add(workspaceFor(task));
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
                const params = { instance: host.instance, workspacePath: task.state.workspace,
                  sessionId: task.state.sessionId, runtimeIdentity: task.state.runtimeIdentity };
                const stopped = await hostCall(this.config, 'stop', params);
                if (!stopped.runtimeEnded) {
                  const snapshot = await hostCall(this.config, 'snapshot', params);
                  if (runningConversation(snapshot)) { count++; continue; }
                }
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
      if (!await this.resources.sweep(tasks)) return;
      tasks.sort((a, b) => a.spec.createdAt.localeCompare(b.spec.createdAt));
      for (const task of tasks) {
        if (task.state.status !== 'queued') continue;
        if (await readJson(path.join(task.dir, 'cancel.json'))) {
          await atomicJson(path.join(task.dir, 'runtime.json'), { status: 'cancelled', finishedAt: now() });
          continue;
        }
        if (count >= this.config.concurrency) continue;
        // A Codex reinstall can remove this supervisor's old plugin cache.
        // Leave queued work queued until a current client replaces the supervisor.
        try { await fs.access(workerPath); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
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
  wait(input, options) {
    return waitForTasks((id) => this.status(id), input.task_ids, options);
  }
}
