import http from 'node:http';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Supervisor } from './supervisor.mjs';
import { validate } from './schemas.mjs';
import { settings, VERSION, privateDir, atomicJson, processIdentity } from './common.mjs';

const execute = promisify(execFile);
export async function startDaemon(config = settings()) {
  process.umask(0o077);
  await privateDir(config.home);
  const lockPath = path.join(config.home, 'supervisor.lock');
  // The launcher holds an OS flock for this process's entire lifetime.
  // Workers do not inherit it; reconnecting clients cannot create two pools.
  if (process.env.ZCODE_SUBAGENTS_LOCKED !== '1') throw new Error('Launch the supervisor through the MCP client.');
  await privateDir(lockPath);
  await atomicJson(path.join(lockPath, 'owner.json'), {
    pid: process.pid, identity: await processIdentity(process.pid), version: VERSION,
  });
  await fs.rm(config.socket, { force: true });
  const supervisor = new Supervisor(config);
  await supervisor.init();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    try {
      if (req.method === 'GET' && req.url === '/health') {
        res.end(JSON.stringify({ version: VERSION, pid: process.pid, concurrency: config.concurrency }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/rpc') throw new Error('Unknown endpoint.');
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024 * 1024) throw new Error('Request too large.');
      }
      const { method, params } = JSON.parse(body);
      const input = validate(method, params);
      let result;
      switch (method) {
        case 'zcode_spawn': result = await supervisor.spawn(input); break;
        case 'zcode_followup': result = await supervisor.followup(input); break;
        case 'zcode_status': result = await supervisor.status(input.task_id); break;
        case 'zcode_cancel': result = await supervisor.cancel(input.task_id); break;
        case 'zcode_wait': result = await supervisor.wait(input); break;
        case 'zcode_list': {
          const all = await supervisor.list(input.workflow_id);
          result = { total: all.length, tasks: all.slice(-input.limit).map((task) => ({
            task_id: task.task_id, workflow_id: task.workflow_id, parent_task_id: task.parent_task_id,
            status: task.status, kind: task.kind, created_at: task.created_at, workspace: task.workspace,
          })) };
          break;
        }
        case 'zcode_doctor': {
          let cli;
          try {
            const { stdout } = await execute(config.binary, ['--version'], { timeout: 15000, maxBuffer: 8192 });
            cli = { available: true, version: stdout.trim() };
          } catch (error) { cli = { available: false, error: error.message }; }
          result = { version: VERSION, concurrency: config.concurrency, hard_limit: 12,
            cli: { command: config.binary, ...cli }, data_directory: config.home,
            wait: { default_ms: 900000, min_ms: 600000, max_ms: 1800000, slice_ms: 20000 } };
        }
      }
      res.end(JSON.stringify({ result }));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.socket, resolve);
  });
  await fs.chmod(config.socket, 0o600);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await supervisor.close();
    server.close();
    server.closeAllConnections();
    // Detached workers continue. Their status is rediscovered by the next supervisor.
    await fs.rm(config.socket, { force: true });
    await fs.rm(lockPath, { recursive: true, force: true });
  };
  process.once('SIGTERM', () => { close().finally(() => process.exit(0)); });
  process.once('SIGINT', () => { close().finally(() => process.exit(0)); });
  return { server, supervisor, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDaemon().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
