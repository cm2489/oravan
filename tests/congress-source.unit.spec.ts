import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  CONGRESS,
  CURRENT_CONGRESS,
  congressFirstYear,
  congressOfSlug,
  congressTerm,
  sessionForYear,
} from '../lib/congress.mjs';
import { CONGRESS as FETCH_CONGRESS } from '../scripts/congress-fetch.mjs';
import { CONGRESS as MAP_CONGRESS, congressGovUrlForSlug } from '../scripts/moment-updates-map.mjs';
import { findCitations } from '../scripts/newsdesk-match.mjs';
import { NOMINATION_CONGRESS } from '../scripts/nominations-fetch.mjs';
import { CONGRESS_START, wholeLifeStart } from '../scripts/coverage-query.mjs';
import { congressFirstYear as votesFirstYear, sessionForYear as votesSessionForYear } from '../lib/votes-core.mjs';
import { ROLLOVER_DEADLINE } from '../lib/rollover-tripwire.mjs';
import { SITTING_CONGRESS } from '../lib/district';

/*
 * ONE SOURCE FOR THE TRACKED CONGRESS (2026-11-12).
 *
 * Before this, 119 was typed into six files, each with a comment asking the
 * next person to bump it "alongside" the others. The 119th Congress ends at
 * noon on Jan 3, 2027, and a rollover that bumped five of the six would have
 * synced one Congress's bills while matching headlines, linking records and
 * fetching nominations in another. This spec pins three things:
 *
 *   1. what lib/congress.mjs says about the 119th (number, term, sessions);
 *   2. that every module that used to carry its own copy now reads it;
 *   3. that no file in pipeline or page code declares a Congress number or a
 *      Jan 3 term date of its own again.
 *
 * When the tracked Congress changes, (1) is the test to edit, deliberately.
 */

test.describe('lib/congress.mjs: the tracked Congress', () => {
  test('is the 119th: term Jan 3, 2025 to Jan 3, 2027, sessions 2025 and 2026', () => {
    expect(CURRENT_CONGRESS.number).toBe(119);
    expect(CONGRESS).toBe(119);
    expect(CURRENT_CONGRESS.start).toBe('2025-01-03');
    expect(CURRENT_CONGRESS.end).toBe('2027-01-03');
    expect(CURRENT_CONGRESS.sessions).toEqual([
      { session: 1, year: 2025 },
      { session: 2, year: 2026 },
    ]);
  });

  test('is frozen, so no importer can move it at run time', () => {
    expect(Object.isFrozen(CURRENT_CONGRESS)).toBe(true);
    expect(Object.isFrozen(CURRENT_CONGRESS.sessions)).toBe(true);
    expect(Object.isFrozen(CURRENT_CONGRESS.sessions[0])).toBe(true);
  });

  test('derives the term and sessions the same way for any Congress', () => {
    expect(congressFirstYear(1)).toBe(1789);
    expect(congressFirstYear(118)).toBe(2023);
    expect(congressFirstYear(120)).toBe(2027);
    expect(congressTerm(118)).toEqual({ start: '2023-01-03', end: '2025-01-03' });
    expect(congressTerm(120)).toEqual({ start: '2027-01-03', end: '2029-01-03' });
    expect(sessionForYear(119, 2024)).toBeNull();
    expect(sessionForYear(119, 2025)).toBe(1);
    expect(sessionForYear(119, 2026)).toBe(2);
    expect(sessionForYear(119, 2027)).toBeNull();
    expect(sessionForYear(120, 2027)).toBe(1);
  });

  test('reads the Congress out of a slug, and nothing out of a slug without one', () => {
    expect(congressOfSlug('hr-3633-119')).toBe(119);
    expect(congressOfSlug('hconres-89-118')).toBe(118);
    expect(congressOfSlug('pn-12-1-119')).toBe(119);
    for (const bad of ['hr-1', 'bogus', '', null, undefined, 'HR-1-119']) {
      expect(congressOfSlug(bad)).toBeNull();
    }
  });
});

test.describe('every former copy reads the one source', () => {
  test('the bill sync, the Big Question updates, nominations and the district layer', () => {
    expect(FETCH_CONGRESS).toBe(CURRENT_CONGRESS.number);
    expect(MAP_CONGRESS).toBe(CURRENT_CONGRESS.number);
    expect(NOMINATION_CONGRESS).toBe(CURRENT_CONGRESS.number);
    expect(SITTING_CONGRESS).toBe(CURRENT_CONGRESS.number);
  });

  test('the newsdesk turns a bare citation into a slug of the tracked Congress', () => {
    expect(findCitations('House passes H.R. 3633').map((c: { slug: string }) => c.slug)).toEqual([
      `hr-3633-${CURRENT_CONGRESS.number}`,
    ]);
  });

  test('the vote sync uses the same session arithmetic (re-exported, not copied)', () => {
    expect(votesFirstYear).toBe(congressFirstYear);
    expect(votesSessionForYear).toBe(sessionForYear);
  });

  test("the coverage sync's floor is the tracked Congress's first day", () => {
    expect(CONGRESS_START).toBe(CURRENT_CONGRESS.start);
  });

  test('the district tripwire is aimed at the end of the tracked Congress', () => {
    // lib/rollover-tripwire.mjs is about this one rollover and keeps its own
    // dated wording. If the tracked Congress moves, this fails until the
    // tripwire is re-aimed or retired in the same change.
    expect(ROLLOVER_DEADLINE).toBe(CURRENT_CONGRESS.end);
  });
});

test.describe("a slug's own Congress wins over the tracked one", () => {
  test('a record link names the Congress in the slug', () => {
    expect(congressGovUrlForSlug('hconres-89-119')).toBe(
      'https://www.congress.gov/bill/119th-congress/house-concurrent-resolution/89'
    );
    // An earlier Congress's bill links to itself, never to the same-numbered
    // bill of the tracked Congress.
    expect(congressGovUrlForSlug('s-1776-118')).toBe('https://www.congress.gov/bill/118th-congress/senate-bill/1776');
    // No Congress segment: the tracked one, as before.
    expect(congressGovUrlForSlug('hr-1')).toBe(
      `https://www.congress.gov/bill/${CURRENT_CONGRESS.number}th-congress/house-bill/1`
    );
  });

  test("the coverage floor of an undated bill is its own Congress's first day", () => {
    expect(wholeLifeStart({ introduced_date: null, congress_number: 119 })).toBe('2025-01-03');
    expect(wholeLifeStart({ introduced_date: null, congress_number: 118 })).toBe('2023-01-03');
    expect(wholeLifeStart({ introduced_date: null })).toBe(CURRENT_CONGRESS.start);
    expect(wholeLifeStart({ introduced_date: '2025-06-01', congress_number: 119 })).toBe('2025-06-01');
  });
});

test.describe('no second copy', () => {
  const ROOTS = ['scripts', 'lib', 'app', 'components', 'i18n'];
  const SOURCE = /\.(?:mjs|js|cjs|ts|tsx|py)$/;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (SOURCE.test(name)) files.push(p);
    }
  };
  for (const r of ROOTS) walk(join(process.cwd(), r));

  test('no file but lib/congress.mjs declares a Congress number', () => {
    // `CONGRESS = 119`, `SITTING_CONGRESS = 120`, `NOMINATION_CONGRESS = 119`:
    // any name containing CONGRESS assigned a three-digit literal.
    const decl = /\b[A-Z_]*CONGRESS[A-Z_]*\s*(?::\s*number\s*)?=\s*\d{3}\b/;
    const offenders = files
      .filter((f) => !f.endsWith(join('lib', 'congress.mjs')))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((line, i) => ({ line, i }))
          .filter(({ line }) => decl.test(line) && !/^\s*(\*|\/\/|#)/.test(line))
          .map(({ i }) => `${relative(process.cwd(), f)}:${i + 1}`)
      );
    expect(offenders).toEqual([]);
  });

  test('no file but lib/congress.mjs and the dated tripwire writes a Jan 3 term date as code', () => {
    // A quoted 'YYYY-01-03' outside a comment. The tripwire keeps its own
    // literal on purpose (it is about the 2027 rollover only) and is pinned
    // equal to CURRENT_CONGRESS.end above.
    const allowed = [join('lib', 'congress.mjs'), join('lib', 'rollover-tripwire.mjs')];
    const dateLit = /['"`]20\d\d-01-03['"`]/;
    const offenders = files
      .filter((f) => !allowed.some((a) => f.endsWith(a)))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((line, i) => ({ line, i }))
          .filter(({ line }) => dateLit.test(line) && !/^\s*(\*|\/\/|#)/.test(line))
          .map(({ i }) => `${relative(process.cwd(), f)}:${i + 1}`)
      );
    expect(offenders).toEqual([]);
  });
});
