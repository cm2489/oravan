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

/**
 * The AE3 collapse rule as an importable primitive: an empty "Act now" band
 * is a quiet week only while the data is fresh; both 'stale' and 'dead'
 * collapse to data_stale — never assert quiet on dead data. This is the ONE
 * copy of that rule: the site's empty band renders it (components/
 * UrgencyEmptyState.tsx), and the future MCP `whats_moving` tool must import
 * this same function rather than re-deriving the collapse inline — a second
 * copy is the exact drift docs/solutions/stale-urgency-freeze.md closed for
 * the urgency curve.
 */
export function emptyStateVerdict(checkedAt: string, now: number = Date.now()): EmptyStateVerdict {
  return freshnessState(checkedAt, now) === 'fresh' ? 'quiet_week' : 'data_stale';
}
