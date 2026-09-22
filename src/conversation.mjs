import { crc32 } from 'node:zlib';

// Read an authoritative V4 snapshot through an owned, short-lived subscription.
// No legacy event schema, retained delta state, or replay of commands is involved.
export class SnapshotAssembly {
  constructor(topic) { this.topic = topic; this.parts = new Map(); }
  accept(wire) {
    if (wire.topic !== this.topic || wire.deliveryKind !== 'initial') return;
    if (wire.wireVersion !== 3) throw new Error('Unsupported conversation wire version');
    let frame;
    if (wire.kind === 'complete') frame = wire.frame;
    else if (wire.kind === 'fragment') {
      const { fragmentCount: count, fragmentIndex: index, logicalBytes: size } = wire;
      if (!Number.isInteger(count) || count < 1 || count > 4096 || !Number.isInteger(index) || index < 0 || index >= count ||
        !Number.isInteger(size) || size < 1 || size > 16 * 1024 * 1024) throw new Error('Invalid conversation fragment bounds');
      let assembly = this.parts.get(wire.logicalFrameId);
      if (!assembly) {
        if (this.parts.size >= 2) throw new Error('Too many initial snapshot assemblies');
        assembly = { wire, chunks: new Map(), bytes: 0 }; this.parts.set(wire.logicalFrameId, assembly);
      }
      if (assembly.wire.fragmentCount !== count || assembly.wire.logicalBytes !== size ||
        assembly.wire.subscriptionId !== wire.subscriptionId || assembly.wire.checksum?.value !== wire.checksum?.value) throw new Error('Inconsistent conversation fragments');
      const chunk = Buffer.from(wire.dataBase64, 'base64');
      const prior = assembly.chunks.get(index);
      if (prior && !prior.equals(chunk)) throw new Error('Conflicting conversation fragment');
      if (!prior) { assembly.chunks.set(index, chunk); assembly.bytes += chunk.length; }
      if (assembly.bytes > size) throw new Error('Conversation snapshot too large');
      if (assembly.chunks.size !== count) return;
      const bytes = Buffer.concat(Array.from({ length: count }, (_, i) => assembly.chunks.get(i)));
      if (bytes.length !== size || wire.checksum?.algorithm !== 'crc32' || crc32(bytes).toString(16).padStart(8, '0') !== wire.checksum.value) throw new Error('Conversation snapshot checksum mismatch');
      frame = JSON.parse(bytes.toString()); this.parts.delete(wire.logicalFrameId);
    } else throw new Error('Unknown conversation frame kind');
    if (frame?.topic !== this.topic || frame.subscriptionId !== wire.subscriptionId || frame.payload?.kind !== 'snapshot') throw new Error('Invalid initial conversation snapshot');
    const snapshot = frame.payload.snapshot;
    if (snapshot?.protocolVersion !== 1 || !snapshot.control || !snapshot.rows?.window || snapshot.seq !== frame.toSeq) throw new Error('Invalid conversation snapshot state');
    return { subscriptionId: wire.subscriptionId, snapshot };
  }
}

export async function readConversation(rpc, target) {
  const assembly = new SnapshotAssembly('conversation/' + target.sessionId);
  let resolve, reject, ack;
  const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
  ready.catch(() => {});
  const timer = setTimeout(() => reject(new Error('V4 conversation snapshot timed out')), 15000);
  const closed = (error) => reject(error);
  rpc.once('closed', closed);
  const dispose = await rpc.listen('zcode-agent', 'onDynamicConversationFrame', { workspacePath: target.workspacePath }, (wire) => {
    try { const result = assembly.accept(wire); if (result) resolve(result); } catch (error) { reject(error); }
  });
  try {
    ({ ack } = await rpc.call('zcode-agent', 'subscribeConversationV4', [target]));
    const result = await ready;
    if (result.subscriptionId !== ack.subscriptionId) throw new Error('Conversation subscription changed');
    return result.snapshot;
  } finally {
    clearTimeout(timer); rpc.off('closed', closed); dispose();
    if (ack) await rpc.call('zcode-agent', 'unsubscribeConversationV4', [{ workspacePath: target.workspacePath,
      subscriptionId: ack.subscriptionId, runtimePolicy: 'existing-only' }]).catch(() => {});
  }
}

export const runningConversation = (snapshot) => snapshot.control.canStop || ['running', 'prewarming'].includes(snapshot.control.phase);

export function turnResult(snapshot, commandId) {
  const header = snapshot.rows.window.find((row) => row.kind === 'turnHeader' && row.sourceCommandId === commandId);
  if (!header || header.state === 'running') return;
  const response = snapshot.rows.window.filter((row) => row.kind === 'assistantText' && row.turnId === header.turnId).map((row) => row.text).join('\n\n');
  return { response, resultType: header.state, usage: snapshot.usage, error: snapshot.control.lastError };
}
