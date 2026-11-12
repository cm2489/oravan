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
