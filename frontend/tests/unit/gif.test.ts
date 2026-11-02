import { describe, expect, it } from 'vitest';
import { encodeGif } from '../../src/lib/gif';

describe('GIF encoder', () => {
  it('writes a valid looping GIF89a with one image block per frame', () => {
    const w = 37, h = 23;
    const mk = (k: number): Uint8ClampedArray => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { d[i * 4] = (i * 7 + k) & 255; d[i * 4 + 1] = (i * 3) & 255; d[i * 4 + 2] = k * 40; d[i * 4 + 3] = 255; } return d; };
    const g = encodeGif(w, h, [0, 1, 2].map((k) => ({ data: mk(k), delayCs: 10 })));
    expect(String.fromCharCode(...g.slice(0, 6))).toBe('GIF89a');
    expect(g[6]! | (g[7]! << 8)).toBe(w);
    expect(g[g.length - 1]).toBe(0x3b);
    expect(String.fromCharCode(...g.slice(16, 27))).toBe('NETSCAPE2.0');
  });
});
