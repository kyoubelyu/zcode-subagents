// Explicit live-model check. Uses the existing ZCode account and consumes quota.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-live-'));
await execute('git', ['init', cwd]);
await execute('git', ['-C', cwd, 'config', 'user.name', 'Smoke Test']);
await execute('git', ['-C', cwd, 'config', 'user.email', 'smoke@example.invalid']);
await fs.writeFile(path.join(cwd, 'arithmetic.py'), 'def add(a, b):\n    return a - b\n');
await execute('git', ['-C', cwd, 'add', '.']);
await execute('git', ['-C', cwd, 'commit', '-m', 'Add smoke fixture']);
const client = new Client({ name: 'zcode-live-smoke', version: '0.1.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [path.join(root, 'dist/server.mjs')], stderr: 'inherit',
}));
const tool = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
};
let task;
try {
  console.log('CLI:', JSON.stringify(await tool('zcode_doctor', {})));
  task = await tool('zcode_spawn', {
    workflow_id: 'live-smoke-' + Date.now(), request_key: 'fix-add', cwd, kind: 'edit',
    prompt: 'Fix arithmetic.py so add(a, b) adds its arguments. Create test_arithmetic.py using Python unittest, covering positive and negative numbers and zero. Do not run shell commands; Codex will run python3 -m unittest -v after inspecting the files. Work only in the supplied directory and do not delegate. Report the files changed.',
    run_timeout_ms: 180000,
  });
  console.log('Task:', task.task_id, 'source:', cwd);
  let wait;
  do {
    wait = await tool('zcode_wait', wait ? { wait_id: wait.wait_id } : { task_ids: [task.task_id] });
    console.log('Progress:', wait.tasks.map((task) => task.status).join(', '));
  } while (!wait.ready && !wait.timed_out);
  const result = await tool('zcode_status', { task_id: task.task_id });
  console.log(JSON.stringify({ task_id: result.task_id, status: result.status, workspace: result.workspace,
    response: result.response, error: result.error, usage: result.usage, changes: result.changes }, null, 2));
  assert.equal(result.status, 'succeeded');
  assert.equal(await fs.readFile(path.join(cwd, 'arithmetic.py'), 'utf8'), 'def add(a, b):\n    return a - b\n');
  const tests = await execute('python3', ['-m', 'unittest', '-v'], { cwd: result.workspace });
  console.log(tests.stdout + tests.stderr);
  assert.match(tests.stdout + tests.stderr, /Ran [1-9]\d* tests?/);
  await execute('python3', ['-c', 'from arithmetic import add; assert add(2, 3) == 5; assert add(-2, -3) == -5; assert add(0, 0) == 0'], { cwd: result.workspace });
  console.log('LIVE_SMOKE_PASSED');
} finally {
  if (task) {
    const state = await tool('zcode_status', { task_id: task.task_id }).catch(() => undefined);
    if (state && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state.status)) {
      await tool('zcode_cancel', { task_id: task.task_id });
    }
  }
  await client.close();
}
