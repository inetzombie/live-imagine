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

export type Scene = 'mountains' | 'ocean' | 'city' | 'forest' | 'desert' | 'space';
export type Mood = 'dusk' | 'night' | 'day' | 'neon';
const has = (p: string, words: string[]): boolean => words.some((w) => new RegExp(`\\b${w}`, 'i').test(p));

/** Pick a scene and mood from prompt keywords; fall back to the hash so every prompt still gets a stable look. */
export function sceneFor(prompt: string, rnd: () => number): { scene: Scene; mood: Mood } {
  const scenes: [Scene, string[]][] = [
    ['space', ['space', 'galaxy', 'planet', 'nebula', 'star', 'cosmic', 'astronaut', 'moon']],
    ['ocean', ['ocean', 'sea', 'beach', 'wave', 'lake', 'water', 'island', 'coast', 'boat', 'river']],
    ['city', ['city', 'cyberpunk', 'street', 'skyline', 'tokyo', 'building', 'tower', 'urban', 'neon', 'robot']],
    ['forest', ['forest', 'tree', 'wood', 'jungle', 'garden', 'flower', 'meadow', 'cat', 'dog', 'fox', 'deer']],
    ['desert', ['desert', 'dune', 'sand', 'canyon', 'mars', 'pyramid', 'egypt']],
    ['mountains', ['mountain', 'peak', 'alps', 'snow', 'valley', 'hill', 'castle', 'dragon']],
  ];
  const moods: [Mood, string[]][] = [
    ['neon', ['neon', 'cyberpunk', 'synthwave', 'vaporwave', 'glow']],
    ['night', ['night', 'midnight', 'dark', 'moon', 'stars', 'galaxy', 'space']],
    ['day', ['day', 'noon', 'sunny', 'bright', 'morning', 'summer']],
    ['dusk', ['sunset', 'dusk', 'dawn', 'golden', 'evening', 'sunrise']],
  ];
  const r1 = rnd(), r2 = rnd();
  const scene = scenes.find(([, w]) => has(prompt, w))?.[0] ?? scenes[Math.floor(r1 * scenes.length)]![0];
  const mood = moods.find(([, w]) => has(prompt, w))?.[0] ?? (['dusk', 'night', 'day', 'dusk'] as Mood[])[Math.floor(r2 * 4)]!;
  return { scene, mood };
}

/** Deterministic smooth 1-D noise from a seed (sum of a few sines with random phases). */
function ridge(rnd: () => number, oct = 4): (u: number) => number {
  const f = Array.from({ length: oct }, (_, i) => ({ k: (2 + rnd() * 2) * 2 ** i, p: rnd() * 6.283, a: 0.55 ** i }));
  const norm = f.reduce((s, x) => s + x.a, 0);
  return (u) => f.reduce((s, x) => s + x.a * Math.sin(u * x.k * Math.PI + x.p), 0) / norm;
}

export function paintProcedural(ctx: Ctx2D, w: number, h: number, prompt: string, seed: number): void {
  const rnd = mulberry32(hashString(`${prompt}|${seed}`));
  const { scene, mood } = sceneFor(prompt, rnd);
  const u = Math.min(w, h) / 512;
  const hue = rnd() * 360;
  const pal = {
    dusk: { top: hsl(hue + 230, 50, 14), mid: hsl(hue + 300, 45, 34), bot: hsl(hue + 25, 85, 62), sun: hsl(hue + 35, 95, 72), land: hue + 250, ll: 22 },
    night: { top: hsl(hue + 225, 60, 5), mid: hsl(hue + 230, 50, 13), bot: hsl(hue + 220, 40, 26), sun: hsl(hue + 50, 30, 90), land: hue + 225, ll: 12 },
    day: { top: hsl(205, 70, 48), mid: hsl(200, 65, 68), bot: hsl(190, 50, 86), sun: hsl(50, 100, 92), land: 140 + (hue % 60), ll: 34 },
    neon: { top: hsl(270, 70, 8), mid: hsl(300, 75, 22), bot: hsl(330, 90, 52), sun: hsl(45, 100, 65), land: 265, ll: 14 },
  }[mood];
  if (scene === 'desert') { pal.land = 28 + (hue % 20); pal.ll = mood === 'night' ? 18 : 40; }
  const seaHue = mood === 'neon' ? 280 : mood === 'day' ? 200 : 215 + (hue % 30);
  const horizon = h * (scene === 'space' ? 1.1 : scene === 'ocean' ? 0.6 : 0.62);

  // sky
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, pal.top); sky.addColorStop(0.6, pal.mid); sky.addColorStop(1, pal.bot);
  ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);

  // stars + nebula
  if (mood !== 'day') {
    const n = scene === 'space' ? 600 : mood === 'night' ? 260 : 90;
    for (let i = 0; i < n; i++) {
      const r = (rnd() ** 3 * 1.8 + 0.3) * u, y = rnd() * (scene === 'space' ? h : horizon * 0.7);
      ctx.fillStyle = hsl(hue + rnd() * 60, 40, 90, 0.4 + rnd() * 0.6);
      ctx.beginPath(); ctx.arc(rnd() * w, y, r, 0, 6.283); ctx.fill();
    }
  }
  if (scene === 'space') {
    for (let i = 0; i < 7; i++) {
      const cx = rnd() * w, cy = rnd() * h, r = (0.25 + rnd() * 0.4) * Math.max(w, h);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, hsl(hue + i * 40, 80, 55, 0.22)); g.addColorStop(1, hsl(hue + i * 40, 80, 40, 0));
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }
    // ringed planet
    const px = (0.3 + rnd() * 0.4) * w, py = (0.45 + rnd() * 0.25) * h, pr = (0.12 + rnd() * 0.1) * Math.min(w, h);
    const pg = ctx.createRadialGradient(px - pr * 0.4, py - pr * 0.4, pr * 0.1, px, py, pr);
    pg.addColorStop(0, hsl(hue + 20, 70, 72)); pg.addColorStop(0.7, hsl(hue + 340, 55, 38)); pg.addColorStop(1, hsl(hue + 300, 50, 12));
    ctx.save(); ctx.translate(px, py); ctx.rotate(-0.35);
    ctx.strokeStyle = hsl(hue + 40, 60, 75, 0.55); ctx.lineWidth = pr * 0.08;
    ctx.beginPath(); ctx.ellipse(0, 0, pr * 1.9, pr * 0.45, 0, Math.PI, 2 * Math.PI); ctx.stroke(); ctx.restore();
    ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(px, py, pr, 0, 6.283); ctx.fill();
    ctx.save(); ctx.translate(px, py); ctx.rotate(-0.35);
    ctx.beginPath(); ctx.ellipse(0, 0, pr * 1.9, pr * 0.45, 0, 0, Math.PI); ctx.stroke(); ctx.restore();
    const mr = pr * 0.25, mx = (rnd() * 0.8 + 0.1) * w, my = rnd() * h * 0.35;
    ctx.fillStyle = hsl(hue, 10, 80); ctx.beginPath(); ctx.arc(mx, my, mr, 0, 6.283); ctx.fill();
    vignette(ctx, w, h);
    return;
  }

  // sun / moon with glow
  const sx = (0.2 + rnd() * 0.6) * w, sy = horizon - (mood === 'dusk' ? 0.08 : 0.3 + rnd() * 0.15) * h, sr = (mood === 'night' ? 0.045 : 0.075) * Math.min(w, h);
  const glow = ctx.createRadialGradient(sx, sy, sr * 0.5, sx, sy, sr * 9);
  glow.addColorStop(0, pal.sun.replace(/,1\)$/, ',0.55)')); glow.addColorStop(1, pal.sun.replace(/,1\)$/, ',0)'));
  ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = pal.sun; ctx.beginPath(); ctx.arc(sx, sy, sr, 0, 6.283); ctx.fill();
  if (mood === 'neon') { // synthwave sun stripes
    ctx.fillStyle = pal.mid;
    for (let i = 0; i < 6; i++) ctx.fillRect(sx - sr, sy + sr * (0.1 + i * 0.16), sr * 2, sr * 0.04 * (i + 1));
  }

  // clouds
  for (let i = 0; i < 6 + rnd() * 6; i++) {
    const cy = rnd() * horizon * 0.75, cx = rnd() * w, cw = (80 + rnd() * 200) * u;
    ctx.fillStyle = mood === 'day' ? 'rgba(255,255,255,0.55)' : hsl(hue + 320, 50, 70, 0.18);
    for (let k = 0; k < 6; k++) { ctx.beginPath(); ctx.ellipse(cx + (rnd() - 0.5) * cw, cy + (rnd() - 0.5) * cw * 0.12, cw * (0.25 + rnd() * 0.3), cw * 0.07, 0, 0, 6.283); ctx.fill(); }
  }

  // far → near terrain layers
  const layers = scene === 'ocean' ? 2 : 4;
  for (let i = 0; i < layers; i++) {
    const d = (i + 1) / layers;
    const f = ridge(rnd, scene === 'desert' ? 2 : 5);
    const amp = (scene === 'mountains' ? 0.32 : scene === 'desert' ? 0.08 : scene === 'city' ? 0.05 : 0.14) * h * (1.1 - d * 0.6);
    const base = scene === 'ocean' ? horizon : horizon + d * (h - horizon) * 0.55;
    const pts: number[] = [];
    for (let x = 0; x <= w + 2; x += Math.max(1, w / 300)) pts.push(x, base - amp * (scene === 'mountains' ? Math.abs(f(x / w)) * 1.4 : f(x / w) * 0.6 + 0.4));
    const L = pal.ll * (0.35 + 0.65 * (1 - d)) + (1 - d) * 18;
    const lg = ctx.createLinearGradient(0, base - amp, 0, h);
    lg.addColorStop(0, hsl(pal.land + d * 20, scene === 'desert' ? 55 : 30, scene === 'desert' ? L + 25 : L + 6));
    lg.addColorStop(1, hsl(pal.land + d * 20, 35, Math.max(3, L - 8)));
    ctx.fillStyle = lg;
    ctx.beginPath(); ctx.moveTo(0, h);
    for (let k = 0; k < pts.length; k += 2) ctx.lineTo(pts[k]!, pts[k + 1]!);
    ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
    if (scene === 'mountains' && i < 2) { // snow caps
      ctx.save(); ctx.clip();
      ctx.fillStyle = 'rgba(240,245,255,0.75)'; ctx.fillRect(0, 0, w, base - amp * 0.95); ctx.restore();
    }
    // atmospheric haze between layers
    const haze = ctx.createLinearGradient(0, base - amp, 0, base + 30 * u);
    haze.addColorStop(0, hsl(hue + 300, 40, 70, 0)); haze.addColorStop(1, hsl(hue + 300, 40, mood === 'day' ? 85 : 55, 0.18));
    ctx.fillStyle = haze; ctx.fillRect(0, base - amp, w, h - base + amp);
    if (scene === 'forest' && i >= 1) trees(ctx, w, h, pts, d, u, pal.land, rnd);
    if (scene === 'city' && i === layers - 2) skyline(ctx, w, base, h, u, mood, hue, rnd);
  }

  if (scene === 'ocean') {
    const sea = ctx.createLinearGradient(0, horizon, 0, h);
    sea.addColorStop(0, hsl(seaHue, 50, mood === 'day' ? 45 : 22)); sea.addColorStop(1, hsl(seaHue, 55, 6));
    ctx.fillStyle = sea; ctx.fillRect(0, horizon, w, h - horizon);
    ctx.fillStyle = pal.sun.replace(/,1\)$/, ',0.6)');
    for (let y = horizon + 2; y < h; y += 3 * u + (y - horizon) * 0.03) { // sun glitter path
      const spread = sr * (1 + (y - horizon) / (h - horizon) * 4) * (0.5 + rnd());
      ctx.fillRect(sx - spread / 2 + (rnd() - 0.5) * spread * 0.4, y, spread, Math.max(1, u * (1 + (y - horizon) / 80)));
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = u;
    for (let k = 0; k < 120; k++) { const y = horizon + rnd() ** 2 * (h - horizon), x = rnd() * w, l = (10 + (y - horizon) * 0.3) * u; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + l, y); ctx.stroke(); }
  }
  vignette(ctx, w, h);
}

function trees(ctx: Ctx2D, w: number, h: number, pts: number[], d: number, u: number, land: number, rnd: () => number): void {
  const n = Math.round(30 + 50 * d);
  for (let i = 0; i < n; i++) {
    const k = Math.floor(rnd() * (pts.length / 2)) * 2, x = pts[k]!, y = pts[k + 1]! + rnd() * 20 * u * d;
    const th = (20 + rnd() * 50) * u * (0.5 + d), tw = th * 0.32;
    ctx.fillStyle = hsl(land - 80 + rnd() * 20, 35, 6 + (1 - d) * 18);
    ctx.beginPath(); ctx.moveTo(x, y - th); ctx.lineTo(x - tw, y); ctx.lineTo(x + tw, y); ctx.closePath(); ctx.fill();
  }
  void w; void h;
}

function skyline(ctx: Ctx2D, w: number, base: number, h: number, u: number, mood: Mood, hue: number, rnd: () => number): void {
  let x = -10;
  while (x < w) {
    const bw = (18 + rnd() * 46) * u, bh = (40 + rnd() ** 2 * 260) * u;
    ctx.fillStyle = hsl(hue + 230, 25, mood === 'day' ? 40 : 7 + rnd() * 5);
    ctx.fillRect(x, base - bh, bw, h - base + bh);
    const lit = mood === 'day' ? 0.05 : 0.35;
    for (let wy = base - bh + 5 * u; wy < base; wy += 7 * u)
      for (let wx = x + 3 * u; wx < x + bw - 4 * u; wx += 6 * u)
        if (rnd() < lit) { ctx.fillStyle = mood === 'neon' ? hsl(rnd() < 0.5 ? 320 : 185, 100, 65) : hsl(45, 90, 70, 0.9); ctx.fillRect(wx, wy, 2.5 * u, 3 * u); }
    x += bw + rnd() * 6 * u;
  }
}

function vignette(ctx: Ctx2D, w: number, h: number): void {
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.6);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}
