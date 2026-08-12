import { expect, test } from '@playwright/test';
// Imported from the scripts THEMSELVES, not copies - the same pattern as
// tests/sync-cursor.unit.spec.ts importing resolveNextSync. Both modules are
// import-clean: congress-fetch.mjs reads CONGRESS_API_KEY per fetch rather
// than at import, and sync-bills.mjs's whole body sits behind an argv[1]
// guard, so neither import fires a sync or needs a secret.
import { CONGRESS, offCongressBills } from '../scripts/congress-fetch.mjs';
import { forceSlugTarget } from '../scripts/sync-bills.mjs';

/*
 * Pins the two congress-pin gates added 2026-08-11.
 *
 * WHAT WENT WRONG. Two 118th-Congress records - s-1776-118 and s-5110-118 -
 * came in with the original seed commit (ad6668f, 2026-06-12) and lived in
 * data/bills.json for two months. Every write path since has been pinned to
 * CONGRESS, so nothing could ADD another; nothing, however, ever looked at
 * what was already there. They rendered live bill pages, and s-1776-118 is
 * the literal example in tests/freshness.spec.ts's R2b: a full-bleed green
 * panel asserting "This bill is queued for a vote of the full Senate" off a
 * 2024-09-24 placement, for a Congress that ended in January 2025.
 *
 * TWO GATES, because there were two ways for it to be true:
 *   1. offCongressBills - what's IN the corpus (run by scripts/verify-sync.mjs
 *      before the nightly commit).
 *   2. forceSlugTarget - what can still GET IN. FORCE_DECODE_SLUGS parsed
 *      slugs with `/^([a-z]+)-(\d+)-\d+$/` and discarded the congress
 *      segment, then fetched under CONGRESS: forcing `s-1776-118` returned
 *      S.1776 of the 119th - a different bill - and reported success.
 *
 * FIXTURE-BASED ON PURPOSE. Nothing here reads data/bills.json or asserts a
 * corpus size: a spec that pinned tonight's count would fail on tomorrow's
 * sync, and the property being tested ("one Congress, no strays") is about
 * the rule, not about how many bills happen to satisfy it today.
 */

type Fixture = { bill_type: string; bill_number: number; congress_number: number };

const bill = (bill_type: string, bill_number: number, congress_number: number): Fixture => ({
  bill_type,
  bill_number,
  congress_number,
});

const offCongress = offCongressBills as (bills: unknown, congress?: number) => string[];
const forceTarget = forceSlugTarget as (
  slug: unknown,
  congress?: number
) =>
  | { ok: true; type: string; number: string; congress: number }
  | { ok: false; reason: 'malformed' | 'wrong-congress'; congress?: number };

test.describe('offCongressBills (corpus uniformity, verify-sync.mjs)', () => {
  test('the tracked Congress is the 119th - the constant both gates read', () => {
    // If this fails, the rollover happened: bump CONGRESS in
    // scripts/congress-fetch.mjs deliberately (lib/rollover-tripwire.mjs
    // warns from Dec 1, 2026) and update this pin in the same change.
    expect(CONGRESS).toBe(119);
  });

  test('an all-119 corpus is clean', () => {
    const corpus = [bill('hr', 3633, 119), bill('s', 1776, 119), bill('sjres', 99, 119)];
    expect(offCongress(corpus)).toEqual([]);
  });

  test('a single 118th-Congress record is caught, and named by slug', () => {
    // The exact record that shipped: seeded, never fetchable again, still
    // rendering a page.
    const corpus = [bill('hr', 3633, 119), bill('s', 1776, 118)];
    expect(offCongress(corpus)).toEqual(['s-1776-118']);
  });

  test('every stray is reported, not just the first - the failure names all of them', () => {
    const corpus = [bill('s', 1776, 118), bill('hr', 1, 119), bill('s', 5110, 118)];
    expect(offCongress(corpus)).toEqual(['s-1776-118', 's-5110-118']);
  });

  test('a FUTURE Congress is a stray too - the gate is "not the tracked one", not "older"', () => {
    // The 120th arrives Jan 3, 2027. Until CONGRESS is bumped, a 120th-
    // Congress record in a 119th-Congress corpus is the same lie.
    expect(offCongress([bill('hr', 1, 120)])).toEqual(['hr-1-120']);
  });

  test('the congress is a parameter, so the gate follows the rollover instead of hardcoding 119', () => {
    const corpus = [bill('hr', 1, 119), bill('hr', 2, 120)];
    expect(offCongress(corpus, 120)).toEqual(['hr-1-119']);
  });

  test('a string congress_number is a stray - the field type is part of the shape', () => {
    // No write path produces this; a corpus where it appeared has drifted in
    // a way worth failing on rather than coercing past.
    expect(offCongress([{ bill_type: 'hr', bill_number: 1, congress_number: '119' }])).toEqual([
      'hr-1-119',
    ]);
  });

  test('a non-array (a corrupt or half-written file) yields no strays - the array check owns that failure', () => {
    // verify-sync.mjs already fails on "not a non-empty array"; this must not
    // throw first and lose that message.
    expect(offCongress(null)).toEqual([]);
    expect(offCongress({})).toEqual([]);
  });
});

test.describe('forceSlugTarget (FORCE_DECODE_SLUGS congress pin, sync-bills.mjs)', () => {
  test('a previous-Congress slug is refused, not silently answered with another bill', () => {
    // THE BUG. This used to parse to {type: 's', number: '1776'} and fetch
    // /bill/119/s/1776 - a different bill, added under a slug nobody asked
    // for, logged as a success.
    const t = forceTarget('s-1776-118');
    expect(t.ok).toBe(false);
    expect(t).toMatchObject({ reason: 'wrong-congress', congress: 118 });
  });

  test('the same bill in the tracked Congress is accepted, with its segments intact', () => {
    expect(forceTarget('s-1776-119')).toEqual({
      ok: true,
      type: 's',
      number: '1776',
      congress: 119,
    });
  });

  test('every tracked bill type still parses - the pin narrowed the congress, nothing else', () => {
    for (const type of ['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres']) {
      expect(forceTarget(`${type}-42-119`)).toMatchObject({ ok: true, type, number: '42' });
    }
  });

  test('a FUTURE Congress is refused on the same rule', () => {
    expect(forceTarget('hr-1-120')).toMatchObject({ ok: false, reason: 'wrong-congress', congress: 120 });
  });

  test('the congress is a parameter, so the pin follows the rollover', () => {
    expect(forceTarget('hr-1-120', 120)).toMatchObject({ ok: true, type: 'hr', number: '1' });
    expect(forceTarget('hr-1-119', 120)).toMatchObject({ ok: false, reason: 'wrong-congress' });
  });

  test('malformed slugs keep their old verdict - this change added a reason, it did not take one away', () => {
    for (const bad of ['', 'hr-1', 'hr-one-119', 'not-a-slug', 'HR-1-119', null, undefined]) {
      expect(forceTarget(bad)).toEqual({ ok: false, reason: 'malformed' });
    }
  });
});
