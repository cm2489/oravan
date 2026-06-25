import { expect, test } from '@playwright/test';
import coverageData from '../data/coverage.json';
import { coverageTier, getCoverage } from '../lib/coverage';

/*
 * Data-driven: the nightly sync rewrites data/coverage.json, so the suite finds
 * its fixtures from whatever's baked in — a bill the section shows, a one-sided
 * bill (shown WITH a disclaimer), and a too-thin/no-coverage bill (no section).
 * Tier logic itself is covered exhaustively in coverage.unit.spec.ts.
 */
const slugs = Object.keys(coverageData).filter((k) => !k.startsWith('_'));
const shownSlug = slugs.find((s) => getCoverage(s).length > 0);
const oneSidedSlug = slugs.find((s) => coverageTier(getCoverage(s)) === 'one_sided');
const thinSlug = slugs.find((s) => getCoverage(s).length === 0); // stored but < 2 outlets

const section = (page: import('@playwright/test').Page) =>
  page.locator('section[aria-labelledby="coverage-heading"]');

test('a bill with coverage renders the Read section', async ({ page }) => {
  test.skip(!shownSlug, 'no showable coverage in current data');
  await page.goto(`/bills/${shownSlug}`);
  await expect(section(page).getByRole('heading', { name: "How it's being covered" })).toBeVisible();
  await expect(section(page).getByRole('listitem').first()).toBeVisible();
  await expect(section(page).getByText(/labels describe the news outlet/)).toBeVisible();
});

test('snippet preview toggles open (keyboard/touch path)', async ({ page }) => {
  test.skip(!shownSlug, 'no showable coverage in current data');
  await page.goto(`/bills/${shownSlug}`);
  const button = section(page).getByRole('button', { name: 'Preview' }).first();
  test.skip((await button.count()) === 0, 'current coverage has no article snippets');
  // Toggling needs React attached — retry-guard against the hydration race.
  await expect(async () => {
    if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true', { timeout: 500 });
  }).toPass({ timeout: 10_000 });
  const panelId = await button.getAttribute('aria-controls');
  await expect(page.locator(`#${panelId}`)).toBeVisible();
});

test('one-sided coverage is shown WITH a disclaimer (not hidden)', async ({ page }) => {
  test.skip(!oneSidedSlug, 'no one-sided coverage in current data');
  await page.goto(`/bills/${oneSidedSlug}`);
  await expect(section(page).getByRole('heading', { name: "How it's being covered" })).toBeVisible();
  await expect(section(page).getByText(/one side of the spectrum/)).toBeVisible();
});

test('too-thin coverage renders no section', async ({ page }) => {
  test.skip(!thinSlug, 'no sub-threshold coverage in current data');
  await page.goto(`/bills/${thinSlug}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); // page rendered (not 404)
  await expect(section(page)).toHaveCount(0);
});
