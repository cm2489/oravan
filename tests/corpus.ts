/*
 * Corpus-derived test expectations, time-parameterized — the ONE test-side
 * mirror of lib/core/bills.ts's pools (docketCorpus / getTopActions /
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
import { TERMINAL_STATUSES, isSignalFresh } from '../lib/urgency.mjs';
import { floorCalendarChamber, floorPendingChamber } from '../lib/journey';
/*
 * THE LADDER ITSELF IS IMPORTED, NOT MIRRORED — the one deliberate break in
 * this file's mirror rule, and the ladder is exactly why it is safe.
 *
 * The mirror exists so a spec can ask "what would this be at time t", and the
 * old scoring answered that with a decay curve plus percentile floors read off
 * the whole corpus — a lot of arithmetic worth reproducing independently.
 * `docketRung` takes `now` as an argument already, so a hand-copy would answer
 * the identical question with the identical inputs and buy nothing but the
 * drift this header exists to prevent. What the mirror still owns is
 * everything BUILT on the rung: the pools, the bands, the tool windows.
 */
import {
  bandForRung,
  compareDocket,
  docketKey,
  docketRung,
  isActNow,
  isDecidingNow,
} from '../lib/docket.mjs';
import floorSignalsJson from '../data/floor-signals.json';
import { BAND_SIZES } from '../lib/taxonomy';
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

/** Same shape as lib/core/bills.ts's billSlug, hoisted above the ladder
 *  helpers that need it to look a signal up. */
export const slugOf = (b: CorpusBill): string =>
  `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();

const FLOOR_SIGNALS = (floorSignalsJson as { signals?: Record<string, unknown> }).signals ?? {};

/** One bill's rung at instant `at` — the mirror's entry point into the ladder. */
export function rungAt(b: CorpusBill, at: number) {
  return docketRung(b, FLOOR_SIGNALS[slugOf(b)] ?? null, { now: at });
}

/** The whole corpus, placed and ordered exactly as lib/core/bills.ts's
 *  `docketCorpus` orders it. */
export function docketedAt(at: number) {
  return corpus
    .map((b) => {
      const rung = rungAt(b, at);
      return { b, rung, key: docketKey({ slug: slugOf(b), date: b.last_action_date, rung }) };
    })
    .sort((x, y) => compareDocket(x.key, y.key));
}

/**
 * THE ACT-NOW POOL (2026-08-12, re-derived on the ladder the same day): every
 * bill on rung T0, T1 or T2 — the chamber announced it, the record says a vote
 * is ripening, or it carries a dated calendar placement still inside the signal
 * window. lib/core/bills.ts's `docketCorpus().actNowPool`, which every "worth a
 * call" surface reads.
 *
 * A bill whose floor question the record has already ANSWERED cannot be here by
 * construction — a rejected motion to proceed, cloture not invoked, a withdrawn
 * measure all fail the T1 rung's settled guard and land on T4 with a
 * `just_decided` annotation. That is the same exclusion the pre-ladder pool
 * made with an explicit filter; it is now structural.
 *
 * NOTE THE POOL IS NOT THE LEAD BAND. /bills' "Deciding now" band is T0 ∪ T1
 * (`decidingNowAt` below); the pool is one rung wider. See lib/docket.mjs's
 * `isActNow` for why, and `anyNowAt`/`bandCountsAt` for the two mirrors.
 */
export function actNowPoolAt(at: number): CorpusBill[] {
  return docketedAt(at)
    .filter((e) => isActNow(e.rung))
    .map((e) => e.b);
}

/** The /bills lead band's membership (T0 ∪ T1) — the narrower claim. */
export function decidingNowAt(at: number): CorpusBill[] {
  return docketedAt(at)
    .filter((e) => isDecidingNow(e.rung))
    .map((e) => e.b);
}

/** Newest last_action_date anywhere in the corpus — the third freshness
 *  signal emptyStateVerdict reads. */
export const newestActionDate = corpus.reduce(
  (max, b) => (b.last_action_date && b.last_action_date > max ? b.last_action_date : max),
  ''
);

/** Mirror of hasActNow: any act-now-pool bill (decoded or not) exists. */
export function anyNowAt(at: number): boolean {
  return actNowPoolAt(at).length > 0;
}

/** Mirror of getTopActions' predicate: a DECODED act-now-pool bill exists. */
export function anyTopAt(at: number): boolean {
  return actNowPoolAt(at).some((b) => b.ai_headline);
}

/** Mirror of getTopActions: slugs in the site's own order (the docket ladder —
 *  rung, then the tier's own significance key, then last action desc, then
 *  slug). */
export function topActionSlugsAt(at: number): string[] {
  return actNowPoolAt(at)
    .filter((b) => b.ai_headline)
    .map(slugOf);
}

/** Mirror of lib/core/mcp.ts's whatsMoving: the act-now pool further gated to
 *  bills with a known last action inside the recency window (and, optionally, a
 *  topic), capped at `limit`. */
export function movingSlugsAt(
  at: number,
  { topic, days = 7, limit = 10 }: { topic?: string; days?: number; limit?: number } = {}
): string[] {
  const cutoff = at - days * 86_400_000;
  return actNowPoolAt(at)
    .filter((b) => b.ai_headline)
    .filter((b) => !topic || (b.issue_tags ?? []).includes(topic))
    .filter((b) => b.last_action_date && new Date(b.last_action_date).getTime() >= cutoff)
    .slice(0, limit)
    .map(slugOf);
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

/** Mirror of /bills' band split (getTeasers): the band IS the rung —
 *  Deciding now = T0 ∪ T1, Moving = T2 ∪ T3, radar = T4 with every terminal
 *  bill pinned there. No floors, no percentiles: see lib/taxonomy.ts's v4
 *  history note for what was retired and why. */
export function bandCountsAt(at: number): Record<'now' | 'moving' | 'radar', number> {
  const counts = { now: 0, moving: 0, radar: 0 };
  for (const b of corpus) counts[bandForRung(rungAt(b, at)) as 'now' | 'moving' | 'radar'] += 1;
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
