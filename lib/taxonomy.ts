/** The 12 CRS-anchored issue categories. Labels live in messages/{locale}.json under "categories". */
export const CATEGORIES = [
  'jobs_economy',
  'health',
  'national_security',
  'environment_energy',
  'government_democracy',
  'crime_justice',
  'family_community',
  'education',
  'immigration',
  'ai_technology',
  'housing',
  'rights_liberties',
] as const;

export type Category = (typeof CATEGORIES)[number];

export type UrgencyBand = 'now' | 'moving' | 'radar';

/*
 * Bands have been reversed once already; both reversals are recorded here so
 * a future change doesn't re-litigate settled ground (KTD-2).
 *
 * v1 (launch). Absolute score thresholds: score >= 0.75 = "Act now",
 * >= 0.5 = "Moving". Real legislative cadence leaves most bills idle in
 * committee for months, so the threshold left "Act now" empty almost every
 * week - the feed's whole promise silently failing.
 *
 * v2 (commit 21dfaaf, "Rank-based urgency bands so 'Act now' is never
 * empty"). Thresholds became pure rank cutoffs - a band's floor is just the
 * urgency of the bill at its rank, so "Act now" always shows the 6 most
 * urgent active bills and "Moving" the next 12, no matter how urgent (or
 * not) any of them actually are. That traded one dishonesty for another: on
 * a genuinely quiet week, ordinary committee bills still got dressed up as
 * "Act now" because *something* had to fill the slot.
 *
 * v3 (KTD-2, this change). The v1 absolute floors return, layered on top of
 * v2 rather than replacing it: a bill only earns a band if it clears BOTH
 * the rank cutoff and the absolute floor, whichever is stricter. Ranking
 * still decides order among qualifying bills; the floor decides whether the
 * band gets to exist at all this week. When nothing clears "Act now", the
 * site says so - a designed quiet-week (or, if the data itself is stale,
 * data-stale) state, never a rank-forced backfill. Honesty over fullness is
 * the deliberate verdict this time. See lib/freshness-state.ts and
 * components/UrgencyEmptyState.tsx for the empty-state rendering, and
 * lib/data.ts's getTeasers/getTopActions for where the floor is applied.
 *
 * Each bill is compared against the floor rather than sliced by index, so two
 * bills with identical urgency always share a band instead of being split
 * across the line by an arbitrary tie-break.
 */
export const BAND_SIZES = { now: 6, moving: 12 } as const;

export interface BandFloors {
  nowFloor: number;
  movingFloor: number;
}

/** The v1 absolute floors, reinstated in v3 as a hard minimum - see the
 *  history above. Pinned in tests/taxonomy.unit.spec.ts. */
export const ABSOLUTE_FLOORS: BandFloors = { nowFloor: 0.75, movingFloor: 0.5 };

/*
 * v3a (2026-08-09). THE MIDDLE BAND CAME BACK.
 *
 * v3 read the moving floor off a FIXED rank — the 18th bill, `now`'s 6 plus
 * `moving`'s 12 — which silently assumed the "now" band ends at rank 6. It
 * does not. Bands are compared by VALUE precisely so tied bills share a band
 * (see the note at the end of the history above), so a tie block straddling
 * rank 6 pulls every tied bill into "now" and can swallow rank 18 whole. When
 * that happened the derived movingFloor came out EQUAL to nowFloor, and
 * bandForEff tests `eff >= nowFloor` first — so "moving" became unreachable
 * and the middle band vanished from /bills without erroring. On the corpus of
 * 2026-08-09, 21 active bills tied at eff 0.95: bands read now 21 / moving 0 /
 * radar 2,645, and 38 bills that outscored 98% of the corpus rendered under
 * "On the radar — quieter right now".
 *
 * THE FIX: start the moving rank window where the "now" band actually ends,
 * not where rank alone predicted it would. `firstBelowNow` is the first bill
 * the now-floor does not claim; the moving floor is the 12th bill from there.
 *
 * Why that and not an epsilon (nowFloor - 0.001): an epsilon only rescues
 * bills within a hair of the top block. Today's next distinct score is 0.90,
 * a full 0.05 below, so every epsilon small enough to be honest leaves the
 * band exactly as empty as the bug did. The rank window is also what v3
 * actually meant — "moving" is the next twelve — and it REDUCES to the old
 * expression whenever nothing ties across the cutoff (no ties ⇒
 * firstBelowNow === 6 ⇒ the floor is still read at rank 18), so the ordinary
 * week is untouched.
 *
 * The strict ordering movingFloor < nowFloor is structural here, not clamped
 * after the fact: `at(movingRank) <= sortedEffs[firstBelowNow] < nowFloor`
 * because the array descends, and the absolute fallback 0.5 is below the
 * absolute nowFloor 0.75 that every nowFloor is raised to. Pinned in
 * tests/taxonomy.unit.spec.ts, including on the degenerate all-tied corpus.
 */

/** Per-band urgency floors, read off the urgency-sorted (DESCENDING) active
 *  bills, raised to the absolute floor whenever rank alone would set the bar
 *  too low. The two floors are always strictly ordered — see v3a above. */
export function bandFloors(sortedEffs: number[]): BandFloors {
  const n = sortedEffs.length;
  const at = (i: number) => sortedEffs[Math.min(i, n - 1)] ?? -Infinity;
  const nowFloor = Math.max(at(BAND_SIZES.now - 1), ABSOLUTE_FLOORS.nowFloor);
  // Where "now" really ends: the first bill its floor does not claim. -1 means
  // the floor claims every active bill, so there is nothing left to move and
  // the absolute minimum is the honest bar.
  const firstBelowNow = sortedEffs.findIndex((e) => e < nowFloor);
  if (firstBelowNow === -1) return { nowFloor, movingFloor: ABSOLUTE_FLOORS.movingFloor };
  const movingRank = firstBelowNow + BAND_SIZES.moving - 1;
  return {
    nowFloor,
    movingFloor: Math.max(at(movingRank), ABSOLUTE_FLOORS.movingFloor),
  };
}

export function bandForEff(eff: number, { nowFloor, movingFloor }: BandFloors): UrgencyBand {
  if (eff >= nowFloor) return 'now';
  if (eff >= movingFloor) return 'moving';
  return 'radar';
}
