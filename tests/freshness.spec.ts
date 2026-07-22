import { expect, test, type Page } from '@playwright/test';
import syncState from '../data/sync-state.json';
import { FRESHNESS_DEAD_WINDOW_DAYS, freshnessAgeDays } from '../lib/freshness-state';
import { anyNowAt, anyTopAt, newestActionDate, stableAcross } from './corpus';
import { waitForFeedHydrated } from './helpers';

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

// The corpus mirror (scoreActiveBills + getTopActions on the same shared
// modules the site imports) lives in tests/corpus.ts — one copy shared with
// funnel.spec.ts / feed.spec.ts / mcp-tools.spec.ts, drift-pinned by
// corpus.unit.spec.ts. Evaluated at the real clock — the same clock the
// server used when the suite's `npm run build` baked these pages minutes ago.
/** Any active bill clears the "Act now" floor (site: hasActNow / getTeasers' now band). */
const anyNow = anyNowAt(Date.now());
/** Any DECODED active bill clears it (site: getTopActions — the homepage cards). */
const anyTop = anyTopAt(Date.now());
/** The build baked one branch of the tri-state; when the corpus sits at a
 *  scoring boundary the assert-time recomputation can disagree with it —
 *  skip the branch-dependent tests then, never gamble (tests/corpus.ts). */
const CORPUS_STABLE = stableAcross((at) => [anyNowAt(at), anyTopAt(at)]);

const LAST_RUN = new Date(syncState.lastRun).getTime();
const FRESH_CLOCK = LAST_RUN + 60 * 60 * 1000; // 1h after the last check
const STALE_CLOCK = LAST_RUN + 10 * 86_400_000; // past the 5d claim window
const DEAD_CLOCK = LAST_RUN + 30 * 86_400_000; // past the 21d dead window

// 2026-07-16 (audit §5 item 4): emptyStateVerdict no longer looks only at
// lastRun/checkedAt — the sync cursor (lastSync/completeThrough) and the
// corpus's own newest last_action_date (tests/corpus.ts's newestActionDate)
// now independently gate the verdict too (lib/freshness-state.ts). Mirror
// that here, corpus-derived exactly like anyNow/anyTop above, rather than
// hardcoding today's specific data — so these tests keep tracking the
// site's real behavior as the nightly sync rewrites data/ instead of
// silently drifting from it. Deterministic (fixed clock over static data),
// so it needs no CORPUS_STABLE guard.
/** Whether the empty-state verdict reads data_stale AT FRESH_CLOCK for a
 *  reason that has nothing to do with lastRun (which is fresh by
 *  construction at FRESH_CLOCK) — i.e. the cursor or the corpus's newest
 *  known activity has gone dark past the dead window. */
const contentStaleAtFreshClock =
  freshnessAgeDays(syncState.lastSync, FRESH_CLOCK) > FRESHNESS_DEAD_WINDOW_DAYS ||
  freshnessAgeDays(newestActionDate, FRESH_CLOCK) > FRESHNESS_DEAD_WINDOW_DAYS;

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
  test('fresh clock: quiet week reads as quiet — and only on a truly quiet, genuinely current corpus', async ({ page }) => {
    test.skip(!CORPUS_STABLE, 'corpus sits at a scoring boundary — the baked branch could flip before the assert');
    const hydrationErrors = trackHydrationErrors(page);
    await page.clock.setFixedTime(FRESH_CLOCK);
    await page.goto('/');
    const quietCard = page.getByRole('status').filter({ hasText: /Quiet week/ });
    const staleCard = page.getByRole('status').filter({ hasText: /Data check needed/ });
    if (anyTop) {
      // Hot corpus: cards render, no quiet-week claim anywhere.
      await expect(
        page.locator('section[aria-labelledby="top-actions"] a[href*="/bills/"]').first()
      ).toBeVisible();
      await expect(quietCard).toHaveCount(0);
    } else if (contentStaleAtFreshClock) {
      // The band is empty, but the sync cursor or the corpus's own newest
      // activity is dead-window-stale — never claim "quiet" over that, even
      // though lastRun (checkedAt) itself is fresh at this clock (2026-07-16
      // fix, audit §5 item 4: emptyStateVerdict no longer looks at lastRun
      // alone).
      await expect(staleCard).toBeVisible();
      await expect(quietCard).toHaveCount(0);
    } else if (!anyNow) {
      // Genuinely quiet AND genuinely current: the honest empty state, never
      // a padded card.
      await expect(quietCard).toBeVisible();
    } else {
      // Floor cleared only by undecoded bills: no cards, but also no false
      // "quiet week" claim (it would contradict /bills' Act-now band).
      await expect(quietCard).toHaveCount(0);
    }
    expect(hydrationErrors, 'no hydration mismatch from the client verdict').toEqual([]);
  });

  test('Spanish locale renders the same verdict in Spanish', async ({ page }) => {
    test.skip(!CORPUS_STABLE, 'corpus sits at a scoring boundary — the baked branch could flip before the assert');
    test.skip(anyNow, 'corpus not quiet this week — ES quiet-week copy not renderable');
    await page.clock.setFixedTime(FRESH_CLOCK);
    await page.goto('/es');
    const text = contentStaleAtFreshClock ? 'Verificación pendiente' : 'Semana tranquila';
    await expect(page.getByRole('status').filter({ hasText: text })).toBeVisible();
  });

  test('stale clock: the empty slot says "data check needed", never "quiet"', async ({ page }) => {
    test.skip(!CORPUS_STABLE, 'corpus sits at a scoring boundary — the baked branch could flip before the assert');
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
    test.skip(!CORPUS_STABLE, 'corpus sits at a scoring boundary — the baked branch could flip before the assert');
    test.skip(anyNow, 'corpus not quiet this week — empty band not renderable');
    await page.clock.setFixedTime(DEAD_CLOCK);
    await page.goto('/');
    const status = page.getByRole('status').filter({ hasText: /Data check needed|Quiet week/ });
    await expect(status).toContainText('Data check needed');
  });
});

test.describe('AE3: /bills "Act now" band mirrors the same tri-state', () => {
  test('unfiltered empty band shows the honest empty state; a filter never fakes one', async ({ page }) => {
    test.skip(!CORPUS_STABLE, 'corpus sits at a scoring boundary — the baked branch could flip before the assert');
    await page.clock.setFixedTime(FRESH_CLOCK);
    await page.goto('/bills');
    // The search interaction below drives a controlled input — wedged if it
    // fires before React attaches (tests/helpers.ts) — and the 2026-07-22 CI
    // reds were exactly that lost fill on webkit. Wait it out up front.
    await waitForFeedHydrated(page);
    const quietCard = page.getByRole('status').filter({ hasText: /Quiet week/ });
    const staleCard = page.getByRole('status').filter({ hasText: /Data check needed/ });
    if (!anyNow) {
      // The unfiltered now band renders the empty-state card under its
      // header — quiet_week only when the cursor/corpus are also genuinely
      // current at this clock (audit §5 item 4), data_stale otherwise.
      await expect(page.locator('section[aria-labelledby="band-now"]').getByRole('status')).toBeVisible();
      if (contentStaleAtFreshClock) {
        await expect(staleCard).toBeVisible();
        await expect(quietCard).toHaveCount(0);
      } else {
        await expect(quietCard).toBeVisible();
      }
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
