import type { Frame } from './frames';
import type { LiveCanvas } from './renderer';

/** Replay the stored formation through the live canvas and capture it as WebM via MediaRecorder. */
export async function recordWebM(lc: LiveCanvas, frames: readonly Frame[], final: ImageBitmap | null, frameMs = 180): Promise<Blob> {
  if (typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record video (no MediaRecorder).');
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('This browser cannot record WebM.');
  const stream = lc.canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise<void>((r) => { rec.onstop = () => r(); });
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  lc.setKeepAlive(true);
  rec.start(250);
  try {
    for (const f of frames) { lc.show(f.bitmap, f.step / f.total); await wait(frameMs); }
    if (final) { lc.show(final, 1); }
    await wait(1200);
  } finally {
    rec.stop();
    await stopped;
    lc.setKeepAlive(false);
    stream.getTracks().forEach((t) => t.stop());
  }
  return new Blob(chunks, { type: 'video/webm' });
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Encode the stored formation as an animated GIF (long side capped for size), last frame held. */
export async function recordGif(frames: readonly Frame[], final: ImageBitmap | null, maxSide = 384, frameMs = 140): Promise<Blob> {
  const { encodeGif } = await import('./gif');
  const src = [...frames.map((f) => f.bitmap), ...(final ? [final] : [])];
  if (!src.length) throw new Error('No frames to export.');
  const first = src[src.length - 1]!;
  const k = Math.min(1, maxSide / Math.max(first.width, first.height));
  const w = Math.max(1, Math.round(first.width * k)), h = Math.max(1, Math.round(first.height * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D not supported');
  ctx.imageSmoothingQuality = 'high';
  const out = src.map((bm, i) => {
    ctx.drawImage(bm, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h).data, delayCs: i === src.length - 1 ? 250 : frameMs / 10 };
  });
  await new Promise((r) => setTimeout(r, 0));
  return new Blob([encodeGif(w, h, out) as Uint8Array<ArrayBuffer>], { type: 'image/gif' });
}
