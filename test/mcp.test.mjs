import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixtureRuntime, stopHost } from './helpers.mjs';
import { settings, readJson, sameProcess, delay, TERMINAL } from '../src/common.mjs';
import { request } from '../src/client.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
test('direct MCP tools preserve app-server tasks across disconnects, with models, followups and cancellation', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zsa-mcp-'));
  const env = { ...process.env, ZCODE_SUBAGENTS_HOME: home, ZCODE_SUBAGENTS_RUNTIME_ROOT: await fixtureRuntime(home) };
  const config = settings(env);
  const clients = [];
  const manifest = await readJson(path.join(pluginRoot, '.codex-plugin/plugin.json'));
  const mcp = (await readJson(path.join(pluginRoot, manifest.mcpServers))).mcpServers['zcode-subagents'];
  const connect = async () => {
    const client = new Client({ name: 'zcode-mcp-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: mcp.args.map((a) => a.replaceAll('${PLUGIN_ROOT}', pluginRoot)), env, stderr: 'pipe' }));
    return client;
  };
  const call = async (client, name, input = {}) => {
    const result = await client.callTool({ name, arguments: input });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const value = JSON.parse(result.content[0].text);
    assert.deepEqual(result.structuredContent, value);
    return value;
  };
  t.after(async () => {
    const list = await request(config, 'zcode_list', {}).catch(() => ({ tasks: [] }));
    for (const task of list.tasks) if (!TERMINAL.has(task.status)) await request(config, 'zcode_cancel', { task_id: task.task_id });
    if (list.tasks.length) await request(config, 'zcode_wait', { task_ids: list.tasks.map((t) => t.task_id) });
    await Promise.allSettled(clients.map((c) => c.close()));
    const owner = await readJson(path.join(home, 'supervisor.lock/owner.json'));
    if (await sameProcess(owner)) process.kill(owner.pid, 'SIGTERM');
    await stopHost(config); await delay(400); await fs.rm(home, { recursive: true, force: true });
  });
  const first = await connect();
  const catalog = await first.listTools();
  assert.deepEqual(catalog.tools.map((t) => t.name).sort(),
    ['zcode_spawn', 'zcode_status', 'zcode_wait', 'zcode_followup', 'zcode_cancel', 'zcode_list', 'zcode_doctor', 'zcode_models'].sort());
  assert.ok(JSON.stringify(catalog.tools.find((t) => t.name === 'zcode_spawn').inputSchema.properties.model).includes('providerId'));
  const doctor = await call(first, 'zcode_doctor');
  assert.equal(doctor.backend, 'desktop-app-server'); assert.equal(doctor.concurrency, 12);
  assert.equal((await call(first, 'zcode_models')).defaultModel.modelId, 'default');
  const bad = await first.callTool({ name: 'zcode_status', arguments: { task_id: 'not-a-uuid' } });
  assert.equal(bad.isError, true);
  const missing = await first.callTool({ name: 'zcode_status', arguments: { task_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
  assert.equal(missing.isError, true); assert.match(missing.content[0].text, /Task not found/);
  // Validation/backend errors must not close the tool transport.
  assert.equal((await call(first, 'zcode_doctor')).appServer.instance, doctor.appServer.instance);
  const input = { workflow_id: 'mcp-test', request_key: 'one', cwd: home, prompt: '[fixture:sleep=1800]',
    model: { providerId: 'fixture', modelId: 'explicit', options: { reasoningLevel: 'low' } } };
  const task = await call(first, 'zcode_spawn', input);
  const pending = first.callTool({ name: 'zcode_wait', arguments: { task_ids: [task.task_id] } }).catch(() => undefined);
  await delay(150); await first.close(); await pending;
  const second = await connect();
  assert.equal((await call(second, 'zcode_spawn', input)).task_id, task.task_id);
  const finished = (await call(second, 'zcode_wait', { task_ids: [task.task_id] })).tasks[0];
  assert.equal(finished.status, 'succeeded');
  assert.equal(finished.effectiveModel.modelId, 'explicit');
  assert.equal(finished.observedModel.modelId, 'explicit');
  assert.equal(finished.appServer.instance, doctor.appServer.instance);
  const next = await call(second, 'zcode_followup', { task_id: task.task_id, request_key: 'default', prompt: 'continue', model: 'default' });
  const continued = (await call(second, 'zcode_wait', { task_ids: [next.task_id] })).tasks[0];
  assert.equal(continued.sessionId, finished.sessionId);
  assert.equal(continued.effectiveModel.modelId, 'default');
  const long = await call(second, 'zcode_spawn', { workflow_id: 'mcp-test', request_key: 'cancel', cwd: home, prompt: '[fixture:sleep=30000]' });
  let state;
  for (let i = 0; i < 80; i++) {
    state = await call(second, 'zcode_status', { task_id: long.task_id });
    if (state.status === 'running') break;
    await delay(100);
  }
  assert.equal(state.status, 'running');
  await call(second, 'zcode_cancel', { task_id: long.task_id });
  assert.equal((await call(second, 'zcode_wait', { task_ids: [long.task_id] })).tasks[0].status, 'cancelled');
  assert.equal((await call(second, 'zcode_list', { workflow_id: 'mcp-test' })).total, 3);
  assert.equal((await call(second, 'zcode_doctor')).appServer.instance, doctor.appServer.instance);
});
