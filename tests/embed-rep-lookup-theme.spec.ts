import { test, expect } from '@playwright/test';
import { FONT_VALUES, RADIUS_VALUES } from '../lib/embed-theme';
import en from '../messages/en.json';

/*
 * S5a: the rep-lookup widget accepts the same three validated theme params
 * as the bill card, plus the white-label knobs shared by both widgets
 * (brandless chrome; attribution removal for licensed partners). Mirrors
 * tests/embed-bill-card.spec.ts's theming/injection contract so the two
 * widgets can never drift apart on validation behavior.
 */

test('theming: valid accent/radius/font render as CSS custom properties on the rep-lookup root', async ({
  page,
}) => {
  await page.goto('/embed/rep-lookup?locale=en&accent=%23336699&radius=round&font=serif');
  const root = page.locator('.re-root');
  const read = (name: string) =>
    root.evaluate((el, n) => getComputedStyle(el).getPropertyValue(n).trim(), name);
  await expect.poll(() => read('--oravan-accent')).toBe('#336699');
  await expect.poll(() => read('--oravan-radius')).toBe(RADIUS_VALUES.round);
  await expect.poll(() => read('--oravan-font')).toBe(FONT_VALUES.serif);
});

test('theming defaults: no params renders exactly the pre-theming look (fallback values)', async ({
  page,
}) => {
  await page.goto('/embed/rep-lookup?locale=en');
  const root = page.locator('.re-root');
  const accent = await root.evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--oravan-accent').trim()
  );
  expect(accent).toBe(''); // unset: CSS fallbacks carry the default look
  await expect(page.getByText(en.embed.frameTitle)).toBeVisible();
});

test('theming injection: malformed accent is discarded wholesale, never applied or executed', async ({
  page,
}) => {
  const malicious = '#fff"}body{display:none}<script>window.__pwned3=true</script>';
  await page.goto(`/embed/rep-lookup?locale=en&accent=${encodeURIComponent(malicious)}`);
  expect(await page.evaluate(() => (window as unknown as { __pwned3?: boolean }).__pwned3)).toBe(
    undefined
  );
  const root = page.locator('.re-root');
  const accentValue = await root.evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--oravan-accent').trim()
  );
  expect(accentValue).toBe('');
  const html = await page.content();
  expect(html).not.toContain('<script>window.__pwned3');
  await expect(page.getByText(en.embed.frameTitle)).toBeVisible();
});

test('white-label: attribution footer is ON by default, removed only by attribution=none', async ({
  page,
}) => {
  await page.goto('/embed/rep-lookup?locale=en');
  await expect(page.getByText(en.embed.poweredBy)).toBeVisible();

  await page.goto('/embed/rep-lookup?locale=en&brandless=1');
  // Brandless alone never touches attribution - default stays ON.
  await expect(page.getByText(en.embed.poweredBy)).toBeVisible();

  await page.goto('/embed/rep-lookup?locale=en&attribution=none');
  await expect(page.getByText(en.embed.poweredBy)).toHaveCount(0);
});

test('white-label: attribution validation fails closed (junk value keeps the footer)', async ({
  page,
}) => {
  await page.goto('/embed/rep-lookup?locale=en&attribution=off');
  await expect(page.getByText(en.embed.poweredBy)).toBeVisible();
});

test('white-label (bill-card): brandless drops the app-name fallback, never the AI chip; attribution matrix holds', async ({
  page,
}) => {
  // Null-bill state: branded chrome shows the app name, brandless hides it.
  await page.goto('/embed/bill-card?locale=en');
  await expect(page.locator('.bc-citation')).toHaveText(en.common.appName);
  await page.goto('/embed/bill-card?locale=en&brandless=1');
  await expect(page.locator('.bc-citation')).toHaveText('');

  // Found-bill state: AI-integrity chip survives every white-label mode.
  await page.goto('/embed/bill-card?locale=en&slug=hr-5582-119&brandless=1&attribution=none');
  await expect(page.getByText(en.og.aiDecoded, { exact: true })).toBeVisible();
  await expect(page.getByText(en.embed.poweredBy)).toHaveCount(0);
});

test('brandless page title is brand-neutral', async ({ page }) => {
  await page.goto('/embed/rep-lookup?locale=en&brandless=1');
  await expect(page).toHaveTitle('Representative lookup');
  await page.goto('/embed/rep-lookup?locale=en');
  await expect(page).toHaveTitle(/Oravan/);
});
