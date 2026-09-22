# Desktop app-server backend contract

The plugin uses the installed desktop runtime (`~/.zcode/server/node` and
`zcode-server.cjs`). The official Host starts/reuses its own workspace app-server
and owns account authentication, model resolution and session execution. The
plugin never downloads, builds, upgrades, patches or vendors those executables.
An optional runtime root selects another existing installation.

Codex invokes the registered MCP tools through a disposable stdio adapter. The
skill prefers direct tools; the short-lived command remains available for
diagnostics and explicit recovery. There is no prompt-mode ZCode CLI execution.
The MCP adapter forwards requests and owns no task or app-server lifecycle. A detached task supervisor
retains the existing shared 12-task cap, queue, idempotency and worktree behavior.
A separate local connection adapter launches the desktop Host on demand, retains
its stdio connection and exposes a private Unix socket. New clients reuse it;
closing a command, worker or supervisor does not terminate a healthy Host.
Desktop-owned stdio pipes are never attached to or taken over. A failed Host is
reported explicitly; tasks are never automatically resubmitted. A later explicit
operation may launch a fresh Host. No version repair or update occurs.

New tasks without a model use the Host's current configured default. The explicit
value `"default"` also reads that default, including on followups. Explicit
`model` is a structured `{providerId, modelId, options?: {reasoningLevel}}` value.
The Host validates it before submission. Invalid selections fail without fallback.
Followups inherit the parent's effective selection unless explicitly overridden.
Overrides apply to the input and must not change the user's configured default.
Status records requested/effective selection and session/runtime identity.

V4 commands carry a stable command ID. Reads use short-lived V4 subscriptions,
verify the owned initial snapshot, and assemble bounded fragments with CRC32
verification. Online deltas are not retained. Legacy session/events is not used:
the tested desktop/agent pair rejects its own newer event payload fields there.
The submitted command's turn header and assistant text determine completion;
long turns page older rows up to a 10,000-row limit. A lost submission reply is reported as
uncertain rather than replayed. Polls use bounded reads and reconnect independently
of the MCP or command client. Cancellation targets only the task's session, never the
shared Host. A crashed worker requires the supervisor to stop that session before
releasing its concurrency slot. Existing v0.1 tasks retain their artifacts.

Runtime files, provider configuration and credentials are owned by ZCode. Task
artifacts and adapter logs are private. Protocol responses containing credentials
are never logged. Analysis enables independent plan state; editing enables edit
mode. The allowlist contains reading/search and todo tools, plus Edit/Write for
edit tasks. Recursive agents, workflows, Bash and third-party MCP tools are not
allowed. Unexpected interactive requests stop the task for review.

Acceptance: default and explicit model requests run against the real desktop
runtime; invalid models do not fall back; a followup reuses the session; two jobs
reuse a Host; edit worktrees remain isolated; 12 jobs run and the 13th queues;
cancellation affects only its session; client disconnect and supervisor restart
preserve work; Host failure does not duplicate submissions. README and skill
instructions describe only the delivered app-server integration.

Direct-tool acceptance: all original seven zcode_* tools plus zcode_models are
discoverable from the installed manifest. Model defaults/overrides use the same
schemas as the command client. Tool/backend errors leave the MCP connection
usable; disconnect during a wait preserves the task, and a new client retrieves
the original result without creating another task. Followups and cancellation
through MCP preserve shared Host identity. No reconnect automatically resubmits
work. A closed Codex-owned MCP transport still requires client reconnection; it
cannot be repaired from inside that dead transport.

Codex may delete the previous plugin cache on reinstall. A current client detects
the same-version supervisor's missing entry/worker files and replaces only that
owned supervisor after verifying its process identity. Workers and the Host
survive; queued work is not dispatched from a deleted cache. This updates plugin
processes only, never the installed desktop runtime.
