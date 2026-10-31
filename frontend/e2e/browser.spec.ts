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
