import { expect, test } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  RELATED_BILLS_SCHEMA,
  emptyRelatedBills,
  parseRelatedTrouble,
  planRelatedRun,
  relatedAlarms,
  relatedStaleness,
  serializeRelatedBills,
  verifyRelatedBills,
} from '../lib/related-bills.mjs';

/*
 * scripts/sync-related.mjs, the nightly identical-bills step, run for real
 * against a throwaway data/ folder, night by night on PINNED dates
 * (RELATED_TODAY), with every Congress.gov request answered by
 * tests/fixtures/sync-related-fetch-mock.mjs. Zero network, $0. The retry
 * pause is 0 and the per-attempt timeout is short, so a hang costs
 * milliseconds here, not seconds.
 *
 * After each night, the next morning's health report is read the way
 * scripts/pipeline-health.mjs reads it: the writer's REAL output through
 * parseRelatedTrouble, and the written file through relatedStaleness, both
 * into relatedAlarms.
 */

const REPO = process.cwd();
const SCRIPT = join(REPO, 'scripts/sync-related.mjs');
const MOCK = pathToFileURL(join(REPO, 'tests/fixtures/sync-related-fetch-mock.mjs')).href;
const KEY = 'test-congress-key-DO-NOT-PRINT';

type Json = Record<string, unknown>;
const bill = (type: string, number: number) => ({ bill_type: type, bill_number: number, congress_number: 119 });
const identical = (type: string, number: number) => ({ congress: 119, number, type, relationshipDetails: [{ type: 'Identical bill', identifiedBy: 'CRS' }] });
const related = (type: string, number: number) => ({ congress: 119, number, type, relationshipDetails: [{ type: 'Related bill', identifiedBy: 'CRS' }] });
const answer = (...entries: Json[]) => ({ relatedBills: entries, pagination: { count: entries.length } });
const row = (slug: string) => ({ slug, type: 'Identical bill', identifiedBy: ['CRS'] });

function world({ bills, coverage, file }: { bills: Json[]; coverage: string[]; file?: Json | null }) {
  const dir = mkdtempSync(join(tmpdir(), 'related-writer-'));
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'data/bills.json'), JSON.stringify(bills));
  writeFileSync(join(dir, 'data/coverage.json'), JSON.stringify(Object.fromEntries([['_checkedAt', {}], ...coverage.map((s) => [s, [{ url: `https://x.test/${s}` }]])])));
  if (file) writeFileSync(join(dir, 'data/related-bills.json'), serializeRelatedBills(file));
  return dir;
}

function night(dir: string, today: string, scenario: Json, env: Record<string, string> = {}) {
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  rmSync(join(dir, 'requests.log'), { force: true });
  rmSync(join(dir, 'queries.log'), { force: true });
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--import', MOCK, SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      CONGRESS_API_KEY: KEY,
      RELATED_TODAY: today,
      RELATED_RETRY_PAUSE_MS: '0',
      RELATED_ATTEMPT_TIMEOUT_MS: '200',
      RELATED_MOCK_SCENARIO: join(dir, 'scenario.json'),
      RELATED_MOCK_LOG: join(dir, 'requests.log'),
      RELATED_MOCK_QUERY_LOG: join(dir, 'queries.log'),
      ...env,
    } as unknown as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
  const out = `${r.stdout}${r.stderr}`;
  const requests = existsSync(join(dir, 'requests.log')) ? readFileSync(join(dir, 'requests.log'), 'utf8').trim().split('\n').filter(Boolean) : [];
  const queries = existsSync(join(dir, 'queries.log')) ? readFileSync(join(dir, 'queries.log'), 'utf8').trim().split('\n').filter(Boolean) : [];
  return { status: r.status, out, ms: Date.now() - t0, requests, queries };
}

const fileText = (dir: string) => readFileSync(join(dir, 'data/related-bills.json'), 'utf8');
const fileOf = (dir: string) => JSON.parse(fileText(dir));
/** The next morning's alarms, as the daily report (13:00 UTC) reads them. */
const morning = (dir: string, out: string, day: string) =>
  relatedAlarms({ trouble: parseRelatedTrouble(out), staleness: relatedStaleness(fileOf(dir), Date.parse(`${day}T13:00:00Z`)) }).map((a) => a.code);
const base = (over: Json = {}) => ({ ...emptyRelatedBills('2026-11-09'), ...over });

test.describe('an ordinary night, and an ordinary week', () => {
  test('a night looks up bills with coverage AND bills already in the file, keeps "Identical bill" only, and passes its own gate', () => {
    const dir = world({
      bills: [bill('hr', 10), bill('s', 20), bill('hr', 30), bill('hr', 40)],
      coverage: ['hr-10-119', 'hr-30-119'],
      // hr-40 has no coverage, but the file holds a relation for it.
      file: base({ _checkedAt: { 'hr-40-119': '2026-11-01' }, 'hr-40-119': [row('s-20-119')] }),
    });
    try {
      const r = night(dir, '2026-11-10', {
        'hr/10': answer(identical('S', 20), related('HR', 30)),
        'hr/30': answer(),
        'hr/40': answer(identical('S', 20)),
      });
      expect(r.status, r.out).toBe(0);
      expect(r.out.split('\n')[0]).toBe('RELATED START: reading the record\'s "Identical bill" relations');
      expect(r.out).toMatch(/RELATED DONE: looked up 3 of 3 planned \(0 failed; 3 candidate bills, 2 with coverage\)/);
      expect(r.out).toContain('Congress.gov requests: 3. Cost: $0.');
      expect(r.queries).toEqual(Array(3).fill('limit=250 format=json key=given'));
      expect(r.out).toContain('2 bills carry an identical bill (1 before tonight)');
      expect(r.out).not.toContain(KEY);
      expect(r.requests.sort()).toEqual(['/v3/bill/119/hr/10/relatedbills', '/v3/bill/119/hr/30/relatedbills', '/v3/bill/119/hr/40/relatedbills']);
      const f = fileOf(dir);
      expect(f._meta).toEqual({ schema: RELATED_BILLS_SCHEMA, kept_types: ['Identical bill'], filled_at: '2026-11-10', previous_carrying: 1 });
      expect(f['hr-10-119']).toEqual([row('s-20-119')]);
      expect(f['hr-30-119']).toBeUndefined();
      expect(verifyRelatedBills({ data: f, today: '2026-11-10', knownSlugs: new Set(['hr-10-119', 's-20-119', 'hr-30-119', 'hr-40-119']) })).toMatchObject({ failures: [], warnings: [] });
      expect(morning(dir, r.out, '2026-11-11')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the first fill from the committed empty file, then an ordinary week: no alarm on any morning', () => {
    const bills = [bill('hr', 1), bill('s', 1), bill('hr', 2), bill('s', 2), bill('hr', 3), bill('s', 3), bill('hr', 4)];
    // Pinned in October: RELATED_TODAY is only honoured up to the real date.
    const dir = world({ bills, coverage: ['hr-1-119', 'hr-2-119', 'hr-3-119', 'hr-4-119'], file: emptyRelatedBills('2026-10-17') });
    const record: Json = {
      'hr/1': answer(identical('S', 1)),
      'hr/2': answer(identical('S', 2)),
      'hr/3': answer(identical('S', 3)),
      'hr/4': answer(),
      's/1': answer(identical('HR', 1)),
      's/2': answer(identical('HR', 2)),
      's/3': answer(identical('HR', 3)),
    };
    try {
      // The first three mornings, before any nightly: quiet.
      for (const day of ['2026-10-18', '2026-10-19', '2026-10-20']) expect(morning(dir, '', day), day).toEqual([]);
      const days = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'];
      for (const [i, day] of days.entries()) {
        // On the fifth night the record drops one relation: an ordinary change.
        const tonight = i >= 4 ? { ...record, 'hr/3': answer() , 's/3': answer() } : record;
        const r = night(dir, day, tonight);
        expect(r.status, `${day}\n${r.out}`).toBe(0);
        const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
        expect(morning(dir, r.out, next), day).toEqual([]);
      }
      const f = fileOf(dir);
      expect(f._meta.filled_at).toBe('2026-10-27');
      // hr-3 was rechecked within the week and lost its twin.
      expect(f['hr-3-119']).toBeUndefined();
      // Only bills with coverage or already in the file are looked up, so the
      // Senate twins are read from the House side (twinsOf reads both ways).
      expect(Object.keys(f).filter((k) => !k.startsWith('_')).sort()).toEqual(['hr-1-119', 'hr-2-119']);
      expect(f._meta.previous_carrying).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a relation the record drops is removed within the weekly cycle, even on a bill with no coverage', () => {
    const dir = world({
      bills: [bill('hr', 40), bill('s', 20)],
      coverage: [],
      file: base({ _checkedAt: { 'hr-40-119': '2026-11-01' }, 'hr-40-119': [row('s-20-119')] }),
    });
    try {
      // Six days after its check, it waits.
      let r = night(dir, '2026-11-07', { 'hr/40': answer() });
      expect(r.requests).toEqual([]);
      expect(fileOf(dir)['hr-40-119']).toEqual([row('s-20-119')]);
      // On the seventh, it is looked up and the dropped relation goes.
      r = night(dir, '2026-11-08', { 'hr/40': answer() });
      expect(r.requests).toEqual(['/v3/bill/119/hr/40/relatedbills']);
      expect(r.out).toContain('no longer listed as identical: hr-40-119 <-> s-20-119');
      expect(fileOf(dir)['hr-40-119']).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the plan: never-checked first, then the oldest; a bill checked this week waits', () => {
    expect(
      planRelatedRun({
        candidates: ['hr-1-119', 'hr-2-119', 'hr-3-119', 'hr-4-119'],
        checkedAt: { 'hr-1-119': '2026-11-13', 'hr-2-119': '2026-10-01', 'hr-3-119': '2026-11-01' },
        today: '2026-11-14',
        perNight: 2,
        recheckDays: 7,
      })
    ).toEqual(['hr-4-119', 'hr-2-119']);
  });
});

test.describe('a slow or broken Congress.gov never costs the night', () => {
  const tenBills = Array.from({ length: 10 }, (_, i) => bill('hr', i + 1));
  const tenSlugs = tenBills.map((b) => `hr-${b.bill_number}-119`);
  const before = base({ _checkedAt: { 'hr-1-119': '2026-10-01' }, 'hr-1-119': [row('hr-2-119')] });

  test('a hang: one attempt per bill, never retried, and the time budget stops the run; the file is byte-identical', () => {
    const dir = world({ bills: tenBills, coverage: tenSlugs, file: before });
    try {
      const was = fileText(dir);
      const r = night(dir, '2026-11-10', Object.fromEntries(tenBills.map((b) => [`hr/${b.bill_number}`, 'hang'])), {
        RELATED_ATTEMPT_TIMEOUT_MS: '100',
        RELATED_BUDGET_MS: '250',
        RELATED_MAX_FAILS_IN_A_ROW: '100', // so the budget, not the streak, is what stops it
      });
      expect(r.status, r.out).toBe(1);
      const m = r.out.match(/RELATED STOPPED: it reached its 0\.25-second time budget after (\d+) of 10 lookups/);
      expect(m, r.out).not.toBeNull();
      const looked = Number(m![1]);
      expect(looked).toBeGreaterThanOrEqual(2);
      expect(looked).toBeLessThan(10);
      expect(r.requests).toHaveLength(looked); // one attempt per hung bill: never retried
      expect(r.out).toContain('no answer within 0.1 s');
      expect(r.ms).toBeLessThan(5_000);
      expect(fileText(dir)).toBe(was);
      expect(existsSync(join(dir, 'data/related-bills.json.tmp'))).toBe(false);
      expect(morning(dir, r.out, '2026-11-11')).toEqual(['related-bills-stopped']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('five failed lookups in a row stop the run; a 5xx is tried twice; the file is byte-identical', () => {
    const dir = world({ bills: tenBills, coverage: tenSlugs, file: before });
    try {
      const was = fileText(dir);
      const r = night(dir, '2026-11-10', Object.fromEntries(tenBills.map((b) => [`hr/${b.bill_number}`, 503])));
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain('RELATED STOPPED: 5 lookups in a row failed (the last: Congress.gov 503 for /bill/119/hr/');
      expect(r.requests).toHaveLength(10); // 5 bills x 2 attempts
      expect(fileText(dir)).toBe(was);
      expect(morning(dir, r.out, '2026-11-11')).toEqual(['related-bills-stopped']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a 5xx then an answer: the second attempt is used', () => {
    const dir = world({ bills: [bill('hr', 1), bill('s', 1)], coverage: ['hr-1-119'], file: base() });
    try {
      const r = night(dir, '2026-11-10', { 'hr/1': [503, answer(identical('S', 1))] }, { RELATED_RETRY_PAUSE_MS: '400' });
      expect(r.status, r.out).toBe(0);
      expect(r.requests).toHaveLength(2);
      expect(r.out).toContain('Congress.gov requests: 2.');
      expect(r.ms).toBeGreaterThanOrEqual(400); // the pause before the second attempt
      expect(fileOf(dir)['hr-1-119']).toEqual([row('s-1-119')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a kill mid-run (the step timeout): exit 143, no temporary file, the file as it was, and a crash alarm', async () => {
    const dir = world({ bills: tenBills, coverage: tenSlugs, file: before });
    try {
      const was = fileText(dir);
      writeFileSync(join(dir, 'scenario.json'), JSON.stringify(Object.fromEntries(tenBills.map((b) => [`hr/${b.bill_number}`, 'hang']))));
      const child = spawn(process.execPath, ['--import', MOCK, SCRIPT], {
        cwd: dir,
        env: { PATH: process.env.PATH ?? '', CONGRESS_API_KEY: KEY, RELATED_TODAY: '2026-11-10', RELATED_ATTEMPT_TIMEOUT_MS: '60000', RELATED_MOCK_SCENARIO: join(dir, 'scenario.json') } as unknown as NodeJS.ProcessEnv,
      });
      let out = '';
      const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
      child.stdout.on('data', (d) => (out += d));
      await new Promise<void>((res) => child.stdout.on('data', () => out.includes('RELATED START') && res()));
      await new Promise((r) => setTimeout(r, 300));
      // As if the kill landed mid-write: the temporary file must go too.
      writeFileSync(join(dir, 'data/related-bills.json.tmp'), '{"half":');
      child.kill('SIGTERM');
      const code = await exited;
      expect(code).toBe(143);
      expect(fileText(dir)).toBe(was);
      expect(existsSync(join(dir, 'data/related-bills.json.tmp'))).toBe(false);
      expect(morning(dir, out, '2026-11-11')).toEqual(['related-bills-crashed']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('a reshaped answer is a failed lookup, never "no twin"', () => {
  const bills = [bill('hr', 1), bill('s', 1), bill('hr', 2), bill('s', 2)];
  const had = base({ _checkedAt: { 'hr-1-119': '2026-10-01', 'hr-2-119': '2026-10-01' }, 'hr-1-119': [row('s-1-119')], 'hr-2-119': [row('s-2-119')] });

  for (const [name, reshaped] of [
    ['no relatedBills list (a renamed field)', { related_bills: [identical('S', 1)] }],
    ['an entry with no relationshipDetails (a renamed field)', { relatedBills: [{ congress: 119, number: 1, type: 'S', relationship_details: [{ type: 'Identical bill' }] }] }],
    ['a relationshipDetails item with no type', { relatedBills: [{ congress: 119, number: 1, type: 'S', relationshipDetails: [{ kind: 'Identical bill', identifiedBy: 'CRS' }] }] }],
  ] as const) {
    test(`${name}: both bills keep their twins, and the next morning raises an alarm`, () => {
      const dir = world({ bills, coverage: ['hr-1-119', 'hr-2-119'], file: had });
      try {
        const was = fileText(dir);
        // Every answer reshaped: nothing changes, STOPPED.
        let r = night(dir, '2026-11-10', { 'hr/1': reshaped, 'hr/2': reshaped });
        expect(r.status, r.out).toBe(1);
        expect(r.out).toContain('is not in the documented shape');
        expect(r.out).toContain('RELATED STOPPED: all 2 lookups failed (the first: the answer for hr-1-119 is not in the documented shape');
        expect(fileText(dir)).toBe(was);
        expect(morning(dir, r.out, '2026-11-11')).toContain('related-bills-stopped');
        // Half reshaped: the reshaped bill keeps its twin, and the half-or-more alarm fires.
        r = night(dir, '2026-11-11', { 'hr/1': reshaped, 'hr/2': answer(identical('S', 2)) });
        expect(r.status, r.out).toBe(0);
        expect(r.out).toContain('RELATED DONE: looked up 1 of 2 planned (1 failed');
        expect(fileOf(dir)['hr-1-119']).toEqual([row('s-1-119')]);
        expect(morning(dir, r.out, '2026-11-12')).toEqual(['related-bills-lookups-failed']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test.describe('a bill leaving data/bills.json', () => {
  // hr-6500-119 carries a relation; then it leaves the corpus.
  const after = [bill('s', 20), bill('hr', 30)];
  const file = base({
    _checkedAt: { 'hr-6500-119': '2026-11-01', 'hr-30-119': '2026-11-01', 's-20-119': '2026-11-09' },
    'hr-6500-119': [row('s-20-119')],
    'hr-30-119': [row('hr-6500-119'), row('s-20-119')],
    // checked yesterday, so not looked up tonight: its only twin left the corpus
    's-20-119': [row('hr-6500-119')],
  });

  test('the gate only WARNS on the old file, so neither the night nor CI is blocked', () => {
    const v = verifyRelatedBills({ data: file, today: '2026-11-10', knownSlugs: new Set(['s-20-119', 'hr-30-119']) });
    expect(v.failures).toEqual([]);
    expect(v.warnings.join('\n')).toContain('"hr-6500-119" is not a bill in data/bills.json; the writer prunes it on its next run');
  });

  test("the REAL verify-sync on that data passes, with the warning (the nightly commit goes ahead)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-sync-related-'));
    try {
      mkdirSync(join(dir, 'data'));
      const files: Record<string, unknown> = {
        'bills.json': after,
        'bills-es.json': {},
        'coverage.json': {},
        'sync-state.json': { lastSync: '2026-09-25T00:00:00Z' },
        'related-bills.json': JSON.parse(serializeRelatedBills(file)),
      };
      for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, 'data', name), JSON.stringify(value));
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.RUN_STARTED_AT;
      const r = spawnSync(process.execPath, [join(REPO, 'scripts/verify-sync.mjs')], { cwd: dir, env, encoding: 'utf8' });
      const out = `${r.stdout}\n${r.stderr}`;
      expect(out).toContain('::warning::data/related-bills.json: "hr-6500-119" is not a bill in data/bills.json');
      expect(out).not.toMatch(/::error::data\/related-bills\.json/);
      expect(r.status, out).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CI's check-related-bills on that data: exit 0, with the warning printed", () => {
    const dir = world({ bills: after, coverage: [], file });
    try {
      const r = spawnSync(process.execPath, [join(REPO, 'scripts/check-related-bills.mjs'), dir], { encoding: 'utf8' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('::warning::data/related-bills.json: "hr-6500-119" is not a bill in data/bills.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the next run prunes the key and the twin row, says so, and writes a file that passes without a warning', () => {
    const dir = world({ bills: after, coverage: ['hr-30-119'], file });
    try {
      const r = night(dir, '2026-11-10', { 'hr/30': answer(identical('S', 20)) });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('pruned 1 bill(s) and 2 twin row(s) no longer in data/bills.json');
      const f = fileOf(dir);
      expect(f['s-20-119']).toBeUndefined(); // every twin it had left the corpus
      expect(f['hr-6500-119']).toBeUndefined();
      expect(f._checkedAt['hr-6500-119']).toBeUndefined();
      expect(f['hr-30-119']).toEqual([row('s-20-119')]);
      expect(verifyRelatedBills({ data: f, today: '2026-11-10', knownSlugs: new Set(['s-20-119', 'hr-30-119']) })).toMatchObject({ failures: [], warnings: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('dates the writer cannot get wrong', () => {
  test('a future RELATED_TODAY is ignored: the writer never writes a day after the real one', () => {
    const dir = world({ bills: [bill('hr', 1)], coverage: ['hr-1-119'], file: base() });
    try {
      const realBefore = new Date().toISOString().slice(0, 10);
      const r = night(dir, '2999-01-01', { 'hr/1': answer() });
      const realAfter = new Date().toISOString().slice(0, 10);
      expect(r.status, r.out).toBe(0);
      expect([realBefore, realAfter]).toContain(fileOf(dir)._meta.filled_at);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a hand-edited future filled_at or check day only warns, the next run replaces it, and the report calls it stale', () => {
    const hand = base({ _meta: { ...emptyRelatedBills('2999-01-01')._meta }, _checkedAt: { 'hr-1-119': '2999-01-01' }, 'hr-1-119': [row('s-1-119')] });
    const v = verifyRelatedBills({ data: hand, today: '2026-11-10' });
    expect(v.failures).toEqual([]);
    expect(v.warnings).toHaveLength(2);
    expect(relatedAlarms({ trouble: null, staleness: relatedStaleness(hand, Date.parse('2026-11-10T13:00:00Z')) }).map((a) => a.code)).toEqual(['related-bills-stale']);
    const dir = world({ bills: [bill('hr', 1), bill('s', 1)], coverage: ['hr-1-119'], file: hand });
    try {
      // The future check day counts as never checked, so hr-1 is looked up tonight.
      const r = night(dir, '2026-11-10', { 'hr/1': answer(identical('S', 1)) });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('treated 1 future check day(s) as never checked');
      expect(r.requests).toHaveLength(1);
      expect(fileOf(dir)._meta.filled_at).toBe('2026-11-10');
      expect(fileOf(dir)._checkedAt['hr-1-119']).toBe('2026-11-10');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('the other ways it STOPS', () => {
  test('with no key and no file: an empty, valid file, and STOPPED saying so', () => {
    const dir = world({ bills: [bill('hr', 1)], coverage: ['hr-1-119'], file: null });
    try {
      const r = night(dir, '2026-11-10', {}, { CONGRESS_API_KEY: '' });
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain('RELATED STOPPED: CONGRESS_API_KEY is not set, so nothing was looked up. No data/related-bills.json existed, so an empty one was written.');
      expect(r.out).not.toContain('was left as it was');
      expect(fileOf(dir)).toEqual(emptyRelatedBills('2026-11-10'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a file that would fail its own gate is not written, and says it STOPPED', () => {
    // A damaged row on a bill checked yesterday, so tonight does not replace it.
    const bad = base({ _checkedAt: { 'hr-30-119': '2026-11-09' }, 'hr-30-119': [{ slug: 's-20-119', type: 'Related bill', identifiedBy: ['CRS'] }] });
    const dir = world({ bills: [bill('hr', 10), bill('s', 20), bill('hr', 30)], coverage: ['hr-10-119'], file: bad });
    try {
      const was = fileText(dir);
      const r = night(dir, '2026-11-10', { 'hr/10': answer() });
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain('RELATED STOPPED: the new file failed its own gate');
      expect(r.out).not.toContain('RELATED DONE');
      expect(fileText(dir)).toBe(was);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('anything thrown (an unreadable coverage file) says it STOPPED, and nothing is written', () => {
    const dir = world({ bills: [bill('hr', 1)], coverage: [], file: null });
    try {
      writeFileSync(join(dir, 'data/coverage.json'), '{ not json');
      const r = night(dir, '2026-11-10', {});
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain('RELATED STOPPED: it threw:');
      expect(existsSync(join(dir, 'data/related-bills.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('the step in the nightly workflow', () => {
  const yml = readFileSync(join(REPO, '.github/workflows/sync-bills.yml'), 'utf8');
  const step = yml.slice(yml.indexOf('- name: Read identical bills from the record'), yml.indexOf('- name: Collect Moment updates'));

  test('runs under `timeout 8m` with a 10-minute backstop, continue-on-error, between the coverage sync and verify-sync', () => {
    expect(step).toContain('continue-on-error: true');
    expect(step).toMatch(/\n\s+timeout-minutes: 10\n/);
    expect(step).toMatch(/run: timeout --signal=TERM --kill-after=30s 8m node scripts\/sync-related\.mjs\n/);
    expect(yml.indexOf('- name: Read identical bills from the record')).toBeGreaterThan(yml.indexOf('node scripts/sync-coverage.mjs'));
    expect(yml.indexOf('- name: Read identical bills from the record')).toBeLessThan(yml.indexOf('run: node scripts/verify-sync.mjs'));
  });

  test("the script's own worst case ends well inside the 8 minutes, and 8 minutes plus the kill grace inside the 10", () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const num = (name: string) => Number(src.match(new RegExp(`envNum\\('${name}', ([\\d_]+)\\)`))![1].replace(/_/g, ''));
    const attempt = num('RELATED_ATTEMPT_TIMEOUT_MS');
    const pause = num('RELATED_RETRY_PAUSE_MS');
    const budget = num('RELATED_BUDGET_MS');
    expect([attempt, pause, budget]).toEqual([15_000, 3_000, 300_000]);
    // No lookup starts after the budget; the last one takes at most two attempts and a pause.
    const worstMs = budget + (attempt + pause + attempt);
    expect(worstMs).toBe(333_000); // 5 min 33 s
    expect(worstMs).toBeLessThan(8 * 60_000);
    expect(8 * 60_000 + 30_000).toBeLessThan(10 * 60_000);
  });

  test('a leftover temporary file can never reach the nightly commit (.gitignore)', () => {
    const r = spawnSync('git', ['check-ignore', '-q', 'data/related-bills.json.tmp'], { cwd: REPO });
    expect(r.status).toBe(0);
    expect(spawnSync('git', ['check-ignore', '-q', 'data/related-bills.json'], { cwd: REPO }).status).toBe(1);
  });
});

test.describe('small things the writer must also do', () => {
  test('a temporary file left by an earlier killed run is removed at the start, even on a night that writes nothing', () => {
    const dir = world({ bills: [bill('hr', 1)], coverage: ['hr-1-119'], file: base() });
    try {
      writeFileSync(join(dir, 'data/related-bills.json.tmp'), '{"half":');
      const r = night(dir, '2026-11-10', { 'hr/1': 404 });
      expect(r.out).toContain('RELATED STOPPED: all 1 lookups failed');
      expect(existsSync(join(dir, 'data/related-bills.json.tmp'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a bill with more than 250 related bills says only the first 250 were read', () => {
    const dir = world({ bills: [bill('hr', 1)], coverage: ['hr-1-119'], file: base() });
    try {
      const r = night(dir, '2026-11-10', { 'hr/1': { relatedBills: [], pagination: { count: 300 } } });
      expect(r.out).toContain('::warning::hr-1-119 has 300 related bills; only the first 250 were read');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
