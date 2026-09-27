import { expect, test, type Page } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';

/*
 * Street-address fallback for split ZIPs. 10001 is a real split ZIP in
 * data/zip-districts.json: NY-10 (Daniel S. Goldman) and NY-12 (Jerrold
 * Nadler). The census geocoder is called SERVER-side by /api/district (a
 * proxy, so the visitor's IP never reaches census.gov), which means the
 * browser-level interception point is our own endpoint - the same pattern
 * as mockScriptApi for the Anthropic call. The real geocoder response
 * shape is pinned separately in district.unit.spec.ts against live
 * captures, so no test depends on the network.
 */

const SPLIT_ZIP = '10001';

/*
 * Copy is read BY KEY (reps.*), formatted the way the page formats it, so a
 * wording change in messages/*.json never fails this file — only a broken
 * behaviour does. What stays pinned is the record and the privacy contract:
 * which members show, that the address travels in a POST body and never in a
 * URL, and that every refinement is escapable.
 */
const t = createTranslator({ locale: 'en', messages: en, namespace: 'reps' });
const heading = (district: number) => t('districtHeading', { state: 'NY', district });
/** 10001's candidate set, as the headings below assert it. */
const CANDIDATES = [10, 12];
/** The multi-district note (app/[locale]/reps/page.tsx) — a hook, not its wording. */
const MULTI_DISTRICT_NOTE = '[data-multi-district]';

function mockDistrictApi(
  page: Page,
  response: { status: number; body: Record<string, unknown> }
) {
  const requests: { method: string; postData: string | null }[] = [];
  page.route('**/api/district', (route) => {
    requests.push({ method: route.request().method(), postData: route.request().postData() });
    return route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: JSON.stringify(response.body),
    });
  });
  return requests;
}

/**
 * The refinement form renders only after React mounts (see AddressForm),
 * so its input appearing IS the hydration proof - filling it can't wedge.
 */
async function fillAddress(page: Page, address: string) {
  const input = page.getByLabel(t('addressLabel'));
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.fill(address);
  await page.getByRole('button', { name: t('refineCta') }).click();
}

test('split ZIP: address refinement narrows to the one real district', async ({ page }) => {
  const requests = mockDistrictApi(page, { status: 200, body: { state: 'NY', district: 12 } });
  await page.goto(`/reps?zip=${SPLIT_ZIP}`);

  // Default view: the multi-district note and BOTH candidate districts. The
  // note states the real count (pluralized 2026-08-04, Wave A: it once said
  // "both" under six headings), so it is formatted with the candidate count.
  await expect(page.locator(MULTI_DISTRICT_NOTE)).toHaveText(
    t('multiDistrict', { count: CANDIDATES.length })
  );
  for (const district of CANDIDATES) {
    await expect(page.getByRole('heading', { name: heading(district) })).toBeVisible();
  }
  await expect(page.getByText('Daniel S. Goldman')).toBeVisible();
  // The point-of-use privacy sentence sits next to the input.
  await expect(page.getByText(t('refinePrivacy'))).toBeVisible();

  await fillAddress(page, '421 8th Ave');

  // Refined view: only NY-12's House member; senators unaffected.
  await expect(page).toHaveURL(/district=NY-12/);
  await expect(page.getByRole('heading', { name: heading(12) })).toBeVisible();
  await expect(page.getByText('Jerrold Nadler')).toBeVisible();
  await expect(page.getByRole('heading', { name: heading(10) })).toHaveCount(0);
  await expect(page.getByText('Daniel S. Goldman')).toHaveCount(0);
  await expect(page.getByText('Charles E. Schumer')).toBeVisible();
  await expect(page.getByText('Kirsten E. Gillibrand')).toBeVisible();
  await expect(page.getByText(t('refinedNote'))).toBeVisible();

  // Log hygiene, pinned: the address went in a POST body, never in a URL.
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].postData).toContain('421 8th Ave');
  expect(page.url()).not.toContain('8th');

  // The refinement is escapable: back to the full candidate list.
  await page.getByRole('link', { name: t('showAllDistricts', { zip: SPLIT_ZIP }) }).click();
  await expect(page.getByText('Daniel S. Goldman')).toBeVisible();
  await expect(page.getByText('Jerrold Nadler')).toBeVisible();
});

test('address not found: calm inline error, all candidates stay', async ({ page }) => {
  mockDistrictApi(page, { status: 404, body: { error: 'not_found' } });
  await page.goto(`/reps?zip=${SPLIT_ZIP}`);
  await fillAddress(page, '9999 Nowhere Xyzzy Lane');

  await expect(page.getByRole('alert').filter({ hasText: t('addressNotFound') })).toBeVisible();
  for (const district of CANDIDATES) {
    await expect(page.getByRole('heading', { name: heading(district) })).toBeVisible();
  }
  expect(page.url()).not.toContain('district=');
});

test('geocoder down: soft note, the all-candidates view is the graceful fallback', async ({ page }) => {
  mockDistrictApi(page, { status: 502, body: { error: 'unavailable' } });
  await page.goto(`/reps?zip=${SPLIT_ZIP}`);
  await fillAddress(page, '421 8th Ave');

  await expect(page.getByRole('alert').filter({ hasText: t('refineUnavailable') })).toBeVisible();
  await expect(page.getByText('Daniel S. Goldman')).toBeVisible();
  await expect(page.getByText('Jerrold Nadler')).toBeVisible();
});

test('rate limited: a gentle try-again-soon message', async ({ page }) => {
  mockDistrictApi(page, { status: 429, body: { error: 'rate_limited' } });
  await page.goto(`/reps?zip=${SPLIT_ZIP}`);
  await fillAddress(page, '421 8th Ave');
  await expect(page.getByRole('alert').filter({ hasText: t('refineRateLimited') })).toBeVisible();
});

test('district outside the ZIP candidate set: trust the geocoder, say what happened', async ({ page }) => {
  // Server-rendered from the URL params alone - no mock needed. NY-1 is not
  // in 10001's candidate set {NY-10, NY-12}.
  await page.goto(`/reps?zip=${SPLIT_ZIP}&district=NY-1`);
  await expect(page.getByText('Nick LaLota')).toBeVisible();
  await expect(page.getByText(t('refinedOutsideZip', { zip: SPLIT_ZIP }))).toBeVisible();
  await expect(page.getByRole('link', { name: t('showAllDistricts', { zip: SPLIT_ZIP }) })).toBeVisible();
});

test('a bogus district param is ignored, not trusted', async ({ page }) => {
  await page.goto(`/reps?zip=${SPLIT_ZIP}&district=NY-99`);
  await expect(page.getByText('Daniel S. Goldman')).toBeVisible();
  await expect(page.getByText('Jerrold Nadler')).toBeVisible();
  await expect(page.getByText(t('refinedNote'))).toHaveCount(0);
});

test('single-district ZIP never offers the address form', async ({ page }) => {
  await page.goto('/reps?zip=78501');
  await expect(page.getByText('Monica De La Cruz')).toBeVisible();
  // Not rendered at all for single-district ZIPs (not just hidden).
  await expect(page.getByLabel(t('addressLabel'))).toHaveCount(0);
  await expect(page.locator(MULTI_DISTRICT_NOTE)).toHaveCount(0);
});
