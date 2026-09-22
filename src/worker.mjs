import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson, now, taskDir, processIdentity, bounded, settings, delay, sameProcess } from './common.mjs';
import { prepareWorkspace, collectChanges } from './workspace.mjs';
import { ensureHost, hostCall } from './host-client.mjs';
import { runningConversation, turnResult } from './conversation.mjs';

export function taskPrompt(spec) {
  return ['You are a ZCode subagent delegated by Codex.',
    'Do only the bounded task below. Do not create agents, workflows, or invoke other coding agents.',
    'Do not publish, push, deploy, or merge. Bash and recursive delegation are disabled; do not bypass them.',
    'Write tests if relevant and return commands for Codex to run. Do not claim unrun checks passed.',
    spec.kind === 'analysis' ? 'Analysis only: do not edit any files.' : 'Edit only in this isolated worktree.',
    'Return a concise summary, changes, actual checks, suggested commands and unresolved issues.', '', spec.prompt].join('\n');
}
export async function runWorker(config, id) {
  process.umask(0o077);
  const dir = taskDir(config, id);
  await (await fs.open(path.join(dir, 'worker.lock'), 'wx', 0o600)).close();
  await atomicJson(path.join(dir, 'owner.json'), { pid: process.pid, identity: await processIdentity(process.pid) });
  const spec = await readJson(path.join(dir, 'spec.json'));
  const state = { status: 'preparing', startedAt: now(), backend: 'desktop-app-server', requestedModel: spec.model };
  const save = () => atomicJson(path.join(dir, 'runtime.json'), { ...state, updatedAt: now() });
  let stopping;
  process.once('SIGTERM', () => { stopping = 'Worker received SIGTERM'; });
  process.once('SIGINT', () => { stopping = 'Worker received SIGINT'; });
  const params = () => ({ instance: state.appServer.instance, workspacePath: state.workspace, sessionId: state.sessionId, runtimeIdentity: state.runtimeIdentity });
  let accepted = false;
  let terminal = false;
  await save();
  try {
    state.workspace = await prepareWorkspace(spec, dir);
    if (await readJson(path.join(dir, 'cancel.json'))) { state.status = 'cancelled'; return; }
    state.appServer = await ensureHost(config);
    state.effectiveModel = await hostCall(config, 'resolveModel', { model: spec.model, instance: state.appServer.instance });
    const snapshot = await hostCall(config, spec.sessionId ? 'resume' : 'create', {
      instance: state.appServer.instance, workspacePath: state.workspace, sessionId: spec.sessionId, kind: spec.kind,
    });
    state.sessionId = snapshot.session.sessionId;
    state.runtimeIdentity = await hostCall(config, 'identity', params());
    await save();
    const ack = await hostCall(config, 'send', { ...params(), commandId: id, kind: spec.kind,
      model: state.effectiveModel, prompt: taskPrompt(spec) });
    accepted = true;
    state.commandAck = ack.status;
    state.status = 'running';
    await save();
    let stopSent = false, failure;
    while (!terminal) {
      const cancel = await readJson(path.join(dir, 'cancel.json'));
      if (cancel) stopping ||= cancel.reason || 'Cancelled by caller';
      if (spec.runTimeoutMs && Date.now() - Date.parse(state.startedAt) >= spec.runTimeoutMs) {
        failure ||= 'Execution deadline exceeded'; stopping ||= failure;
      }
      if (stopping && !stopSent) {
        await hostCall(config, 'stop', { ...params(), commandId: id + '-stop' }); stopSent = true;
      }
      const current = await hostCall(config, 'snapshot', { ...params(), commandId: id });
      const result = turnResult(current, id);
      if (result && !runningConversation(current)) {
        if (result.resultType !== 'completedSuccess' && !(stopping && result.resultType === 'completedInterrupted')) failure ||= result.error?.message || 'App-server turn ended: ' + result.resultType;
        if (result.resultType === 'completedSuccess' && !result.response) failure ||= 'App-server ended without an assistant response';
        state.response = bounded(result.response); state.usage = result.usage;
        await atomicJson(path.join(dir, 'result.json'), { ...result, sessionId: state.sessionId, effectiveModel: state.effectiveModel });
        terminal = true;
      }
      if (state.eventSeq !== current.seq) await fs.appendFile(path.join(dir, 'progress.jsonl'), JSON.stringify({
        at: now(), seq: current.seq, control: current.control, model: current.config.modelSelection,
        rows: current.rows.window.map((r) => ({ rowId: r.rowId, kind: r.kind, state: r.state, toolName: r.toolName })),
      }) + '\n', { mode: 0o600 });
      state.eventSeq = current.seq;
      state.projection = current.control;
      state.observedModel = current.config.modelSelection;
      if (current.pendingInteractions?.length) {
        failure ||= 'App-server requires interaction; task stopped for review'; stopping ||= failure;
      }
      if (stopping && stopSent && !runningConversation(current)) terminal = true;
      if (!terminal && current.control.phase === 'error') throw new Error(current.control.lastError?.message || 'App-server entered an error state');
      await save();
      if (!terminal) await delay(1000);
    }
    state.status = failure ? 'failed' : stopping ? 'cancelled' : 'succeeded';
    if (failure || stopping) state.error = failure || stopping;
    state.changes = await collectChanges(spec, state.workspace, dir);
  } catch (error) {
    state.error = error.message;
    state.status = 'failed';
    if (state.sessionId && !terminal) {
      // A lost send reply can still mean accepted work. Never resend or kill the shared Host.
      try {
        await hostCall(config, 'stop', { ...params(), commandId: id + '-cleanup' });
        const current = await hostCall(config, 'snapshot', params());
        if (runningConversation(current)) state.status = 'cleanup_pending';
      } catch {
        if (await sameProcess({ pid: state.appServer.hostPid, identity: state.appServer.hostIdentity })) state.status = 'cleanup_pending';
      }
    }
    if (accepted && !terminal) state.submissionOutcome = 'interrupted; not replayed';
  } finally {
    if (state.status !== 'cleanup_pending') state.finishedAt = now();
    await save();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorker(settings(), process.argv[2]).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
