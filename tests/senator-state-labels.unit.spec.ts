import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { districtsForZip, repsForDistrict, vacancyForDistrict } from '../lib/core';
import { crossesStateLine, nameWithState } from '../lib/state-line';

/*
 * WHICH STATE EACH SENATOR REPRESENTS, WHEN A ZIP CROSSES A STATE LINE
 * (2026-09-29). Pure Node: the rule in lib/state-line.ts and the one new line
 * of copy. The rendered surfaces are pinned in tests/senator-state-labels.spec.ts.
 *
 * The rule is checked against every ZIP in data/zip-districts.json, over the
 * same answer app/api/reps/route.ts gives for it, so it can never disagree
 * with the districts file about which ZIPs cross a state line.
 */

const read = (f: string) => JSON.parse(readFileSync(join(process.cwd(), f), 'utf8'));
const ZIPS = read('data/zip-districts.json') as Record<string, { state: string; district: number }[]>;

/** What /api/reps answers for a ZIP: the members, de-duplicated in district
 *  order, and the vacant seats (app/api/reps/route.ts). */
function lookup(zip: string) {
  const districts = districtsForZip(zip);
  const seen = new Set<string>();
  const reps = districts
    .flatMap((d) => repsForDistrict(d))
    .filter((r) => (seen.has(r.bioguide) ? false : (seen.add(r.bioguide), true)));
  const vacancies = districts
    .map((d) => vacancyForDistrict(d))
    .filter((v): v is NonNullable<typeof v> => Boolean(v))
    .map((v) => ({ state: v.state, district: v.district }));
  return { reps, vacancies };
}

const statesOf = (zip: string) => new Set(ZIPS[zip].map((d) => d.state));

test.describe('a ZIP that crosses a state line', () => {
  test('the fixtures are what the e2e spec says they are', () => {
    expect([...statesOf('19973')].sort()).toEqual(['DE', 'MD']);
    expect([...statesOf('82082')].sort()).toEqual(['CO', 'NE', 'WY']);
    expect(ZIPS['10001'].length).toBeGreaterThan(1);
    expect([...statesOf('10001')]).toEqual(['NY']);
    expect(ZIPS['78501']).toEqual([{ state: 'TX', district: 15 }]);
  });

  test('crossesStateLine agrees with the districts file for every ZIP', () => {
    const wrong: string[] = [];
    let crossing = 0;
    for (const zip of Object.keys(ZIPS)) {
      const { reps, vacancies } = lookup(zip);
      const expected = statesOf(zip).size > 1;
      if (expected) crossing++;
      if (crossesStateLine(reps, vacancies) !== expected) wrong.push(zip);
    }
    expect(wrong).toEqual([]);
    // 109 on 2026-09-29. Not pinned exactly: the districts file changes.
    expect(crossing).toBeGreaterThan(0);
  });

  test('19973 lists both states’ senators, and the rule says so', () => {
    const { reps, vacancies } = lookup('19973');
    const senators = reps.filter((r) => r.type === 'sen');
    expect(new Set(senators.map((s) => s.state))).toEqual(new Set(['DE', 'MD']));
    expect(crossesStateLine(reps, vacancies)).toBe(true);
  });

  test('a split ZIP inside one state, and a one-district ZIP, do not cross', () => {
    for (const zip of ['10001', '78501']) {
      const { reps, vacancies } = lookup(zip);
      expect(crossesStateLine(reps, vacancies), zip).toBe(false);
    }
  });

  test('a vacant seat still counts its state', () => {
    expect(crossesStateLine([{ state: 'DE' }], [{ state: 'MD' }])).toBe(true);
    expect(crossesStateLine([{ state: 'DE' }], [{ state: 'DE' }])).toBe(false);
    expect(crossesStateLine([])).toBe(false);
  });

  test('nameWithState prints the settled box’s "Name (ST)" only across a state line', () => {
    const coons = { name: 'Christopher A. Coons', state: 'DE' };
    expect(nameWithState(coons, true)).toBe('Christopher A. Coons (DE)');
    expect(nameWithState(coons, false)).toBe('Christopher A. Coons');
  });
});

test.describe('the settled box’s line for a ZIP across a state line', () => {
  for (const [locale, m, stateWord, countsTwo] of [
    ['en', en, /\bstate\b/i, /\b(two|both)\b/i],
    ['es', es, /\bestado\b/i, /\b(dos|ambos)\b/i],
  ] as const) {
    test(`${locale}: bill.settled.crossState names the reader's state and never counts the states as two`, () => {
      const s = m.bill.settled.crossState;
      expect(s.length).toBeGreaterThan(0);
      expect(s).toMatch(stateWord);
      // 82082 touches three states.
      expect(s).not.toMatch(countsTwo);
    });
  }
});
