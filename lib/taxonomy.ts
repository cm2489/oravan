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
 * Bands are rank-relative, not score-thresholded. Real legislative cadence
 * leaves most bills idle in committee for months, so an absolute "score >=
 * 0.75" gate left "Act now" empty almost every week - the feed's whole promise
 * silently failing. Here a band's floor is just the urgency of the bill at its
 * rank cutoff, so "Act now" is wherever a call lands hardest right now among
 * active bills, not a countdown.
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

/** Per-band urgency floors, read off the urgency-sorted active bills. */
export function bandFloors(sortedEffs: number[]): BandFloors {
  const n = sortedEffs.length;
  const at = (i: number) => sortedEffs[Math.min(i, n - 1)] ?? -Infinity;
  return {
    nowFloor: at(BAND_SIZES.now - 1),
    movingFloor: at(BAND_SIZES.now + BAND_SIZES.moving - 1),
  };
}

export function bandForEff(eff: number, { nowFloor, movingFloor }: BandFloors): UrgencyBand {
  if (eff >= nowFloor) return 'now';
  if (eff >= movingFloor) return 'moving';
  return 'radar';
}
