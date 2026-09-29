import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * SENATORS ACROSS A STATE LINE (2026-09-29, CLAUDE.md "shipped claims that
 * have quietly stopped being true").
 *
 * Every line a split ZIP prints about senators used to promise they don't
 * depend on the district: "Your senators are the same either way" (/reps),
 * "Your senators are always yours" (the bill call panel), "your senators are
 * the same either way" (the embed widget), "only your senators are shown here"
 * (the vote record's members strip). That holds for a ZIP inside one state.
 * It is false for a ZIP that crosses a state line — 19973 is Delaware's
 * at-large seat and Maryland's 1st, so which two senators are the reader's
 * depends on the state they live in, and every surface lists all four.
 *
 * The fix is one sentence, true for every ZIP, so no surface has to know which
 * kind of split it is holding: "Your senators are the same for every district
 * in your state." Pure Node; the rendered surfaces are pinned in
 * tests/cross-state-senators.spec.ts.
 */

const read = (f: string) => JSON.parse(readFileSync(join(process.cwd(), f), 'utf8'));
const ZIPS = read('data/zip-districts.json') as Record<string, { state: string; district: number }[]>;
const statesOf = (zip: string) => new Set((ZIPS[zip] ?? []).map((d) => d.state));

const LOCALES = [
  ['en', en],
  ['es', es],
] as const;

/** The scoping sentence each split-ZIP senators line must carry. */
const SCOPE = {
  en: 'Your senators are the same for every district in your state.',
  es: 'Tus senadores son los mismos en todos los distritos de tu estado.',
} as const;

/** Every line a split ZIP prints about its senators, by key path. */
const SPLIT_ZIP_SENATOR_LINES = [
  ['reps', 'multiDistrict'],
  ['bill', 'callWhoMulti'],
  ['embed', 'multiDistrictBody'],
  ['embed', 'multiDistrictBodyBrandless'],
  ['votes', 'delegation', 'multiDistrict'],
] as const;

/** The wordings that promised the senators regardless of state. */
const RETIRED = {
  en: /senators are (always yours|the same either way)|only your senators are shown/i,
  es: /senadores (siempre son los tuyos|son los mismos en cualquier caso)|solo aparecen tus senadores/i,
} as const;

function at(m: unknown, path: readonly string[]): string {
  const v = path.reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], m);
  if (typeof v !== 'string') throw new Error(`no string at ${path.join('.')}`);
  return v;
}

/** Every string in one message catalog, with its dotted key. */
function allStrings(m: unknown, prefix = ''): [string, string][] {
  if (typeof m === 'string') return [[prefix, m]];
  if (!m || typeof m !== 'object') return [];
  return Object.entries(m as Record<string, unknown>).flatMap(([k, v]) =>
    allStrings(v, prefix ? `${prefix}.${k}` : k)
  );
}

test.describe('senators across a state line', () => {
  test('the fixtures are what the e2e spec says they are', () => {
    // 19973: two districts in two states. 10001: two districts in one state.
    expect(ZIPS['19973']?.length).toBeGreaterThan(1);
    expect(statesOf('19973').size).toBeGreaterThan(1);
    expect(ZIPS['10001']?.length).toBeGreaterThan(1);
    expect(statesOf('10001').size).toBe(1);
  });

  test('ZIPs that cross a state line exist, so the claim has to hold for them', () => {
    const crossing = Object.keys(ZIPS).filter((z) => statesOf(z).size > 1);
    expect(crossing.length).toBeGreaterThan(0);
  });

  for (const [locale, m] of LOCALES) {
    for (const path of SPLIT_ZIP_SENATOR_LINES) {
      test(`${locale} ${path.join('.')} scopes the senators to the reader's state`, () => {
        const s = at(m, path);
        // Case-folded: the embed's copy carries it after a semicolon.
        expect(s.toLowerCase()).toContain(SCOPE[locale].toLowerCase());
        expect(s).not.toMatch(RETIRED[locale]);
      });
    }

    test(`${locale}: no message promises the senators regardless of state`, () => {
      const hits = allStrings(m).filter(([, s]) => RETIRED[locale].test(s));
      expect(hits).toEqual([]);
    });

    // Same sentence, same widget: it also said "both" districts, and 841 ZIPs
    // span three to six of them.
    test(`${locale}: the embed's split-ZIP note does not count the districts as two`, () => {
      const threeOrMore = Object.values(ZIPS).filter((ds) => ds.length > 2).length;
      expect(threeOrMore).toBeGreaterThan(0);
      for (const key of ['multiDistrictBody', 'multiDistrictBodyBrandless'] as const) {
        expect(m.embed[key]).not.toMatch(/\bboth\b|\blos dos\b/i);
      }
    });
  }
});
