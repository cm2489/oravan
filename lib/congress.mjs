/*
 * THE CONGRESS THIS BUILD TRACKS: the one place its number is written.
 *
 * Until 2026-11-12 the number 119 was typed separately into six files
 * (scripts/congress-fetch.mjs, scripts/moment-updates-map.mjs,
 * scripts/newsdesk-match.mjs, scripts/nominations-fetch.mjs, lib/district.ts,
 * and the Congress's first day in scripts/coverage-query.mjs), each with a
 * comment asking the next person to "bump alongside" the others. Every one
 * of them now reads this module, and tests/congress-source.unit.spec.ts fails
 * if a new file declares a Congress number or a Jan 3 date of its own.
 *
 * WHAT CHANGING `number` DOES. It is the rollover switch for the whole
 * pipeline: the nightly bill sync, the vote sync's sessions, the nomination
 * sync, the newsdesk's citation matching, the Big Question updates' record
 * links, verify-sync's corpus-uniformity guard, and the Census district layer
 * app/api/district asks for (lib/district.ts's SITTING_CONGRESS). It is NOT
 * safe to change on its own: lib/district.ts's CENSUS_VINTAGE,
 * data/zip-districts.json and lib/rollover-tripwire.mjs move with it, and the
 * corpus guard in scripts/verify-sync.mjs fails on every bill of the previous
 * Congress until the archive work lands. tests/district.unit.spec.ts and
 * tests/rollover-tripwire.unit.spec.ts fail on a bare bump, on purpose.
 *
 * IMPORT-FREE ON PURPOSE. Scripts, lib/*.ts, route handlers and unit tests all
 * read it, and several of those (scripts/newsdesk-match.mjs,
 * scripts/moment-updates-map.mjs, lib/votes-core.mjs) promise they can be
 * imported by a test without a secret, a network call or a data file. This
 * module keeps that promise for them: no imports, no I/O, no environment.
 */

/** First calendar year of a Congress: the 1st began in 1789, the 119th in
 *  2025. Every Congress since the 74th (1935) has run two calendar years
 *  starting on Jan 3 of an odd year (Twentieth Amendment, section 1). */
export const congressFirstYear = (congress) => 1789 + 2 * (congress - 1);

/** The session a calendar year falls in (1 or 2), or null when the year is
 *  outside that Congress. */
export function sessionForYear(congress, year) {
  const s = year - congressFirstYear(congress) + 1;
  return s === 1 || s === 2 ? s : null;
}

/**
 * The two dates a Congress's term runs between, as plain dates (YYYY-MM-DD,
 * no clock). Under the Twentieth Amendment the terms of members begin and end
 * at noon Eastern on Jan 3, so `start` and `end` are the same calendar day two
 * years apart: the 119th runs from noon Jan 3, 2025 to noon Jan 3, 2027.
 *
 * These are TERM dates. The day a new Congress first meets can differ (it is
 * set by law, and Jan 3, 2027 is a Sunday); nothing here claims when a
 * chamber meets.
 */
export function congressTerm(congress) {
  const first = congressFirstYear(congress);
  return { start: `${first}-01-03`, end: `${first + 2}-01-03` };
}

/** THE PIN. The only Congress number written anywhere in pipeline or library
 *  code; everything else in this file is derived from it. */
const NUMBER = 119;

/**
 * The tracked Congress, frozen: its number, its term's first and last day,
 * and its two sessions with the calendar year each covers.
 */
export const CURRENT_CONGRESS = Object.freeze({
  number: NUMBER,
  ...congressTerm(NUMBER),
  sessions: Object.freeze(
    [1, 2].map((session) => Object.freeze({ session, year: congressFirstYear(NUMBER) + session - 1 }))
  ),
});

/** The tracked Congress's number, under the name every script already uses. */
export const CONGRESS = CURRENT_CONGRESS.number;

/** The Congress segment of a bill or nomination slug (`hr-3633-119` -> 119,
 *  `pn-12-1-119` -> 119), or null when the slug has no Congress segment
 *  (`hr-1`, `bogus`, ''). */
export function congressOfSlug(slug) {
  const m = /^[a-z]+(?:-\d+){1,2}-(\d+)$/.exec(String(slug ?? ''));
  return m ? Number(m[1]) : null;
}

/*
 * ENDED CONGRESSES (stage 2 of the new-Congress work, 2026-11-12).
 *
 * The owner decided on Nov 12, 2026 to keep the 119th Congress's bills as an
 * archive marked "ended" and to read the 120th alongside them. A bill belongs
 * to its own Congress for life: H.R. 1234 of the 119th and H.R. 1234 of the
 * 120th are two different bills, and nothing may ever read one into the
 * other's record.
 *
 * THE LIST IS EMPTY until the switch in January, and while it is empty every
 * helper below answers exactly what the pipeline already assumed: the only
 * Congress is the tracked one, and nothing is ended. Each entry, once filled,
 * is `{ number, ended: 'YYYY-MM-DD' }`, where `ended` is the last day of that
 * Congress's term (congressTerm(number).end). tests/congress-ended.unit.spec.ts
 * pins the list's shape and that it is empty today.
 *
 * WHAT "ENDED" MEANS TO THE PIPELINE (the rules stage 2 put in place):
 *   - scripts/verify-sync.mjs accepts bills of the tracked Congress and of an
 *     ended one, and freezes the ended ones: none added, none removed, and
 *     their identity, text and decode never change (endedBillProblems in
 *     scripts/congress-fetch.mjs);
 *   - every Congress.gov fetch for an existing bill uses that bill's own
 *     Congress (billApiPath in scripts/congress-fetch.mjs), never `number`;
 *   - nothing spends a model call on an ended bill: hot-bill refresh,
 *     re-decoding, call-script pregeneration, Big Question updates, search
 *     inputs and the coverage sweep all skip it.
 *
 * Every helper takes an optional `policy` ({ tracked, ended }) so a test can
 * ask "what if 119 had ended and 120 were tracked" without editing this file.
 * The pipeline never passes one: it always reads CONGRESS_POLICY.
 */

/** @typedef {{ number: number, ended: string }} EndedCongress */
/** @typedef {{ tracked: number, ended: ReadonlyArray<EndedCongress> }} CongressPolicy */

/** The Congresses whose bills are kept as an archive marked "ended".
 *  EMPTY until the switch (stage 8).
 *  @type {ReadonlyArray<EndedCongress>} */
export const ENDED_CONGRESSES = Object.freeze([]);

/** The tracked Congress and the ended list, as one value every helper reads.
 *  @type {Readonly<CongressPolicy>} */
export const CONGRESS_POLICY = Object.freeze({ tracked: NUMBER, ended: ENDED_CONGRESSES });

/** A Congress number as an integer, or null. Strict: a string "119" is not
 *  what any write path stores, so it is not read as one here either. */
const asCongress = (/** @type {unknown} */ n) => (typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null);

/** The ended-list entry for a Congress (`{ number, ended }`), or null when it
 *  has not ended (or is not a Congress number at all).
 *  @param {unknown} congress
 *  @param {CongressPolicy} [policy]
 *  @returns {EndedCongress | null} */
export function endedCongress(congress, policy = CONGRESS_POLICY) {
  const n = asCongress(congress);
  if (n === null) return null;
  return policy.ended.find((e) => e.number === n) ?? null;
}

/** Has this Congress ended (is it on the ended list)?
 *  @param {unknown} congress
 *  @param {CongressPolicy} [policy] */
export function isEndedCongress(congress, policy = CONGRESS_POLICY) {
  return endedCongress(congress, policy) !== null;
}

/** Is this the Congress the pipeline tracks?
 *  @param {unknown} congress
 *  @param {CongressPolicy} [policy] */
export function isTrackedCongress(congress, policy = CONGRESS_POLICY) {
  const n = asCongress(congress);
  return n !== null && n === policy.tracked;
}

/** Tracked or ended: a Congress whose bills may sit in the corpus.
 *  @param {unknown} congress
 *  @param {CongressPolicy} [policy] */
export function isKnownCongress(congress, policy = CONGRESS_POLICY) {
  return isTrackedCongress(congress, policy) || isEndedCongress(congress, policy);
}

/**
 * The Congress a bill belongs to. Takes a corpus record (its `congress_number`,
 * else the Congress in its `full_identifier`) or a slug (`hr-1234-119`).
 * Null when neither says: a caller must then refuse, never assume the tracked
 * Congress, because guessing is how one bill gets read into another's record.
 * @param {unknown} billOrSlug
 * @returns {number | null}
 */
export function congressOfBill(billOrSlug) {
  if (typeof billOrSlug === 'string') return congressOfSlug(billOrSlug);
  if (!billOrSlug || typeof billOrSlug !== 'object') return null;
  return asCongress(billOrSlug.congress_number) ?? congressOfSlug(billOrSlug.full_identifier);
}

/** Does this bill (record or slug) belong to an ended Congress?
 *  @param {unknown} billOrSlug
 *  @param {CongressPolicy} [policy] */
export function isEndedBill(billOrSlug, policy = CONGRESS_POLICY) {
  return isEndedCongress(congressOfBill(billOrSlug), policy);
}
