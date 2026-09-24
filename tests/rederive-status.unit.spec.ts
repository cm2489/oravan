import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { urgencyScore } from '../scripts/congress-fetch.mjs';
import {
  MAX_CHANGE_FRACTION,
  applyRederive,
  guardVerdict,
  planRederive,
  runRederive,
} from '../scripts/rederive-status.mjs';

/*
 * THE NIGHTLY STATUS RE-DERIVATION PASS (2026-09-24). A stored status was only
 * ever recomputed when Congress.gov reported the bill updated, so a matcher fix
 * left every quiet bill on the old verdict — hconres-86-119, agreed to by both
 * chambers, still read `committee`. These pin the three things that make the
 * pass safe to run unattended: it writes only what the sync would write, it
 * keeps the two corpora in lockstep, and it refuses to flip a large share of
 * the corpus in one night.
 */

type Bill = Record<string, unknown>;

const bill = (type: string, number: number, status: string, text: string | null, date = '2026-06-24'): Bill => ({
  full_identifier: `${type}-${number}-119`,
  congress_number: 119,
  bill_type: type,
  bill_number: number,
  status,
  last_action_text: text,
  last_action_date: date,
  urgency_score: 0.45,
});

/** A corpus of `n` bills whose stored status already matches their text. */
const settled = (n: number): Bill[] =>
  Array.from({ length: n }, (_, i) => bill('hr', 1000 + i, 'committee', 'Referred to the House Committee on Rules.'));

const HCONRES_86 = () => bill('hconres', 86, 'committee', 'Message on Senate action sent to the House.');

test.describe('planRederive', () => {
  test('finds a stored status the current matcher disagrees with, and nothing else', () => {
    const corpus = [...settled(5), HCONRES_86()];
    expect(planRederive(corpus)).toEqual([{ slug: 'hconres-86-119', from: 'committee', to: 'passed_chamber' }]);
  });

  test('a bill with no stored sentence is skipped, never rewritten to committee', () => {
    // mapStatus(undefined) falls through to `committee`; refreshBillFields
    // refuses to write from an unreadable action, and so does this pass.
    const corpus = [bill('s', 1, 'floor_vote', null), bill('s', 2, 'floor_vote', '')];
    expect(planRederive(corpus)).toEqual([]);
  });
});

test.describe('applyRederive', () => {
  test('writes status and the urgency the sync derives from it — by the same function — and nothing else', () => {
    const b = HCONRES_86();
    const before = { ...b };
    applyRederive([b], {}, [{ slug: 'hconres-86-119', from: 'committee', to: 'passed_chamber' }]);
    expect(b.status).toBe('passed_chamber');
    expect(b.urgency_score).toBe(urgencyScore('passed_chamber', '2026-06-24'));
    // The record itself is read, never re-dated or re-worded.
    expect(b.last_action_text).toBe(before.last_action_text);
    expect(b.last_action_date).toBe(before.last_action_date);
  });

  test('LOCKSTEP: the Spanish corpus is never given entries, and mirrors a status field if it carries one', () => {
    // Today's bills-es.json carries headline/summary/sections only.
    const esToday = { 'hconres-86-119': { headline: 'h', summary: 's', sections: {} } };
    const snapshot = JSON.stringify(esToday);
    const r1 = applyRederive([HCONRES_86()], esToday, [{ slug: 'hconres-86-119', from: 'committee', to: 'passed_chamber' }]);
    expect(r1.esTouched).toBe(false);
    expect(JSON.stringify(esToday)).toBe(snapshot);

    // If it ever gains a status, the two cannot drift.
    const esWithStatus: Record<string, Record<string, unknown>> = {
      'hconres-86-119': { headline: 'h', status: 'committee', urgency_score: 0.45 },
    };
    const en = HCONRES_86();
    const r2 = applyRederive([en], esWithStatus, [{ slug: 'hconres-86-119', from: 'committee', to: 'passed_chamber' }]);
    expect(r2.esTouched).toBe(true);
    expect(esWithStatus['hconres-86-119'].status).toBe(en.status);
    expect(esWithStatus['hconres-86-119'].urgency_score).toBe(en.urgency_score);
    expect(Object.keys(esWithStatus)).toEqual(['hconres-86-119']);
  });
});

test.describe('the 2% guard', () => {
  test('the ceiling is 2% of the corpus, inclusive', () => {
    expect(MAX_CHANGE_FRACTION).toBe(0.02);
    expect(guardVerdict(64, 3205)).toMatchObject({ ok: true, limit: 64 });
    expect(guardVerdict(65, 3205)).toMatchObject({ ok: false, limit: 64 });
  });

  test('a night above the ceiling prints every change, writes nothing, and exits 1', () => {
    // 3 of 100 = 3% > 2%.
    const corpus = [
      ...settled(97),
      HCONRES_86(),
      bill('s', 4668, 'committee', 'Considered by Senate. (consideration: CR S4851)'),
      bill('hr', 2262, 'committee', 'Motion to reconsider laid on the table Agreed to without objection.'),
    ];
    const snapshot = JSON.stringify(corpus);
    const r = runRederive(corpus, {});
    expect(r.code).toBe(1);
    expect(r.wrote).toEqual({ en: false, es: false });
    expect(JSON.stringify(corpus)).toBe(snapshot);
    const printed = r.log.join('\n');
    expect(printed).toContain('REDERIVE_GUARD_TRIPPED');
    for (const slug of ['hconres-86-119', 's-4668-119', 'hr-2262-119']) expect(printed).toContain(slug);
  });

  test('a night inside the ceiling applies and names every change old->new on the DONE line', () => {
    const corpus = [...settled(99), HCONRES_86()];
    const r = runRederive(corpus, {});
    expect(r.code).toBe(0);
    expect(r.wrote.en).toBe(true);
    expect(r.log.join('\n')).toContain('DONE: rederive-status changed 1 of 100 bills: hconres-86-119 committee->passed_chamber');
  });

  test('--dry-run reports and writes nothing', () => {
    const corpus = [...settled(99), HCONRES_86()];
    const r = runRederive(corpus, {}, { dryRun: true });
    expect(r.code).toBe(0);
    expect(r.wrote).toEqual({ en: false, es: false });
    expect(corpus[99].status).toBe('committee');
  });
});

/*
 * THE SCRIPT BODY, end to end on disk: the guard really leaves both files
 * byte-identical and really exits 1, and a clean night leaves the Spanish file
 * untouched.
 */
test.describe('scripts/rederive-status.mjs on disk', () => {
  const script = join(process.cwd(), 'scripts/rederive-status.mjs');
  const withCorpus = (en: Bill[], es: Record<string, unknown>, args: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), 'rederive-'));
    mkdirSync(join(dir, 'data'));
    const enPath = join(dir, 'data/bills.json');
    const esPath = join(dir, 'data/bills-es.json');
    writeFileSync(enPath, JSON.stringify(en));
    writeFileSync(esPath, JSON.stringify(es));
    const before = { en: readFileSync(enPath, 'utf8'), es: readFileSync(esPath, 'utf8') };
    const run = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' });
    const after = { en: readFileSync(enPath, 'utf8'), es: readFileSync(esPath, 'utf8') };
    rmSync(dir, { recursive: true, force: true });
    return { run, before, after };
  };

  test('guard tripped: exit 1, both files unchanged', () => {
    const en = [...settled(40), HCONRES_86()]; // 1 of 41 > 2% (limit 0)
    const { run, before, after } = withCorpus(en, { 'hconres-86-119': { headline: 'h' } });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('REDERIVE_GUARD_TRIPPED');
    expect(after).toEqual(before);
  });

  test('clean night: EN rewritten, ES byte-identical, exit 0', () => {
    const en = [...settled(99), HCONRES_86()];
    const { run, before, after } = withCorpus(en, { 'hconres-86-119': { headline: 'h' } });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('DONE: rederive-status changed 1 of 100 bills');
    expect(after.es).toBe(before.es);
    const written = JSON.parse(after.en) as Bill[];
    expect(written.find((b) => b.full_identifier === 'hconres-86-119')?.status).toBe('passed_chamber');
  });

  test('--dry-run on disk writes nothing', () => {
    const en = [...settled(99), HCONRES_86()];
    const { run, before, after } = withCorpus(en, {}, ['--dry-run']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('DRY RUN');
    expect(after).toEqual(before);
  });
});
