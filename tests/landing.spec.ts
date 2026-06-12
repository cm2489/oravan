import { expect, test } from '@playwright/test';

test('landing renders and ZIP search reaches reps', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Congress counts calls');
  await page.getByLabel('Your ZIP code').fill('78501');
  await page.getByRole('button', { name: /find my representatives/i }).click();
  await expect(page).toHaveURL(/\/reps\?zip=78501/);
  await expect(page.getByText('Monica De La Cruz')).toBeVisible();
});

test('no horizontal overflow on either landing locale', async ({ page }) => {
  for (const path of ['/', '/es']) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `${path} must not scroll horizontally`).toBeLessThanOrEqual(0);
  }
});

test('spanish landing is fully localized', async ({ page }) => {
  await page.goto('/es');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('El Congreso cuenta las llamadas');
  await expect(page.getByLabel('Tu código postal')).toBeVisible();
});

test('footer privacy link is reachable and clickable on mobile', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'regression guard for the mobile tab-bar overlap');
  await page.goto('/');
  const link = page.locator('footer').getByRole('link', { name: 'Privacy' });
  await link.scrollIntoViewIfNeeded();
  await link.click();
  await expect(page).toHaveURL(/\/privacy/);
});
