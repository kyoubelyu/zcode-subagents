import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { schemas } from './schemas.mjs';
import { call } from './client.mjs';
import { VERSION } from './common.mjs';

const descriptions = {
  zcode_spawn: 'Delegate a bounded task to the installed ZCode Desktop app-server. Returns a task ID immediately; at most 12 tasks run across clients. Edit tasks use isolated Git worktrees. Omit model or pass "default" for the configured default; pass a provider/model object to override it. Reuse identical workflow_id/request_key requests after a lost reply.',
  zcode_status: 'Read task progress, effective and observed models, response, session usage, worktree, diff and artifact paths. Verify generated code and tests before integrating it.',
  zcode_wait: 'Wait for any/all tasks. Logical default 15 minutes, min 10, max 30. Each call returns after at most 20 seconds. Continue with wait_id to preserve the deadline. A wait timeout never cancels tasks.',
  zcode_followup: 'Continue the same app-server session and workspace after the parent finishes. Omitted model inherits the parent effective selection; "default" re-reads the current default; an object overrides it. Use the returned task ID for the next followup; sibling followups are rejected.',
  zcode_cancel: 'Request cancellation of one queued or active task. Poll for a terminal state. Worktrees and logs are retained; the shared Host and other sessions keep running.',
  zcode_list: 'List recent tasks, optionally filtered by workflow_id. Use after reconnecting and read full results with zcode_status.',
  zcode_doctor: 'Check the installed desktop app-server, default model, plugin backend, shared concurrency cap and wait settings. May start the existing runtime; does not send a model prompt or install/update ZCode.',
  zcode_models: 'List ZCode provider/model IDs, supported reasoning levels and the current default. May start the existing desktop runtime, without calling a model or changing the default.',
};

// A disposable transport adapter only. The detached supervisor, Host and tasks
// outlive this process. A broken connection never triggers task resubmission.
const server = new McpServer({ name: 'zcode-subagents', version: VERSION });
for (const [name, schema] of Object.entries(schemas)) {
  server.registerTool(name, {
    description: descriptions[name], inputSchema: schema.shape,
    annotations: {
      readOnlyHint: ['zcode_status', 'zcode_list', 'zcode_doctor', 'zcode_models'].includes(name),
      destructiveHint: false, idempotentHint: true,
      openWorldHint: ['zcode_spawn', 'zcode_followup'].includes(name),
    },
  }, async (input) => {
    try {
      const result = await call(name, input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
}
await server.connect(new StdioServerTransport());
// Clean transport shutdown affects this bridge only, including a pending wait.
process.stdin.once('end', () => { void server.close(); });
process.once('SIGTERM', () => { void server.close().finally(() => process.exit(0)); });
process.once('SIGINT', () => { void server.close().finally(() => process.exit(0)); });
