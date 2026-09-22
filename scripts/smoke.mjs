// Explicit live-model check. Uses the existing ZCode account and consumes quota.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const server = process.env.ZCODE_SUBAGENTS_SMOKE_SERVER || path.join(root, 'dist/server.mjs');
const client = new Client({ name: 'zcode-live-smoke', version: '0.2.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], stderr: 'inherit' }));
const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-live-'));
const command = async (name, input = {}) => {
  const result = await client.callTool({ name: 'zcode_' + name, arguments: input });
  if (result.isError) throw new Error(result.content[0].text);
  return result.structuredContent || JSON.parse(result.content[0].text);
};
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const tasks = [];
const finish = async (task) => {
  tasks.push(task.task_id);
  console.log('Task:', task.task_id);
  let wait;
  do {
    wait = await command('wait', wait ? { wait_id: wait.wait_id } : { task_ids: [task.task_id] });
    console.log('Progress:', wait.tasks.map((t) => t.status).join(', '));
  } while (!wait.ready && !wait.timed_out);
  const result = await command('status', { task_id: task.task_id });
  console.log(JSON.stringify({ task_id: result.task_id, status: result.status, response: result.response,
    error: result.error, effectiveModel: result.effectiveModel, sessionId: result.sessionId, workspace: result.workspace }));
  assert.equal(result.status, 'succeeded', result.error);
  assert.deepEqual(result.observedModel, result.effectiveModel);
  return result;
};
const hashRuntime = async (runtime) => Object.fromEntries(await Promise.all([
  runtime.node, runtime.entry, path.join(runtime.root, 'agents/glm/zcode.cjs'),
].map(async (file) => [file, createHash('sha256').update(await fs.readFile(file)).digest('hex')])));

try {
  const doctor = await command('doctor');
  assert.equal(doctor.appServer.available, true, doctor.appServer.error);
  const before = await hashRuntime(doctor.appServer.runtime);
  const defaultModel = doctor.appServer.defaultModel;
  const alternate = doctor.appServer.models.find((m) => m.modelId !== defaultModel.modelId) || doctor.appServer.models[0];
  const explicit = process.env.ZCODE_SUBAGENTS_SMOKE_MODEL ? JSON.parse(process.env.ZCODE_SUBAGENTS_SMOKE_MODEL) :
    { providerId: alternate.providerId, modelId: alternate.modelId,
      ...(alternate.reasoningLevels.length ? { options: { reasoningLevel: alternate.reasoningLevels[0] } } : {}) };
  console.log('Desktop:', doctor.appServer.desktopVersion, 'default:', JSON.stringify(defaultModel), 'override:', JSON.stringify(explicit));
  const workflow_id = 'app-server-live-' + Date.now();
  const first = await finish(await command('spawn', { workflow_id, request_key: 'default', cwd,
    kind: 'analysis', model: 'default', prompt: 'Reply with exactly DEFAULT_OK. Do not use tools.', run_timeout_ms: 180000 }));
  assert.match(first.response, /DEFAULT_OK/); assert.deepEqual(first.effectiveModel, defaultModel);

  const project = path.join(cwd, 'project'); await fs.mkdir(project);
  await execute('git', ['init', project]);
  await execute('git', ['-C', project, 'config', 'user.name', 'Smoke Test']);
  await execute('git', ['-C', project, 'config', 'user.email', 'smoke@example.invalid']);
  await fs.writeFile(path.join(project, 'arithmetic.py'), 'def add(a, b):\n    return a - b\n');
  await execute('git', ['-C', project, 'add', '.']);
  await execute('git', ['-C', project, 'commit', '-m', 'Add smoke fixture']);
  const edited = await finish(await command('spawn', { workflow_id, request_key: 'explicit-edit', cwd: project,
    kind: 'edit', model: explicit, run_timeout_ms: 240000,
    prompt: 'Fix arithmetic.py so add(a, b) adds its arguments. Create test_arithmetic.py using Python unittest, covering positive and negative numbers and zero. Do not run commands. Codex will run python3 -m unittest -v after inspecting the files. Report the files changed.' }));
  assert.equal(edited.effectiveModel.modelId, explicit.modelId);
  assert.equal(edited.appServer.instance, first.appServer.instance);
  assert.equal(await fs.readFile(path.join(project, 'arithmetic.py'), 'utf8'), 'def add(a, b):\n    return a - b\n');
  console.log('Generated code:', await fs.readFile(path.join(edited.workspace, 'arithmetic.py'), 'utf8'));
  console.log('Generated tests:', await fs.readFile(path.join(edited.workspace, 'test_arithmetic.py'), 'utf8'));
  const checked = await execute('python3', ['-m', 'unittest', '-v'], { cwd: edited.workspace });
  console.log(checked.stdout + checked.stderr);
  assert.match(checked.stdout + checked.stderr, /Ran [1-9]\d* tests?/);
  await execute('python3', ['-c', 'from arithmetic import add; assert add(2, 3) == 5; assert add(-2, -3) == -5; assert add(0, 0) == 0'], { cwd: edited.workspace });
  const continued = await finish(await command('followup', { task_id: edited.task_id, request_key: 'inherit',
    prompt: 'Without tools or further edits, name the two files you just changed and reply with FOLLOWUP_OK.', run_timeout_ms: 180000 }));
  assert.equal(continued.sessionId, edited.sessionId); assert.deepEqual(continued.effectiveModel, edited.effectiveModel);
  assert.match(continued.response, /FOLLOWUP_OK/); assert.match(continued.response, /test_arithmetic.py/);
  const reset = await finish(await command('followup', { task_id: continued.task_id, request_key: 'reset-default', model: 'default',
    prompt: 'Reply with exactly RESET_DEFAULT_OK. Do not use tools or edit files.', run_timeout_ms: 180000 }));
  assert.equal(reset.sessionId, edited.sessionId); assert.deepEqual(reset.effectiveModel, defaultModel);
  assert.match(reset.response, /RESET_DEFAULT_OK/);
  assert.deepEqual((await command('models')).defaultModel, defaultModel);
  assert.deepEqual(await hashRuntime(doctor.appServer.runtime), before);
  console.log('LIVE_SMOKE_PASSED', JSON.stringify({ tasks, workspace: edited.workspace, desktop: doctor.appServer.desktopVersion, defaultModel, explicit }));
} finally {
  try {
    for (const id of tasks) {
      const state = await command('status', { task_id: id }).catch(() => undefined);
      if (state && !terminal.has(state.status)) await command('cancel', { task_id: id });
    }
  } finally { await client.close(); }
}
