// Fake installed Desktop Host; never invokes a model or the ZCode CLI.
(async () => {
  const { Frames, frame } = await import('../src/host-wire.mjs');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const sessions = new Map();
  const listeners = new Map();
  const defaultModel = { providerId: 'fixture', modelId: 'default', options: { reasoningLevel: 'high' } };
  const models = ['default', 'explicit'];
  const write = (header, body) => process.stdout.write(frame(header, body));
  let hello = false, buffer = Buffer.alloc(0);
  const frames = new Frames();
  const snapshot = (s) => ({ session: { sessionId: s.id }, settings: { model: { current: s.model } },
    runtime: { eventSeq: s.events.length, pendingRequestIds: [] },
    projection: { status: s.status, pendingPermissions: [] }, messages: [] });
  const complete = (s, inputId, resultType = 'success') => {
    s.status = 'completed';
    s.events.push({ type: 'turn.completed', seq: s.events.length + 1, sessionId: s.id,
      payload: { inputId, resultType, response: 'FIXTURE_OK', usage: { inputTokens: 5, outputTokens: 2 } } });
  };
  const conversation = (s) => ({ protocolVersion: 1, sessionId: s.id, seq: s.events.length + 1,
    control: { phase: s.status === 'running' ? 'running' : s.status === 'error' ? 'error' : s.inputId ? 'completedSuccess' : 'draft', canStop: s.status === 'running',
      lastError: s.status === 'error' ? { message: 'Fixture turn failed' } : null },
    config: { modelSelection: s.model }, pendingInteractions: [], usage: { cumulative: { inputTokens: 5, outputTokens: 2 } },
    rows: { window: s.inputId ? [{ kind: 'turnHeader', sourceCommandId: s.inputId, turnId: s.inputId,
      state: s.status === 'running' ? 'running' : s.status === 'error' ? 'failed' : s.events.at(-1)?.payload.resultType === 'cancelled' ? 'completedInterrupted' : 'completedSuccess' },
    { kind: 'assistantText', turnId: s.inputId, text: 'FIXTURE_OK' }] : [] } });
  const call = async (channel, name, args = []) => {
    const p = args[0] || {};
    if (channel === 'model-selection') {
      const view = { preferredSelection: defaultModel, providers: [{ providerId: 'fixture', providerName: 'Fixture',
        models: models.map((modelId) => ({ modelId, config: { enabled: true, optionSpecs: { reasoningLevel: { values: ['low', 'high'] } } } })) }] };
      if (p.selection) {
        if (p.selection.providerId !== 'fixture' || !models.includes(p.selection.modelId)) view.selectionIssue = 'model-not-found';
        else if (!['low', 'high'].includes(p.selection.options?.reasoningLevel)) view.selectionIssue = 'reasoning-level-not-supported';
        else view.effectiveSelection = p.selection;
      }
      return view;
    }
    if (name === 'helloConversationV4') return { protocolVersion: 3 };
    if (name === 'initializeConversationV4') return;
    if (name === 'getWorkspaceRuntimeIdentity') return { identity: p.workspacePath, generation: 1, processId: process.pid };
    if (name === 'unsubscribeConversationV4') return;
    if (name === 'createSession') {
      const s = { id: 'sess_' + crypto.randomUUID(), model: defaultModel, status: 'idle', events: [], target: p };
      sessions.set(s.id, s); return snapshot(s);
    }
    const s = sessions.get(p.sessionId || p.envelope?.sessionId);
    if (!s) throw new Error('Session unavailable');
    if (name === 'resumeSession' || name === 'readSession') return snapshot(s);
    if (name === 'readSessionEvents') return s.events.filter((e) => e.seq > (p.afterSeq || 0));
    if (name === 'subscribeConversationV4') {
      const subscriptionId = crypto.randomUUID(), topic = 'conversation/' + s.id;
      const state = conversation(s);
      const wire = { wireVersion: 3, kind: 'complete', deliveryKind: 'initial', topic, subscriptionId,
        frame: { topic, subscriptionId, toSeq: state.seq, payload: { kind: 'snapshot', snapshot: state } } };
      for (const [id, target] of listeners) if (target.workspacePath === p.workspacePath) write([204, id], wire);
      return { ack: { subscriptionId } };
    }
    if (name === 'closeSession') { clearTimeout(s.timer); sessions.delete(s.id); return true; }
    if (name === 'sendConversationCommandV4') {
      const e = p.envelope;
      if (e.type === 'stop') { clearTimeout(s.timer); complete(s, s.inputId, 'cancelled'); return { status: 'accepted' }; }
      s.status = 'running'; s.inputId = e.commandId; s.model = e.payload.modelSelection;
      const text = e.payload.text;
      if (text.includes('[fixture:args]')) await fs.writeFile(path.join(p.workspacePath, 'arguments.json'), JSON.stringify({ create: s.target, envelope: e }));
      if (text.includes('[fixture:crash]')) { setTimeout(() => process.exit(7), 100); return { status: 'accepted' }; }
      if (text.includes('[fixture:fail]')) {
        s.events.push({ type: 'turn.failed', seq: 1, payload: { inputId: e.commandId, error: { message: 'Fixture turn failed' } } });
        s.status = 'error'; return { status: 'accepted' };
      }
      const duration = Number(text.match(/\[fixture:sleep=(\d+)\]/)?.[1] || 100);
      s.timer = setTimeout(async () => {
        if (text.includes('[fixture:edit]')) {
          await fs.writeFile(path.join(p.workspacePath, 'tracked.txt'), 'edited by fixture\n');
          await fs.writeFile(path.join(p.workspacePath, 'new.txt'), 'new file\n');
        }
        complete(s, e.commandId);
      }, duration);
      return { status: 'accepted', result: { inputId: e.commandId } };
    }
    throw new Error('Unknown fixture method: ' + name);
  };
  process.stdout.write(JSON.stringify({ type: 'zcode-hello', version: 'fixture-3.14.3', pid: process.pid }) + '\n');
  process.stdin.on('data', (chunk) => {
    if (!hello) {
      buffer = Buffer.concat([buffer, chunk]); const end = buffer.indexOf(10); if (end < 0) return;
      JSON.parse(buffer.subarray(0, end).toString()); hello = true; chunk = buffer.subarray(end + 1); write([200], undefined);
    }
    frames.accept(chunk, (header, body) => {
      if (header[0] === 102) { listeners.set(header[1], body); return; }
      if (header[0] === 103) { listeners.delete(header[1]); return; }
      if (header[0] !== 100) return;
      call(header[2], header[3], body).then((v) => write([201, header[1]], v), (error) => write([202, header[1]], { message: error.message }));
    });
  });
  process.stdin.on('end', () => process.exit(0));
})();
