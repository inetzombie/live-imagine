import { expect, test } from '@playwright/test';
import { expectFormation } from './helpers';

test('in-browser SimulatedProvider (no backend): canvas pixels change over time', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('mode')).toHaveText('Browser only');
  await expectFormation(page);
});

test('mobile layout forms the image too', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expectFormation(page);
});

test('GIF export downloads a real animated GIF', async ({ page }) => {
  await page.goto('/');
  await expectFormation(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('gif').click()]);
  expect(dl.suggestedFilename()).toMatch(/\.gif$/);
  const buf = await (await import('node:fs/promises')).readFile((await dl.path())!);
  expect(buf.subarray(0, 6).toString()).toBe('GIF89a');
  expect(buf.length).toBeGreaterThan(5000);
  expect(buf[buf.length - 1]).toBe(0x3b);
  await (await import('node:fs/promises')).copyFile((await dl.path())!, 'test-results/formation.gif');
});
