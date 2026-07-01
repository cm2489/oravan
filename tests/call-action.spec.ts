import { expect, test } from '@playwright/test';
import coverageData from '../data/coverage.json';

/*
 * The "surface the call" behavior: a floating Make-the-call button keeps the
 * primary action reachable on a long bill page, but stands down whenever another
 * call CTA (the inline prompt or the action panel) is on screen — never two at
 * once. Data-driven: any real bill page carries the surfaces; use a covered bill
 * (guaranteed valid + long enough that the inline prompt sits below the fold).
 */
const slug = Object.keys(coverageData).find((k) => !k.startsWith('_'));

test('the floating call button surfaces the action and yields to on-screen CTAs', async ({ page }) => {
  test.skip(!slug, 'no bills in current data');
  await page.goto(`/bills/${slug}`);

  const fab = page.locator('[data-floating-call]');
  await expect(fab).toHaveAttribute('href', '#act');
  // At the top of a long page no other CTA is on screen — the button is shown.
  await expect(fab).toHaveCSS('opacity', '1');

  // Bring the inline prompt into view — the floating button fades out (inert).
  await page.locator('[data-call-cta]').first().scrollIntoViewIfNeeded();
  await expect(fab).toHaveCSS('opacity', '0');
  await expect(fab).toHaveAttribute('aria-hidden', 'true');

  // Scroll back to a reading gap — it returns.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(fab).toHaveCSS('opacity', '1');
});
