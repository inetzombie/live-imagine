/**
 * Procedural "painting" for the SimulatedProvider (browser port of backend/app/providers/simulated.py).
 * Deterministic from (prompt, seed). Works on any 2D context (main thread or OffscreenCanvas).
 */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const seedFor = (prompt: string, seed: number | null): number => (seed ?? hashString(prompt)) >>> 0;

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const hsl = (h: number, s: number, l: number, a = 1): string => `hsla(${((h % 360) + 360) % 360},${s}%,${l}%,${a})`;

export function paintProcedural(ctx: Ctx2D, w: number, h: number, prompt: string, seed: number): void {
  const rnd = mulberry32(hashString(`${prompt}|${seed}`));
  const hue = rnd() * 360;
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, hsl(hue + 200, 55, 12));
  sky.addColorStop(0.55, hsl(hue + 250, 50, 30));
  sky.addColorStop(1, hsl(hue + 20, 75, 62));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // stars
  ctx.fillStyle = hsl(hue, 30, 92, 0.8);
  for (let i = 0; i < 120; i++) { const r = rnd() * 1.4 * (w / 512); ctx.fillRect(rnd() * w, rnd() * h * 0.5, r, r); }

  // glowing orbs
  const orbs = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < orbs; i++) {
    const cx = (0.15 + rnd() * 0.7) * w, cy = (0.12 + rnd() * 0.35) * h, r = (0.04 + rnd() * 0.1) * Math.min(w, h);
    const oh = hue + 10 + rnd() * 40;
    const g = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 3.2);
    g.addColorStop(0, hsl(oh, 90, 75, 0.55));
    g.addColorStop(1, hsl(oh, 90, 60, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = hsl(oh, 85, 88);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  }

  // layered ridges, far → near
  const layers = 3 + Math.floor(rnd() * 3);
  for (let i = 0; i < layers; i++) {
    const depth = (i + 1) / layers;
    const base = (0.45 + 0.45 * depth) * h;
    const f1 = 2 + rnd() * 4, f2 = 8 + rnd() * 12, p1 = rnd() * 6.28, p2 = rnd() * 6.28;
    const amp = 0.12 * h * (1 - depth * 0.5);
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += Math.max(1, w / 256)) {
      const u = x / w;
      ctx.lineTo(x, base - amp * (Math.sin(u * f1 * Math.PI + p1) * 0.6 + Math.sin(u * f2 * Math.PI + p2) * 0.25 + 0.3));
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    const lg = ctx.createLinearGradient(0, base - amp, 0, h);
    const lh = hue + 180 + (rnd() - 0.5) * 30;
    lg.addColorStop(0, hsl(lh, 40, 8 + 38 * (1 - depth)));
    lg.addColorStop(1, hsl(lh, 40, 4 + 20 * (1 - depth)));
    ctx.fillStyle = lg;
    ctx.fill();
    // windows / lights on near layers for "detail"
    if (depth > 0.5) {
      ctx.fillStyle = hsl(hue + 30, 95, 70, 0.9);
      for (let k = 0; k < 40 * depth; k++) {
        const x = rnd() * w, y = base + rnd() * (h - base) * 0.8;
        ctx.fillRect(x, y, Math.max(1, w / 400), Math.max(1, w / 400));
      }
    }
  }
}
