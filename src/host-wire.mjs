// ZCode Host channel framing. Protocol reference: zai-org/ZCode, commit
// 872ad960, packages/rpc/src/{protocol,serialization,channels.shared}.ts.
// This is a bounded client implementation, not a copy of the server runtime.
export const MAX_FRAME = 16 * 1024 * 1024;
function integer(value) {
  const out = [];
  do { const byte = value & 127; value >>>= 7; out.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(out);
}
export function encode(value) {
  if (value === undefined) return Buffer.from([0]);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from([4]), integer(value.length), ...value.map(encode)]);
  if (Number.isInteger(value) && value >= 0 && value <= 0x7fffffff) return Buffer.concat([Buffer.from([6]), integer(value)]);
  const kind = typeof value === 'string' ? 1 : 5;
  const bytes = Buffer.from(kind === 1 ? value : JSON.stringify(value));
  return Buffer.concat([Buffer.from([kind]), integer(bytes.length), bytes]);
}
export function decodePair(buffer) {
  let offset = 0;
  const take = (n) => {
    if (n < 0 || offset + n > buffer.length) throw new Error('Truncated Host channel value');
    const out = buffer.subarray(offset, offset + n); offset += n; return out;
  };
  const number = () => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = take(1)[0]; value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw new Error('Invalid Host integer');
  };
  const read = (depth = 0) => {
    if (depth > 32) throw new Error('Host value nesting limit exceeded');
    const type = take(1)[0];
    if (type === 0) return undefined;
    if (type === 6) return number();
    const length = number();
    if (length > MAX_FRAME) throw new Error('Host value too large');
    if (type === 4) {
      if (length > buffer.length - offset) throw new Error('Invalid Host array length');
      return Array.from({ length }, () => read(depth + 1));
    }
    const raw = take(length);
    if (type === 1) return raw.toString('utf8');
    if (type === 5) return JSON.parse(raw.toString('utf8'));
    if (type === 2 || type === 3) return raw;
    throw new Error('Unknown Host value type ' + type);
  };
  const pair = [read(), read()];
  if (offset !== buffer.length) throw new Error('Trailing Host channel data');
  return pair;
}
export function frame(header, body) {
  const data = Buffer.concat([encode(header), encode(body)]);
  if (data.length > MAX_FRAME) throw new Error('Host request too large');
  const head = Buffer.alloc(13); head[0] = 1; head.writeUInt32BE(data.length, 9);
  return Buffer.concat([head, data]);
}
export class Frames {
  buffer = Buffer.alloc(0);
  accept(chunk, callback) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 13) {
      const length = this.buffer.readUInt32BE(9);
      if (length > MAX_FRAME) throw new Error('Host frame too large');
      if (this.buffer.length < 13 + length) break;
      const type = this.buffer[0], data = this.buffer.subarray(13, 13 + length);
      this.buffer = this.buffer.subarray(13 + length);
      if (type === 1) callback(...decodePair(data));
    }
  }
}
