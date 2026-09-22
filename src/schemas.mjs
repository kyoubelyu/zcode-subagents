import { z } from 'zod';

const id = z.string().uuid();
const model = z.union([z.literal('default'), z.object({ providerId: z.string().trim().min(1), modelId: z.string().trim().min(1),
  options: z.object({ reasoningLevel: z.string().trim().min(1).optional() }).strict().optional() }).strict()]);
const runTimeout = z.number().int().min(0).max(86400000).default(0)
  .describe('Execution limit in milliseconds; 0 means no runtime deadline. Independent of wait timeouts.');
export const schemas = {
  zcode_spawn: z.object({
    workflow_id: z.string().min(1).max(128).describe('A stable group name for this Codex workflow. Reuse it after reconnecting.'),
    request_key: z.string().min(1).max(128).describe('Unique within the workflow. Retrying the identical request returns the existing task.'),
    cwd: z.string().min(1).describe('Absolute workspace path. Edit tasks require a clean Git repository.'),
    kind: z.enum(['analysis', 'edit']).default('analysis'),
    prompt: z.string().min(1).max(65536),
    model: model.optional().describe('Explicit ZCode selection, or "default". Omit to use the current ZCode default.'),
    run_timeout_ms: runTimeout,
  }).strict(),
  zcode_status: z.object({ task_id: id }).strict(),
  zcode_followup: z.object({
    task_id: id, request_key: z.string().min(1).max(128),
    prompt: z.string().min(1).max(65536), run_timeout_ms: runTimeout,
    model: model.optional().describe('Override this followup model; "default" resolves the current default. Omit to inherit the parent effective model.'),
  }).strict(),
  zcode_cancel: z.object({ task_id: id }).strict(),
  zcode_list: z.object({
    workflow_id: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }).strict(),
  zcode_wait: z.object({
    task_ids: z.array(id).min(1).max(100).optional(),
    wait_id: id.optional(),
    mode: z.enum(['any', 'all']).default('all'),
    timeout_ms: z.number().int().min(600000).max(1800000).default(900000),
  }).strict(),
  zcode_doctor: z.object({}).strict(),
  zcode_models: z.object({}).strict(),
};
export function validate(method, params) {
  const schema = schemas[method];
  if (!schema) throw new Error('Unknown tool: ' + method);
  const input = schema.parse(params || {});
  if (method === 'zcode_spawn' && !input.cwd.startsWith('/')) throw new Error('cwd must be an absolute path.');
  if (method === 'zcode_wait' && !input.wait_id && !input.task_ids) throw new Error('Supply task_ids or a wait_id.');
  return input;
}
