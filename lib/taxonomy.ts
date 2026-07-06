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

/** Per-band urgency floors, read off the urgency-sorted active bills, raised
 *  to the absolute floor whenever rank alone would set the bar too low. */
export function bandFloors(sortedEffs: number[]): BandFloors {
  const n = sortedEffs.length;
  const at = (i: number) => sortedEffs[Math.min(i, n - 1)] ?? -Infinity;
  return {
    nowFloor: Math.max(at(BAND_SIZES.now - 1), ABSOLUTE_FLOORS.nowFloor),
    movingFloor: Math.max(at(BAND_SIZES.now + BAND_SIZES.moving - 1), ABSOLUTE_FLOORS.movingFloor),
  };
}

export function bandForEff(eff: number, { nowFloor, movingFloor }: BandFloors): UrgencyBand {
  if (eff >= nowFloor) return 'now';
  if (eff >= movingFloor) return 'moving';
  return 'radar';
}
