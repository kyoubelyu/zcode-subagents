export class OutputParser {
  constructor() {
    this.buffer = '';
    this.summary = undefined;
    this.sessionId = undefined;
    this.eventCount = 0;
    this.lastEvent = undefined;
  }
  accept(data) {
    this.buffer += data;
    if (this.buffer.length > 4 * 1024 * 1024) throw new Error('ZCode emitted an oversized output frame.');
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.line(line);
    }
  }
  line(line) {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== 'object') return;
    this.eventCount += 1;
    this.lastEvent = event.type || event.event?.type || event.method || 'json';
    const id = event.sessionId || event.event?.sessionId || event.data?.sessionId || event.params?.sessionId;
    if (typeof id === 'string') this.sessionId = id;
    if (event.type === 'result' && typeof event.response === 'string') this.summary = event;
  }
  finish() {
    this.line(this.buffer);
    this.sessionId ||= this.summary?.sessionId;
    this.buffer = '';
  }
}
