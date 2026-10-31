import { describe, expect, it, vi } from 'vitest';
import { FrameBuffer } from '../../src/lib/frames';
import { HISTORY_MAX, loadHistory, saveHistory, type HistoryItem } from '../../src/lib/history';
import { hashString, mulberry32, seedFor } from '../../src/lib/procedural';

const fakeBitmap = () => ({ close: vi.fn(), width: 1, height: 1 }) as unknown as ImageBitmap;

describe('FrameBuffer', () => {
  it('caps at capacity and closes evicted bitmaps', () => {
    const fb = new FrameBuffer(3);
    const bmps = Array.from({ length: 5 }, fakeBitmap);
    bmps.forEach((b, i) => fb.push({ bitmap: b, step: i + 1, total: 5, elapsedMs: i }));
    expect(fb.length).toBe(3);
    expect(fb.at(0)?.step).toBe(3);
    expect(bmps[0]?.close).toHaveBeenCalled();
    expect(bmps[1]?.close).toHaveBeenCalled();
    expect(bmps[4]?.close).not.toHaveBeenCalled();
    fb.clear();
    expect(fb.length).toBe(0);
    expect(bmps[4]?.close).toHaveBeenCalled();
  });
});

describe('history', () => {
  it('caps entries and survives quota errors', () => {
    localStorage.clear();
    const item = (i: number): HistoryItem => ({ id: String(i), created: i, seed: i, model: 'm', thumb: '', frames: 1,
      params: { prompt: 'p', negative_prompt: '', width: 8, height: 8, steps: 1, guidance: 0, seed: i, preview_every: 1, provider: 'simulated' } });
    for (let i = 0; i < HISTORY_MAX + 5; i++) saveHistory(item(i));
    expect(loadHistory()).toHaveLength(HISTORY_MAX);
    expect(loadHistory()[0]?.id).toBe(String(HISTORY_MAX + 4));
    let calls = 0;
    const tiny = { getItem: () => JSON.stringify([item(2), item(3)]), removeItem: () => undefined, setItem: () => { if (++calls < 3) throw new Error('quota'); } } as unknown as Storage;
    expect(saveHistory(item(1), tiny).length).toBe(1);
  });
});

describe('procedural seeding', () => {
  it('is deterministic', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(seedFor('abc', null)).toBe(hashString('abc'));
    expect(seedFor('abc', 7)).toBe(7);
    const a = mulberry32(1), b = mulberry32(1);
    expect([a(), a()]).toEqual([b(), b()]);
  });
});
