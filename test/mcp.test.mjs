import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { settings, delay, TERMINAL } from '../src/common.mjs';
import { request, ensureDaemon } from '../src/client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = path.join(root, 'test/fixture-zcode.mjs');
test('bundled MCP handshake, concurrent clients share one pool, reconnect and graceful supervisor restart', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zsa-mcp-'));
  const env = { ...process.env, ZCODE_SUBAGENTS_HOME: home, ZCODE_SUBAGENTS_BIN: fixture };
  const config = settings(env);
  const clients = [];
  const connect = async () => {
    const client = new Client({ name: 'plugin-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [path.join(root, 'dist/server.mjs')], env, stderr: 'pipe' }));
    clients.push(client);
    return client;
  };
  const tool = async (client, name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    try {
      const result = await request(config, 'zcode_list', {});
      for (const task of result.tasks) if (!TERMINAL.has(task.status)) await request(config, 'zcode_cancel', { task_id: task.task_id });
      await delay(1200);
      const health = await request(config, undefined, undefined, true);
      process.kill(health.pid, 'SIGTERM');
      await delay(300);
    } catch {}
    await fs.rm(home, { recursive: true, force: true });
  });
  const a = await connect();
  const b = await connect();
  assert.equal((await a.listTools()).tools.length, 7);
  const [doctorA, doctorB] = await Promise.all([tool(a, 'zcode_doctor', {}), tool(b, 'zcode_doctor', {})]);
  assert.equal(doctorA.concurrency, 12);
  assert.equal(doctorB.data_directory, doctorA.data_directory);
  assert.equal(doctorA.cli.available, true);
  const job = await tool(a, 'zcode_spawn', {
    workflow_id: 'mcp-test', request_key: 'one', cwd: home,
    prompt: '[fixture:sleep=2500]', kind: 'analysis',
  });
  await a.close();
  let running;
  for (let i = 0; i < 30; i++) {
    running = await tool(b, 'zcode_status', { task_id: job.task_id });
    if (running.status === 'running') break;
    await delay(100);
  }
  assert.equal(running.status, 'running');
  const before = await request(config, undefined, undefined, true);
  process.kill(before.pid, 'SIGTERM');
  await delay(300);
  await ensureDaemon(config);
  const after = await request(config, undefined, undefined, true);
  assert.notEqual(before.pid, after.pid);
  const wait = await tool(b, 'zcode_wait', { task_ids: [job.task_id] });
  assert.equal(wait.ready, true);
  assert.equal(wait.tasks[0].response, 'FIXTURE_OK');
  assert.equal(wait.tasks[0].status, 'succeeded');
});
