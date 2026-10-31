import { type Page, expect } from '@playwright/test';

/** Cheap fingerprint of the canvas pixels (sampled grid of RGB values). */
export async function canvasSignature(page: Page): Promise<string> {
  return page.getByTestId('live-canvas').evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return '';
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let out = '';
    for (let y = 1; y < 16; y++) for (let x = 1; x < 16; x++) {
      const i = (Math.floor((y / 16) * c.height) * c.width + Math.floor((x / 16) * c.width)) * 4;
      out += `${d[i]},${d[i + 1]},${d[i + 2]};`;
    }
    return out;
  });
}

export async function expectFormation(page: Page): Promise<void> {
  const before = await canvasSignature(page);
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('badge')).toHaveText(/simulated/i);
  const sigs = new Set<string>([before]);
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(220);
    sigs.add(await canvasSignature(page));
  }
  // The canvas must visibly change many times while the image forms (not a single final paint).
  expect(sigs.size).toBeGreaterThanOrEqual(6);
  await expect(page.getByTestId('download')).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByTestId('hud-step')).toContainText('/');
  const finalSig = await canvasSignature(page);
  expect(finalSig).not.toEqual(before);
}
