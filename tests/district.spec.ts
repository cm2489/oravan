import { expect, test, type Page } from '@playwright/test';

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
  const input = page.getByLabel('Street address');
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.fill(address);
  await page.getByRole('button', { name: 'Find my district' }).click();
}

test('split ZIP: address refinement narrows to the one real district', async ({ page }) => {
  const requests = mockDistrictApi(page, { status: 200, body: { state: 'NY', district: 12 } });
  await page.goto(`/reps?zip=${SPLIT_ZIP}`);

  // Default view: the multi-district note and BOTH candidate districts.
  await expect(page.getByText(/spans more than one congressional district/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'NY district 10' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'NY district 12' })).toBeVisible();
  await expect(page.getByText('Daniel S. Goldman')).toBeVisible();
  // The point-of-use privacy sentence sits next to the input.
  await expect(page.getByText(/used once to find your district/)).toBeVisible();

  await fillAddress(page, '421 8th Ave');

  // Refined view: only NY-12's House member; senators unaffected.
  await expect(page).toHaveURL(/district=NY-12/);
  await expect(page.getByRole('heading', { name: 'NY district 12' })).toBeVisible();
  await expect(page.getByText('Jerrold Nadler')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'NY district 10' })).toHaveCount(0);
  await expect(page.getByText('Daniel S. Goldman')).toHaveCount(0);
  await expect(page.getByText('Charles E. Schumer')).toBeVisible();
  await expect(page.getByText('Kirsten E. Gillibrand')).toBeVisible();
  await expect(page.getByText(/found from the street address you entered/)).toBeVisible();

  // Log hygiene, pinned: the address went in a POST body, never in a URL.
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].postData).toContain('421 8th Ave');
  expect(page.url()).not.toContain('8th');

  // The refinement is escapable: back to the full candidate list.
  await page.getByRole('link', { name: /Show all districts/ }).click();
  await expect(page.getByText('Daniel S. Goldman')).toBeVisible();
  await expect(page.getByText('Jerrold Nadler')).toBeVisible();
});

test('address not found: calm inline error, all candidates stay', async ({ page }) => {
  mockDistrictApi(page, { status: 404, body: { error: 'not_found' } });
  await page.goto(`/reps?zip=${SPLIT_ZIP}`);
  await fillAddress(page, '9999 Nowhere Xyzzy Lane');

  await expect(page.getByRole('alert').filter({ hasText: /couldn't find that address/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'NY district 10' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'NY district 12' })).toBeVisible();
  expect(page.url()).not.toContain('district=');
});

test('geocoder down: soft note, the all-candidates view is the graceful fallback', async ({ page }) => {
  mockDistrictApi(page, { status: 502, body: { error: 'unavailable' } });
  await page.goto(`/reps?zip=${SPLIT_ZIP}`);
  await fillAddress(page, '421 8th Ave');

  await expect(
    page.getByRole('alert').filter({ hasText: /couldn't check your address right now/i })
  ).toBeVisible();
  await expect(page.getByText('Daniel S. Goldman')).toBeVisible();
  await expect(page.getByText('Jerrold Nadler')).toBeVisible();
});

test('rate limited: a gentle try-again-soon message', async ({ page }) => {
  mockDistrictApi(page, { status: 429, body: { error: 'rate_limited' } });
  await page.goto(`/reps?zip=${SPLIT_ZIP}`);
  await fillAddress(page, '421 8th Ave');
  await expect(page.getByRole('alert').filter({ hasText: /try again soon/i })).toBeVisible();
});

test('district outside the ZIP candidate set: trust the geocoder, say what happened', async ({ page }) => {
  // Server-rendered from the URL params alone - no mock needed. NY-1 is not
  // in 10001's candidate set {NY-10, NY-12}.
  await page.goto(`/reps?zip=${SPLIT_ZIP}&district=NY-1`);
  await expect(page.getByText('Nick LaLota')).toBeVisible();
  await expect(page.getByText(/didn't expect for 10001/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Show all districts/ })).toBeVisible();
});

test('a bogus district param is ignored, not trusted', async ({ page }) => {
  await page.goto(`/reps?zip=${SPLIT_ZIP}&district=NY-99`);
  await expect(page.getByText('Daniel S. Goldman')).toBeVisible();
  await expect(page.getByText('Jerrold Nadler')).toBeVisible();
  await expect(page.getByText(/found from the street address/)).toHaveCount(0);
});

test('single-district ZIP never offers the address form', async ({ page }) => {
  await page.goto('/reps?zip=78501');
  await expect(page.getByText('Monica De La Cruz')).toBeVisible();
  // Not rendered at all for single-district ZIPs (not just hidden).
  await expect(page.getByLabel('Street address')).toHaveCount(0);
  await expect(page.getByText(/spans more than one/)).toHaveCount(0);
});
