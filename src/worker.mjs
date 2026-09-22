import { promises as fs, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson, now, taskDir, processIdentity, bounded, settings } from './common.mjs';
import { prepareWorkspace, collectChanges } from './workspace.mjs';
import { OutputParser } from './output.mjs';

export async function runWorker(config, id) {
  process.umask(0o077);
  const dir = taskDir(config, id);
  const lock = await fs.open(path.join(dir, 'worker.lock'), 'wx', 0o600);
  await lock.close();
  await atomicJson(path.join(dir, 'owner.json'), {
    pid: process.pid, identity: await processIdentity(process.pid),
  });
  const spec = await readJson(path.join(dir, 'spec.json'));
  let runtime = { status: 'preparing', startedAt: now(), updatedAt: now() };
  let saveChain = Promise.resolve();
  const save = () => {
    const snapshot = { ...runtime, updatedAt: now() };
    saveChain = saveChain.then(() => atomicJson(path.join(dir, 'runtime.json'), snapshot));
    return saveChain;
  };
  await save();
  let child;
  let childOwner;
  let stopping;
  let fatal;
  let killTimer;
  let monitor;
  let monitoring = false;
  const parser = new OutputParser();
  const streams = [];
  const groupSignal = async (signal) => {
    // A live leader must still be the process we started. After its exit the
    // retained process group can contain children holding stdout/stderr open.
    if (!childOwner) return;
    const identity = await processIdentity(childOwner.pid);
    if (identity && identity !== childOwner.identity) return;
    try { process.kill(-childOwner.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  };
  const stop = (reason, failed = false) => {
    if (stopping) return;
    stopping = reason;
    if (failed) fatal ||= reason;
    void groupSignal('SIGTERM');
    killTimer = setTimeout(() => { void groupSignal('SIGKILL'); }, 8000);
  };
  process.once('SIGTERM', () => stop('Worker received SIGTERM'));
  process.once('SIGINT', () => stop('Worker received SIGINT'));
  try {
    runtime.workspace = await prepareWorkspace(spec, dir);
    if (await readJson(path.join(dir, 'cancel.json'))) {
      runtime.status = 'cancelled';
      runtime.error = 'Cancelled before execution';
      return;
    }
    const permission = spec.kind === 'analysis' ? 'plan' : 'edit';
    const contract = [
      'You are a ZCode subagent delegated by Codex.',
      'Work only on the task below. Do not spawn agents, workflows, or invoke another coding agent CLI.',
      'Stay within the supplied workspace and task scope. Do not publish, push, deploy, or merge.',
      'Shell execution is unavailable in this headless permission mode. Bash is disabled; do not retry it or try to bypass it through another tool.',
      'Write tests where relevant and return exact test commands for Codex to run. Never claim those commands have run.',
      'Return a concise summary, changed files, checks actually run, suggested test commands, and unresolved issues.',
      spec.kind === 'analysis' ? 'This is an analysis task; do not change files.' : 'Make changes only in this isolated worktree.',
      '', 'Task:', spec.prompt,
    ].join('\n');
    const args = ['--cwd', runtime.workspace, '--mode', permission, '--output-format', 'stream-json',
      '--disallowed-tools', 'Agent,CreateWorkflow,AmendWorkflow,Bash', '--prompt', contract];
    if (spec.sessionId) args.push('--resume', spec.sessionId);
    child = spawn(config.binary, args, {
      cwd: runtime.workspace, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      env: { ...process.env, ZCODE_SUBAGENTS_CHILD: '1' },
    });
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    // Attach a rejection handler before asynchronous process metadata I/O.
    completion.catch(() => {});
    childOwner = { pid: child.pid, identity: await processIdentity(child.pid) };
    await atomicJson(path.join(dir, 'child.json'), childOwner);
    runtime.status = 'running';
    runtime.childPid = child.pid;
    await save();
    let bytes = 0;
    for (const [name, readable] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      const output = createWriteStream(path.join(dir, name + '.log'), { mode: 0o600 });
      streams.push(output);
      output.on('error', (error) => stop('Cannot write task log: ' + error.message, true));
      readable.setEncoding('utf8');
      readable.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 64 * 1024 * 1024) {
          stop('Task output exceeded the 64 MiB limit', true);
          return;
        }
        if (!output.write(chunk)) {
          readable.pause();
          output.once('drain', () => readable.resume());
        }
        if (name === 'stdout') {
          try { parser.accept(chunk); }
          catch (error) { stop(error.message, true); }
        } else {
          runtime.stderrTail = (runtime.stderrTail || '') + chunk;
          runtime.stderrTail = runtime.stderrTail.slice(-4000);
        }
      });
    }
    monitor = setInterval(async () => {
      if (monitoring) return;
      monitoring = true;
      try {
        const cancel = await readJson(path.join(dir, 'cancel.json'));
        if (cancel) stop(cancel.reason || 'Cancelled by caller');
        if (spec.runTimeoutMs && Date.now() - Date.parse(runtime.startedAt) >= spec.runTimeoutMs) {
          stop('Execution deadline exceeded', true);
        }
        runtime.sessionId = parser.sessionId;
        runtime.eventCount = parser.eventCount;
        runtime.lastEvent = parser.lastEvent;
        await save();
      } catch (error) { stop(error.message, true); }
      finally { monitoring = false; }
    }, 500);
    const { code, signal } = await completion;
    clearInterval(monitor);
    parser.finish();
    runtime.exitCode = code;
    runtime.signal = signal;
    runtime.sessionId = parser.sessionId;
    runtime.eventCount = parser.eventCount;
    runtime.lastEvent = parser.lastEvent;
    if (parser.summary) {
      await atomicJson(path.join(dir, 'result.json'), parser.summary);
      runtime.response = bounded(parser.summary.response);
      runtime.usage = parser.summary.usage;
      runtime.projection = parser.summary.projection;
    }
    runtime.status = fatal ? 'failed' : stopping ? 'cancelled' :
      code === 0 && parser.summary && parser.summary.projection?.status !== 'error' ? 'succeeded' : 'failed';
    if (runtime.status !== 'succeeded') {
      runtime.error = fatal || stopping || (code !== 0 ? 'ZCode exited with code ' + code :
        'ZCode did not return a successful structured result');
    }
    try { runtime.changes = await collectChanges(spec, runtime.workspace, dir); }
    catch (error) {
      runtime.status = 'failed';
      runtime.error = 'Could not collect changes: ' + error.message;
    }
  } catch (error) {
    runtime.status = stopping && !fatal ? 'cancelled' : 'failed';
    runtime.error = error.message;
    if (child?.pid) await groupSignal('SIGKILL');
  } finally {
    clearInterval(monitor);
    clearTimeout(killTimer);
    // Complete group cleanup even if the leader exited before its descendants.
    if (stopping) await groupSignal('SIGKILL');
    for (const stream of streams) stream.end();
    await Promise.allSettled(streams.map((stream) => finished(stream)));
    while (monitoring) await new Promise((resolve) => setTimeout(resolve, 10));
    runtime.finishedAt = now();
    await save();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorker(settings(), process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
