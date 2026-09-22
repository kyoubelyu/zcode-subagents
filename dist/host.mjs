import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);

// src/host.mjs
import http from "node:http";
import { promises as fs3, createWriteStream } from "node:fs";
import path3 from "node:path";
import { fileURLToPath } from "node:url";

// src/host-rpc.mjs
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

// src/host-wire.mjs
var MAX_FRAME = 16 * 1024 * 1024;
function integer(value) {
  const out = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    out.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(out);
}
function encode(value) {
  if (value === void 0) return Buffer.from([0]);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from([4]), integer(value.length), ...value.map(encode)]);
  if (Number.isInteger(value) && value >= 0 && value <= 2147483647) return Buffer.concat([Buffer.from([6]), integer(value)]);
  const kind = typeof value === "string" ? 1 : 5;
  const bytes = Buffer.from(kind === 1 ? value : JSON.stringify(value));
  return Buffer.concat([Buffer.from([kind]), integer(bytes.length), bytes]);
}
function decodePair(buffer) {
  let offset = 0;
  const take = (n) => {
    if (n < 0 || offset + n > buffer.length) throw new Error("Truncated Host channel value");
    const out = buffer.subarray(offset, offset + n);
    offset += n;
    return out;
  };
  const number = () => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = take(1)[0];
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw new Error("Invalid Host integer");
  };
  const read = (depth = 0) => {
    if (depth > 32) throw new Error("Host value nesting limit exceeded");
    const type = take(1)[0];
    if (type === 0) return void 0;
    if (type === 6) return number();
    const length = number();
    if (length > MAX_FRAME) throw new Error("Host value too large");
    if (type === 4) {
      if (length > buffer.length - offset) throw new Error("Invalid Host array length");
      return Array.from({ length }, () => read(depth + 1));
    }
    const raw = take(length);
    if (type === 1) return raw.toString("utf8");
    if (type === 5) return JSON.parse(raw.toString("utf8"));
    if (type === 2 || type === 3) return raw;
    throw new Error("Unknown Host value type " + type);
  };
  const pair = [read(), read()];
  if (offset !== buffer.length) throw new Error("Trailing Host channel data");
  return pair;
}
function frame(header, body) {
  const data = Buffer.concat([encode(header), encode(body)]);
  if (data.length > MAX_FRAME) throw new Error("Host request too large");
  const head = Buffer.alloc(13);
  head[0] = 1;
  head.writeUInt32BE(data.length, 9);
  return Buffer.concat([head, data]);
}
var Frames = class {
  buffer = Buffer.alloc(0);
  accept(chunk, callback) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 13) {
      const length = this.buffer.readUInt32BE(9);
      if (length > MAX_FRAME) throw new Error("Host frame too large");
      if (this.buffer.length < 13 + length) break;
      const type = this.buffer[0], data = this.buffer.subarray(13, 13 + length);
      this.buffer = this.buffer.subarray(13 + length);
      if (type === 1) callback(...decodePair(data));
    }
  }
};

// src/host-rpc.mjs
var HostRpc = class extends EventEmitter {
  constructor(runtime, log) {
    super();
    this.setMaxListeners(64);
    this.pending = /* @__PURE__ */ new Map();
    this.sequence = 0;
    this.frames = new Frames();
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {
    });
    this.child = spawn(runtime.node, [runtime.entry], {
      cwd: runtime.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ZCODE_ENV: "production",
        ZCODE_SERVICE_AUTHORITY_MODE: "standalone-server",
        ZCODE_SERVER_RUNTIME_ROOT: runtime.root,
        ZCODE_SUBAGENTS_CHILD: "1"
      }
    });
    this.child.stderr.on("data", (chunk) => log(chunk));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => this.fail(new Error(`Desktop Host exited (${code ?? signal})`)));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stdout.on("error", (error) => this.fail(error));
    let helloBuffer = Buffer.alloc(0);
    this.child.stdout.on("data", (chunk) => {
      try {
        if (!this.hello) {
          helloBuffer = Buffer.concat([helloBuffer, chunk]);
          if (helloBuffer.length > 65536) throw new Error("Invalid desktop Host hello");
          const newline = helloBuffer.indexOf(10);
          if (newline < 0) return;
          this.hello = JSON.parse(helloBuffer.subarray(0, newline).toString());
          if (this.hello.type !== "zcode-hello") throw new Error("Incompatible desktop Host handshake");
          this.child.stdin.write(JSON.stringify({
            type: "zcode-hello-ack",
            version: this.hello.version,
            clientId: "zcode-subagents"
          }) + "\n");
          chunk = helloBuffer.subarray(newline + 1);
          helloBuffer = void 0;
        }
        this.frames.accept(chunk, (header, body) => {
          if (header[0] === 200) return this.resolveReady(this.hello);
          if (header[0] === 204) return this.emit("notification", header[1], body);
          const pending = this.pending.get(header[1]);
          if (!pending) return;
          this.pending.delete(header[1]);
          clearTimeout(pending.timer);
          if (header[0] === 201) pending.resolve(body);
          else pending.reject(Object.assign(new Error(body?.message || "Desktop Host RPC failed"), { code: body?.code }));
        });
      } catch (error) {
        this.fail(error);
        this.child.stdin.end();
      }
    });
    this.startupTimer = setTimeout(() => {
      this.fail(new Error("Desktop Host handshake timed out"));
      this.child.stdin.end();
    }, 2e4);
    this.ready.finally(() => clearTimeout(this.startupTimer)).catch(() => {
    });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = error;
    this.rejectReady(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }
  async call(channel, method, args = [], timeout = 45e3) {
    await this.ready;
    if (this.closed) throw this.closed;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Host ${method} timed out; mutation outcome may be unknown`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(frame([100, id, channel, method], args), (error) => {
        if (error) this.fail(error);
      });
    });
  }
  async listen(channel, name, args, callback) {
    await this.ready;
    const id = ++this.sequence;
    const listener = (eventId, body) => {
      if (eventId === id) callback(body);
    };
    this.on("notification", listener);
    this.child.stdin.write(frame([102, id, channel, name], args));
    return () => {
      this.off("notification", listener);
      if (!this.closed) this.child.stdin.write(frame([103, id], void 0));
    };
  }
  close() {
    this.child.stdin.end();
  }
};

// src/desktop-runtime.mjs
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
async function desktopRuntime(config) {
  const root = path.resolve(config.runtimeRoot || path.join(os.homedir(), ".zcode/server"));
  const runtime = { root, node: path.join(root, "node"), entry: path.join(root, "zcode-server.cjs"), cwd: config.home };
  for (const file of [runtime.node, runtime.entry, path.join(root, "agents/glm/zcode.cjs")]) {
    try {
      if (!(await fs.stat(file)).isFile()) throw new Error();
    } catch {
      throw new Error("Desktop runtime file missing: " + file + ". Install or repair ZCode Desktop yourself; this plugin never downloads or modifies it.");
    }
  }
  return runtime;
}

// src/conversation.mjs
import { crc32 } from "node:zlib";
var SnapshotAssembly = class {
  constructor(topic) {
    this.topic = topic;
    this.parts = /* @__PURE__ */ new Map();
  }
  accept(wire) {
    if (wire.topic !== this.topic || wire.deliveryKind !== "initial") return;
    if (wire.wireVersion !== 3) throw new Error("Unsupported conversation wire version");
    let frame2;
    if (wire.kind === "complete") frame2 = wire.frame;
    else if (wire.kind === "fragment") {
      const { fragmentCount: count, fragmentIndex: index, logicalBytes: size } = wire;
      if (!Number.isInteger(count) || count < 1 || count > 4096 || !Number.isInteger(index) || index < 0 || index >= count || !Number.isInteger(size) || size < 1 || size > 16 * 1024 * 1024) throw new Error("Invalid conversation fragment bounds");
      let assembly = this.parts.get(wire.logicalFrameId);
      if (!assembly) {
        if (this.parts.size >= 2) throw new Error("Too many initial snapshot assemblies");
        assembly = { wire, chunks: /* @__PURE__ */ new Map(), bytes: 0 };
        this.parts.set(wire.logicalFrameId, assembly);
      }
      if (assembly.wire.fragmentCount !== count || assembly.wire.logicalBytes !== size || assembly.wire.subscriptionId !== wire.subscriptionId || assembly.wire.checksum?.value !== wire.checksum?.value) throw new Error("Inconsistent conversation fragments");
      const chunk = Buffer.from(wire.dataBase64, "base64");
      const prior = assembly.chunks.get(index);
      if (prior && !prior.equals(chunk)) throw new Error("Conflicting conversation fragment");
      if (!prior) {
        assembly.chunks.set(index, chunk);
        assembly.bytes += chunk.length;
      }
      if (assembly.bytes > size) throw new Error("Conversation snapshot too large");
      if (assembly.chunks.size !== count) return;
      const bytes = Buffer.concat(Array.from({ length: count }, (_, i) => assembly.chunks.get(i)));
      if (bytes.length !== size || wire.checksum?.algorithm !== "crc32" || crc32(bytes).toString(16).padStart(8, "0") !== wire.checksum.value) throw new Error("Conversation snapshot checksum mismatch");
      frame2 = JSON.parse(bytes.toString());
      this.parts.delete(wire.logicalFrameId);
    } else throw new Error("Unknown conversation frame kind");
    if (frame2?.topic !== this.topic || frame2.subscriptionId !== wire.subscriptionId || frame2.payload?.kind !== "snapshot") throw new Error("Invalid initial conversation snapshot");
    const snapshot = frame2.payload.snapshot;
    if (snapshot?.protocolVersion !== 1 || !snapshot.control || !snapshot.rows?.window || snapshot.seq !== frame2.toSeq) throw new Error("Invalid conversation snapshot state");
    return { subscriptionId: wire.subscriptionId, snapshot };
  }
};
async function readConversation(rpc, target) {
  const assembly = new SnapshotAssembly("conversation/" + target.sessionId);
  let resolve, reject, ack;
  const ready = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  ready.catch(() => {
  });
  const timer = setTimeout(() => reject(new Error("V4 conversation snapshot timed out")), 15e3);
  const closed = (error) => reject(error);
  rpc.once("closed", closed);
  const dispose = await rpc.listen("zcode-agent", "onDynamicConversationFrame", { workspacePath: target.workspacePath }, (wire) => {
    try {
      const result = assembly.accept(wire);
      if (result) resolve(result);
    } catch (error) {
      reject(error);
    }
  });
  try {
    ({ ack } = await rpc.call("zcode-agent", "subscribeConversationV4", [target]));
    const result = await ready;
    if (result.subscriptionId !== ack.subscriptionId) throw new Error("Conversation subscription changed");
    return result.snapshot;
  } finally {
    clearTimeout(timer);
    rpc.off("closed", closed);
    dispose();
    if (ack) await rpc.call("zcode-agent", "unsubscribeConversationV4", [{
      workspacePath: target.workspacePath,
      subscriptionId: ack.subscriptionId,
      runtimePolicy: "existing-only"
    }]).catch(() => {
    });
  }
}
var runningConversation = (snapshot) => snapshot.control.canStop || ["running", "prewarming"].includes(snapshot.control.phase);

// src/common.mjs
import { promises as fs2 } from "node:fs";
import os2 from "node:os";
import path2 from "node:path";
import { createHash, randomUUID } from "node:crypto";
var MAX_CONCURRENCY = 12;
function settings(env = process.env) {
  const home = path2.resolve(env.ZCODE_SUBAGENTS_HOME || path2.join(os2.homedir(), ".local/share/zcode-subagents"));
  const concurrency = Number(env.ZCODE_SUBAGENTS_CONCURRENCY || MAX_CONCURRENCY);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error("ZCODE_SUBAGENTS_CONCURRENCY must be an integer from 1 to 12.");
  }
  if (process.platform !== "linux") throw new Error("This release supports Linux (including WSL) only.");
  const socket = path2.join(home, "supervisor.sock");
  if (Buffer.byteLength(socket) > 100) throw new Error("ZCODE_SUBAGENTS_HOME is too long for a Unix socket.");
  return {
    home,
    socket,
    concurrency,
    runtimeRoot: path2.resolve(env.ZCODE_SUBAGENTS_RUNTIME_ROOT || path2.join(os2.homedir(), ".zcode/server"))
  };
}
var newId = () => randomUUID();
async function privateDir(dir) {
  await fs2.mkdir(dir, { recursive: true, mode: 448 });
  await fs2.chmod(dir, 448);
}
async function atomicJson(file, value) {
  await privateDir(path2.dirname(file));
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await fs2.writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 384 });
    await fs2.rename(temp, file);
  } finally {
    await fs2.rm(temp, { force: true });
  }
}
async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return void 0;
  try {
    const raw = await fs2.readFile("/proc/" + pid + "/stat", "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return void 0;
    return fields[19];
  } catch {
    return void 0;
  }
}

// src/host.mjs
var DENIED_TOOLS = ["Bash", "Agent", "CreateWorkflow", "AmendWorkflow", "OffPeakCreate"];
var allowedTools = (kind) => [
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoRead",
  "TodoWrite",
  ...kind === "edit" ? ["Edit", "Write"] : []
];
var CLIENT_ID = "zcode-subagents";
async function modelView(rpc, selection) {
  const view = await rpc.call("model-selection", "getView", selection ? [{ selection }] : []);
  return {
    defaultModel: view.preferredSelection,
    effectiveModel: view.effectiveSelection,
    selectionIssue: view.selectionIssue,
    models: view.providers.flatMap((provider) => provider.models.filter((model) => model.config.enabled !== false).map((model) => ({
      providerId: provider.providerId,
      providerName: provider.providerName,
      modelId: model.modelId,
      reasoningLevels: model.config.optionSpecs?.reasoningLevel?.values || []
    })))
  };
}
async function resolveModel(rpc, selection) {
  const view = await modelView(rpc);
  const chosen = structuredClone(selection && selection !== "default" ? selection : view.defaultModel);
  if (!chosen) throw new Error("ZCode has no default model. Select one in ZCode Desktop or pass model explicitly.");
  const model = view.models.find((m) => m.providerId === chosen.providerId && m.modelId === chosen.modelId);
  if (!model) throw new Error("Requested model is unavailable: " + chosen.providerId + "/" + chosen.modelId);
  if (!chosen.options?.reasoningLevel && model.reasoningLevels.length) {
    chosen.options = { reasoningLevel: model.reasoningLevels.at(-1) };
  }
  const checked = await modelView(rpc, chosen);
  if (checked.selectionIssue || !checked.effectiveModel) throw new Error("Invalid model selection: " + (checked.selectionIssue || "unavailable"));
  return checked.effectiveModel;
}
async function startHost(config = settings()) {
  process.umask(63);
  if (process.env.ZCODE_SUBAGENTS_HOST_LOCKED !== "1") throw new Error("Launch the Host through the plugin client.");
  await privateDir(config.home);
  const runtime = await desktopRuntime(config);
  const stderr = createWriteStream(path3.join(config.home, "app-server.stderr.log"), { flags: "a", mode: 384 });
  const rpc = new HostRpc(runtime, (chunk) => stderr.write(chunk));
  const hello = await rpc.ready;
  const v4 = await rpc.call("zcode-agent", "helloConversationV4");
  if (v4.protocolVersion !== 3) throw new Error("Unsupported ZCode V4 wire version: " + v4.protocolVersion);
  await rpc.call("zcode-agent", "initializeConversationV4", [{
    kind: "clientHello",
    protocolVersion: 3,
    clientId: CLIENT_ID,
    appVersion: hello.version
  }]);
  const instance = newId();
  const health = {
    protocol: 2,
    instance,
    pid: process.pid,
    identity: await processIdentity(process.pid),
    hostPid: rpc.child.pid,
    hostIdentity: await processIdentity(rpc.child.pid),
    desktopVersion: hello.version,
    runtimeRoot: runtime.root
  };
  const agent = (method, params) => rpc.call("zcode-agent", method, [params]);
  const command = async (params, type, payload, commandId) => {
    const ack = await agent("sendConversationCommandV4", {
      workspacePath: params.workspacePath,
      envelope: {
        commandId,
        clientId: CLIENT_ID,
        sessionId: params.sessionId,
        type,
        payload,
        issuedAt: Date.now()
      }
    });
    if (!["accepted", "duplicate", "noop"].includes(ack.status)) throw new Error(`${type} ${ack.status}: ${ack.message || ack.reasonCode}`);
    return ack;
  };
  const socket = path3.join(config.home, "host.sock");
  await fs3.rm(socket, { force: true });
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.end(JSON.stringify(health));
        return;
      }
      if (req.method !== "POST" || req.url !== "/rpc") throw new Error("Unknown Host adapter endpoint");
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024 * 1024) throw new Error("Host request too large");
      }
      const { method, params: p = {} } = JSON.parse(body);
      if (p.instance && p.instance !== instance) throw new Error("App-server instance changed; existing task outcome requires review.");
      let result;
      const target = { workspacePath: p.workspacePath, sessionId: p.sessionId };
      switch (method) {
        case "models":
          result = await modelView(rpc);
          break;
        case "resolveModel":
          result = await resolveModel(rpc, p.model);
          break;
        case "create":
          result = await agent("createSession", {
            workspacePath: p.workspacePath,
            mode: p.kind === "analysis" ? "plan" : "edit",
            persistence: "deferred",
            titleGenerationEnabled: false,
            mcpServers: [],
            toolAllowlist: allowedTools(p.kind),
            toolDenylist: DENIED_TOOLS
          });
          break;
        case "resume":
          result = await agent("resumeSession", { ...target, mcpServers: [], toolAllowlist: allowedTools(p.kind), toolDenylist: DENIED_TOOLS });
          break;
        case "snapshot": {
          const identity = await agent("getWorkspaceRuntimeIdentity", { workspacePath: p.workspacePath });
          if (!identity || p.runtimeIdentity && identity.identity !== p.runtimeIdentity.identity) throw new Error("Workspace app-server changed; task will not be replayed.");
          result = await readConversation(rpc, target);
          if (p.commandId && !runningConversation(result)) {
            let pages = 0;
            while (!result.rows.window.some((r) => r.kind === "turnHeader" && r.sourceCommandId === p.commandId)) {
              const beforeRowId = result.rows.window[0]?.rowId;
              if (!beforeRowId || beforeRowId === result.rows.firstRowId) break;
              if (++pages > 50) throw new Error("Turn exceeds the 10,000-row result limit; inspect it in ZCode.");
              const page = await agent("conversationRowsRangeV4", { ...target, beforeRowId, limit: 200 });
              if (!page.rows.length || page.rows[0].rowId >= beforeRowId) throw new Error("Conversation row cursor did not advance");
              result.rows.window.unshift(...page.rows);
            }
          }
          break;
        }
        case "identity":
          result = await agent("getWorkspaceRuntimeIdentity", { workspacePath: p.workspacePath });
          break;
        case "send":
          result = await command(p, "sendText", {
            text: p.prompt,
            modelSelection: p.model,
            mode: p.kind === "analysis" ? "plan" : "edit",
            planEnabled: p.kind === "analysis",
            requestedDelivery: "startNow",
            toolDisallowlist: DENIED_TOOLS
          }, p.commandId);
          break;
        case "stop":
          result = await command(p, "stop", {}, p.commandId || newId());
          break;
        case "close":
          result = await agent("closeSession", target);
          break;
        default:
          throw new Error("Unknown Host adapter method");
      }
      res.end(JSON.stringify({ result }));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  await fs3.chmod(socket, 384);
  await atomicJson(path3.join(config.home, "host-owner.json"), health);
  console.error(JSON.stringify({ event: "host.ready", ...health }));
  let closing = false;
  const close = async (reason) => {
    if (closing) return;
    closing = true;
    console.error(JSON.stringify({ event: "host.closed", instance, reason }));
    server.close();
    server.closeAllConnections();
    rpc.close();
    await fs3.rm(socket, { force: true });
    stderr.end();
  };
  rpc.once("closed", (error) => {
    void close(error.message);
  });
  process.once("SIGTERM", () => {
    void close("adapter received SIGTERM");
  });
  process.once("SIGINT", () => {
    void close("adapter received SIGINT");
  });
  return { health, close };
}
if (process.argv[1] && path3.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startHost().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
export {
  DENIED_TOOLS,
  allowedTools,
  modelView,
  resolveModel,
  startHost
};
