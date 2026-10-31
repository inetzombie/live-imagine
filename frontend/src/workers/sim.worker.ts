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
        const a = Math.min(1, s ** 1.6);
        if (a < 1) {
          const img = octx.getImageData(0, 0, pw, ph);
          const d = img.data, sa = Math.sqrt(a), sn = Math.sqrt(1 - a) * 255;
          for (let i = 0; i < d.length; i += 4) {
            const n = 0.5 + 0.5 * gaussian(rnd);
            d[i] = sa * (d[i] ?? 0) + sn * n + sn * 0.25 * gaussian(rnd);
            d[i + 1] = sa * (d[i + 1] ?? 0) + sn * n + sn * 0.25 * gaussian(rnd);
            d[i + 2] = sa * (d[i + 2] ?? 0) + sn * n + sn * 0.25 * gaussian(rnd);
          }
          octx.putImageData(img, 0, 0);
        }
        const bitmap = out.transferToImageBitmap();
        post({ type: 'frame', step, total: steps, elapsedMs: Math.round(performance.now() - t0), width: W, height: H, bitmap }, [bitmap]);
      }
      await sleep(stepMs);
    }
    const full = new OffscreenCanvas(W, H);
    const fctx = full.getContext('2d');
    if (!fctx) throw new Error('2D context unavailable');
    paintProcedural(fctx, W, H, params.prompt, seed);
    post({ type: 'final', seed, blob: await full.convertToBlob({ type: 'image/png' }) });
  } catch (e) {
    post({ type: 'error', message: (e as Error).message });
  }
};
