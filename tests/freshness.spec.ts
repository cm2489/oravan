import { expect, test, type Page } from '@playwright/test';
import syncState from '../data/sync-state.json';
import bills from '../data/bills.json';
import { TERMINAL_STATUSES, effectiveUrgency } from '../lib/urgency.mjs';
import { bandFloors } from '../lib/taxonomy';

/*
 * KTD-1 / KTD-2 / AE3. The stamp is baked at build time from getFreshness()
 * (fine - a plain historical fact, not a value judgment), so it's asserted
 * directly against data/sync-state.json. The quiet-week/data-stale tri-state
 * is a live client-side judgment (must never freeze into an SSG page), so
 * it's exercised with Playwright's clock moving the VISITOR's clock only.
 *
 * The AE3 expectations are corpus-derived, not hardcoded: whether "Act now"
 * is empty depends on the live data/bills.json, which the nightly sync
 * rewrites. These tests mirror the site's own floor math (same modules, same
 * curve) and branch on what the corpus actually contains, so a hot
 * legislative week flips the expectations instead of breaking CI.
 */

const fmt = (iso: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(iso));

// Mirror lib/data.ts scoreActiveBills + getTopActions, using the same shared
// modules the site imports (the ONE urgency curve + the ONE floor function).
// effectiveUrgency reads the real clock — the same clock the server used
// when the suite's `npm run build` baked these pages minutes ago.
type CorpusBill = { status: string; last_action_date: string | null; ai_headline: string | null };
const active = (bills as CorpusBill[]).filter((b) => !TERMINAL_STATUSES.has(b.status));
const effs = active.map((b) => effectiveUrgency(b.status, b.last_action_date)).sort((a, b) => b - a);
const floors = bandFloors(effs);
/** Any active bill clears the "Act now" floor (site: hasActNow / getTeasers' now band). */
const anyNow = active.some((b) => effectiveUrgency(b.status, b.last_action_date) >= floors.nowFloor);
/** Any DECODED active bill clears it (site: getTopActions — the homepage cards). */
const anyTop = active.some(
  (b) => b.ai_headline && effectiveUrgency(b.status, b.last_action_date) >= floors.nowFloor
);

const LAST_RUN = new Date(syncState.lastRun).getTime();
const FRESH_CLOCK = LAST_RUN + 60 * 60 * 1000; // 1h after the last check
const STALE_CLOCK = LAST_RUN + 10 * 86_400_000; // past the 5d claim window
const DEAD_CLOCK = LAST_RUN + 30 * 86_400_000; // past the 21d dead window

/** Collect hydration-related console errors — the AE3 client verdict must
 *  never be bought at the price of a server/client HTML mismatch. */
function trackHydrationErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /hydrat|did not match|418|423|425/i.test(msg.text())) {
      errors.push(msg.text());
    }
  });
  return errors;
}

test.describe('freshness stamp reads from sync-state via the shared accessor', () => {
  test('bill page (English): "Data as of {date}" matches sync-state.lastRun', async ({ page }) => {
    await page.goto('/bills/hr-5582-119');
    await expect(page.getByText(`Data as of ${fmt(syncState.lastRun, 'en')}`)).toBeVisible();
  });

  test('bill page (Spanish): "Datos al {date}" matches sync-state.lastRun', async ({ page }) => {
    await page.goto('/es/bills/hr-5582-119');
    await expect(page.getByText(`Datos al ${fmt(syncState.lastRun, 'es')}`)).toBeVisible();
  });

  test('homepage and /bills carry the same stamp (single code path)', async ({ page }) => {
    // .first(): pre-hydration, the empty-state card renders the same
    // verdict-neutral "Data as of" line as the stamp itself.
    const stamp = `Data as of ${fmt(syncState.lastRun, 'en')}`;
    await page.goto('/');
    await expect(page.getByText(stamp).first()).toBeVisible();
    await page.goto('/bills');
    await expect(page.getByText(stamp).first()).toBeVisible();
  });
});

test.describe('AE3: quiet-week vs data-stale tri-state (homepage)', () => {
  test('fresh clock: quiet week reads as quiet — and only on a truly quiet corpus', async ({ page }) => {
    const hydrationErrors = trackHydrationErrors(page);
    await page.clock.setFixedTime(FRESH_CLOCK);
    await page.goto('/');
    const quietCard = page.getByRole('status').filter({ hasText: /Quiet week/ });
    if (anyTop) {
      // Hot corpus: cards render, no quiet-week claim anywhere.
      await expect(
        page.locator('section[aria-labelledby="top-actions"] a[href*="/bills/"]').first()
      ).toBeVisible();
      await expect(quietCard).toHaveCount(0);
    } else if (!anyNow) {
      // Genuinely quiet: the honest empty state, never a padded card.
      await expect(quietCard).toBeVisible();
    } else {
      // Floor cleared only by undecoded bills: no cards, but also no false
      // "quiet week" claim (it would contradict /bills' Act-now band).
      await expect(quietCard).toHaveCount(0);
    }
    expect(hydrationErrors, 'no hydration mismatch from the client verdict').toEqual([]);
  });

  test('Spanish locale renders the same verdict in Spanish', async ({ page }) => {
    test.skip(anyNow, 'corpus not quiet this week — ES quiet-week copy not renderable');
    await page.clock.setFixedTime(FRESH_CLOCK);
    await page.goto('/es');
    await expect(page.getByRole('status').filter({ hasText: 'Semana tranquila' })).toBeVisible();
  });

  test('stale clock: the empty slot says "data check needed", never "quiet"', async ({ page }) => {
    test.skip(anyNow, 'corpus not quiet this week — empty band not renderable');
    const hydrationErrors = trackHydrationErrors(page);
    await page.clock.setFixedTime(STALE_CLOCK);
    await page.goto('/');
    const status = page.getByRole('status').filter({ hasText: /Data check needed|Quiet week/ });
    await expect(status).toContainText('Data check needed');
    await expect(status).not.toContainText('Quiet week');
    expect(hydrationErrors, 'no hydration mismatch in the stale flip').toEqual([]);
  });

  test('dead clock (>21d): still an honest stale message, still never "quiet"', async ({ page }) => {
    test.skip(anyNow, 'corpus not quiet this week — empty band not renderable');
    await page.clock.setFixedTime(DEAD_CLOCK);
    await page.goto('/');
    const status = page.getByRole('status').filter({ hasText: /Data check needed|Quiet week/ });
    await expect(status).toContainText('Data check needed');
  });
});

test.describe('AE3: /bills "Act now" band mirrors the same tri-state', () => {
  test('unfiltered empty band shows the honest empty state; a filter never fakes one', async ({ page }) => {
    await page.clock.setFixedTime(FRESH_CLOCK);
    await page.goto('/bills');
    const quietCard = page.getByRole('status').filter({ hasText: /Quiet week/ });
    if (!anyNow) {
      // The unfiltered now band renders the quiet-week card under its header.
      await expect(page.locator('section[aria-labelledby="band-now"]').getByRole('status')).toBeVisible();
      await expect(quietCard).toBeVisible();
    } else {
      await expect(page.locator('section[aria-labelledby="band-now"] a[href*="/bills/"]').first()).toBeVisible();
      await expect(quietCard).toHaveCount(0);
    }
    // A search that matches nothing empties every band — that's filtering,
    // not a quiet week, and must never render the claim (KTD-2 guard).
    await page.getByRole('searchbox').fill('zzzzqqq');
    await expect(page.getByText(/No bills match/)).toBeVisible();
    await expect(quietCard).toHaveCount(0);
  });
});

test.describe('R2: staleness note on populated (call-urging) surfaces', () => {
  test('bill page: hidden while fresh, a quiet caveat once the check is overdue', async ({ page }) => {
    await page.clock.setFixedTime(FRESH_CLOCK);
    await page.goto('/bills/hr-5582-119');
    await expect(page.getByText(/newer activity in Congress may not be shown yet/)).toBeHidden();

    await page.clock.setFixedTime(STALE_CLOCK);
    await page.goto('/bills/hr-5582-119');
    await expect(page.getByText(/newer activity in Congress may not be shown yet/)).toBeVisible();
  });

  test('bill page (Spanish): the caveat is localized', async ({ page }) => {
    await page.clock.setFixedTime(STALE_CLOCK);
    await page.goto('/es/bills/hr-5582-119');
    await expect(page.getByText(/actividad más reciente del Congreso aún no se muestre/)).toBeVisible();
  });
});
