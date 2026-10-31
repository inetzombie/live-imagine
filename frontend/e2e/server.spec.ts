import { expect, test } from '@playwright/test';
import { canvasSignature, expectFormation } from './helpers';

test('SimulatedProvider on the FastAPI backend: canvas pixels change over time', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('mode')).toHaveText('FastAPI backend');
  await expectFormation(page);
  // replay scrubber works after generation
  const end = await canvasSignature(page);
  await page.getByTestId('scrubber').fill('2');
  await page.waitForTimeout(400);
  expect(await canvasSignature(page)).not.toEqual(end);
});

test('Esc cancels a running job', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('mode')).toHaveText('FastAPI backend');
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('cancel')).toBeVisible();
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await expect(page.getByText(/Cancelled/)).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('generate')).toBeEnabled();
});

test('unconfigured API provider shows a clean not-configured state', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('mode')).toHaveText('FastAPI backend');
  await page.getByTestId('provider').selectOption('openai');
  await expect(page.getByTestId('not-configured')).toContainText('OPENAI_API_KEY');
  await expect(page.getByTestId('generate')).toBeDisabled();
});
