import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { SITE_ORIGIN } from '../lib/site';
import { FONT_VALUES, RADIUS_VALUES } from '../lib/embed-theme';

/*
 * S14 — bill-card embed widget. Drives the widget's own page directly (not
 * through the loader/iframe seam — tests/embed-loader.spec.ts covers the
 * bill-card loader integration on a genuine cross-origin host) to pin: the
 * AI-decoded label semantics (house rule — the label only ever travels
 * alongside a real AI headline, never with the bare official title), the
 * freshness stamp, the link-out URL shape, both locales, CSS-custom-
 * property theming and its injection rejection, and the privacy/a11y
 * basics that don't depend on being embedded.
 *
 * Fixtures reused from other suites that already pin these same bills'
 * shape (tests/jsonld.spec.ts, tests/sitemap.spec.ts), so a corpus refresh
 * that breaks one of these breaks all of them together, not silently.
 */

const DECODED_SLUG = 'hr-5582-119'; // has an ai_headline
const ES_DECODED_SLUG = 'sjres-99-119'; // has an ai_headline (ES decode too)
const NO_HEADLINE_SLUG = 'hr-8553-119'; // no ai_headline — official title, no label
const NO_HEADLINE_TITLE =
  'To direct the Secretary of Veterans Affairs to establish a precision oncology program for cancer of the prostate, and for other purposes.';

test('EN: citation, AI-decoded headline + label, status, freshness stamp, and a link-out', async ({
  page,
}) => {
  await page.goto(`/embed/bill-card?locale=en&slug=${DECODED_SLUG}`);
  await expect(page.getByText('H.R. 5582')).toBeVisible();
  await expect(
    page.getByText('Hospitals and insurers must publish real prices under HR 5582')
  ).toBeVisible();
  await expect(page.getByText(en.og.aiDecoded, { exact: true })).toBeVisible();
  await expect(page.getByText(en.bills.status.committee, { exact: true })).toBeVisible();
  await expect(page.getByText(/Data as of/)).toBeVisible();

  const link = page.getByRole('link', { name: new RegExp(en.embed.poweredBy) });
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(link).toHaveAttribute('href', `${SITE_ORIGIN}/bills/${DECODED_SLUG}`);
});

test('ES: Spanish labels, no English leakage, ES-prefixed canonical link-out', async ({ page }) => {
  await page.goto(`/embed/bill-card?locale=es&slug=${ES_DECODED_SLUG}`);
  await expect(page.getByText('S.J.Res. 99')).toBeVisible();
  // The ES corpus carries its own translated headline, not the EN one -
  // localizeBill (lib/core/bills.ts) overlays it for locale='es'.
  await expect(
    page.getByText('El Senado busca restablecer extensiones automáticas de permisos de trabajo')
  ).toBeVisible();
  await expect(page.getByText(es.og.aiDecoded, { exact: true })).toBeVisible();
  await expect(page.getByText(es.bills.status.floor_vote, { exact: true })).toBeVisible();
  await expect(page.getByText(en.og.aiDecoded, { exact: true })).toHaveCount(0);
  await expect(page.getByText(en.embed.poweredBy, { exact: true })).toHaveCount(0);

  const link = page.getByRole('link', { name: new RegExp(es.embed.poweredBy) });
  await expect(link).toHaveAttribute('href', `${SITE_ORIGIN}/es/bills/${ES_DECODED_SLUG}`);
});

test('a bill with no AI headline shows the official title and never the AI-decoded label', async ({
  page,
}) => {
  await page.goto(`/embed/bill-card?locale=en&slug=${NO_HEADLINE_SLUG}`);
  await expect(page.getByText(NO_HEADLINE_TITLE)).toBeVisible();
  await expect(page.getByText(en.og.aiDecoded, { exact: true })).toHaveCount(0);
  await expect(page.getByText(en.bills.status.committee, { exact: true })).toBeVisible();
});

test('the EN/ES toggle is always present and switches locale live, no reload', async ({ page }) => {
  await page.goto(`/embed/bill-card?locale=en&slug=${DECODED_SLUG}`);
  const enToggle = page.getByRole('button', { name: 'EN', exact: true });
  const esToggle = page.getByRole('button', { name: 'ES', exact: true });
  await expect(enToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(esToggle).toHaveAttribute('aria-pressed', 'false');
  await esToggle.click();
  await expect(page.getByText(es.bills.status.committee, { exact: true })).toBeVisible();
  await expect(esToggle).toHaveAttribute('aria-pressed', 'true');
});

test('a host page may default the locale to ES but the toggle can always switch back to EN', async ({
  page,
}) => {
  await page.goto(`/embed/bill-card?locale=es&slug=${DECODED_SLUG}`);
  await expect(page.getByText(es.bills.status.committee, { exact: true })).toBeVisible();
  const enToggle = page.getByRole('button', { name: 'EN', exact: true });
  await expect(enToggle).toBeVisible();
  await enToggle.click();
  await expect(page.getByText(en.bills.status.committee, { exact: true })).toBeVisible();
});

test('unknown slug: graceful not-found message, toggle still present, no crash', async ({
  page,
}) => {
  const res = await page.goto('/embed/bill-card?locale=en&slug=not-a-real-bill');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('alert').filter({ hasText: en.embed.billNotFound })).toBeVisible();
  await expect(page.getByRole('button', { name: 'EN', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ES', exact: true })).toBeVisible();
});

test('missing slug param: same graceful not-found state, not a crash', async ({ page }) => {
  const res = await page.goto('/embed/bill-card?locale=en');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('alert').filter({ hasText: en.embed.billNotFound })).toBeVisible();
});

test('theming: a valid accent/radius/font renders as the corresponding CSS custom properties', async ({
  page,
}) => {
  await page.goto(
    `/embed/bill-card?locale=en&slug=${DECODED_SLUG}&accent=%23336699&radius=round&font=serif`
  );
  const root = page.locator('.bc-root');
  const read = (name: string) =>
    root.evaluate((el, n) => getComputedStyle(el).getPropertyValue(n).trim(), name);
  await expect.poll(() => read('--oravan-accent')).toBe('#336699');
  await expect.poll(() => read('--oravan-radius')).toBe(RADIUS_VALUES.round);
  await expect.poll(() => read('--oravan-font')).toBe(FONT_VALUES.serif);
});

test('theming injection: a malformed accent value is rejected outright, never applied', async ({
  page,
}) => {
  const malicious = '#fff"}body{display:none}<script>window.__pwned=true</script>';
  await page.goto(
    `/embed/bill-card?locale=en&slug=${DECODED_SLUG}&accent=${encodeURIComponent(malicious)}`
  );

  // The script never ran - React never puts attacker text anywhere JS can parse it.
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBe(
    undefined
  );
  // And the custom property itself was never set to the malicious string -
  // an invalid theme value is discarded wholesale, not sanitized-and-kept.
  const root = page.locator('.bc-root');
  const accentValue = await root.evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--oravan-accent').trim()
  );
  expect(accentValue).toBe('');
  const html = await page.content();
  expect(html).not.toContain('<script>window.__pwned');
  // The rest of the widget still renders normally - a bad theme param never breaks the page.
  await expect(
    page.getByText('Hospitals and insurers must publish real prices under HR 5582')
  ).toBeVisible();
});

test('theming injection: non-enum radius/font values fall back to the safe default mapping', async ({
  page,
}) => {
  const badRadius = encodeURIComponent('sharp"; } body { display:none } //');
  const badFont = encodeURIComponent("serif</style><script>window.__pwned2=true</script>");
  await page.goto(
    `/embed/bill-card?locale=en&slug=${DECODED_SLUG}&radius=${badRadius}&font=${badFont}`
  );
  expect(await page.evaluate(() => (window as unknown as { __pwned2?: boolean }).__pwned2)).toBe(
    undefined
  );
  const root = page.locator('.bc-root');
  const radiusValue = await root.evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--oravan-radius').trim()
  );
  const fontValue = await root.evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--oravan-font').trim()
  );
  expect(radiusValue).toBe(RADIUS_VALUES.soft); // invalid input -> the 'soft' default
  expect(fontValue).toBe(FONT_VALUES.system); // invalid input -> the 'system' default
});

test('a11y basics: labeled toggle group, 44px targets, visible focus', async ({ page }) => {
  await page.goto(`/embed/bill-card?locale=en&slug=${DECODED_SLUG}`);
  const enToggle = page.getByRole('button', { name: 'EN', exact: true });
  const box = await enToggle.boundingBox();
  expect(box?.height, 'toggle must meet the 44px touch target').toBeGreaterThanOrEqual(44);
  await enToggle.focus();
  await expect(enToggle).toBeFocused();
});

test('zero cookies on the embed response', async ({ page }) => {
  const res = await page.goto(`/embed/bill-card?locale=en&slug=${DECODED_SLUG}`);
  expect(res?.headers()['set-cookie']).toBeUndefined();
  expect(await page.context().cookies()).toHaveLength(0);
});

test('the embed CSP carve-out applies to bill-card too (same route-group header)', async ({
  page,
}) => {
  const res = await page.goto(`/embed/bill-card?locale=en&slug=${DECODED_SLUG}`);
  const csp = res?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain('frame-ancestors *');
  expect(csp).toContain("connect-src 'self'");
});
