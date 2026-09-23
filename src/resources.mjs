import path from 'node:path';
import { atomicJson, readJson, now, TERMINAL, sameProcess, delay } from './common.mjs';
import { hostCall, hostHealth, ensureHost } from './host-client.mjs';

export const activeTask = (status) => ['starting', 'preparing', 'running', 'cleanup_pending'].includes(status);
export const workspaceFor = (task) => task.state.workspace || task.spec.workspace ||
  (task.spec.kind === 'analysis' ? task.spec.cwd : path.join(task.dir, 'worktree'));

export class ResourceReaper {
  constructor(config) { this.config = config; this.retryAfter = new Map(); }
  async refreshAdapter(host, busy) {
    if (host.capabilities?.workspaceRelease) { this.upgrade = undefined; return host; }
    // One-time migration from the old plugin adapter. Drain existing workers
    // before closing its stdio connection; queued tasks remain queued.
    this.upgrade = { status: 'draining', reason: 'Waiting for active tasks before updating the plugin Host adapter.' };
    if (busy.size) return;
    this.upgrade.status = 'replacing';
    const owner = await readJson(path.join(this.config.home, 'host-owner.json'));
    if (owner?.instance !== host.instance || owner.pid !== host.pid || !await sameProcess(owner)) {
      throw new Error('Host adapter changed during update; retrying after identity verification.');
    }
    process.kill(owner.pid, 'SIGTERM');
    const native = { pid: host.hostPid, identity: host.hostIdentity };
    const deadline = Date.now() + 15000;
    while ((await sameProcess(owner) || await sameProcess(native)) && Date.now() < deadline) await delay(100);
    if (await sameProcess(owner) || await sameProcess(native)) throw new Error('Previous Host adapter is still closing.');
    const updated = await ensureHost(this.config);
    if (!updated.capabilities?.workspaceRelease) throw new Error('Installed plugin adapter lacks workspace cleanup support.');
    this.upgrade = undefined;
    return updated;
  }
  // Called only by the scheduler while dispatch is paused. No other supervisor
  // can start workers because the shared pool holds a lifetime flock.
  async sweep(tasks) {
    const busy = new Set(tasks.filter((t) => activeTask(t.state.status)).map(workspaceFor));
    const groups = new Map();
    for (const task of tasks) {
      const s = task.state;
      if (!TERMINAL.has(s.status) || !s.appServer || !s.workspace || s.resourceCleanup?.status === 'released' || busy.has(s.workspace)) continue;
      const key = s.appServer.instance + ':' + s.workspace;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(task);
    }
    // A finished task may share a busy workspace. Still inspect adapter
    // capability so a legacy adapter can drain before accepting more work.
    if (!groups.size && !tasks.some((t) => TERMINAL.has(t.state.status) && t.state.appServer && t.state.resourceCleanup?.status !== 'released')) return true;
    let host;
    try { host = await hostHealth(this.config); } catch { return true; }
    try { host = await this.refreshAdapter(host, busy); }
    catch (error) { this.upgrade = { status: 'pending', error: error.message }; return false; }
    if (!host) return false;
    for (const [key, group] of groups) {
      if (Date.now() < (this.retryAfter.get(key) || 0)) continue;
      const first = group[0].state;
      let result;
      try {
        if (first.appServer.instance !== host.instance) {
          if (await sameProcess({ pid: first.appServer.hostPid, identity: first.appServer.hostIdentity })) {
            throw new Error('Previous Host is still alive; its workspace cannot be released through a replacement Host.');
          }
          result = { released: true, reason: 'host-ended' };
        } else {
          if (!host.capabilities?.workspaceRelease) throw new Error('Host adapter needs the idle-workspace cleanup update.');
          result = await hostCall(this.config, 'releaseWorkspace', { instance: host.instance,
            workspacePath: first.workspace,
            identities: [...new Set(group.map((t) => t.state.runtimeIdentity?.identity).filter(Boolean))] });
          if (!result.released) throw new Error('Workspace not released: ' + result.reason);
        }
        this.retryAfter.delete(key);
      } catch (error) {
        this.retryAfter.set(key, Date.now() + 5000);
        result = { released: false, error: error.message };
      }
      for (const task of group) {
        task.state = { ...task.state, resourceCleanup: { status: result.released ? 'released' : 'pending',
          at: now(), historyRetained: true, reason: result.reason, error: result.error } };
        await atomicJson(path.join(task.dir, 'runtime.json'), task.state);
      }
    }
    return true;
  }
}
