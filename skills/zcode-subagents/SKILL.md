---
name: zcode-subagents
description: Delegate independent coding, investigation, or review tasks to the official ZCode CLI from Codex. Use when the user asks for ZCode or GLM workers, or has authorized ZCode delegation in this workflow.
---

Keep planning, ambiguous decisions, integration, and final verification in Codex.
Give ZCode bounded tasks with concrete acceptance criteria. Reuse the user's
existing ZCode model and login configuration; this plugin does not select a model.

Use the plugin's zcode_spawn/status/wait/followup/cancel/list tools. These workers
are external CLI processes, not native spawn_agent or wait_agent sessions.

- Choose a stable workflow_id for the current assignment. Give each new task a
  distinct request_key; reuse the identical request when retrying a lost reply.
- Include the objective, relevant files, scope, constraints, checks to run, and
  expected deliverables. Supply necessary context explicitly; workers do not
  inherit the Codex conversation. Treat worker output as evidence to review.
- Use kind=analysis for investigation/review. It uses ZCode plan mode in the
  supplied directory. Use kind=edit for changes: the plugin requires a clean Git
  source snapshot and creates a worktree. Do not stash, commit, or discard the
  user's pending changes merely to satisfy that prerequisite. Prepare an
  appropriate snapshot within the authorized task or use analysis instead.
- The shared pool runs at most 12 workers. Queue independent work; do not create
  extra data directories to bypass the pool limit. Recursive Agent/workflow tools
  are denied. Permission modes and worktrees are not OS sandboxes.
- The official CLI's headless edit mode cannot approve Bash commands. This
  plugin disables Bash explicitly instead of upgrading to yolo. Ask workers to
  write tests and return exact commands; run those checks from Codex after
  reviewing the worktree. Do not promise autonomous shell execution.
- Spawn returns immediately. Continue useful local work while tasks run.
  zcode_wait returns after a short slice; reuse wait_id to preserve its original
  15-minute deadline (configurable 10–30 minutes). Waiting out never cancels work.
  A separate run_timeout_ms can stop execution; 0 leaves it unset.
- Followups use --resume and retain the original workspace. A followup to a busy
  task queues until that task ends; it does not steer the running turn. Continue
  from the returned followup task ID, not the original parent.
- A task's succeeded state means the CLI returned a structured result with exit
  code 0. Read the response, inspect the diff and new files, and run relevant
  checks before incorporating changes. changes.patch includes tracked changes;
  untrackedFiles remain in the retained worktree. The plugin never merges them.
- Use status/list after reconnecting. Review interrupted/failed artifacts before
  explicitly retrying; avoid blindly replaying tasks with side effects. Cancel
  obsolete tasks and wait for a terminal state before treating their slot as free.

Keep task directories private. Logs and prompts may contain source code or user
data; do not publish them with the plugin or paste entire logs into the chat.
