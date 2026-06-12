import { expect, test } from '@playwright/test';

test('normal district shows one rep and two senators with local offices', async ({ page }) => {
  await page.goto('/reps?zip=78501');
  await expect(page.getByText('Monica De La Cruz')).toBeVisible();
  await expect(page.getByText('John Cornyn')).toBeVisible();
  await expect(page.getByText('Ted Cruz')).toBeVisible();
  await expect(page.getByText(/^Local offices/).first()).toBeVisible();
});

test('DC explains the delegate situation instead of promising senators', async ({ page }) => {
  await page.goto('/reps?zip=20002');
  await expect(page.getByText(/elects a delegate/)).toBeVisible();
  await expect(page.getByText('Eleanor Holmes Norton')).toBeVisible();
  await expect(page.getByText(/Delegate ·/)).toBeVisible();
});

test('unknown ZIP gets a recoverable error', async ({ page }) => {
  await page.goto('/reps?zip=00000');
  await expect(page.getByRole('alert').filter({ hasText: /couldn't match/i })).toBeVisible();
});
