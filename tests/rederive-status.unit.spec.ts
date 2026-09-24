import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AMBIGUOUS_WITHOUT_CONTEXT,
  isAmbiguousAction,
  mapStatus,
  resolveAmbiguousStatus,
  statusFromActions,
  urgencyScore,
} from '../scripts/congress-fetch.mjs';
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
 * left every quiet bill on the old verdict. These pin what makes the pass safe
 * to run unattended: it writes only what the sync would write, it keeps the
 * two corpora in lockstep, it refuses to flip a large share of the corpus in
 * one night, and it never writes a passage for a sentence that cannot say
 * whether the vote before it passed.
 */

type Bill = Record<string, unknown>;
type Action = { text?: string };

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

const RECONSIDER = 'Motion to reconsider laid on the table Agreed to without objection.';
const MESSAGE_SENATE = 'Message on Senate action sent to the House.';
const MESSAGE_HOUSE = 'Message on House action sent to the Senate.';
const CONSIDERED = 'Considered by Senate. (consideration: CR S4851)';

/** The real action lists, newest first, as Congress.gov returned them on 2026-09-24. */
const RECORD: Record<string, Action[]> = {
  'hconres-38-119': [
    { text: RECONSIDER },
    { text: 'On agreeing to the resolution Failed by the Yeas and Nays: 212 - 219 (Roll no. 85).' },
    { text: 'Failed of passage/not agreed to in House On agreeing to the resolution Failed by the Yeas and Nays: 212 - 219 (Roll no. 85).' },
  ],
  'hr-2262-119': [
    { text: RECONSIDER },
    { text: 'On passage Failed by the Yeas and Nays: 209 - 215 (Roll no. 19).' },
  ],
  'hconres-86-119': [
    { text: MESSAGE_SENATE },
    { text: 'Resolution agreed to in Senate without amendment by Yea-Nay Vote. 50 - 48. Record Vote Number: 184. (consideration: CR S3039-3040)' },
  ],
  'hr-5345-119': [
    { text: MESSAGE_SENATE },
    { text: 'Passed Senate without amendment by Unanimous Consent. (consideration: CR S4790)' },
  ],
};
const recordResolver = (b: Bill) =>
  resolveAmbiguousStatus(b as never, {
    fetchActions: async (x: Bill) => RECORD[`${x.bill_type}-${x.bill_number}-119`] ?? null,
  });
const noApi = async () => null;

test.describe('the ambiguous sentences', () => {
  test('both shapes are declared, and matched in either chamber direction', () => {
    expect(AMBIGUOUS_WITHOUT_CONTEXT).toHaveLength(2);
    for (const t of [RECONSIDER, MESSAGE_SENATE, MESSAGE_HOUSE]) expect(isAmbiguousAction(t), t).toBe(true);
    expect(isAmbiguousAction('Passed Senate without amendment by Unanimous Consent.')).toBe(false);
  });

  test('each shape after a PASSAGE resolves to passed_chamber', () => {
    for (const shape of [RECONSIDER, MESSAGE_SENATE]) {
      expect(
        statusFromActions([
          { text: shape },
          { text: 'On passage Passed by the Yeas and Nays: 220 - 210 (Roll no. 40).' },
          { text: 'Passed/agreed to in House: On passage Passed by the Yeas and Nays: 220 - 210 (Roll no. 40).' },
        ]),
        shape
      ).toMatchObject({ status: 'passed_chamber' });
      // Without its summary sibling the bare vote sentence reads as no stage
      // at all, and the miss lands on the SAFE side: never a passage.
      expect(statusFromActions([{ text: shape }, { text: 'On passage Passed by the Yeas and Nays: 220 - 210 (Roll no. 40).' }]), shape)
        .not.toMatchObject({ status: 'passed_chamber' });
      expect(statusFromActions([{ text: shape }, { text: 'Passed Senate without amendment by Unanimous Consent.' }]), shape)
        .toMatchObject({ status: 'passed_chamber' });
    }
  });

  test('each shape after a FAILURE never resolves to a passage (no failed rung: committee)', () => {
    for (const shape of [RECONSIDER, MESSAGE_SENATE]) {
      expect(statusFromActions([{ text: shape }, { text: 'On passage Failed by the Yeas and Nays: 209 - 215 (Roll no. 19).' }]), shape)
        .toMatchObject({ status: 'committee' });
      expect(
        statusFromActions([{ text: shape }, { text: 'Failed of passage/not agreed to in House On agreeing to the resolution Failed by the Yeas and Nays: 212 - 219 (Roll no. 85).' }]),
        shape
      ).toMatchObject({ status: 'committee' });
    }
  });

  test('the vote is read as its same-timestamp GROUP, whichever sibling Congress.gov lists first', () => {
    // H.R. 1919's shape: the bare vote sentence ("On passage Passed by the
    // Yeas and Nays") is not a mapStatus passage, its summary sibling is.
    const t = { actionDate: '2025-07-17', actionTime: '14:02:11' };
    expect(
      statusFromActions([
        { text: RECONSIDER, actionDate: '2025-07-17', actionTime: '14:02:13' },
        { ...t, text: 'On passage Passed by the Yeas and Nays: 219 - 210 (Roll no. 201).' },
        { ...t, text: 'Passed/agreed to in House: On passage Passed by the Yeas and Nays: 219 - 210 (Roll no. 201).' },
        // An EARLIER failed motion at a different time is not part of the vote.
        { actionDate: '2025-07-17', actionTime: '13:40:00', text: 'On motion to recommit Failed by the Yeas and Nays: 209 - 213 (Roll no. 200).' },
      ] as never)
    ).toMatchObject({ status: 'passed_chamber' });
    // H.R. 1329's shape, summary listed second: still a defeat.
    const f = { actionDate: '2026-05-21', actionTime: '12:00:00' };
    expect(
      statusFromActions([
        { text: RECONSIDER, actionDate: '2026-05-21', actionTime: '12:00:02' },
        { ...f, text: 'On passage Failed by the Yeas and Nays: 204 - 216 (Roll no. 188).' },
        { ...f, text: 'Failed of passage/not agreed to in House On passage Failed by the Yeas and Nays: 204 - 216 (Roll no. 188).' },
      ] as never)
    ).toMatchObject({ status: 'committee' });
  });

  test('stacked ambiguous sentences are all skipped; an all-ambiguous list says nothing', () => {
    expect(statusFromActions([{ text: MESSAGE_HOUSE }, { text: RECONSIDER }, { text: 'Passed House by voice vote.' }]))
      .toMatchObject({ status: 'passed_chamber', basis: 'Passed House by voice vote.' });
    expect(statusFromActions([{ text: RECONSIDER }, { text: MESSAGE_SENATE }])).toBeNull();
  });

  test('the House defeat summary line is not read as a passage by mapStatus either', () => {
    // It contains "agreed to in House", which the passage branch matches.
    expect(mapStatus('Failed of passage/not agreed to in House On agreeing to the resolution Failed by the Yeas and Nays: 212 - 219 (Roll no. 85).'))
      .toBe('floor_vote');
  });
});

test.describe('planRederive', () => {
  test('finds a stored status the current matcher disagrees with, and nothing else', async () => {
    const corpus = [...settled(5), bill('s', 4668, 'committee', CONSIDERED)];
    const { changes, warnings } = await planRederive(corpus, { resolve: noApi });
    expect(changes).toEqual([{ slug: 's-4668-119', from: 'committee', to: 'floor_vote' }]);
    expect(warnings).toEqual([]);
  });

  test('the four live ambiguous bills resolve from the record before them', async () => {
    const corpus = [
      bill('hconres', 38, 'committee', RECONSIDER),
      bill('hr', 2262, 'committee', RECONSIDER),
      bill('hconres', 86, 'committee', MESSAGE_SENATE),
      bill('hr', 5345, 'committee', MESSAGE_SENATE),
    ];
    const { changes } = await planRederive(corpus, { resolve: recordResolver });
    // The two failed votes stay put — never passed_chamber.
    expect(changes.map((c) => [c.slug, c.to])).toEqual([
      ['hconres-86-119', 'passed_chamber'],
      ['hr-5345-119', 'passed_chamber'],
    ]);
  });

  test('a passage status ALREADY stored on an ambiguous sentence is checked too, and corrected', async () => {
    const { changes } = await planRederive([bill('hconres', 38, 'passed_chamber', RECONSIDER)], { resolve: recordResolver });
    expect(changes).toEqual([
      expect.objectContaining({ slug: 'hconres-38-119', from: 'passed_chamber', to: 'committee' }),
    ]);
  });

  test('NO API: an ambiguous bill keeps its stored status and is named in a warning', async () => {
    const corpus = [bill('hconres', 86, 'committee', MESSAGE_SENATE), bill('hr', 2262, 'passed_chamber', RECONSIDER)];
    const { changes, warnings } = await planRederive(corpus, { resolve: noApi });
    expect(changes).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('hconres-86-119');
    expect(warnings[1]).toContain('hr-2262-119');
  });

  test('a bill with no stored sentence is skipped, never rewritten to committee', async () => {
    const corpus = [bill('s', 1, 'floor_vote', null), bill('s', 2, 'floor_vote', '')];
    expect((await planRederive(corpus, { resolve: noApi })).changes).toEqual([]);
  });
});

test.describe('applyRederive', () => {
  test('writes status and the urgency the sync derives from it — by the same function — and nothing else', () => {
    const b = bill('s', 4668, 'committee', CONSIDERED);
    const before = { ...b };
    applyRederive([b], {}, [{ slug: 's-4668-119', from: 'committee', to: 'floor_vote' }]);
    expect(b.status).toBe('floor_vote');
    expect(b.urgency_score).toBe(urgencyScore('floor_vote', '2026-06-24'));
    expect(b.last_action_text).toBe(before.last_action_text);
    expect(b.last_action_date).toBe(before.last_action_date);
  });

  test('LOCKSTEP: the Spanish corpus is never given entries, and mirrors a status field if it carries one', () => {
    const change = [{ slug: 's-4668-119', from: 'committee', to: 'floor_vote' }];
    const esToday = { 's-4668-119': { headline: 'h', summary: 's', sections: {} } };
    const snapshot = JSON.stringify(esToday);
    expect(applyRederive([bill('s', 4668, 'committee', CONSIDERED)], esToday, change).esTouched).toBe(false);
    expect(JSON.stringify(esToday)).toBe(snapshot);

    const esWithStatus: Record<string, Record<string, unknown>> = {
      's-4668-119': { headline: 'h', status: 'committee', urgency_score: 0.45 },
    };
    const en = bill('s', 4668, 'committee', CONSIDERED);
    expect(applyRederive([en], esWithStatus, change).esTouched).toBe(true);
    expect(esWithStatus['s-4668-119'].status).toBe(en.status);
    expect(esWithStatus['s-4668-119'].urgency_score).toBe(en.urgency_score);
    expect(Object.keys(esWithStatus)).toEqual(['s-4668-119']);
  });
});

test.describe('the 2% guard', () => {
  test('the ceiling is 2% of the corpus, inclusive', () => {
    expect(MAX_CHANGE_FRACTION).toBe(0.02);
    expect(guardVerdict(64, 3205)).toMatchObject({ ok: true, limit: 64 });
    expect(guardVerdict(65, 3205)).toMatchObject({ ok: false, limit: 64 });
  });

  test('a night above the ceiling prints every change, writes nothing, and exits 1', async () => {
    const corpus = [
      ...settled(97),
      bill('s', 4668, 'committee', CONSIDERED),
      bill('hconres', 86, 'committee', MESSAGE_SENATE),
      bill('hr', 5345, 'committee', MESSAGE_SENATE),
    ];
    const snapshot = JSON.stringify(corpus);
    const r = await runRederive(corpus, {}, { resolve: recordResolver });
    expect(r.code).toBe(1);
    expect(r.wrote).toEqual({ en: false, es: false });
    expect(JSON.stringify(corpus)).toBe(snapshot);
    const printed = r.log.join('\n');
    expect(printed).toContain('REDERIVE_GUARD_TRIPPED');
    for (const slug of ['s-4668-119', 'hconres-86-119', 'hr-5345-119']) expect(printed).toContain(slug);
  });

  test('a night inside the ceiling applies and names every change old->new on the DONE line', async () => {
    const corpus = [...settled(99), bill('hconres', 86, 'committee', MESSAGE_SENATE)];
    const r = await runRederive(corpus, {}, { resolve: recordResolver });
    expect(r.code).toBe(0);
    expect(r.wrote.en).toBe(true);
    expect(r.log.join('\n')).toContain('DONE: rederive-status changed 1 of 100 bills: hconres-86-119 committee->passed_chamber');
  });

  test('--dry-run reports and writes nothing', async () => {
    const corpus = [...settled(99), bill('s', 4668, 'committee', CONSIDERED)];
    const r = await runRederive(corpus, {}, { dryRun: true, resolve: noApi });
    expect(r.code).toBe(0);
    expect(r.wrote).toEqual({ en: false, es: false });
    expect(corpus[99].status).toBe('committee');
  });
});

/*
 * THE SCRIPT BODY, end to end on disk, with the Congress.gov key REMOVED from
 * the child's environment: the guard really leaves both files byte-identical
 * and exits 1, a clean night leaves the Spanish file untouched, and an
 * ambiguous bill with no way to look is left exactly as it was.
 */
test.describe('scripts/rederive-status.mjs on disk (no API key)', () => {
  const script = join(process.cwd(), 'scripts/rederive-status.mjs');
  const env = { ...process.env };
  delete env.CONGRESS_API_KEY;
  const withCorpus = (en: Bill[], es: Record<string, unknown>, args: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), 'rederive-'));
    mkdirSync(join(dir, 'data'));
    const enPath = join(dir, 'data/bills.json');
    const esPath = join(dir, 'data/bills-es.json');
    writeFileSync(enPath, JSON.stringify(en));
    writeFileSync(esPath, JSON.stringify(es));
    const before = { en: readFileSync(enPath, 'utf8'), es: readFileSync(esPath, 'utf8') };
    const run = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', env });
    const after = { en: readFileSync(enPath, 'utf8'), es: readFileSync(esPath, 'utf8') };
    rmSync(dir, { recursive: true, force: true });
    return { run, before, after };
  };

  test('guard tripped: exit 1, both files unchanged', () => {
    const en = [...settled(40), bill('s', 4668, 'committee', CONSIDERED)]; // 1 of 41 > 2% (limit 0)
    const { run, before, after } = withCorpus(en, { 's-4668-119': { headline: 'h' } });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('REDERIVE_GUARD_TRIPPED');
    expect(after).toEqual(before);
  });

  test('clean night: EN rewritten, ES byte-identical, exit 0', () => {
    const en = [...settled(99), bill('s', 4668, 'committee', CONSIDERED)];
    const { run, before, after } = withCorpus(en, { 's-4668-119': { headline: 'h' } });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('DONE: rederive-status changed 1 of 100 bills');
    expect(after.es).toBe(before.es);
    const written = JSON.parse(after.en) as Bill[];
    expect(written.find((b) => b.full_identifier === 's-4668-119')?.status).toBe('floor_vote');
  });

  test('ambiguous bill, no key: status unchanged, file untouched, WARN names the slug, exit 0', () => {
    const en = [...settled(99), bill('hconres', 38, 'passed_chamber', RECONSIDER)];
    const { run, before, after } = withCorpus(en, {});
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('WARN hconres-38-119');
    expect(after).toEqual(before);
  });

  test('--dry-run on disk writes nothing', () => {
    const en = [...settled(99), bill('s', 4668, 'committee', CONSIDERED)];
    const { run, before, after } = withCorpus(en, {}, ['--dry-run']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('DRY RUN');
    expect(after).toEqual(before);
  });
});
