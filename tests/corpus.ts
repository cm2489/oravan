/*
 * Corpus-derived test expectations, time-parameterized — the ONE test-side
 * mirror of lib/core/bills.ts's scoring (scoreActiveBills / getTopActions /
 * hasActNow) plus lib/core/mcp.ts's whats_moving recency window.
 *
 * Why a mirror instead of importing lib/core directly: every helper here
 * takes an explicit `at` clock so specs can ask "would this expectation
 * still hold an hour either side of now?" — the production path deliberately
 * reads the real clock (read-time urgency, docs/solutions/
 * stale-urgency-freeze.md). The mirror is pinned against the real
 * implementation by tests/corpus.unit.spec.ts, so it cannot silently drift.
 *
 * Why the stability guard exists (2026-07-22): these suites branch on the
 * live nightly-synced corpus by design — a hot legislative week flips
 * expectations instead of breaking CI. But the corpus scores decay with the
 * real clock, so a bill sitting exactly at a band floor, a bonus breakpoint
 * (3d/7d), or the recency window's edge can flip between `next build` baking
 * the pages and the assertion minutes later — a red that diagnoses as
 * "flaky" and costs a debugging round (it did, twice, 2026-07-21/22).
 * `stableAcross` evaluates an expectation at both ends of a generous window
 * around now; specs skip-with-reason when the two disagree, so a knife-edge
 * corpus reads as an explicit skip, never a gamble. Every score here is
 * monotonically non-increasing in time (bonuses only expire, decay only
 * grows, floors only fall toward the absolute minimum), so agreeing
 * endpoints imply a stable interior.
 */
import billsJson from '../data/bills.json';
import syncState from '../data/sync-state.json';
import { TERMINAL_STATUSES, effectiveUrgency } from '../lib/urgency.mjs';
import { BAND_SIZES, bandFloors, bandForEff, type BandFloors } from '../lib/taxonomy';
import { FRESHNESS_DEAD_WINDOW_DAYS, freshnessAgeDays, freshnessState } from '../lib/freshness-state';

export interface CorpusBill {
  bill_type: string;
  bill_number: number;
  congress_number: number;
  status: string;
  last_action_date: string | null;
  ai_headline: string | null;
  issue_tags?: string[];
}

export const corpus = billsJson as unknown as CorpusBill[];
export const activeBills = corpus.filter((b) => !TERMINAL_STATUSES.has(b.status));

/** Same shape as lib/core/bills.ts's billSlug. */
export const slugOf = (b: CorpusBill): string =>
  `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();

/** Newest last_action_date anywhere in the corpus — the third freshness
 *  signal emptyStateVerdict reads. */
export const newestActionDate = corpus.reduce(
  (max, b) => (b.last_action_date && b.last_action_date > max ? b.last_action_date : max),
  ''
);

export function floorsAt(at: number): BandFloors {
  const effs = activeBills
    .map((b) => effectiveUrgency(b.status, b.last_action_date, at))
    .sort((a, b) => b - a);
  return bandFloors(effs);
}

/** Mirror of hasActNow: any active bill (decoded or not) clears the now floor. */
export function anyNowAt(at: number): boolean {
  const floors = floorsAt(at);
  return activeBills.some(
    (b) => effectiveUrgency(b.status, b.last_action_date, at) >= floors.nowFloor
  );
}

/** Mirror of getTopActions' predicate: a DECODED active bill clears it. */
export function anyTopAt(at: number): boolean {
  const floors = floorsAt(at);
  return activeBills.some(
    (b) =>
      b.ai_headline && effectiveUrgency(b.status, b.last_action_date, at) >= floors.nowFloor
  );
}

/** Mirror of getTopActions: slugs in the site's own order (urgency desc,
 *  then last-action desc — lib/core/bills.ts's byUrgencyDesc). */
export function topActionSlugsAt(at: number): string[] {
  const floors = floorsAt(at);
  return activeBills
    .map((b) => ({ b, eff: effectiveUrgency(b.status, b.last_action_date, at) }))
    .filter((s) => s.eff >= floors.nowFloor && s.b.ai_headline)
    .sort(
      (x, y) =>
        y.eff - x.eff ||
        (y.b.last_action_date ?? '').localeCompare(x.b.last_action_date ?? '')
    )
    .map((s) => slugOf(s.b));
}

/** Mirror of lib/core/mcp.ts's whatsMoving: the Act-now pool further gated
 *  to bills with a known last action inside the recency window (and,
 *  optionally, a topic), capped at `limit`. */
export function movingSlugsAt(
  at: number,
  { topic, days = 7, limit = 10 }: { topic?: string; days?: number; limit?: number } = {}
): string[] {
  const floors = floorsAt(at);
  const cutoff = at - days * 86_400_000;
  return activeBills
    .map((b) => ({ b, eff: effectiveUrgency(b.status, b.last_action_date, at) }))
    .filter((s) => s.eff >= floors.nowFloor && s.b.ai_headline)
    .filter((s) => !topic || (s.b.issue_tags ?? []).includes(topic))
    .filter((s) => s.b.last_action_date && new Date(s.b.last_action_date).getTime() >= cutoff)
    .sort(
      (x, y) =>
        y.eff - x.eff ||
        (y.b.last_action_date ?? '').localeCompare(x.b.last_action_date ?? '')
    )
    .slice(0, limit)
    .map((s) => slugOf(s.b));
}

/** Mirror of emptyStateVerdict's data_stale collapse (lib/freshness-state.ts),
 *  fed the same three signals whats_moving reads. */
export function expectDataStaleAt(at: number): boolean {
  return (
    freshnessState(syncState.lastRun, at) !== 'fresh' ||
    freshnessAgeDays(syncState.lastSync, at) > FRESHNESS_DEAD_WINDOW_DAYS ||
    freshnessAgeDays(newestActionDate, at) > FRESHNESS_DEAD_WINDOW_DAYS
  );
}

/** Mirror of /bills' band split (getTeasers): active bills band by floor,
 *  terminal bills pin to radar. True when any band would render its
 *  "Show all" button (more items than the BAND_CAP display slice). */
export function anyBandExceedsCapAt(at: number): boolean {
  const floors = floorsAt(at);
  const counts: Record<string, number> = {};
  for (const b of corpus) {
    const band = TERMINAL_STATUSES.has(b.status)
      ? 'radar'
      : bandForEff(effectiveUrgency(b.status, b.last_action_date, at), floors);
    counts[band] = (counts[band] ?? 0) + 1;
  }
  return Object.values(counts).some((n) => n > BAND_SIZES.now);
}

/** Generous bound on how far the assertion clock can sit from the clock
 *  `next build` baked the pages with (CI builds minutes before asserting). */
export const CLOCK_SKEW_MS = 60 * 60 * 1000;

/** True when a corpus-derived expectation reads the same at both ends of the
 *  skew window — safe to assert. False = knife-edge: skip-with-reason. */
export function stableAcross(fn: (at: number) => unknown): boolean {
  const now = Date.now();
  return (
    JSON.stringify(fn(now - CLOCK_SKEW_MS)) === JSON.stringify(fn(now + CLOCK_SKEW_MS))
  );
}
