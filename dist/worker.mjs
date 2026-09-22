import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);

// src/worker.mjs
import { promises as fs3, createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { finished } from "node:stream/promises";
import path3 from "node:path";
import { fileURLToPath } from "node:url";

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
  if (process.platform !== "linux") throw new Error("Version 0.1 supports Linux (including WSL) only.");
  const socket = path.join(home, "supervisor.sock");
  if (Buffer.byteLength(socket) > 100) throw new Error("ZCODE_SUBAGENTS_HOME is too long for a Unix socket.");
  return { home, socket, concurrency, binary: env.ZCODE_SUBAGENTS_BIN || "zcode" };
}
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

// src/output.mjs
var OutputParser = class {
  constructor() {
    this.buffer = "";
    this.summary = void 0;
    this.sessionId = void 0;
    this.eventCount = 0;
    this.lastEvent = void 0;
  }
  accept(data) {
    this.buffer += data;
    if (this.buffer.length > 4 * 1024 * 1024) throw new Error("ZCode emitted an oversized output frame.");
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.line(line);
    }
  }
  line(line) {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;
    this.eventCount += 1;
    this.lastEvent = event.type || event.event?.type || event.method || "json";
    const id = event.sessionId || event.event?.sessionId || event.data?.sessionId || event.params?.sessionId;
    if (typeof id === "string") this.sessionId = id;
    if (event.type === "result" && typeof event.response === "string") this.summary = event;
  }
  finish() {
    this.line(this.buffer);
    this.sessionId ||= this.summary?.sessionId;
    this.buffer = "";
  }
};

// src/worker.mjs
async function runWorker(config, id) {
  process.umask(63);
  const dir = taskDir(config, id);
  const lock = await fs3.open(path3.join(dir, "worker.lock"), "wx", 384);
  await lock.close();
  await atomicJson(path3.join(dir, "owner.json"), {
    pid: process.pid,
    identity: await processIdentity(process.pid)
  });
  const spec = await readJson(path3.join(dir, "spec.json"));
  let runtime = { status: "preparing", startedAt: now(), updatedAt: now() };
  let saveChain = Promise.resolve();
  const save = () => {
    const snapshot = { ...runtime, updatedAt: now() };
    saveChain = saveChain.then(() => atomicJson(path3.join(dir, "runtime.json"), snapshot));
    return saveChain;
  };
  await save();
  let child;
  let childOwner;
  let stopping;
  let fatal;
  let killTimer;
  let monitor;
  let monitoring = false;
  const parser = new OutputParser();
  const streams = [];
  const groupSignal = async (signal) => {
    if (!childOwner) return;
    const identity = await processIdentity(childOwner.pid);
    if (identity && identity !== childOwner.identity) return;
    try {
      process.kill(-childOwner.pid, signal);
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  };
  const stop = (reason, failed = false) => {
    if (stopping) return;
    stopping = reason;
    if (failed) fatal ||= reason;
    void groupSignal("SIGTERM");
    killTimer = setTimeout(() => {
      void groupSignal("SIGKILL");
    }, 8e3);
  };
  process.once("SIGTERM", () => stop("Worker received SIGTERM"));
  process.once("SIGINT", () => stop("Worker received SIGINT"));
  try {
    runtime.workspace = await prepareWorkspace(spec, dir);
    if (await readJson(path3.join(dir, "cancel.json"))) {
      runtime.status = "cancelled";
      runtime.error = "Cancelled before execution";
      return;
    }
    const permission = spec.kind === "analysis" ? "plan" : "edit";
    const contract = [
      "You are a ZCode subagent delegated by Codex.",
      "Work only on the task below. Do not spawn agents, workflows, or invoke another coding agent CLI.",
      "Stay within the supplied workspace and task scope. Do not publish, push, deploy, or merge.",
      "Shell execution is unavailable in this headless permission mode. Bash is disabled; do not retry it or try to bypass it through another tool.",
      "Write tests where relevant and return exact test commands for Codex to run. Never claim those commands have run.",
      "Return a concise summary, changed files, checks actually run, suggested test commands, and unresolved issues.",
      spec.kind === "analysis" ? "This is an analysis task; do not change files." : "Make changes only in this isolated worktree.",
      "",
      "Task:",
      spec.prompt
    ].join("\n");
    const args = [
      "--cwd",
      runtime.workspace,
      "--mode",
      permission,
      "--output-format",
      "stream-json",
      "--disallowed-tools",
      "Agent,CreateWorkflow,AmendWorkflow,Bash",
      "--prompt",
      contract
    ];
    if (spec.sessionId) args.push("--resume", spec.sessionId);
    child = spawn(config.binary, args, {
      cwd: runtime.workspace,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, ZCODE_SUBAGENTS_CHILD: "1" }
    });
    const completion = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code2, signal2) => resolve({ code: code2, signal: signal2 }));
    });
    completion.catch(() => {
    });
    childOwner = { pid: child.pid, identity: await processIdentity(child.pid) };
    await atomicJson(path3.join(dir, "child.json"), childOwner);
    runtime.status = "running";
    runtime.childPid = child.pid;
    await save();
    let bytes = 0;
    for (const [name, readable] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
      const output = createWriteStream(path3.join(dir, name + ".log"), { mode: 384 });
      streams.push(output);
      output.on("error", (error) => stop("Cannot write task log: " + error.message, true));
      readable.setEncoding("utf8");
      readable.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 64 * 1024 * 1024) {
          stop("Task output exceeded the 64 MiB limit", true);
          return;
        }
        if (!output.write(chunk)) {
          readable.pause();
          output.once("drain", () => readable.resume());
        }
        if (name === "stdout") {
          try {
            parser.accept(chunk);
          } catch (error) {
            stop(error.message, true);
          }
        } else {
          runtime.stderrTail = (runtime.stderrTail || "") + chunk;
          runtime.stderrTail = runtime.stderrTail.slice(-4e3);
        }
      });
    }
    monitor = setInterval(async () => {
      if (monitoring) return;
      monitoring = true;
      try {
        const cancel = await readJson(path3.join(dir, "cancel.json"));
        if (cancel) stop(cancel.reason || "Cancelled by caller");
        if (spec.runTimeoutMs && Date.now() - Date.parse(runtime.startedAt) >= spec.runTimeoutMs) {
          stop("Execution deadline exceeded", true);
        }
        runtime.sessionId = parser.sessionId;
        runtime.eventCount = parser.eventCount;
        runtime.lastEvent = parser.lastEvent;
        await save();
      } catch (error) {
        stop(error.message, true);
      } finally {
        monitoring = false;
      }
    }, 500);
    const { code, signal } = await completion;
    clearInterval(monitor);
    parser.finish();
    runtime.exitCode = code;
    runtime.signal = signal;
    runtime.sessionId = parser.sessionId;
    runtime.eventCount = parser.eventCount;
    runtime.lastEvent = parser.lastEvent;
    if (parser.summary) {
      await atomicJson(path3.join(dir, "result.json"), parser.summary);
      runtime.response = bounded(parser.summary.response);
      runtime.usage = parser.summary.usage;
      runtime.projection = parser.summary.projection;
    }
    runtime.status = fatal ? "failed" : stopping ? "cancelled" : code === 0 && parser.summary && parser.summary.projection?.status !== "error" ? "succeeded" : "failed";
    if (runtime.status !== "succeeded") {
      runtime.error = fatal || stopping || (code !== 0 ? "ZCode exited with code " + code : "ZCode did not return a successful structured result");
    }
    try {
      runtime.changes = await collectChanges(spec, runtime.workspace, dir);
    } catch (error) {
      runtime.status = "failed";
      runtime.error = "Could not collect changes: " + error.message;
    }
  } catch (error) {
    runtime.status = stopping && !fatal ? "cancelled" : "failed";
    runtime.error = error.message;
    if (child?.pid) await groupSignal("SIGKILL");
  } finally {
    clearInterval(monitor);
    clearTimeout(killTimer);
    if (stopping) await groupSignal("SIGKILL");
    for (const stream of streams) stream.end();
    await Promise.allSettled(streams.map((stream) => finished(stream)));
    while (monitoring) await new Promise((resolve) => setTimeout(resolve, 10));
    runtime.finishedAt = now();
    await save();
  }
}
if (process.argv[1] && path3.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorker(settings(), process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
export {
  runWorker
};
