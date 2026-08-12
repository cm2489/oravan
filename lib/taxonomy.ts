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
 * THE BANDS ARE FACTS NOW — and this is the record of the four attempts that
 * came before, kept whole so a future change cannot re-litigate settled ground
 * (KTD-2) or re-invent a mechanism this corpus has already broken twice.
 *
 * v1 (launch). Absolute score thresholds: score >= 0.75 = "Act now",
 * >= 0.5 = "Moving". Real legislative cadence leaves most bills idle in
 * committee for months, so the threshold left "Act now" empty almost every
 * week — the feed's whole promise silently failing.
 *
 * v2 (commit 21dfaaf, "Rank-based urgency bands so 'Act now' is never empty").
 * Thresholds became pure rank cutoffs — a band's floor is just the urgency of
 * the bill at its rank, so "Act now" always showed the 6 most urgent active
 * bills and "Moving" the next 12, no matter how urgent (or not) any of them
 * actually were. That traded one dishonesty for another: on a genuinely quiet
 * week, ordinary committee bills got dressed up as "Act now" because
 * *something* had to fill the slot.
 *
 * v3 (KTD-2). The v1 absolute floors returned, layered on top of v2: a bill
 * earned a band only by clearing BOTH the rank cutoff and the absolute floor.
 * Ranking decided order among qualifying bills; the floor decided whether the
 * band got to exist at all that week.
 *
 * v3a (2026-08-09). THE MIDDLE BAND CAME BACK. v3 read the moving floor off a
 * FIXED rank — the 18th bill — which silently assumed the "now" band ends at
 * rank 6. It does not: bands were compared by VALUE so tied bills shared a
 * band, and a tie block straddling rank 6 pulled every tied bill into "now" and
 * could swallow rank 18 whole. The derived movingFloor then came out EQUAL to
 * nowFloor and "moving" became unreachable. On the corpus of 2026-08-09, 21
 * active bills tied at eff 0.95: bands read now 21 / moving 0 / radar 2,645,
 * and 38 bills that outscored 98% of the corpus rendered under "On the radar —
 * quieter right now". The repair started the moving window where "now" actually
 * ended rather than where rank alone predicted.
 *
 * v4 (2026-08-12, THIS CHANGE) — THE FLOORS ARE RETIRED. `bandFloors` and
 * `bandForEff` are gone, and with them the last percentile in the product.
 * Every reversal above was the same bug wearing a different number: a DISCRETE
 * legislative process was being ranked by a CONTINUOUS score, so ties were
 * structural (every busy week is a 0.95 tie block), an empty band could not be
 * distinguished from a broken cutoff, and the score could not say WHY any bill
 * was in any band. Three measured failures finished it — a cloture vote that
 * had already FAILED held shortlist rank 2 for four days; the two biggest bills
 * of the fortnight were invisible because Congress overwrites `last_action_text`
 * and their derived status fell back to `committee`; and on the day the Senate
 * passed the continuing resolution 90-6 the floors moved it to "On the radar".
 *
 * The bands now read a RUNG of the docket ladder (lib/docket.mjs), which is a
 * sentence from the record rather than a number:
 *
 *   Deciding now  T0 announced by the chamber ∪ T1 a vote ripening in the record
 *   Moving        T2 dated calendar placement ∪ T3 just cleared a gate
 *   On the radar  T4 everything else, and every terminal bill, pinned
 *
 * A band may be EMPTY, and that is the honest output of a quiet fortnight
 * rather than a bug to be tuned away — which is what v1 tried to buy, v2 sold,
 * and v3/v3a spent two reversals trying to buy back. `BAND_SIZES` survives as
 * what it always was on the browse surface: a DISPLAY cap.
 */

/** DISPLAY caps only — how many cards a band shows before "Show all"
 *  (components/BillsBrowser.tsx). Since v4 these decide nothing about which
 *  band a bill lands in; the rung does. */
export const BAND_SIZES = { now: 6, moving: 12 } as const;
