import { expect, test } from '@playwright/test';
import { anyBandExceedsCapAt, stableAcross } from './corpus';
import { waitForFeedHydrated } from './helpers';

test('feed renders capped bands with show-all expansion', async ({ page }) => {
  // "Show all" only renders on a band holding more items than the display
  // cap (BillsBrowser's BAND_CAP) - whether any band does is a fact about
  // the live corpus, so derive it instead of assuming it (a sparse week
  // renders zero buttons, and that's correct, not a failure).
  test.skip(
    !stableAcross((at) => anyBandExceedsCapAt(at)),
    'a band count sits at the display-cap boundary - expectation could flip between build and assert'
  );
  const anyBandOverCap = anyBandExceedsCapAt(Date.now());

  await page.goto('/bills');
  await waitForFeedHydrated(page);
  // Bands are populated by honest, decayed urgency - assert the first
  // rendered band rather than hardcoding which one qualifies today.
  await expect(page.locator('section[aria-labelledby^=band-] h2').first()).toBeVisible();
  const links = page.locator('a[href*="/bills/"]');
  const buttons = page.getByRole('button', { name: /show all/i });
  if (!anyBandOverCap) {
    await expect(buttons).toHaveCount(0);
    return;
  }
  const before = await links.count();
  const buttonsBefore = await buttons.count();
  // Expansion unmounts the clicked button, so "one fewer button" is the
  // deterministic signal the click registered and state applied - re-click
  // only while nothing has changed (a lost click leaves no other trace),
  // then let the link count catch up to the re-render.
  await expect(async () => {
    if ((await buttons.count()) === buttonsBefore) await buttons.first().click();
    expect(await buttons.count()).toBeLessThan(buttonsBefore);
  }).toPass({ timeout: 10_000 });
  await expect.poll(() => links.count()).toBeGreaterThan(before);
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
  const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('oravan.prefs') ?? '{}'));
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

/*
 * Bare bill-number lookup (2026-08 benchmark steal, GovTrack + 5calls):
 * "hr 5582" — no dots — must find H.R. 5582, because that is how
 * journalists and staffers arrive. The slug is the same shared fixture
 * tests/embed-bill-card.spec.ts pins (DECODED_SLUG), so a corpus refresh
 * that drops it breaks the fixtures together, never silently.
 */
test('bare bill-number search: "hr 5582" finds H.R. 5582 without the punctuation', async ({
  page,
}) => {
  await page.goto('/bills');
  // A fill dispatched before hydration lands its `input` event on a
  // listener React never replays (the ZipForm comment documents the same
  // trap) — wait for the feed to hydrate like every other test here.
  await waitForFeedHydrated(page);
  const search = page.getByRole('searchbox');
  await search.fill('hr 5582');
  await expect(page.locator('a[href$="/bills/hr-5582-119"]').first()).toBeVisible();
  // And the guard holds: a plain word query must NOT take the
  // punctuation-stripped path (only digit-carrying queries do).
  await search.fill('care');
  await expect(page.locator('a[href*="/bills/"]').first()).toBeVisible();
});

test('the corpus trust line renders at the point of first input, with a live four-digit count', async ({
  page,
}) => {
  await page.goto('/bills');
  // The line carries the LIVE decoded count — assert the shape (a
  // thousands-scale number), never tonight's exact value.
  await expect(page.getByText(/[\d,.]{4,}.*(decoded into plain words|descifrados)/)).toBeVisible();
});
