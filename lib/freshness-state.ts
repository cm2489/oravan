/*
 * Pure freshness-age math, deliberately split out of lib/freshness.ts (which
 * reads data/sync-state.json and data/bills.json and is 'server-only'). This
 * file has no data import, so it's safe to ship to a client bundle - the
 * KTD-2 staleness note is a 'use client' component precisely because it must
 * re-diff `checkedAt` against the visitor's real clock at render time. Baking
 * "fresh" into a statically-generated page (this site is ~1,000 SSG pages)
 * would freeze that verdict at build time, so a dead pipeline reads as
 * eternally fresh to anyone loading the page after the next deploy stops
 * happening - the exact silent-failure shape docs/solutions/
 * pinned-sync-cursor.md and bare-date-cursor-400.md already document for the
 * sync pipeline itself.
 */

export type FreshnessState = 'fresh' | 'stale' | 'dead';

/** How many days old `checkedAt` can be before the "as of" claim needs a
 *  caveat (KTD-2's quiet-week vs data-stale boundary). */
export const FRESHNESS_CLAIM_WINDOW_DAYS = 5;

/** Beyond this, the nightly pipeline reads as dead, not just running a bit
 *  behind schedule. */
export const FRESHNESS_DEAD_WINDOW_DAYS = 21;

/** Age of `checkedAt` in days, as of `now`. Unparseable input reads as
 *  infinitely old rather than throwing, so a corrupted timestamp fails
 *  toward "stale", never toward a false "fresh". */
export function freshnessAgeDays(checkedAt: string, now: number = Date.now()): number {
  const t = new Date(checkedAt).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (now - t) / 86_400_000;
}

export function freshnessState(checkedAt: string, now: number = Date.now()): FreshnessState {
  const days = freshnessAgeDays(checkedAt, now);
  if (days > FRESHNESS_DEAD_WINDOW_DAYS) return 'dead';
  if (days > FRESHNESS_CLAIM_WINDOW_DAYS) return 'stale';
  return 'fresh';
}

export type EmptyStateVerdict = 'quiet_week' | 'data_stale';

/** The three freshness signals `emptyStateVerdict` reads — structurally the
 *  same shape as lib/freshness.ts's `Freshness`, redeclared here (rather than
 *  imported) so this file stays free of any data import and safe to ship to
 *  a client bundle, per the header comment above. */
export interface FreshnessSignals {
  /** Last successful nightly sync run — "did the job run at all". */
  checkedAt: string;
  /** Sync cursor high-water mark — "how far the backlog scan has actually
   *  processed" (data/sync-state.json's lastSync). */
  completeThrough: string;
  /** Newest `last_action_date` across the whole corpus — "is there anything
   *  current in the data at all", regardless of what the sync's own
   *  bookkeeping claims. */
  newestAction: string;
}

/**
 * The AE3 collapse rule as an importable primitive: an empty "Act now" band
 * reads as a genuine quiet_week only when EVERY freshness signal checks out.
 * This is the ONE copy of that rule: the site's empty band renders it
 * (components/UrgencyEmptyState.tsx), and lib/core/mcp.ts's `whatsMoving`
 * imports this same function rather than re-deriving the collapse inline —
 * a second copy is the exact drift docs/solutions/stale-urgency-freeze.md
 * closed for the urgency curve.
 *
 * Two different thresholds, deliberately (2026-07-16, audit §5 item 4):
 *  - `checkedAt` (did the nightly job even run tonight) uses the tight
 *    FRESHNESS_CLAIM_WINDOW_DAYS/FRESHNESS_DEAD_WINDOW_DAYS pair via
 *    freshnessState — a "we checked recently" claim should go stale fast.
 *  - `completeThrough` (the sync cursor) and `newestAction` (the corpus's
 *    own newest activity) instead trip data_stale only past
 *    FRESHNESS_DEAD_WINDOW_DAYS, the wider of the two constants. Both are
 *    EXPECTED to lag `checkedAt` by real days under ordinary operation — the
 *    ascending backlog-scan cursor deliberately trails while it drains (see
 *    lib/freshness.ts's own doc comment and scripts/sync-bills.mjs's
 *    two-pass fetch design note) — so gating them on the tight claim window
 *    would make the site cry "data stale" every single night even when
 *    tonight's recent-first pass kept the actually-relevant content current.
 *    The wide dead window instead catches the failure mode this item exists
 *    for: a pipeline that runs every night, commits every night, and reports
 *    itself "fresh" via `checkedAt` alone while making no real forward
 *    progress for weeks (the bug this audit found — a 29-day-old cursor and
 *    a 29-day-old newest action, both silently passing as "fresh" under the
 *    old checkedAt-only check). Past three weeks with NOTHING new anywhere
 *    in the corpus, "quiet week" stops being a credible claim regardless of
 *    how recently the job merely executed.
 */
export function emptyStateVerdict(signals: FreshnessSignals, now: number = Date.now()): EmptyStateVerdict {
  if (freshnessState(signals.checkedAt, now) !== 'fresh') return 'data_stale';
  if (freshnessAgeDays(signals.completeThrough, now) > FRESHNESS_DEAD_WINDOW_DAYS) return 'data_stale';
  if (freshnessAgeDays(signals.newestAction, now) > FRESHNESS_DEAD_WINDOW_DAYS) return 'data_stale';
  return 'quiet_week';
}
