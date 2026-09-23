import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);

// src/worker.mjs
import { promises as fs3 } from "node:fs";
import path4 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/common.mjs
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
var MAX_CONCURRENCY = 12;
function settings(env = process.env) {
  const home = path.resolve(env.ZCODE_SUBAGENTS_HOME || path.join(os.homedir(), ".local/share/zcode-subagents"));
  const concurrency = Number(env.ZCODE_SUBAGENTS_CONCURRENCY || MAX_CONCURRENCY);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error("ZCODE_SUBAGENTS_CONCURRENCY must be an integer from 1 to 12.");
  }
  if (process.platform !== "linux") throw new Error("This release supports Linux (including WSL) only.");
  const socket = path.join(home, "supervisor.sock");
  if (Buffer.byteLength(socket) > 100) throw new Error("ZCODE_SUBAGENTS_HOME is too long for a Unix socket.");
  return {
    home,
    socket,
    concurrency,
    runtimeRoot: path.resolve(env.ZCODE_SUBAGENTS_RUNTIME_ROOT || path.join(os.homedir(), ".zcode/server"))
  };
}
var delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var now = () => (/* @__PURE__ */ new Date()).toISOString();
function validId(id) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid task or wait ID.");
  return id;
}
var taskDir = (config, id) => path.join(config.home, "tasks", validId(id));
async function privateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 448 });
  await fs.chmod(dir, 448);
}
async function atomicJson(file, value) {
  await privateDir(path.dirname(file));
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 384 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
async function readJson(file, fallback = void 0) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return void 0;
  try {
    const raw = await fs.readFile("/proc/" + pid + "/stat", "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return void 0;
    return fields[19];
  } catch {
    return void 0;
  }
}
async function sameProcess(owner) {
  return Boolean(owner?.pid && owner?.identity && await processIdentity(owner.pid) === owner.identity);
}
function bounded(value, length = 12e3) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text?.length > length ? text.slice(0, length) + "\n[Truncated; see task artifacts.]" : text;
}

// src/workspace.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs2 } from "node:fs";
import path2 from "node:path";
var execute = promisify(execFile);
async function git(cwd, args, maxBuffer = 16 * 1024 * 1024) {
  const { stdout } = await execute("git", ["-C", cwd, ...args], { maxBuffer, encoding: "utf8" });
  return stdout;
}
async function prepareWorkspace(spec, dir) {
  if (spec.workspace || spec.kind === "analysis") return spec.workspace || spec.cwd;
  const worktree = path2.join(dir, "worktree");
  await git(spec.repo, ["worktree", "add", "-b", "zcode-subagents/" + spec.id, worktree, spec.baseCommit]);
  return worktree;
}
async function collectChanges(spec, workspace, dir) {
  if (spec.kind !== "edit" || !spec.baseCommit) return {};
  const status = await git(workspace, ["status", "--short"]);
  const patch = await git(workspace, ["diff", "--binary", spec.baseCommit, "--"]);
  const untracked = (await git(workspace, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  const patchPath = path2.join(dir, "changes.patch");
  await fs2.writeFile(patchPath, patch, { mode: 384 });
  return {
    gitStatus: status,
    patchPath,
    untrackedFiles: untracked,
    branch: (await git(workspace, ["branch", "--show-current"])).trim(),
    note: "changes.patch contains tracked changes; untracked files remain in the retained worktree. No changes were merged."
  };
}

// src/host-client.mjs
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import path3 from "node:path";
import { fileURLToPath } from "node:url";

// src/client.mjs
import http from "node:http";
function request(config, method, params, health = false) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: config.socket,
      path: health ? "/health" : "/rpc",
      method: health ? "GET" : "POST",
      headers: { "Content-Type": "application/json" }
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 8 * 1024 * 1024) res.destroy(new Error("Supervisor response too large."));
      });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data.error) reject(new Error(data.error));
          else resolve(health ? data : data.result);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(55e3, () => req.destroy(new Error("Supervisor request timed out. Query task status before retrying a mutation.")));
    req.on("error", reject);
    req.end(health ? void 0 : JSON.stringify({ method, params }));
  });
}

// src/host-client.mjs
var hostConfig = (config) => ({ ...config, socket: path3.join(config.home, "host.sock") });
var hostCall = (config, method, params = {}) => request(hostConfig(config), method, params);
var hostHealth = (config) => request(hostConfig(config), null, null, true);
async function ensureHost(config) {
  let health;
  try {
    health = await hostHealth(config);
  } catch {
  }
  if (health) {
    if (health.protocol !== 2) throw new Error("Incompatible app-server adapter; finish active tasks before replacing it.");
    if (health.runtimeRoot !== config.runtimeRoot) throw new Error("Existing Host uses another runtime root. Finish tasks before changing the root.");
    return health;
  }
  await privateDir(config.home);
  const log = openSync(path3.join(config.home, "host.log"), "a", 384);
  try {
    const child = spawn("flock", [
      "--exclusive",
      "--nonblock",
      "--close",
      path3.join(config.home, "host.flock"),
      process.execPath,
      fileURLToPath(new URL("./host.mjs", import.meta.url))
    ], {
      detached: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        ZCODE_SUBAGENTS_HOME: config.home,
        ZCODE_SUBAGENTS_RUNTIME_ROOT: config.runtimeRoot,
        ZCODE_SUBAGENTS_HOST_LOCKED: "1"
      }
    });
    child.on("error", () => {
    });
    child.unref();
  } finally {
    closeSync(log);
  }
  for (let i = 0; i < 220; i++) {
    await delay(100);
    try {
      health = await hostHealth(config);
    } catch {
      continue;
    }
    if (health.protocol !== 2 || health.runtimeRoot !== config.runtimeRoot) throw new Error("An incompatible Host adapter is already running. Finish tasks before replacing it.");
    return health;
  }
  throw new Error("Desktop Host did not start. Inspect " + path3.join(config.home, "host.log"));
}

// src/conversation.mjs
var runningConversation = (snapshot) => snapshot.control.canStop || ["running", "prewarming"].includes(snapshot.control.phase);
function turnResult(snapshot, commandId) {
  const header = snapshot.rows.window.find((row) => row.kind === "turnHeader" && row.sourceCommandId === commandId);
  if (!header || header.state === "running") return;
  const response = snapshot.rows.window.filter((row) => row.kind === "assistantText" && row.turnId === header.turnId).map((row) => row.text).join("\n\n");
  return { response, resultType: header.state, usage: snapshot.usage, error: snapshot.control.lastError };
}

// src/worker.mjs
function taskPrompt(spec) {
  return [
    "You are a ZCode subagent delegated by Codex.",
    "Do only the bounded task below. Do not create agents, workflows, or invoke other coding agents.",
    "Do not publish, push, deploy, or merge. Bash and recursive delegation are disabled; do not bypass them.",
    "Write tests if relevant and return commands for Codex to run. Do not claim unrun checks passed.",
    spec.kind === "analysis" ? "Analysis only: do not edit any files." : "Edit only in this isolated worktree.",
    "Return a concise summary, changes, actual checks, suggested commands and unresolved issues.",
    "",
    spec.prompt
  ].join("\n");
}
async function runWorker(config, id) {
  process.umask(63);
  const dir = taskDir(config, id);
  await (await fs3.open(path4.join(dir, "worker.lock"), "wx", 384)).close();
  await atomicJson(path4.join(dir, "owner.json"), { pid: process.pid, identity: await processIdentity(process.pid) });
  const spec = await readJson(path4.join(dir, "spec.json"));
  const state = { status: "preparing", startedAt: now(), backend: "desktop-app-server", requestedModel: spec.model };
  const save = () => atomicJson(path4.join(dir, "runtime.json"), { ...state, updatedAt: now() });
  let stopping;
  process.once("SIGTERM", () => {
    stopping = "Worker received SIGTERM";
  });
  process.once("SIGINT", () => {
    stopping = "Worker received SIGINT";
  });
  const params = () => ({ instance: state.appServer.instance, workspacePath: state.workspace, sessionId: state.sessionId, runtimeIdentity: state.runtimeIdentity });
  let accepted = false;
  let terminal = false;
  await save();
  try {
    state.workspace = await prepareWorkspace(spec, dir);
    await save();
    if (await readJson(path4.join(dir, "cancel.json"))) {
      state.status = "cancelled";
      return;
    }
    state.appServer = await ensureHost(config);
    await save();
    state.effectiveModel = await hostCall(config, "resolveModel", { model: spec.model, instance: state.appServer.instance });
    const snapshot = await hostCall(config, spec.sessionId ? "resume" : "create", {
      instance: state.appServer.instance,
      workspacePath: state.workspace,
      sessionId: spec.sessionId,
      kind: spec.kind
    });
    state.sessionId = snapshot.session.sessionId;
    state.runtimeIdentity = await hostCall(config, "identity", params());
    await save();
    const ack = await hostCall(config, "send", {
      ...params(),
      commandId: id,
      kind: spec.kind,
      model: state.effectiveModel,
      prompt: taskPrompt(spec)
    });
    accepted = true;
    state.commandAck = ack.status;
    state.status = "running";
    await save();
    let stopSent = false, failure;
    while (!terminal) {
      const cancel = await readJson(path4.join(dir, "cancel.json"));
      if (cancel) stopping ||= cancel.reason || "Cancelled by caller";
      if (spec.runTimeoutMs && Date.now() - Date.parse(state.startedAt) >= spec.runTimeoutMs) {
        failure ||= "Execution deadline exceeded";
        stopping ||= failure;
      }
      if (stopping && !stopSent) {
        await hostCall(config, "stop", { ...params(), commandId: id + "-stop" });
        stopSent = true;
      }
      const current = await hostCall(config, "snapshot", { ...params(), commandId: id });
      const result = turnResult(current, id);
      if (result && !runningConversation(current)) {
        if (result.resultType !== "completedSuccess" && !(stopping && result.resultType === "completedInterrupted")) failure ||= result.error?.message || "App-server turn ended: " + result.resultType;
        if (result.resultType === "completedSuccess" && !result.response) failure ||= "App-server ended without an assistant response";
        state.response = bounded(result.response);
        state.usage = result.usage;
        await atomicJson(path4.join(dir, "result.json"), { ...result, sessionId: state.sessionId, effectiveModel: state.effectiveModel });
        terminal = true;
      }
      if (state.eventSeq !== current.seq) await fs3.appendFile(path4.join(dir, "progress.jsonl"), JSON.stringify({
        at: now(),
        seq: current.seq,
        control: current.control,
        model: current.config.modelSelection,
        rows: current.rows.window.map((r) => ({ rowId: r.rowId, kind: r.kind, state: r.state, toolName: r.toolName }))
      }) + "\n", { mode: 384 });
      state.eventSeq = current.seq;
      state.projection = current.control;
      state.observedModel = current.config.modelSelection;
      if (current.pendingInteractions?.length) {
        failure ||= "App-server requires interaction; task stopped for review";
        stopping ||= failure;
      }
      if (stopping && stopSent && !runningConversation(current)) terminal = true;
      if (!terminal && current.control.phase === "error") throw new Error(current.control.lastError?.message || "App-server entered an error state");
      await save();
      if (!terminal) await delay(1e3);
    }
    state.status = failure ? "failed" : stopping ? "cancelled" : "succeeded";
    if (failure || stopping) state.error = failure || stopping;
    state.changes = await collectChanges(spec, state.workspace, dir);
  } catch (error) {
    state.error = error.message;
    state.status = "failed";
    if (state.sessionId && !terminal) {
      try {
        const stopped = await hostCall(config, "stop", { ...params(), commandId: id + "-cleanup" });
        if (!stopped.runtimeEnded) {
          const current = await hostCall(config, "snapshot", params());
          if (runningConversation(current)) state.status = "cleanup_pending";
        }
      } catch {
        if (await sameProcess({ pid: state.appServer.hostPid, identity: state.appServer.hostIdentity })) state.status = "cleanup_pending";
      }
    }
    if (accepted && !terminal) state.submissionOutcome = "interrupted; not replayed";
  } finally {
    if (state.status !== "cleanup_pending") state.finishedAt = now();
    await save();
  }
}
if (process.argv[1] && path4.resolve(process.argv[1]) === fileURLToPath2(import.meta.url)) {
  runWorker(settings(), process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
export {
  runWorker,
  taskPrompt
};
