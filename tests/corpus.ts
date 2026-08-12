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
import { TERMINAL_STATUSES, effectiveUrgency, isSignalFresh } from '../lib/urgency.mjs';
import { floorCalendarChamber, floorPendingChamber } from '../lib/journey';
import { BAND_SIZES, bandFloors, bandForEff, type BandFloors } from '../lib/taxonomy';
import { FRESHNESS_DEAD_WINDOW_DAYS, freshnessAgeDays, freshnessState } from '../lib/freshness-state';

export interface CorpusBill {
  bill_type: string;
  bill_number: number;
  congress_number: number;
  status: string;
  last_action_date: string | null;
  last_action_text: string | null;
  ai_headline: string | null;
  issue_tags?: string[];
  /** Read by mcp-tools.spec.ts to derive get_representative's sponsored
   *  window from the corpus instead of naming a bill inside it. */
  sponsor_bioguide_id?: string | null;
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
 *  terminal bills pin to radar. */
export function bandCountsAt(at: number): Record<'now' | 'moving' | 'radar', number> {
  const floors = floorsAt(at);
  const counts = { now: 0, moving: 0, radar: 0 };
  for (const b of corpus) {
    const band = TERMINAL_STATUSES.has(b.status)
      ? 'radar'
      : bandForEff(effectiveUrgency(b.status, b.last_action_date, at), floors);
    counts[band] += 1;
  }
  return counts;
}

/** True when any band would render its "Show all" button (more items than
 *  the BAND_CAP display slice). */
export function anyBandExceedsCapAt(at: number): boolean {
  return Object.values(bandCountsAt(at)).some((n) => n > BAND_SIZES.now);
}

/**
 * Bills carrying a DATED floor-calendar placement, split by the published
 * signal window — the two sides of the bill page's green-panel gate.
 *
 * Derived rather than pinned because which placements are fresh moves with
 * the clock AND with the nightly sync. The stale side is the larger by far
 * (261 of 313 on 2026-08-09, the day the freshness half of that gate was
 * added): a placement is a one-time event and the sentence over it —
 * "This bill is queued for a vote of the full Senate" — is present tense.
 */
export function calendarPlacementSlugs(at: number): { fresh: string[]; stale: string[] } {
  const fresh: string[] = [];
  const stale: string[] = [];
  for (const b of corpus) {
    if (b.status !== 'floor_vote' || !b.last_action_date) continue;
    if (floorCalendarChamber(b.last_action_text) === null) continue;
    (isSignalFresh(b.last_action_date, at) ? fresh : stale).push(slugOf(b));
  }
  return { fresh: fresh.sort(), stale: stale.sort() };
}

/**
 * Bills whose newest action is a PENDING floor vote and NOT a placement —
 * cloture filed, a motion to proceed made, proceedings postponed, a rule
 * reported — split by the same published signal window.
 *
 * The other half of the bill page's green-panel gate since 2026-08-11. The
 * homepage crown has read this fact since the 2026-08-09 ruling; the bill page
 * read only placements, so a crowned "Floor vote pending in the Senate" lost
 * its band one click later. Derived, never pinned: the pending set is small
 * (8 bills on 2026-08-11, 2 of them inside the window) and it turns over with
 * every sync, so a named bill would be a trap by next week.
 *
 * `calendar` is excluded rather than merely losing the tie, because these
 * slugs drive assertions about the PENDING copy specifically.
 */
export function floorPendingSlugs(at: number): { fresh: string[]; stale: string[] } {
  const fresh: string[] = [];
  const stale: string[] = [];
  for (const b of corpus) {
    if (b.status !== 'floor_vote' || !b.last_action_date) continue;
    if (floorCalendarChamber(b.last_action_text) !== null) continue;
    if (floorPendingChamber(b.last_action_text) === null) continue;
    (isSignalFresh(b.last_action_date, at) ? fresh : stale).push(slugOf(b));
  }
  return { fresh: fresh.sort(), stale: stale.sort() };
}

/** The chamber the record names for a pending-floor bill, by slug — the specs
 *  assert the chamber-specific sentence, and must read it out of the same
 *  sentence the page does rather than guess it from the bill type (H.R. 3633
 *  is a House bill standing on a SENATE cloture motion). */
export function pendingChamberOf(slug: string): 'house' | 'senate' | null {
  const bill = corpus.find((b) => slugOf(b) === slug);
  return bill ? floorPendingChamber(bill.last_action_text) : null;
}

/**
 * DECODED bills whose record puts the live call in the Senate with no prior
 * chamber vote — liveCallTarget → {chamber:'senate', afterVote:false}, the
 * routing that prints `bill.liveSenateFloor`.
 *
 * Derived, not pinned, and that is the whole point. The routing specs used to
 * drive S.J.Res. 99, whose last action is a REJECTED motion to proceed. Once
 * the 2026-08-09 floor-truth fix stopped calling a dead motion a live call,
 * that bill correctly prints no routing sentence at all — one spec would have
 * failed and the other (the no-senator gate) would have started passing
 * vacuously, which is worse. Naming a different bill would only re-arm the
 * same trap on the next sync, so the specs ask the corpus for a bill that is
 * genuinely in the Senate's hands.
 *
 * THE FRESHNESS HALF, added 2026-08-11 with liveCallTarget's own clock: the
 * routing now requires the floor signal to be inside the published window, so
 * this mirror must too or the specs would drive a bill whose page prints no
 * routing sentence — the same trap, re-armed by the clock instead of by the
 * vocabulary. On the corpus that day it cut the pool from 177 slugs to 19; re-
 * measured 2026-08-12, after #210 purged the two previous-Congress records,
 * 176 to 19.
 *
 * Freshness is judged at `now + CLOCK_SKEW_MS` rather than at `now`, and that
 * is the whole flake guard: a signal fresh at the LATE end of the window was
 * fresh at every earlier instant too (isSignalFresh only ever expires), so a
 * bill this function returns was already live when `next build` baked its
 * page, however many minutes ago that was. No spec needs a stability skip for
 * it.
 */
export function senateLiveBillSlugs(at: number = Date.now()): string[] {
  return corpus
    .filter((b) => b.status === 'floor_vote' && b.ai_headline)
    .filter((b) => isSignalFresh(b.last_action_date, at + CLOCK_SKEW_MS))
    .filter(
      (b) =>
        floorCalendarChamber(b.last_action_text) === 'senate' ||
        floorPendingChamber(b.last_action_text) === 'senate'
    )
    .map(slugOf)
    .sort();
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
