import { describe, expect, it } from 'vitest';
import { SSEParser, b64ToBlob } from '../../src/lib/sse';
import { parseStreamEvent, validateParams, type GenerateParams } from '../../src/shared/events';

describe('SSEParser', () => {
  it('parses events split across chunks, with ids, comments and CRLF', () => {
    const p = new SSEParser();
    expect(p.feed(': ping\r\nid: 3\r\nevent: progress\r\nda')).toEqual([]);
    const out = p.feed('ta: {"a":1}\r\n\r\ndata: x\ndata: y\n\n');
    expect(out).toEqual([{ event: 'progress', data: '{"a":1}', id: '3' }, { event: 'message', data: 'x\ny', id: null }]);
    expect(p.lastEventId).toBe('3');
  });
  it('ignores blocks without data', () => {
    expect(new SSEParser().feed('event: x\n\n')).toEqual([]);
  });
});

describe('parseStreamEvent', () => {
  it('validates progress', () => {
    const ok = parseStreamEvent('progress', JSON.stringify({ step: 1, total_steps: 2, elapsed_ms: 5, preview_b64_jpeg: 'AA', width: 8, height: 8 }));
    expect(ok?.type).toBe('progress');
    expect(parseStreamEvent('progress', JSON.stringify({ step: 'x' }))).toBeNull();
    expect(parseStreamEvent('progress', 'not json')).toBeNull();
  });
  it('normalizes errors and rejects unknown events', () => {
    expect(parseStreamEvent('error', JSON.stringify({ message: 'm', code: 'weird' }))).toEqual({ type: 'error', message: 'm', recoverable: true, code: 'upstream' });
    expect(parseStreamEvent('error', JSON.stringify({ message: 'oom', code: 'oom', recoverable: false }))).toMatchObject({ code: 'oom', recoverable: false });
    expect(parseStreamEvent('bogus', '{}')).toBeNull();
    expect(parseStreamEvent('final', JSON.stringify({ image_url: '/x.png', seed: 3 }))).toMatchObject({ type: 'final', seed: 3 });
    expect(parseStreamEvent('queue', JSON.stringify({ position: 2 }))).toEqual({ type: 'queue', position: 2 });
  });
});

describe('validateParams', () => {
  const base: GenerateParams = { prompt: 'hi', negative_prompt: '', width: 768, height: 768, steps: 30, guidance: 4, seed: 1, preview_every: 1, provider: 'simulated' };
  it('accepts sane params and rejects limits', () => {
    expect(validateParams(base)).toBeNull();
    expect(validateParams({ ...base, prompt: '  ' })).toMatch(/prompt/i);
    expect(validateParams({ ...base, steps: 61 })).toMatch(/Steps/);
    expect(validateParams({ ...base, width: 2048, height: 2048 })).toMatch(/large/);
    expect(validateParams({ ...base, width: 770 })).toMatch(/multiples/);
    expect(validateParams({ ...base, seed: -1 })).toMatch(/Seed/);
  });
});

describe('b64ToBlob', () => {
  it('sniffs png vs jpeg', () => {
    expect(b64ToBlob(btoa('\x89PNG')).type).toBe('image/png');
    expect(b64ToBlob(btoa('\xff\xd8\xff')).type).toBe('image/jpeg');
  });
});
