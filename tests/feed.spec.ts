import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import { matchesBillQuery, parseBillQuery, teaserSearchDoc } from '../lib/bill-search.mjs';
import { getTeasers } from '../lib/core';
import { anyBandExceedsCapAt, bandCountsAt, stableAcross } from './corpus';
import { waitForFeedHydrated } from './helpers';

const BANDS = ['now', 'moving', 'radar'] as const;

/*
 * EVERY BAND THE DATA SUPPORTS ACTUALLY REACHES THE PAGE.
 *
 * The middle band went missing for a while and nothing here noticed: the
 * floors were computed such that "moving" was unreachable, so /bills printed
 * "Deciding now" straight into "On the radar" and 38 bills that outscored
 * almost the whole corpus were filed as "quieter right now"
 * (lib/taxonomy.ts's v3a note). The arithmetic guard for that lives in
 * tests/taxonomy.unit.spec.ts — where it can fail on a floor bug the mirror
 * below would faithfully reproduce. THIS spec covers the other half:
 * BillsBrowser actually renders a section for each band the split populates.
 */
test('every band the corpus populates renders its own section', async ({ page }) => {
  const presence = (at: number) =>
    BANDS.map((b) => [b, bandCountsAt(at)[b] > 0] as const);
  test.skip(
    !stableAcross(presence),
    'a band sits at the empty/non-empty boundary — expectation could flip between build and assert'
  );
  const counts = bandCountsAt(Date.now());
  await page.goto('/bills');
  await waitForFeedHydrated(page);
  for (const band of BANDS) {
    if (counts[band] === 0) continue;
    await expect(
      page.locator(`section[aria-labelledby="band-${band}"]`),
      `the "${band}" band holds ${counts[band]} bills and must render`
    ).toBeVisible();
  }
});

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
 * Bare bill-number lookup (2026-08):
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

/*
 * Every word, in any order; a citation in any spelling (the 2026-09-27 audit,
 * SY-21). The search used to match the whole query as one substring, so
 * "Iran war powers" found 1 of 12 resolutions and "H. Con. Res. 89" found
 * nothing. Corpus-derived, like the rest of this file: the target is a card
 * whose own title yields three long words that, typed BACKWARDS, match only a
 * few cards — backwards so the old whole-phrase rule could never have passed,
 * and few so the card is inside its band's first page. The expectation is
 * computed with the page's own matcher and field list (lib/bill-search.mjs).
 */
test('search matches every word in any order, and a bill number in any spelling', async ({ page }) => {
  const categories = en.categories as Record<string, string>;
  const teasers = getTeasers('en');
  const docs = teasers.map((b) => teaserSearchDoc(b, (tag) => categories[tag] ?? tag));
  const matches = (q: string) => teasers.filter((_, i) => matchesBillQuery(parseBillQuery(q), docs[i]));
  let target: (typeof teasers)[number] | undefined;
  let query = '';
  for (const b of teasers) {
    const words = b.title.split(/[^A-Za-z]+/).filter((w) => w.length >= 7);
    if (words.length < 3) continue;
    const q = words.slice(0, 3).reverse().join(' ');
    if (b.title.toLowerCase().includes(q.toLowerCase())) continue;
    if (matches(q).length > 3) continue;
    target = b;
    query = q;
    break;
  }
  test.skip(!target, 'no card title in this corpus yields a narrow three-word query');

  await page.goto('/bills');
  await waitForFeedHydrated(page);
  const search = page.getByRole('searchbox');
  const card = page.locator(`a[href$="/bills/${target!.slug}"]`).first();

  await search.fill(query);
  await expect(card).toBeVisible();

  // The citation, spelled three ways a reader types it; each names this bill.
  const compact = target!.slug.split('-').slice(0, 2).join(''); // "hconres89"
  const spaced = target!.identifier.replace(/\./g, '. ').replace(/\s+/g, ' ').trim(); // "H. Con. Res. 89"
  for (const q of [compact, spaced, compact.toUpperCase()]) {
    await search.fill(q);
    await expect(card, q).toBeVisible();
  }
});

test('the corpus trust line renders at the point of first input, with a live four-digit count', async ({
  page,
}) => {
  await page.goto('/bills');
  // The line carries the LIVE decoded count — assert the shape (a
  // thousands-scale number), never tonight's exact value.
  await expect(page.getByText(/[\d,.]{4,}.*(decoded into plain words|descifrados)/)).toBeVisible();
});
