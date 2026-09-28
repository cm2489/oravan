import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// Relative import of the plain .mjs module, the same logic
// scripts/sync-special-elections.mjs runs every Monday.
import {
  FEC_DEMO_KEY,
  buildSpecialElections,
  electionDatesUrl,
  fecDistrict,
  seatSlug,
  specialDatesFrom,
} from '../lib/special-elections.mjs';

/*
 * Special-election dates for vacant House seats, from the FEC. What this
 * pins: only rows the FEC states are recorded, as it states them; nothing is
 * guessed; a failed fetch keeps the old answer WITH its old checked date.
 */

const AZ07 = { state: 'AZ', district: 7, since: '2025-03-17' };

/** Shaped like a real /v1/election-dates/ response (AZ-07, fetched 2026-09-28). */
function row(over: Record<string, unknown>) {
  return {
    election_state: 'AZ',
    election_district: '07',
    office_sought: 'H',
    election_type_id: 'SG',
    election_type_full: 'Special election general',
    election_date: '2025-09-23',
    ...over,
  };
}

test('seat keys and FEC districts', () => {
  expect(seatSlug({ state: 'FL', district: 20 })).toBe('fl-20');
  expect(fecDistrict(7)).toBe('07');
  expect(fecDistrict(20)).toBe('20');
  expect(fecDistrict(0)).toBe('00');
});

test('the query asks for this seat, House only, from the day it was first seen vacant, with the public key', () => {
  const u = new URL(electionDatesUrl(AZ07));
  expect(u.origin + u.pathname).toBe('https://api.open.fec.gov/v1/election-dates/');
  expect(u.searchParams.get('api_key')).toBe(FEC_DEMO_KEY);
  expect(FEC_DEMO_KEY).toBe('DEMO_KEY');
  expect(u.searchParams.get('office_sought')).toBe('H');
  expect(u.searchParams.get('election_state')).toBe('AZ');
  expect(u.searchParams.get('election_district')).toBe('07');
  expect(u.searchParams.get('min_election_date')).toBe('2025-03-17');
});

test('keeps the special rows as the FEC states them, sorted, and nothing else', () => {
  const body = {
    pagination: { pages: 1 },
    results: [
      row({}),
      row({ election_type_id: 'SP', election_type_full: 'Special primary', election_date: '2025-07-15' }),
      row({ election_type_id: 'SGR', election_type_full: 'Special general runoff', election_date: '2025-11-04' }),
      // Duplicate of the first row: recorded once.
      row({}),
      // A regular election is not a special election.
      row({ election_type_id: 'G', election_type_full: 'General election', election_date: '2026-11-03' }),
      // An earlier vacancy of the same seat (before `since`).
      row({ election_date: '2022-01-11' }),
      // The API's filters are re-checked, not trusted.
      row({ election_district: '08' }),
      row({ election_state: 'FL' }),
      row({ office_sought: 'S' }),
      // A row that does not parse is dropped, never repaired.
      row({ election_date: 'TBD' }),
      row({ election_type_id: 'sg ' }),
    ],
  };
  expect(specialDatesFrom(body, AZ07)).toEqual([
    { date: '2025-07-15', type: 'SP' },
    { date: '2025-09-23', type: 'SG' },
    { date: '2025-11-04', type: 'SGR' },
  ]);
});

test('no row means an empty list, never a guessed date', () => {
  expect(specialDatesFrom({ pagination: { pages: 0 }, results: [] }, AZ07)).toEqual([]);
});

test('a response that is not the expected shape, or has more pages than we read, is a failed fetch', () => {
  expect(specialDatesFrom(null, AZ07)).toBeNull();
  expect(specialDatesFrom({ error: 'OVER_RATE_LIMIT' }, AZ07)).toBeNull();
  expect(specialDatesFrom({ pagination: { pages: 2 }, results: [row({})] }, AZ07)).toBeNull();
});

test('the file: fresh answers get today, a failed fetch keeps the old entry and its old date, filled seats drop off', () => {
  const vacancies = [
    { state: 'TX', district: 23, since: '2026-07-05' },
    { state: 'FL', district: 20, since: '2026-07-05' },
    { state: 'CA', district: 14, since: '2026-09-28' },
  ];
  const prev = {
    'fl-20': { checked: '2026-09-21', dates: [] },
    'ga-13': { checked: '2026-08-24', dates: [{ date: '2026-08-25', type: 'SR' }] },
  };
  const fetched = new Map<string, { date: string; type: string }[] | null>([
    ['tx-23', [{ date: '2026-11-03', type: 'SG' }]],
    ['fl-20', null],
    ['ca-14', null],
  ]);
  const next = buildSpecialElections(vacancies, fetched, prev, '2026-09-28');
  expect(next).toEqual({
    'fl-20': { checked: '2026-09-21', dates: [] },
    'tx-23': { checked: '2026-09-28', dates: [{ date: '2026-11-03', type: 'SG' }] },
  });
  // Stable key order, so an unchanged week is an unchanged file.
  expect(Object.keys(next)).toEqual(['fl-20', 'tx-23']);
});

test('the committed file only describes seats that are vacant, in the recorded shape', () => {
  const read = (p: string) => JSON.parse(readFileSync(join(process.cwd(), p), 'utf8'));
  const vacant = new Set((read('data/vacancies.json') as { state: string; district: number }[]).map(seatSlug));
  const file = read('data/special-elections.json') as Record<string, { checked: string; dates: { date: string; type: string }[] }>;
  for (const [slug, entry] of Object.entries(file)) {
    expect(vacant.has(slug), slug).toBe(true);
    expect(entry.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const d of entry.dates) {
      expect(d.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(d.type).toMatch(/^[A-Z]{1,4}$/);
    }
  }
});

test('the weekly workflow runs the sync after the roster refresh and before the commit, and cannot skip it quietly', () => {
  const yml = readFileSync(join(process.cwd(), '.github/workflows/refresh-legislators.yml'), 'utf8');
  const refresh = yml.indexOf('run: python3 scripts/process-data.py --download');
  const sync = yml.indexOf('run: node scripts/sync-special-elections.mjs');
  const commit = yml.indexOf('- name: Commit data');
  expect(refresh).toBeGreaterThan(0);
  expect(sync).toBeGreaterThan(refresh);
  expect(commit).toBeGreaterThan(sync);
  const step = yml.slice(yml.lastIndexOf('- name:', sync), sync);
  expect(step).not.toMatch(/continue-on-error/);
  expect(step).not.toMatch(/^\s*if:/m);
  expect(step).not.toMatch(/secrets\./);
});
