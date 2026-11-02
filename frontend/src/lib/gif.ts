/**
 * Tiny dependency-free animated GIF89a encoder.
 * Per-frame 256-colour palette by median cut on sampled pixels, nearest-colour lookup cached on 15-bit RGB, LZW.
 */
export interface GifFrame { data: Uint8ClampedArray; delayCs: number }

function medianCut(px: Uint8ClampedArray, maxColors = 256): Uint8Array {
  const step = Math.max(1, Math.floor(px.length / 4 / 40000));
  const pts: number[][] = [];
  for (let i = 0; i < px.length; i += 4 * step) pts.push([px[i]!, px[i + 1]!, px[i + 2]!]);
  let boxes: number[][][] = [pts];
  while (boxes.length < maxColors) {
    let bi = -1, bestRange = 0, bestCh = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const p of b) { const v = p[c]!; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (hi - lo > bestRange) { bestRange = hi - lo; bi = i; bestCh = c; }
      }
    });
    if (bi < 0 || bestRange === 0) break;
    const b = boxes[bi]!.sort((x, y) => x[bestCh]! - y[bestCh]!);
    const mid = b.length >> 1;
    boxes.splice(bi, 1, b.slice(0, mid), b.slice(mid));
  }
  const pal = new Uint8Array(maxColors * 3);
  boxes.forEach((b, i) => {
    let r = 0, g = 0, bl = 0;
    for (const p of b) { r += p[0]!; g += p[1]!; bl += p[2]!; }
    const n = b.length || 1;
    pal[i * 3] = r / n; pal[i * 3 + 1] = g / n; pal[i * 3 + 2] = bl / n;
  });
  return pal;
}

function indexPixels(px: Uint8ClampedArray, pal: Uint8Array): Uint8Array {
  const n = pal.length / 3, out = new Uint8Array(px.length / 4), cache = new Int16Array(32768).fill(-1);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const r = px[i]!, g = px[i + 1]!, b = px[i + 2]!, key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let c = cache[key]!;
    if (c < 0) {
      let best = 1e9;
      for (let k = 0; k < n; k++) {
        const dr = r - pal[k * 3]!, dg = g - pal[k * 3 + 1]!, db = b - pal[k * 3 + 2]!, d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
        if (d < best) { best = d; c = k; }
      }
      cache[key] = c;
    }
    out[j] = c;
  }
  return out;
}

function lzw(indices: Uint8Array, minCode = 8): number[] {
  const clear = 1 << minCode, eoi = clear + 1, out: number[] = [];
  let size = minCode + 1, next = eoi + 1, cur = 0, bits = 0;
  const emit = (code: number): void => { cur |= code << bits; bits += size; while (bits >= 8) { out.push(cur & 255); cur >>= 8; bits -= 8; } };
  let dict = new Map<number, number>();
  emit(clear);
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!, key = (prefix << 8) | k, hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) { dict.set(key, next++); if (next > 1 << size && size < 12) size++; }
    else { emit(clear); dict = new Map(); size = minCode + 1; next = eoi + 1; }
    prefix = k;
  }
  emit(prefix); emit(eoi);
  if (bits > 0) out.push(cur & 255);
  return out;
}

export function encodeGif(width: number, height: number, frames: readonly GifFrame[]): Uint8Array {
  const b: number[] = [];
  const u16 = (v: number): void => { b.push(v & 255, (v >> 8) & 255); };
  for (const c of 'GIF89a') b.push(c.charCodeAt(0));
  u16(width); u16(height); b.push(0x00, 0, 0); // no global palette
  b.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0); // loop forever
  for (const f of frames) {
    const pal = medianCut(f.data), idx = indexPixels(f.data, pal);
    b.push(0x21, 0xf9, 4, 0x04); u16(Math.max(2, Math.round(f.delayCs))); b.push(0, 0);
    b.push(0x2c); u16(0); u16(0); u16(width); u16(height); b.push(0x87); // local palette, 256 entries
    for (const v of pal) b.push(v);
    b.push(8);
    const data = lzw(idx);
    for (let i = 0; i < data.length; i += 255) { const n = Math.min(255, data.length - i); b.push(n); for (let k = 0; k < n; k++) b.push(data[i + k]!); }
    b.push(0);
  }
  b.push(0x3b);
  return new Uint8Array(b);
}
