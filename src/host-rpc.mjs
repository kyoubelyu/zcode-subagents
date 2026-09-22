import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { frame, Frames } from './host-wire.mjs';

export class HostRpc extends EventEmitter {
  constructor(runtime, log) {
    super();
    this.setMaxListeners(64);
    this.pending = new Map(); this.sequence = 0; this.frames = new Frames();
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
    this.child = spawn(runtime.node, [runtime.entry], {
      cwd: runtime.cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ZCODE_ENV: 'production', ZCODE_SERVICE_AUTHORITY_MODE: 'standalone-server',
        ZCODE_SERVER_RUNTIME_ROOT: runtime.root, ZCODE_SUBAGENTS_CHILD: '1' },
    });
    this.child.stderr.on('data', (chunk) => log(chunk));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Desktop Host exited (${code ?? signal})`)));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.stdout.on('error', (error) => this.fail(error));
    let helloBuffer = Buffer.alloc(0);
    this.child.stdout.on('data', (chunk) => {
      try {
        if (!this.hello) {
          helloBuffer = Buffer.concat([helloBuffer, chunk]);
          if (helloBuffer.length > 65536) throw new Error('Invalid desktop Host hello');
          const newline = helloBuffer.indexOf(10);
          if (newline < 0) return;
          this.hello = JSON.parse(helloBuffer.subarray(0, newline).toString());
          if (this.hello.type !== 'zcode-hello') throw new Error('Incompatible desktop Host handshake');
          this.child.stdin.write(JSON.stringify({ type: 'zcode-hello-ack', version: this.hello.version,
            clientId: 'zcode-subagents' }) + '\n');
          chunk = helloBuffer.subarray(newline + 1); helloBuffer = undefined;
        }
        this.frames.accept(chunk, (header, body) => {
          if (header[0] === 200) return this.resolveReady(this.hello);
          if (header[0] === 204) return this.emit('notification', header[1], body);
          const pending = this.pending.get(header[1]);
          if (!pending) return;
          this.pending.delete(header[1]); clearTimeout(pending.timer);
          if (header[0] === 201) pending.resolve(body);
          else pending.reject(Object.assign(new Error(body?.message || 'Desktop Host RPC failed'), { code: body?.code }));
        });
      } catch (error) { this.fail(error); this.child.stdin.end(); }
    });
    this.startupTimer = setTimeout(() => {
      this.fail(new Error('Desktop Host handshake timed out')); this.child.stdin.end();
    }, 20000);
    this.ready.finally(() => clearTimeout(this.startupTimer)).catch(() => {});
  }
  fail(error) {
    if (this.closed) return;
    this.closed = error; this.rejectReady(error);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.emit('closed', error);
  }
  async call(channel, method, args = [], timeout = 45000) {
    await this.ready;
    if (this.closed) throw this.closed;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Host ${method} timed out; mutation outcome may be unknown`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(frame([100, id, channel, method], args), (error) => { if (error) this.fail(error); });
    });
  }
  async listen(channel, name, args, callback) {
    await this.ready;
    const id = ++this.sequence;
    const listener = (eventId, body) => { if (eventId === id) callback(body); };
    this.on('notification', listener);
    this.child.stdin.write(frame([102, id, channel, name], args));
    return () => { this.off('notification', listener); if (!this.closed) this.child.stdin.write(frame([103, id], undefined)); };
  }
  close() { this.child.stdin.end(); }
}
