# ZCode Subagents

A Codex plugin that puts Astra in charge and lets ZCode handle delegated work, with up to **12 concurrent workers**.

## Why I built this

For my workflow, Astra is good, but too slow and expensive to use for every small coding task. GLM is cheaper, but dumber.

I want Astra to understand the problem, split it into sensible tasks, make the hard calls, and check the result. I want GLM to handle the bounded work: inspect a module, trace a bug, write a focused patch, or review a change.

This plugin brings them together in one workflow. I stay in Codex, delegate through ZCode, and bring the results back for review.

The plugin runs whatever model you have configured in ZCode. It does not force GLM, change your Codex model, or include either model subscription.

## How it works

```text
You → Codex / Astra → ZCode task pool → results, usage, logs, worktrees
          ↑                                      |
          └──────── review and integrate ─────────┘
```

The skill teaches Codex how to delegate. A local MCP server exposes the tools. A detached supervisor manages the queue, and each task runs in its own worker process.

- **12 workers maximum**, shared by all clients using the same data directory. Extra tasks queue.
- **Persistent tasks.** Closing an MCP connection does not kill its workers. Reconnecting clients can query them.
- **Resumable conversations.** Followups use ZCode's `--resume`. Followups to busy tasks wait in the queue.
- **Isolated edits.** Edit tasks get a Git worktree based on an explicit clean HEAD. The plugin never merges it into your checkout.
- **Actual cancellation.** Queued tasks are removed from execution; active model process groups receive SIGTERM, then SIGKILL after a grace period if needed.
- **Structured results.** Status includes the final response, token usage when reported, progress, and artifact paths.
- **Idempotent submissions.** Retrying the same workflow/request key returns the existing task.

These are external ZCode processes. They use this plugin's tools, not Codex's native `spawn_agent` or `wait_agent`.

## Requirements

- Linux or WSL. Version 0.1 uses Linux process identities and Unix process groups; macOS and native Windows are not supported yet.
- Node.js 22 or newer for the plugin, Git, and `flock` from util-linux.
- The **official [zai-org/ZCode](https://github.com/zai-org/ZCode) CLI**, available as `zcode` on PATH.
- A working ZCode model configuration. Run `zcode --version` and a small prompt first; run `zcode login` if your configuration requires login.
- Codex with local plugin and stdio MCP support (native loading verified with Codex CLI 0.155.1).

Tested with official ZCode CLI **0.16.9**. Its build/runtime requirements are separate from this plugin's Node requirement. Use the official repository's installation instructions; the similarly named `zcode-app-cli` package is an unofficial client.

## Install in Codex

```bash
codex plugin marketplace add kyoubelyu/zcode-subagents
codex plugin add zcode-subagents@zcode-subagents-community
```

Start a **new Codex thread** so the skill and tools are loaded. The repository includes the built runtime in `dist/`, so installing the plugin does not need an npm install or build step.

Try:

> Use ZCode subagents to investigate the parser and the cache independently. Review their findings before changing anything.

Or:

> Give ZCode a focused implementation task in a worktree. Inspect its diff and run the relevant tests before integrating it.

The existing ZCode login and selected model are reused. The plugin does not copy credentials.

## Tools

| Tool | Purpose |
| --- | --- |
| `zcode_spawn` | Start or queue a task; return its task ID immediately |
| `zcode_status` | Read progress, results, usage and artifact paths |
| `zcode_wait` | Wait for any/all tasks, preserving a logical deadline across short calls |
| `zcode_followup` | Continue a conversation in its existing ZCode session and workspace |
| `zcode_cancel` | Request cancellation and retain artifacts |
| `zcode_list` | Find recent tasks, optionally filtered by workflow |
| `zcode_doctor` | Check the CLI, shared worker limit and plugin settings without calling a model |

A spawn request looks like:

```json
{
  "workflow_id": "parser-cleanup",
  "request_key": "review-error-handling",
  "cwd": "/path/to/project",
  "kind": "analysis",
  "prompt": "Trace parser error handling. Identify concrete bugs, cite files, and suggest checks. Do not modify files.",
  "run_timeout_ms": 0
}
```

Use `kind: "edit"` for implementation. The source repository must have an existing commit and be clean, including ordinary untracked files. This avoids silently dropping your pending work from the worker's snapshot. Ignored files such as local credentials and dependencies are not copied into worktrees.

Pass the original `task_id` to `zcode_followup`. It returns a new task ID; use that ID for the next followup. Conversations are linear, so sibling followups are rejected. Live steering is not implemented.

## Waiting is separate from execution

Logical waits default to **15 minutes**, accept **10–30 minutes**, and return after at most **20 seconds per tool call** so Codex can remain responsive. Repeat `zcode_wait` with the returned `wait_id` to keep the original deadline.

A wait timeout leaves the task running. `run_timeout_ms` is a separate execution deadline; `0` means no deadline. Use `zcode_cancel` to stop an unwanted task.

These defaults match my Codex waiting preferences. The plugin does not modify or inherit native `multi_agent_v2` settings.

## Configuration and local data

Set these in the environment used to launch the MCP server:

| Variable | Default |
| --- | --- |
| `ZCODE_SUBAGENTS_BIN` | `zcode` from PATH |
| `ZCODE_SUBAGENTS_CONCURRENCY` | `12`; accepts 1–12 |
| `ZCODE_SUBAGENTS_HOME` | `~/.local/share/zcode-subagents` |

All clients sharing the data directory share one supervisor and concurrency limit. Keep that directory path short enough for a Unix socket. Changing the concurrency setting requires stopping the existing supervisor; finish or cancel tasks first.

Each task retains its prompt, state, stdout/stderr logs, final result, and any edit worktree. Directories are private to the current OS user. Results and logs can contain source code or other sensitive task data; they are not part of this repository.

The supervisor survives MCP disconnection. Workers also survive a supervisor restart. If a worker crashes, the supervisor cleans up its model process group, marks the task interrupted, and does not automatically replay it.

Use `node scripts/control.mjs status` to inspect the supervisor or `node scripts/control.mjs stop` to stop it. Stopping the supervisor does not cancel workers; they are rediscovered when the plugin is used again.

## Reviewing changes

An edit result includes its worktree path, branch, `changes.patch` and `untrackedFiles`.

- The patch includes tracked changes relative to the original base commit, including changes the worker committed.
- New untracked files remain in the worktree and are listed separately.
- Nothing is automatically applied, committed, merged, pushed or published in your main checkout by the plugin.

Review both the patch and the new files, then integrate the work through your normal Git workflow. Remove completed worktrees with `git worktree remove <path>` only after retaining the changes you want. Task artifacts are kept until you explicitly delete them.

Analysis tasks use ZCode's `plan` permission mode; edit tasks use `edit`. Recursive Agent and workflow tools are denied. These controls and Git worktrees are **not an OS sandbox**. ZCode runs with your user account's access, and existing ZCode plugins/configuration can affect its behavior.

The official CLI's headless `edit` mode cannot approve Bash commands. Version 0.1 therefore disables Bash explicitly. Workers can inspect and edit files and write tests; **Codex runs the returned test commands**. The plugin does not switch to `yolo` to get around this limitation.

## Development

```bash
git clone https://github.com/kyoubelyu/zcode-subagents.git
cd zcode-subagents
npm ci
npm run check
```

The tests use a fake CLI and temporary repositories. They cover the 12-worker cap and queue, request deduplication, followups, worktree isolation, failure reporting, process-group cancellation, separate wait/execution deadlines, MCP transport, and reconnection. They do not need model credentials.

Rebuild and commit `dist/` when changing runtime source. GitHub Actions checks that the committed bundle matches the source. A real-model smoke test is separate and may consume your ZCode provider quota.

The code is MIT licensed. Bundled dependency licenses are in `dist/THIRD-PARTY-NOTICES.txt`.
