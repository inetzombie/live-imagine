/// <reference lib="webworker" />
/**
 * In-browser SimulatedProvider. NOT real diffusion: renders a procedural target, then fakes a denoising
 * trajectory (decaying Gaussian noise + progressive upscaling 8px → full + blur-to-sharp). Runs off the
 * main thread; frames are transferred as ImageBitmaps (zero-copy).
 */
import type { WorkerIn, WorkerOut } from '../lib/transport';
import { mulberry32, paintProcedural, seedFor } from '../lib/procedural';

declare const self: DedicatedWorkerGlobalScope;
const post = (m: WorkerOut, t: Transferable[] = []): void => self.postMessage(m, t);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function gaussian(rnd: () => number): number {
  // Irwin–Hall approximation: fast and good enough for visual noise.
  return (rnd() + rnd() + rnd() + rnd() - 2) * 1.73;
}

self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const { params, stepMs } = ev.data;
  try {
    const t0 = performance.now();
    const seed = seedFor(params.prompt, params.seed);
    const { width: W, height: H, steps } = params;
    const scale = Math.min(1, 512 / Math.max(W, H));
    const pw = Math.round(W * scale), ph = Math.round(H * scale);
    const target = new OffscreenCanvas(pw, ph);
    const tctx = target.getContext('2d');
    if (!tctx) throw new Error('OffscreenCanvas 2D not available');
    paintProcedural(tctx, pw, ph, params.prompt, seed);
    const rnd = mulberry32(seed ^ 0x9e3779b9);
    const longSide = Math.max(pw, ph);
    // Latent-like starting noise: coloured Gaussian at 1/8 resolution (like an SD latent), smoothly upscaled.
    const lw = Math.max(4, Math.round(pw / 8)), lh = Math.max(4, Math.round(ph / 8));
    const lc = new OffscreenCanvas(lw, lh), lcx = lc.getContext('2d');
    const full = new OffscreenCanvas(pw, ph), fcx = full.getContext('2d', { willReadFrequently: true });
    if (!lcx || !fcx) throw new Error('2D context unavailable');
    const li = lcx.createImageData(lw, lh);
    for (let i = 0; i < li.data.length; i += 4) {
      const m = 128 + gaussian(rnd) * 40;
      li.data[i] = m + gaussian(rnd) * 45; li.data[i + 1] = m + gaussian(rnd) * 45; li.data[i + 2] = m + gaussian(rnd) * 45; li.data[i + 3] = 255;
    }
    lcx.putImageData(li, 0, 0);
    fcx.imageSmoothingQuality = 'high';
    fcx.drawImage(lc, 0, 0, pw, ph);
    const latent = fcx.getImageData(0, 0, pw, ph);

    for (let step = 1; step <= steps; step++) {
      const s = step / steps;
      if (step % params.preview_every === 0 || step === steps) {
        const res = Math.round(8 * Math.pow(longSide / 8, Math.min(1, s * 1.15)));
        const rw = Math.max(2, Math.round((pw * res) / longSide)), rh = Math.max(2, Math.round((ph * res) / longSide));
        const small = new OffscreenCanvas(rw, rh);
        const sctx = small.getContext('2d');
        const out = new OffscreenCanvas(pw, ph);
        const octx = out.getContext('2d', { willReadFrequently: true });
        if (!sctx || !octx) throw new Error('2D context unavailable');
        sctx.imageSmoothingQuality = 'high';
        sctx.drawImage(target, 0, 0, rw, rh);
        const blur = 12 * (1 - s) ** 2;
        octx.imageSmoothingQuality = 'high';
        if (blur > 0.3) octx.filter = `blur(${blur.toFixed(2)}px)`;
        octx.drawImage(small, 0, 0, pw, ph);
        octx.filter = 'none';
        // Cosine-style signal schedule: structure appears early, fine detail late (like a real sampler).
        const a = Math.min(1, Math.sin((Math.PI / 2) * Math.min(1, s * 1.05)) ** 2);
        if (a < 1) {
          const img = octx.getImageData(0, 0, pw, ph);
          const d = img.data, sa = Math.sqrt(a), sn = Math.sqrt(1 - a);
          const L = latent.data;
          for (let i = 0; i < d.length; i += 4) {
            // fixed low-frequency "latent" noise (coherent between frames) + a little per-frame grain
            const g = gaussian(rnd) * 22 * sn;
            d[i] = sa * (d[i] ?? 0) + sn * (L[i] ?? 0) + g;
            d[i + 1] = sa * (d[i + 1] ?? 0) + sn * (L[i + 1] ?? 0) + g;
            d[i + 2] = sa * (d[i + 2] ?? 0) + sn * (L[i + 2] ?? 0) + g;
          }
          octx.putImageData(img, 0, 0);
        }
        const bitmap = out.transferToImageBitmap();
        post({ type: 'frame', step, total: steps, elapsedMs: Math.round(performance.now() - t0), width: W, height: H, bitmap }, [bitmap]);
      }
      await sleep(stepMs);
    }
    const fin = new OffscreenCanvas(W, H);
    const fctx = fin.getContext('2d');
    if (!fctx) throw new Error('2D context unavailable');
    paintProcedural(fctx, W, H, params.prompt, seed);
    post({ type: 'final', seed, blob: await fin.convertToBlob({ type: 'image/png' }) });
  } catch (e) {
    post({ type: 'error', message: (e as Error).message });
  }
};
