import path from 'node:path';
import { readJson, taskDir } from './common.mjs';

// Workers atomically publish state here. Read it without tying observers to
// the lifetime of a supervisor process or its HTTP connections.
export async function readTask(config, id) {
  const dir = taskDir(config, id);
  const spec = await readJson(path.join(dir, 'spec.json'));
  if (!spec) throw new Error('Task not found: ' + id);
  const state = await readJson(path.join(dir, 'runtime.json'), { status: 'queued' });
  return { spec, state, dir };
}

export async function taskStatus(config, id) {
  const { spec, state, dir } = await readTask(config, id);
  return {
    task_id: id, workflow_id: spec.workflowId, kind: spec.kind, parent_task_id: spec.parentTaskId,
    created_at: spec.createdAt, ...state,
    artifacts: { directory: dir, worker: path.join(dir, 'worker.log'),
      ...(state.backend === 'desktop-app-server' ? { progress: path.join(dir, 'progress.jsonl') } :
        { stdout: path.join(dir, 'stdout.log'), stderr: path.join(dir, 'stderr.log') }), result: path.join(dir, 'result.json') },
  };
}
