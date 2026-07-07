/*
 * 119th -> 120th Congress rollover tripwire — pure core (S24, two-clock
 * model). Plain .mjs, no side effects, same pattern as lib/salt.mjs.
 *
 * The two-clock model (full record: docs/solutions/
 * two-clock-district-boundaries.md):
 *   Clock 1 - "who represents you now": the current federal boundary/roster
 *     pipeline (the `'119th Congressional Districts'` literal in
 *     app/api/district/route.ts, data/zip-districts.json,
 *     data/legislators.json) is valid through Jan 3, 2027 regardless of the
 *     2025-26 mid-decade redistricting wave - House terms run Jan 3 -> Jan
 *     3, and a new state map does not unseat a sitting member. NO SWAP IS
 *     NEEDED before then.
 *   Clock 2 - "your Nov 2026 ballot / Jan 2027 rep": a separate
 *     next-term/ballot-facing dataset. Not built, and per the strategy doc
 *     (§9.1(f)) not currently a stated Oravan feature - this tripwire exists
 *     so the Clock-1 bump to the 120th vintage happens deliberately before
 *     Jan 3, 2027, not as a post-hoc scramble after someone notices the site
 *     is showing turned-over members' old districts.
 *
 * Non-blocking by design: the edit isn't due for months after
 * WARNING_START, so this never fails a workflow - it only emits a
 * ::warning once real lead time is needed, the same "never let a mandatory
 * human edit be forgotten" posture as ci.yml's noindex launch-gate
 * reminder.
 */

/** 120th Congress is sworn in - the hard deadline for the literal/dataset bump. */
export const ROLLOVER_DEADLINE = '2027-01-03';

/** ~1 month of lead time before the deadline - enough to schedule the edit, not so early it's noise for months. */
export const WARNING_START = '2026-12-01';

/**
 * @param {string|Date} today
 * @returns {string|null} a warning message once on/after WARNING_START, else null
 */
export function rolloverWarning(today) {
  const t = today instanceof Date ? today : new Date(today);
  const start = new Date(`${WARNING_START}T00:00:00Z`);
  if (t < start) return null;

  const deadline = new Date(`${ROLLOVER_DEADLINE}T00:00:00Z`);
  const daysLeft = Math.round((deadline.getTime() - t.getTime()) / 86_400_000);
  const countdown =
    daysLeft >= 0
      ? `${daysLeft} day(s) until Jan 3, 2027`
      : `${Math.abs(daysLeft)} day(s) PAST the Jan 3, 2027 deadline`;

  return (
    `119th -> 120th Congress rollover: ${countdown}. app/api/district/route.ts's ` +
    "CENSUS_QUERY.layers literal ('119th Congressional Districts'), plus whatever " +
    'boundary dataset feeds data/zip-districts.json, must be bumped to the 120th ' +
    'vintage before the 120th Congress is sworn in - see ' +
    'docs/solutions/two-clock-district-boundaries.md.'
  );
}
