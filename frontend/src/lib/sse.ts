/** Incremental text/event-stream parser (spec-compliant subset: event, data, id, comments, CRLF). */
export interface RawSSE { event: string; data: string; id: string | null }

export class SSEParser {
  private buf = '';
  lastEventId: string | null = null;

  feed(chunk: string): RawSSE[] {
    this.buf += chunk.replace(/\r\n?/g, '\n');
    const out: RawSSE[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      let event = 'message';
      let id: string | null = null;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const c = line.indexOf(':');
        const key = c < 0 ? line : line.slice(0, c);
        let val = c < 0 ? '' : line.slice(c + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (key === 'event') event = val;
        else if (key === 'data') data.push(val);
        else if (key === 'id') id = val;
      }
      if (id !== null) this.lastEventId = id;
      if (data.length) out.push({ event, data: data.join('\n'), id });
    }
    return out;
  }
}

export function b64ToBlob(b64: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const type = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0x52 ? 'image/webp' : 'image/jpeg';
  return new Blob([bytes], { type });
}
