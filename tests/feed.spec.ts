import { expect, test } from '@playwright/test';
import { waitForFeedHydrated } from './helpers';

test('feed renders capped bands with show-all expansion', async ({ page }) => {
  await page.goto('/bills');
  await waitForFeedHydrated(page);
  // Bands are populated by honest, decayed urgency - assert the first
  // rendered band rather than hardcoding which one qualifies today.
  await expect(page.locator('section[aria-labelledby^=band-] h2').first()).toBeVisible();
  const before = await page.locator('a[href*="/bills/"]').count();
  const showAll = page.getByRole('button', { name: /show all/i }).first();
  await showAll.click();
  const after = await page.locator('a[href*="/bills/"]').count();
  expect(after).toBeGreaterThan(before);
});

test('search filters and clears', async ({ page }) => {
  await page.goto('/bills');
  await waitForFeedHydrated(page);
  const search = page.getByRole('searchbox');
  await search.fill('zzzzqqq');
  await expect(page.getByText(/No bills match/)).toBeVisible();
  await search.fill('veterans');
  await expect(page.getByText(/No bills match/)).toBeHidden();
  await search.press('Escape');
  await expect(search).toHaveValue('');
});

test('topic chip filters the feed and persists', async ({ page }) => {
  await page.goto('/bills');
  await waitForFeedHydrated(page);
  await page.getByRole('button', { name: 'Health care' }).click();
  await expect(page.getByRole('button', { name: 'Health care' })).toHaveAttribute('aria-pressed', 'true');
  const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('rostra.prefs') ?? '{}'));
  expect(prefs.interests).toContain('health');
});

test('"/" focuses search on desktop', async ({ page, isMobile }) => {
  test.skip(!!isMobile, 'keyboard accelerator');
  await page.goto('/bills');
  // retry until hydration has attached the listener
  await expect(async () => {
    await page.keyboard.press('/');
    await expect(page.getByRole('searchbox')).toBeFocused({ timeout: 250 });
  }).toPass();
});
