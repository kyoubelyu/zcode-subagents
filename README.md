# ZCode Subagents

A Codex plugin that puts Astra in charge and delegates bounded work to ZCode Desktop's app-server, with up to **12 concurrent tasks**.

## Why I built this

For my workflow, Astra is good, but too slow and expensive to use for every small coding task. GLM is cheaper, but dumber.

I want Astra to understand the problem, divide the work, make the hard calls, and check the result. I want GLM to inspect a module, trace a bug, write a focused patch, or review a change.

This plugin brings them together in my workflow. I stay in Codex, delegate through the ZCode app-server, then review and integrate the results. It uses the models available in your ZCode installation; it does not include a model subscription or change your Codex model.

## How it works

```text
Codex / Astra
  → plugin MCP tools → persistent task supervisor (12 slots)
                       → shared desktop Host connection
                         → workspace app-server → selected model
  ← results, usage, progress, isolated Git worktrees
```

Version **0.2 uses the existing desktop runtime directly**, with the direct plugin tools from 0.1 restored. Codex calls `zcode_spawn`, `zcode_status`, and the other registered tools. The MCP adapter forwards requests to a detached supervisor; it does not own running tasks. It never invokes `zcode -p` or requires the ZCode CLI on PATH. A bundled command client is also available for diagnostics and recovery.

The plugin starts a Host from the desktop's existing files when needed and reuses **its own** Host instance across clients and tasks. That official Host starts and reuses workspace app-servers and handles ZCode account authentication. The plugin does not attach to private stdio pipes belonging to the running desktop application.

When a workspace has no active tasks, the supervisor releases its app-server through ZCode's `disposeWorkspace` API. The shared Host stays alive. Conversation history, results and worktrees are retained; a followup starts a fresh workspace process and resumes the same session. Completed tasks therefore do not each leave a resident ZCode/Node process behind.

The plugin does **not** download, install, build, upgrade, patch, or vendor ZCode's runtime. It holds the connection needed to use it. It does not supervise runtime upgrades or automatically replay work after a crash. A later explicit request can start a fresh instance from the same files.

- **At most 12 active tasks** across clients using the same data directory; extra tasks queue.
- **Persistent task IDs and results.** MCP disconnection, client exit and supervisor restart preserve work.
- **Linear followups** in the same session and workspace, with model inheritance or an explicit override.
- **Automatic process cleanup** after a workspace's tasks stop, including failed and cancelled tasks. Active tasks protect their workspace from cleanup.
- **Isolated edits** in Git worktrees. The source repository must have a commit and be clean, including ordinary untracked files.
- **Cancellation targets one session.** It does not kill the shared Host or another task.
- **Idempotent submissions.** Identical workflow/request keys return the existing task; conflicting reuse is rejected.
- **No automatic integration.** Codex reviews the patch and new files and runs relevant checks.

These are external ZCode sessions, separate from Codex's native `spawn_agent` and `wait_agent`.

## Requirements

- Linux or WSL, Node.js **22.2 or newer**, Git, and util-linux `flock`.
- An existing [ZCode Desktop](https://github.com/zai-org/ZCode) installation with these Linux/WSL runtime files:

  ```text
  ~/.zcode/server/node
  ~/.zcode/server/zcode-server.cjs
  ~/.zcode/server/agents/glm/zcode.cjs
  ```

- A usable model/account configuration in ZCode. Existing authentication is reused by the official Host. If it expires, resolve it in ZCode Desktop.
- Codex with plugin skills and stdio MCP support.

The integration was tested against desktop Host **3.14.3**, its installed agent app-server **0.16.9**, and V4 wire protocol **3**. The desktop protocol can change; incompatible installations produce errors rather than triggering a runtime modification. Native Windows and macOS are not supported by this release.

## Install in Codex

```bash
codex plugin marketplace add kyoubelyu/zcode-subagents
codex plugin add zcode-subagents@zcode-subagents-community
```

Start a **new Codex thread** to load the updated skill and MCP tools. Built files are committed in `dist/`; plugin installation needs no npm build.

Try:

> Use ZCode subagents to investigate the parser and cache independently, using the default model. Review the findings.

> Give ZCode a focused implementation task in a worktree. Choose GLM-5.3 explicitly, inspect its diff, and run its tests.

### Upgrading from 0.1

Finish or cancel old 0.1 tasks, then run `node scripts/control.mjs stop` from the old source checkout if its supervisor is still running. Update/reinstall the plugin and open a new Codex thread. All seven original tools are available, plus `zcode_models`. Existing 0.2 app-server tasks share the same supervisor and Host with the restored MCP adapter.

Existing task artifacts and worktrees are retained. New tasks use the desktop backend. Followups to historical CLI sessions depend on whether the installed desktop app-server can resume that history; completed old results remain readable. `ZCODE_SUBAGENTS_BIN` is no longer used.

## Direct plugin tools

Use these tools directly from Codex; shell commands are not required for normal delegation.

| Tool | Purpose |
| --- | --- |
| `zcode_spawn` | Queue a new task and return its ID |
| `zcode_status` | Read a task's progress, response, usage and artifacts |
| `zcode_list` | Find tasks, optionally by `workflow_id` |
| `zcode_wait` | Block up to 10 minutes until any explicitly listed task ends |
| `zcode_followup` | Continue the same session; return a new task ID |
| `zcode_cancel` | Stop one task and retain its artifacts |
| `zcode_doctor` | Inspect runtime availability, pool and wait settings |
| `zcode_models` | Read the default and available model selections |

The adapter keeps protocol traffic on stdout and returns tool errors without
terminating the connection. A disconnected MCP client does not cancel or replay
tasks. Reconnect and use their task IDs or workflow/request keys to recover them.
If Codex reports `transport closed`, it still needs to reconnect its tool client
(a new thread loads the installed registration); a server cannot repair the
client's dead transport from inside it. The command client below can inspect
existing work during recovery.

## Command client for diagnostics

Resolve `<plugin-root>` from the installed skill's location, then invoke:

```bash
node <plugin-root>/dist/control.mjs doctor
node <plugin-root>/dist/control.mjs models
node <plugin-root>/dist/control.mjs spawn --json-file request.json
```

Command names are the tool names without `zcode_`, with the same JSON payloads and shared task pool. `doctor` and `models` may start the installed Host, but do not send a model prompt. All commands return JSON. Supply payloads using `--json-file` or `--stdin`, preserving prompt text literally.

Example `zcode_spawn` arguments (also accepted as command-client `request.json`):

```json
{
  "workflow_id": "parser-cleanup",
  "request_key": "review-errors",
  "cwd": "/path/to/project",
  "kind": "analysis",
  "prompt": "Trace parser error handling. Cite concrete bugs and suggest checks. Do not modify files.",
  "model": "default",
  "run_timeout_ms": 0
}
```

Use `kind: "edit"` for a worktree. Ignored files, including local credentials and dependencies, are not copied into it.

## Choosing a model

| Request | Selection |
| --- | --- |
| New task, `model` omitted | ZCode's configured default when the worker starts |
| Any task, `"model": "default"` | Read that current default explicitly |
| Followup, `model` omitted | Inherit the parent's effective selection |
| Explicit model object | Validate and use that provider/model for this input |

Example explicit override, using IDs returned by `models`:

```json
{
  "model": {
    "providerId": "account:bigmodel-individual-coding-plan",
    "modelId": "GLM-5.3",
    "options": { "reasoningLevel": "low" }
  }
}
```

If an explicit selection omits reasoning, the resolver uses the last level in the model's advertised ordering (the tested GLM models advertise `low`, `high`, `max`). Pass a level for deterministic behavior. Unknown models or unsupported reasoning levels fail; there is no silent fallback.

Per-input overrides do not change the configured default. Status records `requestedModel`, `effectiveModel`, and the app-server's `observedModel`. No model ID is hardcoded as the plugin default; read `zcode_models` for the current selection.

For a followup, pass `task_id`, a new `request_key`, and `prompt`; optionally pass `model`. Followups wait for their parent to finish. Continue from the returned task ID, since sibling followups are rejected. This does not steer an in-progress turn.

## Waiting, failures and review

`zcode_wait` blocks in **one call for up to 10 minutes**, returning as soon as **any** listed task ends. A non-empty `task_ids` array is required (1–100 UUIDs). IDs can belong to different sessions and workflows in the shared pool. Unlisted tasks cannot wake the wait, and simultaneous callers do not consume each other's completion events.

```json
{"task_ids":["<task-a-uuid>","<task-b-uuid>"]}
```

The response includes `completed_task_ids`, `pending_task_ids`, and each selected task's status. Already-ended tasks return immediately. Ended means `succeeded`, `failed`, `cancelled`, or `interrupted`; inspect the status before treating a result as successful. To keep waiting for the remaining work, call again with only `pending_task_ids` as `task_ids`.

At ten minutes, a still-pending wait returns `ready: false, timed_out: true`. The tasks continue running. `run_timeout_ms` is a separate execution deadline; `0` leaves it unset. There are no 20-second slices, `wait_id` continuations, configurable wait duration, or `mode` parameter. Those old arguments now fail validation. Reopen your Codex thread after upgrading to load the new tool schema.

The plugin's MCP declaration allows 660 seconds per call, leaving transport headroom for the 600-second wait. Custom MCP clients must also allow at least 660 seconds (for the TypeScript SDK, pass `{ timeout: 660000 }` in request options). Disconnecting or cancelling a wait releases that request's timer without cancelling its tasks.

The plugin uses V4 commands and authoritative conversation snapshots. `succeeded` means it observed the submitted turn finish successfully with an assistant response. It does not mean the generated code is correct or its suggested tests ran. Usage is the session's cumulative usage, including earlier followup turns.

After a worker crash, the supervisor stops that session before releasing its slot. If it cannot confirm that work stopped, `cleanup_pending` keeps the slot occupied. A Host or workspace app-server replacement fails the affected task without resubmitting it. Review failed/interrupted artifacts before explicitly retrying.

Process cleanup runs on the supervisor's next scheduler tick once all tasks in that workspace are terminal. `resourceCleanup.status: "released"` confirms release; `"pending"` records a cleanup error and retries independently of the task result. A supervisor restart also checks historical completed tasks. Cleanup checks runtime identity, keeps other workspaces running, and never restarts a missing process just to stop it. Retained conversations still appear in ZCode's history; process cleanup does not delete them.

On the first upgrade from an adapter without process cleanup, queued tasks wait for existing workers to finish. The supervisor then replaces its own connection adapter and Host, using the same installed runtime files, before dispatching the queue. `zcode_doctor.resource_cleanup.adapter_update` reports this transition. Subsequent cleanup releases individual workspace processes and keeps the shared Host.

Queued tasks and followups recheck their workspace before contacting the Host. If you removed that directory while the task waited, the task fails locally instead of asking the desktop runtime to spawn in a missing directory.

Edit results include the worktree, branch, `changes.patch`, and `untrackedFiles`. Review both tracked and new files. No changes are automatically merged into your checkout. Remove worktrees only after retaining the changes you want.

Analysis tasks enable ZCode's plan state and allow reading/search tools. Edit tasks additionally allow `Edit` and `Write`. Both can use todo tools; Bash, recursive delegation, workflows, and third-party MCP tools are outside the allowlist. Workers write tests and return commands for **Codex to run after review**. Unexpected interactive requests stop the task for review. These controls and worktrees are not an OS sandbox; execution uses your OS account and the installed ZCode runtime.

## Configuration and local data

Set these in the environment used to launch the MCP adapter or command client:

| Variable | Default |
| --- | --- |
| `ZCODE_SUBAGENTS_RUNTIME_ROOT` | `~/.zcode/server`; must already contain the desktop files |
| `ZCODE_SUBAGENTS_CONCURRENCY` | `12`; accepts 1–12 |
| `ZCODE_SUBAGENTS_HOME` | `~/.local/share/zcode-subagents` |

Clients sharing the data directory share the supervisor and Host. If Codex removes an old plugin cache during reinstall, the new client replaces the stale plugin supervisor while preserving active workers and the Host. Do not use extra directories to bypass the pool limit. Finish tasks and stop the supervisor before changing its settings. A different runtime root requires explicitly stopping the plugin-owned Host after its tasks finish; the client never takes over an incompatible live instance.

Task prompts, state, progress, results and worktrees are retained in private directories. Adapter logs remain local. They can contain source code or other task data; do not publish them. The plugin does not read or copy account credentials into task requests or results.

`node scripts/control.mjs status` inspects the supervisor; `node scripts/control.mjs stop` stops only the supervisor. Workers and the Host survive that operation. No plugin command installs or repairs ZCode.

## Development and validation

```bash
npm ci
npm run check
```

Tests use a fake desktop Host and temporary repositories, with no model credentials. They cover all eight MCP tools, task recovery after an MCP disconnect, tool-error isolation, the 12-task cap, queue, deduplication, default/explicit models, followup inheritance, isolated edits, cancellation, idle process release, cold session resume, runtime identity guards, wait deadlines, client exit, supervisor restart, worker/Host crashes, and binary/snapshot framing.

A separate live test consumes provider quota:

```bash
node scripts/smoke.mjs
```

It calls the MCP tools to check the default model, an explicit override, a real edit and Python tests, followup inheritance after the previous process exits, reset to `default`, Host reuse, and unchanged runtime-file hashes/default selection. It verifies every task's workspace process exits after completion. Set `ZCODE_SUBAGENTS_SMOKE_MODEL` to a JSON model object to choose its explicit override. Set `ZCODE_SUBAGENTS_SMOKE_SERVER` to test an installed `dist/server.mjs`. Its temporary fixture and task artifacts are retained for inspection.

Commit rebuilt `dist/` with source changes. GitHub Actions checks tests and bundle consistency. Protocol implementation notes are in [docs/app-server.md](docs/app-server.md). The plugin is MIT licensed; bundled dependency notices are in [dist/THIRD-PARTY-NOTICES.txt](dist/THIRD-PARTY-NOTICES.txt).

To verify long waits through the installed plugin and real Codex MCP client, run
`node scripts/smoke-wait.mjs`. It creates an isolated set of task-state fixtures,
opens two ephemeral Codex threads, checks that a 65-second task completion wakes
both selected waits, and lets a separate call reach the full ten-minute timeout.
It sends no model prompts and consumes no model quota. `--quick` skips the
ten-minute case. The isolated data and diagnostic log are retained under `/tmp`.

This package uses `.codex-plugin/plugin.json` and `.mcp.json`. The Codex MCP manifest carries `tool_timeout_sec: 660`. A portable root manifest would take precedence in current Codex while its MCP loader drops this timeout setting, so this package intentionally uses the supported Codex compatibility format.
