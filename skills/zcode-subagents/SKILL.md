---
name: zcode-subagents
description: Delegate bounded coding, investigation, or review tasks from Codex to the installed ZCode Desktop app-server. Use when the user asks for ZCode or GLM workers, or authorizes ZCode delegation in the workflow.
---

Keep planning, ambiguous decisions, integration and final verification in Codex.
Give ZCode concrete tasks and acceptance criteria. Workers do not inherit the
Codex conversation. Review their evidence before relying on it.

## Use the plugin tools directly

Prefer the registered zcode_spawn, zcode_status, zcode_wait, zcode_followup,
zcode_cancel, zcode_list, zcode_doctor and zcode_models tools. They forward requests
to the shared desktop app-server task pool. Do not substitute shell commands for
available plugin tools. These are external ZCode sessions, not native spawn_agent
or wait_agent sessions.

The MCP connection owns no task lifecycle. Disconnecting it does not cancel or
replay tasks. After reconnecting, query existing task IDs; retry a lost spawn reply
only with the identical workflow_id/request_key and payload. Backend/validation
errors are tool errors, not a reason to restart the Host. A closed Codex-owned
transport requires reconnection or a new thread to load the installed tools.

## Command fallback for diagnostics and recovery

Resolve the plugin root as two directories above this SKILL.md's directory.
Use the exact installed path; do not assume a particular version/cache path.

```text
node <plugin-root>/dist/control.mjs doctor
node <plugin-root>/dist/control.mjs models
node <plugin-root>/dist/control.mjs <spawn|status|list|wait|followup|cancel> --json-file <request.json>
```

Use this fallback to diagnose missing/unavailable tools or recover existing
tasks. Explain when the direct MCP tools are unavailable. The command client
uses the same pool and request schemas, so do not submit duplicate work under a
new key. It is not the ZCode CLI; never use `zcode -p` for this backend. Use a
private JSON file (or literal JSON via --stdin) to avoid interpreting prompt text
as shell code. Do not interpolate arbitrary prompts into a shell command.

zcode_doctor reports desktop availability, pool settings and default model. zcode_models
lists providerId/modelId and reasoningLevels. Both can start the existing desktop
Host without calling a model. The plugin only starts/reuses its own Host using
existing desktop files. Never install, upgrade, patch or rebuild ZCode to repair
this integration without a separate user instruction. Authentication belongs to
ZCode; do not copy tokens or modify account files.

## Requests and model routing

zcode_spawn payload:

```json
{
  "workflow_id": "stable-workflow-name",
  "request_key": "unique-bounded-task",
  "cwd": "/absolute/workspace/path",
  "kind": "analysis",
  "prompt": "Objective, files, constraints, acceptance criteria and expected deliverables.",
  "model": "default",
  "run_timeout_ms": 0
}
```

Use a stable workflow_id. Reuse the identical request_key and payload to recover
from a lost submission reply. A different task needs a different key.

New tasks with model omitted or `"default"` resolve the current ZCode default when
they start. Do not claim a hardcoded default; inspect `models`/`doctor`. Explicit:

```json
{"model":{"providerId":"<from models>","modelId":"<from models>","options":{"reasoningLevel":"<supported level>"}}}
```

The Host validates selections; invalid ones fail without fallback. If reasoning
is omitted, the resolver chooses the last advertised level. Specify it when the
user cares about reasoning cost or latency. Per-input overrides do not change the
configured default. Check effectiveModel and observedModel in the result.

zcode_followup payload: `task_id`, a new `request_key`, `prompt`, optional `model` and
`run_timeout_ms`. Omitted model inherits the parent's effective model; `"default"`
resolves the current default again. It queues behind a busy parent and resumes
the same session/workspace. Continue from its returned task ID; sibling followups
are rejected. Followups do not steer an active turn.

## Execution and review

- Use analysis for investigation/review. It enables plan state and allows
  reading/search tools. Use edit for implementation in an isolated Git worktree.
  Edit requires a clean source repository with a commit. Do not stash, commit or
  discard unrelated user changes just to satisfy this requirement; prepare an
  appropriate snapshot within the task's authorization or use analysis.
- At most 12 tasks run across clients sharing the data directory. Extra work
  queues. Do not make new data directories to bypass this limit.
- Bash, recursive agents, workflows and third-party MCP tools are outside the
  task allowlist. Ask workers to write tests and return commands. Review files,
  then run checks from Codex. Do not promise worker shell execution.
- zcode_spawn returns a task_id immediately. Continue independent local work.
  zcode_status/zcode_cancel take `{"task_id":"<id>"}`. zcode_list accepts optional workflow_id.
- Call zcode_wait with `{"task_ids":["<id>"],"mode":"all"}` (or mode any).
  Each call returns after at most 20 seconds. Repeat with
  `{"wait_id":"<returned id>"}` until ready or timed_out. The logical timeout
  defaults to 15 minutes and accepts timeout_ms from 600000 to 1800000. A wait
  timeout never cancels work. run_timeout_ms separately limits execution;
  0 leaves it unset.
- succeeded means V4 reported the submitted turn completed with a response.
  Read the response, inspect changes.patch and untrackedFiles in the retained
  worktree, and run meaningful checks. Usage is session cumulative, including
  earlier turns. No automatic merge or publication occurs.
- MCP/client exits and supervisor restarts preserve work. Use zcode_status/zcode_list to
  reconnect. Runtime crashes are reported without replay. Review failed or
  interrupted artifacts before explicitly retrying. cleanup_pending retains
  its concurrency slot until the session is confirmed stopped.
- Cancel obsolete tasks and confirm a terminal state before treating the slot
  as free. Cancellation stops only that session, never the shared Host or the
  desktop application's processes. Do not kill unrelated ZCode processes.

Keep task artifacts private. They can contain source code and user data; do not
publish them with the plugin or paste entire diagnostic logs into chat. Runtime
permission controls and Git worktrees are not an OS sandbox.
