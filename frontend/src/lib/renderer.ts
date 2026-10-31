/**
 * LiveCanvas: draws preview frames at devicePixelRatio, letterboxed to the target aspect ratio.
 * - rAF-driven crossfade between consecutive frames (200 ms)
 * - "deblur settle": canvas blur filter eased from 12px → 0 as progress rises
 * - film grain overlay that fades out as steps rise
 * Reduced motion disables crossfade and grain. The loop sleeps when nothing is animating.
 */
export interface LiveCanvasOptions { reducedMotion: boolean; deblur: boolean; grain: boolean }

const FADE_MS = 200;

export class LiveCanvas {
  private ctx: CanvasRenderingContext2D;
  private prev: ImageBitmap | null = null;
  private cur: ImageBitmap | null = null;
  private fadeStart = 0;
  private progress = 0;
  private blurNow = 0;
  private generating = false;
  private aspect = 1;
  private raf = 0;
  private grainTile: HTMLCanvasElement;
  private ro: ResizeObserver;
  private keepAlive = false;
  opts: LiveCanvasOptions;
  /** Rendered frames per second (for the HUD / perf checks). */
  fps = 0;
  private fpsCount = 0;
  private fpsT = 0;

  constructor(readonly canvas: HTMLCanvasElement, opts: LiveCanvasOptions) {
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('Canvas 2D not supported');
    this.ctx = ctx;
    this.opts = opts;
    this.grainTile = makeGrain(160);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
  }

  destroy(): void { cancelAnimationFrame(this.raf); this.ro.disconnect(); }

  setAspect(w: number, h: number): void { this.aspect = w / h; this.kick(); }
  setGenerating(on: boolean): void { this.generating = on; this.kick(); }
  /** Keep painting every frame (needed while MediaRecorder captures the canvas). */
  setKeepAlive(on: boolean): void { this.keepAlive = on; this.kick(); }

  /** Show a frame. progress in [0,1]. instant skips the crossfade (scrubbing). */
  show(bitmap: ImageBitmap, progress: number, instant = false): void {
    const fade = !instant && !this.opts.reducedMotion && this.cur !== null;
    this.prev = fade ? this.cur : null;
    this.cur = bitmap;
    this.fadeStart = performance.now();
    this.progress = Math.max(0, Math.min(1, progress));
    if (instant || this.opts.reducedMotion) this.blurNow = this.targetBlur();
    this.kick();
  }

  reset(): void { this.prev = null; this.cur = null; this.progress = 0; this.blurNow = 0; this.kick(); }

  private targetBlur(): number { return this.opts.deblur ? 12 * Math.pow(1 - this.progress, 1.5) : 0; }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.kick();
  }

  /** Letterboxed image rect in device pixels. */
  rect(): { x: number; y: number; w: number; h: number } {
    const cw = this.canvas.width, ch = this.canvas.height;
    let w = cw, h = cw / this.aspect;
    if (h > ch) { h = ch; w = ch * this.aspect; }
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }

  private kick(): void { if (!this.raf) this.raf = requestAnimationFrame((t) => this.frame(t)); }

  private frame(now: number): void {
    this.raf = 0;
    const { ctx, canvas } = this;
    ctx.fillStyle = '#060607';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const r = this.rect();
    ctx.fillStyle = '#0c0c0f';
    ctx.fillRect(r.x, r.y, r.w, r.h);

    // ease blur toward its target (deblur settle)
    const target = this.targetBlur();
    this.blurNow += (target - this.blurNow) * (this.opts.reducedMotion ? 1 : 0.12);
    if (Math.abs(this.blurNow - target) < 0.05) this.blurNow = target;

    const t = this.prev ? Math.min(1, (now - this.fadeStart) / FADE_MS) : 1;
    // blur is defined relative to a 512px-wide preview, so it looks the same at any canvas size
    const blurPx = (this.blurNow * r.w) / 512;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    if (blurPx > 0.2) ctx.filter = `blur(${blurPx.toFixed(2)}px)`;
    if (this.prev && t < 1) { ctx.globalAlpha = 1; ctx.drawImage(this.prev, r.x, r.y, r.w, r.h); }
    if (this.cur) { ctx.globalAlpha = this.prev ? easeInOut(t) : 1; ctx.drawImage(this.cur, r.x, r.y, r.w, r.h); }
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    if (t >= 1) this.prev = null;

    // film grain: strong at step 0, gone at the end
    const grainA = this.opts.grain && !this.opts.reducedMotion && this.cur && this.generating ? 0.16 * (1 - this.progress) : 0;
    if (grainA > 0.004) {
      const pat = ctx.createPattern(this.grainTile, 'repeat');
      if (pat) {
        ctx.globalAlpha = grainA;
        ctx.globalCompositeOperation = 'overlay';
        const ox = Math.random() * 160, oy = Math.random() * 160;
        ctx.translate(-ox, -oy);
        ctx.fillStyle = pat;
        ctx.fillRect(r.x + ox, r.y + oy, r.w, r.h);
      }
    }
    ctx.restore();

    this.fpsCount++;
    if (now - this.fpsT > 1000) { this.fps = (this.fpsCount * 1000) / (now - this.fpsT); this.fpsCount = 0; this.fpsT = now; }

    const animating = (this.prev !== null) || this.blurNow !== target || grainA > 0.004 || this.keepAlive;
    if (animating) this.kick();
  }
}

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function makeGrain(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) return c;
  const img = g.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (Math.random() + Math.random() + Math.random() - 1.5) * 120;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}
