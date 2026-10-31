/** Ring buffer of received preview frames (max 60). Evicted bitmaps are closed to free memory. */
export interface Frame { bitmap: ImageBitmap; step: number; total: number; elapsedMs: number }

export class FrameBuffer {
  private frames: Frame[] = [];
  constructor(readonly capacity = 60) {}

  push(f: Frame): void {
    this.frames.push(f);
    while (this.frames.length > this.capacity) this.frames.shift()?.bitmap.close();
  }
  get length(): number { return this.frames.length; }
  at(i: number): Frame | undefined { return this.frames[Math.max(0, Math.min(this.frames.length - 1, i))]; }
  last(): Frame | undefined { return this.frames[this.frames.length - 1]; }
  all(): readonly Frame[] { return this.frames; }
  clear(): void { for (const f of this.frames) f.bitmap.close(); this.frames = []; }
}
