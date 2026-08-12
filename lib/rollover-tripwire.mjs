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

/* ------------------------------------------------------------------------ *
 * The escalation half.
 *
 * The ::warning above is the right volume for eleven months and the wrong
 * volume for the last one: it lives in a run log nobody is required to read.
 * Once the window opens, the weekly workflow opens ONE actionable issue
 * instead - the single genuinely actionable artifact this whole apparatus
 * has been building toward. Search-first idempotence in the workflow keeps
 * it to exactly one, ever, not one a week for five weeks.
 *
 * Rendering lives here (pure, unit-tested in
 * tests/rollover-tripwire.unit.spec.ts) rather than in workflow YAML, and it
 * returns null before WARNING_START so the date gate itself is testable.
 * ------------------------------------------------------------------------ */

/** Title of the one escalation issue. The workflow looks this up EXACTLY. */
export const ROLLOVER_ISSUE_TITLE = 'Bump Clock 1 to the 120th Congress before Jan 3, 2027';

/**
 * @param {Array<{state: string, status: string, checked: string, rdhLastmod: string, url: string}>} detections
 *   states whose RDH page has moved at least once since the seed
 *   (lib/redistricting-watch.mjs's statesWithDetections)
 * @param {string|Date} today
 * @returns {string|null} the issue body, or null while the window is still shut
 */
export function renderRolloverIssueBody(detections, today) {
  const warning = rolloverWarning(today);
  if (!warning) return null;

  const rows = (detections ?? []).map(
    (d) =>
      `| [${d.state}](${d.url}) | ${d.status} | ${d.checked} | \`${d.rdhLastmod}\` |`
  );

  const detectionSection = rows.length
    ? [
        '| State | Status | Last detected | RDH lastmod |',
        '| --- | --- | --- | --- |',
        ...rows,
      ]
    : [
        'None recorded — the tripwire never fired for any tracked state. **The bump is still mandatory:** it is dated, not conditional on a detection.',
      ];

  return [
    '**This is the one actionable issue the redistricting watch exists to produce.** Everything else it files is "a human should go re-read an RDH page"; this one is a code and data change with a hard date on it.',
    '',
    `> ${warning}`,
    '',
    '## What must be bumped',
    '',
    "1. **`app/api/district/route.ts:42`** — `CENSUS_QUERY.layers` is pinned to the literal `'119th Congressional Districts'`. It must become the 120th-Congress layer before the 120th is sworn in.",
    '2. **`data/zip-districts.json`** — rebuilt weekly by `scripts/process-data.py`; it must be rebuilt from a 120th-Congress-vintage source. It feeds `/api/reps` and the MCP `lookup_representatives` tool.',
    '',
    'Until both land, every ZIP-to-district lookup in a redrawn state silently returns the 119th-Congress district after Jan 3, 2027 — wrong district, wrong representative, wrong call script, delivered confidently. FL is the sharpest case: FL-20 is eliminated outright by the map signed 2026-05-04.',
    '',
    '## States where RDH recorded a map-page change since the seed',
    '',
    ...detectionSection,
    '',
    'Detections are a hint about *where* the boundaries moved, not the trigger — this issue is dated, not event-driven.',
    '',
    '## Scope',
    '',
    'Clock 1 only ("who represents you now"). Clock 2 (ballot-facing / next-term districts) is an explicit non-goal and is **not** what this issue asks for. Decision record: `docs/solutions/two-clock-district-boundaries.md`.',
    '',
    `_Opened once by \`.github/workflows/refresh-legislators.yml\` when \`rolloverWarning()\`'s window opened (${WARNING_START}). It is never re-filed. Close it when both bumps have landed._`,
    '',
  ].join('\n');
}
