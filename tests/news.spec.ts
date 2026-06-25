import { expect, test } from '@playwright/test';

/*
 * The coverage-led "In the news" discovery lens. Ranking/exclusion is unit-
 * tested in coverage.unit.spec.ts (rankNews); here we just confirm it surfaces
 * on the homepage + feed with the source-count cue. Data-driven: skips cleanly
 * if a sync has left no cross/neutral coverage to feature.
 */
const lens = (page: import('@playwright/test').Page) =>
  page.locator('section[aria-labelledby="news"]');

test('homepage leads with the "In the news" lens', async ({ page }) => {
  await page.goto('/');
  test.skip((await lens(page).count()) === 0, 'no news-lens coverage in current data');

  await expect(lens(page).getByRole('heading', { name: 'In the news' })).toBeVisible();
  // each card carries a "covered by N outlets" cue
  await expect(lens(page).getByText(/\d+ outlets?/i).first()).toBeVisible();
  // and links through to a bill
  await expect(lens(page).getByRole('link').first()).toBeVisible();
});

test('the bills feed shows the news lens above the bands', async ({ page }) => {
  await page.goto('/bills');
  test.skip((await lens(page).count()) === 0, 'no news-lens coverage in current data');

  await expect(lens(page).getByRole('heading', { name: 'In the news' })).toBeVisible();
});
