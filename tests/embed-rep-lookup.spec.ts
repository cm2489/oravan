import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * S13 — rep-lookup embed widget. Drives the widget's own page directly
 * (not through the loader/iframe seam - tests/embed-loader.spec.ts covers
 * that) to pin its behavior: ZIP lookup, both locales, the ZIP-only
 * split-district link-out (F2 - never an address field in-frame), and the
 * privacy/a11y basics that don't depend on being embedded.
 */

test('EN: ZIP lookup renders reps with a working tel link', async ({ page }) => {
  await page.goto('/embed/rep-lookup?locale=en');
  await page.getByLabel(en.home.zipLabel).fill('78501');
  await page.getByRole('button', { name: en.home.zipCta }).click();
  await expect(page.getByText('Monica De La Cruz')).toBeVisible();
  await expect(page.getByText('John Cornyn')).toBeVisible();
  await expect(page.getByText('Ted Cruz')).toBeVisible();
  await expect(page.locator('a[href^="tel:"]').first()).toBeVisible();
});

test('ES: same ZIP renders Spanish labels, no English leakage on the reps surface', async ({
  page,
}) => {
  await page.goto('/embed/rep-lookup?locale=es');
  await expect(page.getByText(es.embed.frameTitle)).toBeVisible();
  await page.getByLabel(es.home.zipLabel).fill('78501');
  await page.getByRole('button', { name: es.home.zipCta }).click();
  await expect(page.getByText('Monica De La Cruz')).toBeVisible();
  await expect(page.getByText(es.reps.dcOffice).first()).toBeVisible();
  await expect(page.getByText(en.reps.dcOffice, { exact: true })).toHaveCount(0);
  await expect(page.getByText(en.embed.poweredBy, { exact: true })).toHaveCount(0);
});

test('the EN/ES toggle is always present and switches locale live, no reload', async ({
  page,
}) => {
  await page.goto('/embed/rep-lookup?locale=en');
  const enToggle = page.getByRole('button', { name: 'EN', exact: true });
  const esToggle = page.getByRole('button', { name: 'ES', exact: true });
  await expect(enToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(esToggle).toHaveAttribute('aria-pressed', 'false');
  await esToggle.click();
  await expect(page.getByText(es.reps.noZip)).toBeVisible();
  await expect(esToggle).toHaveAttribute('aria-pressed', 'true');
});

test('split ZIP: shows both candidate districts plus a link-out, never an address field', async ({
  page,
}) => {
  await page.goto('/embed/rep-lookup?locale=en&zip=10001');
  await expect(page.getByText(en.embed.multiDistrictTitle)).toBeVisible();
  const link = page.getByRole('link', { name: new RegExp(en.embed.openFullLookup) });
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(link).toHaveAttribute('href', /\/reps\?zip=10001/);
  // F2, hard rule: street-address refinement never renders inside this iframe.
  await expect(page.locator('input[name="street-address"]')).toHaveCount(0);
  await expect(page.getByText('Daniel S. Goldman')).toBeVisible();
  await expect(page.getByText('Jerrold Nadler')).toBeVisible();
});

/*
 * S24 groundwork's vacant-seat pattern (tests/reps.spec.ts's FL-20 fixture):
 * /api/reps now answers a `vacancies` array alongside `reps`, and the main
 * /reps page shows an explicit vacant notice rather than silently rendering
 * fewer cards. The embed widget reads the same endpoint, so it needs to
 * carry the same honesty rather than quietly regressing behind it.
 */
test('vacant seat (FL-20): explicit notice, senators still shown, no invented election claim', async ({
  page,
}) => {
  await page.goto('/embed/rep-lookup?locale=en&zip=33313');
  await expect(page.getByText(en.reps.vacantSeat, { exact: true })).toBeVisible();
  await expect(page.getByText(en.reps.vacantSeatBody)).toBeVisible();
  await expect(page.getByRole('link', { name: en.reps.vacantSeatLink })).toHaveAttribute(
    'href',
    'https://www.house.gov/representatives/find-your-representative'
  );
  // Senators for the state are unaffected by a House vacancy.
  await expect(page.getByText('Rick Scott')).toBeVisible();
  await expect(page.getByText('Ashley Moody')).toBeVisible();
  // Never show the departed member, never speculate about a special election.
  await expect(page.getByText('Cherfilus-McCormick')).toHaveCount(0);
  await expect(page.getByText(/special election/i)).toHaveCount(0);
});

test('unknown ZIP gets a recoverable, localized error', async ({ page }) => {
  await page.goto('/embed/rep-lookup?locale=en');
  await page.getByLabel(en.home.zipLabel).fill('00000');
  await page.getByRole('button', { name: en.home.zipCta }).click();
  // Next's own route announcer also carries role="alert" - scope to ours.
  await expect(page.getByRole('alert').filter({ hasText: /couldn't match/i })).toBeVisible();
});

test('an invalid (non-ZIP) entry is rejected client-side with the right message', async ({
  page,
}) => {
  await page.goto('/embed/rep-lookup?locale=en');
  await page.getByLabel(en.home.zipLabel).fill('abc');
  await page.getByRole('button', { name: en.home.zipCta }).click();
  await expect(page.getByRole('alert').filter({ hasText: en.home.zipInvalid })).toBeVisible();
});

test('a11y basics: labeled input, 44px targets, visible focus', async ({ page }) => {
  await page.goto('/embed/rep-lookup?locale=en');
  const cta = page.getByRole('button', { name: en.home.zipCta });
  const box = await cta.boundingBox();
  expect(box?.height, 'submit button must meet the 44px touch target').toBeGreaterThanOrEqual(44);

  const input = page.getByLabel(en.home.zipLabel);
  await expect(input).toBeVisible();
  await input.focus();
  await expect(input).toBeFocused();
});

test('zero cookies on the embed response', async ({ page }) => {
  const res = await page.goto('/embed/rep-lookup?locale=en');
  expect(res?.headers()['set-cookie']).toBeUndefined();
  expect(await page.context().cookies()).toHaveLength(0);
});

test('the embed CSP carve-out allows framing by any origin (F1 site-wide lock is NOT here yet)', async ({
  page,
}) => {
  const res = await page.goto('/embed/rep-lookup?locale=en');
  const csp = res?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain('frame-ancestors *');
  expect(csp).toContain("connect-src 'self'");
});
