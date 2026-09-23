import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const execute = promisify(execFile);
export async function git(cwd, args, maxBuffer = 16 * 1024 * 1024) {
  const { stdout } = await execute('git', ['-C', cwd, ...args], { maxBuffer, encoding: 'utf8' });
  return stdout;
}
export async function inspectWorkspace(cwd, kind) {
  const real = await fs.realpath(cwd);
  if (!(await fs.stat(real)).isDirectory()) throw new Error('cwd must be a directory.');
  if (kind === 'analysis') return { cwd: real };
  let root;
  try { root = (await git(real, ['rev-parse', '--show-toplevel'])).trim(); }
  catch { throw new Error('Edit tasks require a Git repository with an existing commit.'); }
  if ((await git(root, ['status', '--porcelain', '--untracked-files=normal'])).trim()) {
    throw new Error('Edit tasks require a clean source repository. Commit the intended snapshot first; local changes are never silently omitted or stashed.');
  }
  return { cwd: real, repo: root, baseCommit: (await git(root, ['rev-parse', 'HEAD'])).trim() };
}
export async function prepareWorkspace(spec, dir) {
  if (spec.workspace || spec.kind === 'analysis') {
    const workspace = spec.workspace || spec.cwd;
    // Queued work can outlive a user's temporary checkout. The installed Host
    // can crash on spawn ENOENT, so reject stale paths before contacting it.
    try { if (!(await fs.stat(workspace)).isDirectory()) throw new Error(); }
    catch { throw new Error('Workspace no longer exists or is not accessible: ' + workspace); }
    return workspace;
  }
  const worktree = path.join(dir, 'worktree');
  await git(spec.repo, ['worktree', 'add', '-b', 'zcode-subagents/' + spec.id, worktree, spec.baseCommit]);
  return worktree;
}
export async function collectChanges(spec, workspace, dir) {
  if (spec.kind !== 'edit' || !spec.baseCommit) return {};
  const status = await git(workspace, ['status', '--short']);
  // Include staged, unstaged, and committed edits relative to the original snapshot.
  const patch = await git(workspace, ['diff', '--binary', spec.baseCommit, '--']);
  const untracked = (await git(workspace, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0').filter(Boolean);
  const patchPath = path.join(dir, 'changes.patch');
  await fs.writeFile(patchPath, patch, { mode: 0o600 });
  return { gitStatus: status, patchPath, untrackedFiles: untracked,
    branch: (await git(workspace, ['branch', '--show-current'])).trim(),
    note: 'changes.patch contains tracked changes; untracked files remain in the retained worktree. No changes were merged.' };
}
