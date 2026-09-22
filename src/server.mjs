import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { schemas } from './schemas.mjs';
import { call } from './client.mjs';
import { VERSION } from './common.mjs';

const descriptions = {
  zcode_spawn: 'Delegate a bounded task to official ZCode. Returns immediately. Up to 12 tasks run across all clients; excess tasks queue. Edit tasks get an isolated Git worktree. Requires a stable workflow_id and idempotent request_key.',
  zcode_status: 'Read one task: status, progress, bounded final response, usage, worktree, diff and log paths. A successful process still requires Codex to verify its work.',
  zcode_wait: 'Wait for any/all tasks. Logical default 15 minutes, min 10, max 30. Each call returns after at most 20 seconds. Continue with wait_id to preserve the deadline. Timing out never cancels tasks.',
  zcode_followup: 'Continue a ZCode conversation using --resume. A running parent finishes before this task starts. Follow the returned task ID for further conversation; sibling followups are rejected.',
  zcode_cancel: 'Cancel a queued or active task. Active cancellation is asynchronous: poll status for a terminal state. Worktrees and logs are retained for review.',
  zcode_list: 'List recent tasks, optionally limited to a workflow_id. Useful after reconnecting. Read full results with zcode_status.',
  zcode_doctor: 'Check the installed ZCode command, plugin version, shared concurrency cap and wait settings. Does not make a model request.',
};
const server = new McpServer({ name: 'zcode-subagents', version: VERSION });
for (const [name, schema] of Object.entries(schemas)) {
  server.registerTool(name, {
    description: descriptions[name], inputSchema: schema.shape,
    annotations: { readOnlyHint: ['zcode_status', 'zcode_list', 'zcode_doctor'].includes(name),
      destructiveHint: false, idempotentHint: true,
      openWorldHint: ['zcode_spawn', 'zcode_followup'].includes(name) },
  }, async (input) => {
    try {
      const result = await call(name, input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
}
await server.connect(new StdioServerTransport());
