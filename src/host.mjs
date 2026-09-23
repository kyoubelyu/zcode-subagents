import http from 'node:http';
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostRpc } from './host-rpc.mjs';
import { desktopRuntime } from './desktop-runtime.mjs';
import { readConversation, runningConversation } from './conversation.mjs';
import { settings, privateDir, atomicJson, newId, processIdentity } from './common.mjs';

export const DENIED_TOOLS = ['Bash', 'Agent', 'CreateWorkflow', 'AmendWorkflow', 'OffPeakCreate'];
export const allowedTools = (kind) => ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoRead', 'TodoWrite',
  ...(kind === 'edit' ? ['Edit', 'Write'] : [])];
const CLIENT_ID = 'zcode-subagents';
export async function modelView(rpc, selection) {
  const view = await rpc.call('model-selection', 'getView', selection ? [{ selection }] : []);
  return { defaultModel: view.preferredSelection, effectiveModel: view.effectiveSelection,
    selectionIssue: view.selectionIssue, models: view.providers.flatMap((provider) =>
      provider.models.filter((model) => model.config.enabled !== false).map((model) => ({
        providerId: provider.providerId, providerName: provider.providerName, modelId: model.modelId,
        reasoningLevels: model.config.optionSpecs?.reasoningLevel?.values || [],
      }))) };
}
export async function resolveModel(rpc, selection) {
  const view = await modelView(rpc);
  const chosen = structuredClone(selection && selection !== 'default' ? selection : view.defaultModel);
  if (!chosen) throw new Error('ZCode has no default model. Select one in ZCode Desktop or pass model explicitly.');
  const model = view.models.find((m) => m.providerId === chosen.providerId && m.modelId === chosen.modelId);
  if (!model) throw new Error('Requested model is unavailable: ' + chosen.providerId + '/' + chosen.modelId);
  if (!chosen.options?.reasoningLevel && model.reasoningLevels.length) {
    chosen.options = { reasoningLevel: model.reasoningLevels.at(-1) };
  }
  const checked = await modelView(rpc, chosen);
  if (checked.selectionIssue || !checked.effectiveModel) throw new Error('Invalid model selection: ' + (checked.selectionIssue || 'unavailable'));
  return checked.effectiveModel;
}

export async function startHost(config = settings()) {
  process.umask(0o077);
  if (process.env.ZCODE_SUBAGENTS_HOST_LOCKED !== '1') throw new Error('Launch the Host through the plugin client.');
  await privateDir(config.home);
  const runtime = await desktopRuntime(config);
  const stderr = createWriteStream(path.join(config.home, 'app-server.stderr.log'), { flags: 'a', mode: 0o600 });
  const rpc = new HostRpc(runtime, (chunk) => stderr.write(chunk));
  const hello = await rpc.ready;
  const v4 = await rpc.call('zcode-agent', 'helloConversationV4');
  if (v4.protocolVersion !== 3) throw new Error('Unsupported ZCode V4 wire version: ' + v4.protocolVersion);
  await rpc.call('zcode-agent', 'initializeConversationV4', [{ kind: 'clientHello', protocolVersion: 3,
    clientId: CLIENT_ID, appVersion: hello.version }]);
  const instance = newId();
  const health = { protocol: 2, instance, pid: process.pid, identity: await processIdentity(process.pid),
    hostPid: rpc.child.pid, hostIdentity: await processIdentity(rpc.child.pid),
    desktopVersion: hello.version, runtimeRoot: runtime.root, capabilities: { workspaceRelease: true } };
  const agent = (method, params) => rpc.call('zcode-agent', method, [params]);
  const command = async (params, type, payload, commandId) => {
    const ack = await agent('sendConversationCommandV4', { workspacePath: params.workspacePath,
      envelope: { commandId, clientId: CLIENT_ID, sessionId: params.sessionId,
        type, payload, issuedAt: Date.now() } });
    if (!['accepted', 'duplicate', 'noop'].includes(ack.status)) throw new Error(`${type} ${ack.status}: ${ack.message || ack.reasonCode}`);
    return ack;
  };
  const socket = path.join(config.home, 'host.sock');
  await fs.rm(socket, { force: true });
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    try {
      if (req.method === 'GET' && req.url === '/health') { res.end(JSON.stringify(health)); return; }
      if (req.method !== 'POST' || req.url !== '/rpc') throw new Error('Unknown Host adapter endpoint');
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1024 * 1024) throw new Error('Host request too large'); }
      const { method, params: p = {} } = JSON.parse(body);
      if (p.instance && p.instance !== instance) throw new Error('App-server instance changed; existing task outcome requires review.');
      let result;
      const target = { workspacePath: p.workspacePath, sessionId: p.sessionId };
      switch (method) {
        case 'models': result = await modelView(rpc); break;
        case 'resolveModel': result = await resolveModel(rpc, p.model); break;
        case 'create': result = await agent('createSession', { workspacePath: p.workspacePath,
          mode: p.kind === 'analysis' ? 'plan' : 'edit', persistence: 'deferred', titleGenerationEnabled: false,
          mcpServers: [], toolAllowlist: allowedTools(p.kind), toolDenylist: DENIED_TOOLS }); break;
        case 'resume': result = await agent('resumeSession', { ...target, mcpServers: [], toolAllowlist: allowedTools(p.kind), toolDenylist: DENIED_TOOLS }); break;
        case 'snapshot': {
          const identity = await agent('getWorkspaceRuntimeIdentity', { workspacePath: p.workspacePath });
          if (!identity || (p.runtimeIdentity && identity.identity !== p.runtimeIdentity.identity)) throw new Error('Workspace app-server changed; task will not be replayed.');
          result = await readConversation(rpc, target);
          // A long turn's header can fall outside the snapshot's tail window.
          if (p.commandId && !runningConversation(result)) {
            let pages = 0;
            while (!result.rows.window.some((r) => r.kind === 'turnHeader' && r.sourceCommandId === p.commandId)) {
              const beforeRowId = result.rows.window[0]?.rowId;
              if (!beforeRowId || beforeRowId === result.rows.firstRowId) break;
              if (++pages > 50) throw new Error('Turn exceeds the 10,000-row result limit; inspect it in ZCode.');
              const page = await agent('conversationRowsRangeV4', { ...target, beforeRowId, limit: 200 });
              if (!page.rows.length || page.rows[0].rowId >= beforeRowId) throw new Error('Conversation row cursor did not advance');
              result.rows.window.unshift(...page.rows);
            }
          }
          break;
        }
        case 'identity': result = await agent('getWorkspaceRuntimeIdentity', { workspacePath: p.workspacePath }); break;
        case 'releaseWorkspace': {
          // Identity is a read-only API: never start a process just to clean it up.
          let identity;
          try { identity = await agent('getWorkspaceRuntimeIdentity', { workspacePath: p.workspacePath }); }
          catch (error) {
            if (!/runtime identity is unavailable/i.test(error.message)) throw error;
            result = { released: true, reason: 'already-absent' }; break;
          }
          if (p.identities?.length && !p.identities.includes(identity.identity)) {
            result = { released: false, reason: 'runtime-changed' }; break;
          }
          await agent('disposeWorkspace', { workspacePath: p.workspacePath });
          result = { released: true, reason: 'idle-workspace', runtimeIdentity: identity }; break;
        }
        case 'send': result = await command(p, 'sendText', { text: p.prompt, modelSelection: p.model,
          mode: p.kind === 'analysis' ? 'plan' : 'edit', planEnabled: p.kind === 'analysis',
          requestedDelivery: 'startNow', toolDisallowlist: DENIED_TOOLS }, p.commandId); break;
        case 'stop': {
          // The legacy stop path can start a workspace. Do not resurrect a
          // manually closed/crashed runtime just to stop its old session.
          let identity;
          try { identity = await agent('getWorkspaceRuntimeIdentity', { workspacePath: p.workspacePath }); }
          catch (error) {
            if (!/runtime identity is unavailable/i.test(error.message)) throw error;
            result = { runtimeEnded: true }; break;
          }
          if (p.runtimeIdentity && p.runtimeIdentity.identity !== identity.identity) {
            result = { runtimeEnded: true }; break;
          }
          result = await command(p, 'stop', {}, p.commandId || newId()); break;
        }
        case 'close': result = await agent('closeSession', target); break;
        default: throw new Error('Unknown Host adapter method');
      }
      res.end(JSON.stringify({ result }));
    } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await fs.chmod(socket, 0o600);
  await atomicJson(path.join(config.home, 'host-owner.json'), health);
  console.error(JSON.stringify({ event: 'host.ready', ...health }));
  let closing = false;
  const close = async (reason) => {
    if (closing) return; closing = true;
    console.error(JSON.stringify({ event: 'host.closed', instance, reason }));
    server.close(); server.closeAllConnections(); rpc.close();
    await fs.rm(socket, { force: true });
    stderr.end();
  };
  rpc.once('closed', (error) => { void close(error.message); });
  process.once('SIGTERM', () => { void close('adapter received SIGTERM'); });
  process.once('SIGINT', () => { void close('adapter received SIGINT'); });
  return { health, close };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startHost().catch((error) => { console.error(error.message); process.exit(1); });
}
