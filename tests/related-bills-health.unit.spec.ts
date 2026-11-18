import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alarms } from '../lib/pipeline-health.mjs';
import {
  RELATED_REASON_MAX,
  RELATED_STALE_DAYS,
  TWIN_FALL_MIN,
  emptyRelatedBills,
  parseRelatedTrouble,
  relatedAlarms,
  recordAnswerProblem,
  relatedStaleness,
  twinCountFell,
  verifyRelatedBills,
} from '../lib/related-bills.mjs';

/*
 * The daily health report's three alarms for the nightly identical-bills step
 * (scripts/sync-related.mjs; owner, 2026-11-13, twin coverage):
 *   (a) related-bills-stopped  the night's log holds a RELATED STOPPED line
 *   (b) related-bills-crashed  RELATED START with no DONE or STOPPED after it
 *   (c) related-bills-stale    data/related-bills.json's _meta.filled_at is
 *                              more than RELATED_STALE_DAYS days old
 * Every input here is a fixture or a pinned date. The log lines are in the
 * REAL shape of a downloaded GitHub Actions log: tests/fixtures/
 * related-bills-health/nightly-2026-11-16-before-step.log is cut, byte for
 * byte, from the nightly of 2026-11-16 (run 43978722399): every line starts
 * `sync<TAB>UNKNOWN STEP<TAB><timestamp> `, and the first line carries a
 * byte-order mark just before its timestamp.
 */

const FIXTURE = join(process.cwd(), 'tests/fixtures/related-bills-health/nightly-2026-11-16-before-step.log');
const REAL = readFileSync(FIXTURE, 'utf8');
const BOM = '﻿';
// The real prefix, with a timestamp in the night's own format.
const line = (text: string, ts = '2026-11-18T14:52:10.1234567Z') => `sync\tUNKNOWN STEP\t${ts} ${text}`;
const START = line('RELATED START: reading the record\'s "Identical bill" relations for bills with stored coverage');
const DONE = (failed: number, planned: number) =>
  line(
    `RELATED DONE: looked up ${planned - failed} of ${planned} planned (${failed} failed; 523 bills with coverage); 0 relation(s) added, 0 removed; 107 bills carry an identical bill. Congress.gov requests: ${planned}. Cost: $0.`
  );
const STOPPED = (why: string) => line(`##[error]RELATED STOPPED: ${why}. data/related-bills.json was left as it was.`);
const NOW = Date.parse('2026-11-21T13:00:00Z'); // a daily report's hour, pinned
const fresh = { trouble: null, staleness: relatedStaleness(emptyRelatedBills('2026-11-20'), NOW) };
const codes = (list: { code: string }[]) => list.map((a) => a.code);

test.describe('the real log shape', () => {
  test('the fixture really is the downloaded shape: TAB-separated job and step, and a byte-order mark on the first line', () => {
    const lines = REAL.split('\n').filter(Boolean);
    expect(lines.length).toBe(8);
    for (const l of lines) expect(l.startsWith('sync\tUNKNOWN STEP\t')).toBe(true);
    expect(lines[0].split('\t')[2].startsWith(`${BOM}2026-11-16T23:22:33`)).toBe(true);
    expect(REAL).not.toContain('RELATED');
  });

  test('a nightly log from BEFORE this step (no RELATED lines at all) raises nothing', () => {
    const t = parseRelatedTrouble(REAL);
    expect(t).toEqual({ started: false, done: null, stopped: null });
    expect(relatedAlarms({ ...fresh, trouble: t })).toEqual([]);
  });

  test('a RELATED START on the first line, behind the byte-order mark, is still read', () => {
    const first = `sync\tUNKNOWN STEP\t${BOM}2026-11-18T14:00:00.0000000Z RELATED START: x`;
    expect(parseRelatedTrouble(first).started).toBe(true);
  });

  test('an ordinary night (the real lines plus START and DONE) raises nothing', () => {
    const log = [REAL.trimEnd(), START, DONE(0, 200)].join('\n');
    expect(relatedAlarms({ ...fresh, trouble: parseRelatedTrouble(log) })).toEqual([]);
  });
});

test.describe('(a) a STOPPED line', () => {
  test('fires on its smallest input, carrying the reason, in either annotation form', () => {
    for (const mark of ['##[error]', '::error::', '']) {
      const log = [START, line(`${mark}RELATED STOPPED: all 4 lookups failed (the first: Congress.gov 503). data/related-bills.json was left as it was.`)].join('\n');
      const a = relatedAlarms({ ...fresh, trouble: parseRelatedTrouble(log) });
      expect(codes(a)).toEqual(['related-bills-stopped']);
      expect(a[0].text).toContain('all 4 lookups failed (the first: Congress.gov 503)');
      expect(a[0].text).toContain('docs/runbooks/related-bills.md');
      // It promises only what it knows: nothing about the rest of the night.
      expect(a[0].text).not.toContain('rest of the night');
    }
  });

  test('just under it: START and DONE with no STOPPED raises nothing', () => {
    expect(relatedAlarms({ ...fresh, trouble: parseRelatedTrouble([START, DONE(0, 10)].join('\n')) })).toEqual([]);
  });

  test('a STOPPED line from before the last START does not count (the night is its own run)', () => {
    const log = [START, STOPPED('earlier'), START, DONE(0, 10)].join('\n');
    expect(relatedAlarms({ ...fresh, trouble: parseRelatedTrouble(log) })).toEqual([]);
  });

  test(`the reason is cut to ${RELATED_REASON_MAX} characters`, () => {
    const long = 'x'.repeat(RELATED_REASON_MAX * 3);
    const a = relatedAlarms({ ...fresh, trouble: parseRelatedTrouble([START, STOPPED(long)].join('\n')) });
    expect(a[0].text).toContain(`${'x'.repeat(RELATED_REASON_MAX - 1)}…`);
    expect(a[0].text).not.toContain('x'.repeat(RELATED_REASON_MAX));
  });
});

test.describe('(b) START with no DONE after it', () => {
  test('fires on its smallest input: a START line alone', () => {
    const crashed = relatedAlarms({ ...fresh, trouble: parseRelatedTrouble(START) });
    expect(codes(crashed)).toEqual(['related-bills-crashed']);
    expect(crashed[0].text).toContain('started but never said it finished or stopped');
    expect(crashed[0].text).toContain('docs/runbooks/related-bills.md');
    expect(codes(relatedAlarms({ ...fresh, trouble: parseRelatedTrouble([START, line('##[error]Process completed with exit code 1.')].join('\n')) }))).toEqual([
      'related-bills-crashed',
    ]);
  });

  test('just under it: a DONE after the START raises nothing; a DONE only BEFORE the last START still fires', () => {
    expect(relatedAlarms({ ...fresh, trouble: parseRelatedTrouble([START, DONE(0, 1)].join('\n')) })).toEqual([]);
    expect(codes(relatedAlarms({ ...fresh, trouble: parseRelatedTrouble([START, DONE(0, 1), START].join('\n')) }))).toEqual(['related-bills-crashed']);
  });
});

test.describe('(c) the file not filled for more than 3 days (state, not the log)', () => {
  const at = (filled: string) => relatedAlarms({ trouble: null, staleness: relatedStaleness(emptyRelatedBills(filled), NOW) });
  test(`fires at ${RELATED_STALE_DAYS + 1} days, stays quiet at ${RELATED_STALE_DAYS}`, () => {
    expect(codes(at('2026-11-17'))).toEqual(['related-bills-stale']); // 4 days before 2026-11-21
    expect(at('2026-11-18')).toEqual([]); // 3 days
    expect(at('2026-11-21')).toEqual([]); // filled today
  });

  test('the committed empty file, dated 2026-11-17, is quiet on the mornings of Nov 18, 19 and 20 and speaks on Nov 21', () => {
    const committed = emptyRelatedBills('2026-11-17');
    for (const [day, want] of [
      ['2026-11-18', []],
      ['2026-11-19', []],
      ['2026-11-20', []],
      ['2026-11-21', ['related-bills-stale']],
    ] as const) {
      expect(codes(relatedAlarms({ trouble: null, staleness: relatedStaleness(committed, Date.parse(`${day}T13:00:00Z`)) })), day).toEqual(want);
    }
  });

  test('the stale alarm says the day, the age and where to look', () => {
    const a = at('2026-11-17');
    expect(a[0].text).toContain('last filled on 2026-11-17, 4 days ago');
    expect(a[0].text).toContain('docs/runbooks/related-bills.md');
    expect(relatedAlarms({ trouble: null, staleness: relatedStaleness(null, NOW) })[0].text).toContain('missing or has no "last filled" date');
  });

  test('a missing file, or one with no last-filled day, is stale', () => {
    expect(codes(relatedAlarms({ trouble: null, staleness: relatedStaleness(null, NOW) }))).toEqual(['related-bills-stale']);
    expect(codes(relatedAlarms({ trouble: null, staleness: relatedStaleness({ _meta: {} }, NOW) }))).toEqual(['related-bills-stale']);
  });

  test('a log with no RELATED lines never raises it by itself: only the date does', () => {
    expect(relatedAlarms({ trouble: parseRelatedTrouble(REAL), staleness: relatedStaleness(emptyRelatedBills('2026-11-20'), NOW) })).toEqual([]);
  });
});

test.describe('(d) the number of bills with a twin falling (state, not the log)', () => {
  // A file whose last fill left `carrying` bills with a twin, from `previous`.
  const filled = (carrying: number, previous: number | undefined) => {
    const f: Record<string, unknown> = { ...emptyRelatedBills('2026-11-20') };
    if (previous !== undefined) f._meta = { ...(f._meta as object), previous_carrying: previous };
    for (let i = 1; i <= carrying; i++) f[`hr-${i}-119`] = [{ slug: `s-${i}-119`, type: 'Identical bill', identifiedBy: ['CRS'] }];
    return f;
  };
  const at = (carrying: number, previous: number | undefined) =>
    codes(relatedAlarms({ trouble: null, staleness: relatedStaleness(filled(carrying, previous), NOW) }));

  test('at 125, a fall of 14 fires and a fall of 13 does not; at 107 (a full read of today\'s record), 12 fires and 11 does not', () => {
    expect(at(95, 107)).toEqual(['related-bills-twins-fell']);
    expect(at(96, 107)).toEqual([]);
    expect(at(111, 125)).toEqual(['related-bills-twins-fell']);
    expect(at(112, 125)).toEqual([]);
    const a = relatedAlarms({ trouble: null, staleness: relatedStaleness(filled(111, 125), NOW) });
    expect(a[0].text).toContain('fell from 125 to 111');
    expect(a[0].text).toContain('docs/runbooks/related-bills.md');
  });

  test(`small counts: the floor is ${TWIN_FALL_MIN}, and any fall to 0 fires`, () => {
    expect(at(14, 20)).toEqual(['related-bills-twins-fell']); // fall 6 > 5
    expect(at(15, 20)).toEqual([]); // fall 5
    expect(at(0, 3)).toEqual(['related-bills-twins-fell']); // the check's 3, 2, 1, 0
    expect(at(1, 2)).toEqual([]);
  });

  test('a real night (one or two removed), the first fill (rising from 0), and a file with no count raise nothing', () => {
    expect(at(124, 125)).toEqual([]);
    expect(at(123, 125)).toEqual([]);
    expect(at(125, 0)).toEqual([]);
    expect(at(0, 0)).toEqual([]);
    expect(at(0, undefined)).toEqual([]);
    expect(twinCountFell(null, 10)).toBe(false);
  });
});

test.describe('a future last-filled day (only a hand edit can write one)', () => {
  test('is stale, and says the date has not come yet', () => {
    const a = relatedAlarms({ trouble: null, staleness: relatedStaleness(emptyRelatedBills('2026-11-25'), NOW) });
    expect(codes(a)).toEqual(['related-bills-stale']);
    expect(a[0].text).toContain('a day that has not come yet');
  });
});

test.describe('partial failures', () => {
  test('fewer than half the lookups failing raises nothing; half or more does', () => {
    const t = (failed: number, planned: number) => codes(relatedAlarms({ ...fresh, trouble: parseRelatedTrouble([START, DONE(failed, planned)].join('\n')) }));
    expect(t(99, 200)).toEqual([]);
    expect(t(1, 3)).toEqual([]);
    expect(t(100, 200)).toEqual(['related-bills-lookups-failed']);
    const text = relatedAlarms({ ...fresh, trouble: parseRelatedTrouble([START, DONE(100, 200)].join('\n')) })[0].text;
    expect(text).toContain('could not get a usable answer from Congress.gov for 100 of 200 bills');
    expect(text).toContain('docs/runbooks/related-bills.md');
    expect(t(0, 0)).toEqual([]);
  });
});

test.describe('wired into the health report', () => {
  test("lib/pipeline-health.mjs's alarms() carries them, and nothing when the report has no related part", () => {
    const base = { nightly: { conclusion: 'success' } };
    expect(codes(alarms(base))).not.toContain('related-bills-stale');
    expect(codes(alarms({ ...base, related: { trouble: parseRelatedTrouble(START), staleness: relatedStaleness(emptyRelatedBills('2026-11-01'), NOW) } }))).toEqual(
      expect.arrayContaining(['related-bills-crashed', 'related-bills-stale'])
    );
  });

  // scripts/pipeline-health.mjs's buildReport, end to end: a temporary folder
  // as the working directory (its data/ holds only the related-bills file), a
  // fake `gh` on PATH answering one finished nightly whose log is the given
  // text, and a pinned clock. No network, no live data/, no real gh.
  function report(log: string, filledAt: string | null) {
    const dir = mkdtempSync(join(tmpdir(), 'related-health-'));
    try {
      mkdirSync(join(dir, 'bin'));
      mkdirSync(join(dir, 'data'));
      const gh = join(dir, 'bin', 'gh');
      writeFileSync(
        gh,
        `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const d = ${JSON.stringify(dir)};
if (a[0] === 'run' && a[1] === 'list') process.stdout.write(fs.readFileSync(d + '/runs.json', 'utf8'));
else if (a[0] === 'run' && a[1] === 'view' && a.includes('--log')) process.stdout.write(fs.readFileSync(d + '/nightly.log', 'utf8'));
else if (a[0] === 'run' && a[1] === 'view' && a.includes('--log-failed')) process.stdout.write('');
else if (a[0] === 'run' && a[1] === 'view') process.stdout.write('{"jobs":[]}');
else process.stdout.write('[]');
`
      );
      chmodSync(gh, 0o755);
      writeFileSync(
        join(dir, 'runs.json'),
        JSON.stringify([
          {
            databaseId: 1,
            workflowName: 'Nightly bill sync',
            conclusion: 'success',
            status: 'completed',
            event: 'schedule',
            createdAt: '2026-11-20T14:15:00Z',
            startedAt: '2026-11-20T14:15:00Z',
            updatedAt: '2026-11-20T15:00:00Z',
            url: 'https://example.invalid/runs/1',
            headBranch: 'main',
          },
        ])
      );
      writeFileSync(join(dir, 'nightly.log'), log);
      if (filledAt) writeFileSync(join(dir, 'data/related-bills.json'), JSON.stringify(emptyRelatedBills(filledAt)));
      const script = join(process.cwd(), 'scripts/pipeline-health.mjs');
      const r = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const m = await import(${JSON.stringify(script)}); const r = m.buildReport({ now: ${NOW} }); process.stdout.write('\\nREPORT ' + JSON.stringify({ related: r.related, codes: r.alarms.map((a) => a.code) }));`,
        ],
        { cwd: dir, encoding: 'utf8', env: { PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`, HOME: dir } as unknown as NodeJS.ProcessEnv, timeout: 60_000 }
      );
      const out = r.stdout.split('\nREPORT ').pop() ?? '';
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(out) as { related: unknown; codes: string[] };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('the real pre-step nightly log and a fresh file: the report raises no related-bills alarm', () => {
    const r = report(REAL, '2026-11-20');
    expect(r.codes.filter((c) => c.startsWith('related-bills'))).toEqual([]);
    expect(r.related).toEqual({
      trouble: { started: false, done: null, stopped: null },
      staleness: { readable: true, filledAt: '2026-11-20', ageDays: 1, carrying: 0, previousCarrying: null },
    });
  });

  test('the same log with a STOPPED night appended: the report raises related-bills-stopped', () => {
    const r = report([REAL.trimEnd(), START, STOPPED('all 3 lookups failed (the first: boom)')].join('\n'), '2026-11-20');
    expect(r.codes).toContain('related-bills-stopped');
  });

  test('a file last filled four days before the report: the report raises related-bills-stale', () => {
    expect(report(REAL, '2026-11-17').codes).toContain('related-bills-stale');
  });
});

test('the CI gate still rejects every bad shape it was built to reject, last-filled day included', () => {
  const r = spawnSync(process.execPath, [join(process.cwd(), 'scripts/check-related-bills.mjs'), '--self-test'], { encoding: 'utf8' });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toContain('(8 bad shapes rejected, 3 warned and passed)');
});

test.describe('the gate and the readers, at their edges', () => {
  test('a well-shaped answer has no problem (null), an empty list included', () => {
    expect(recordAnswerProblem({ relatedBills: [] })).toBeNull();
    expect(recordAnswerProblem({ relatedBills: [{ relationshipDetails: [{ type: 'Identical bill' }] }] })).toBeNull();
  });

  test('a file that is not an object fails with an empty warnings list', () => {
    expect(verifyRelatedBills({ data: null, today: '2026-11-10' })).toEqual({ failures: ['data/related-bills.json is not an object'], warnings: [], notes: [] });
  });

  test('a previous_carrying that is not a count only warns', () => {
    const v = verifyRelatedBills({ data: { ...emptyRelatedBills('2026-11-10'), _meta: { ...emptyRelatedBills('2026-11-10')._meta, previous_carrying: -1 } }, today: '2026-11-10' });
    expect(v.failures).toEqual([]);
    expect(v.warnings.join('\n')).toContain('previous_carrying is -1, not a count');
  });

  test('a file with no last-filled day still carries its twin counts (so a fall to 0 is still seen)', () => {
    const st = relatedStaleness({ _meta: { previous_carrying: 5 } }, NOW);
    expect(st).toEqual({ readable: false, filledAt: null, ageDays: null, carrying: 0, previousCarrying: 5 });
    expect(codes(relatedAlarms({ trouble: null, staleness: st }))).toEqual(['related-bills-stale', 'related-bills-twins-fell']);
  });
});

test.describe('the DONE line, old and new (2026-11-18)', () => {
  // The first real night's line, from nightly run 44188792590 (2026-11-17), in the downloaded log's shape.
  const REAL_NIGHT_1 =
    "sync\tUNKNOWN STEP\t2026-11-17T22:59:21.1642862Z RELATED DONE: looked up 200 of 200 planned (0 failed; 522 candidate bills, 522 with coverage); 65 relation(s) added, 0 removed; 41 bills carry an identical bill (0 before tonight); pruned 0 bill(s) and 0 twin row(s) no longer in data/bills.json. Congress.gov requests: 200. Cost: $0.";

  test('the first real night reads as a clean night: no kinds listed, not stopped early, no alarm', () => {
    const t = parseRelatedTrouble([START, REAL_NIGHT_1].join('\n'));
    expect(t.done).toEqual({ looked: 200, planned: 200, failed: 0, kinds: null, early: null });
    expect(relatedAlarms({ ...fresh, trouble: t })).toEqual([]);
  });

  test('a night stopped early: the unread bills count with the failures toward the half-or-more alarm', () => {
    const line = (looked: number, failed: number, after: number) =>
      parseRelatedTrouble(
        [
          START,
          `sync\tUNKNOWN STEP\t2026-11-18T22:59:21.0000000Z RELATED DONE: looked up ${looked} of 200 planned (${failed ? `${failed} failed: 0 no answer, ${failed} an error status, 0 a misshapen answer` : '0 failed'}; 522 candidate bills, 522 with coverage); stopped early after ${after} of 200 lookups at the 300-second time budget, so Congress.gov is answering very slowly, and the ${200 - after} not read go first next night; 0 relation(s) added, 0 removed; 41 bills carry an identical bill (41 before tonight); pruned 0 bill(s) and 0 twin row(s) no longer in data/bills.json. Congress.gov requests: ${after}. Cost: $0.`,
        ].join('\n')
      );
    expect(line(100, 0, 100).done!.early).toEqual({ after: 100, of: 200 });
    // A DONE line listing three kinds (the code of 2026-11-18 morning) still parses; its unreadable count is 0.
    expect(line(91, 10, 101).done!.kinds).toEqual({ noAnswer: 0, status: 10, unreadable: 0, shape: 0 });
    expect(codes(relatedAlarms({ ...fresh, trouble: line(100, 0, 100) }))).toEqual(['related-bills-lookups-failed']); // 100 unread
    expect(relatedAlarms({ ...fresh, trouble: line(101, 0, 101) })).toEqual([]); // 99 unread
    expect(codes(relatedAlarms({ ...fresh, trouble: line(91, 10, 101) }))).toEqual(['related-bills-lookups-failed']); // 10 failed + 99 unread
    const both = relatedAlarms({ ...fresh, trouble: line(40, 10, 50) })[0].text;
    // "the next nightly", not "tomorrow": the report runs in the morning and
    // the next nightly runs later the same day.
    expect(both).toContain('stopped early after 50 of 200 lookups because Congress.gov answered very slowly (it saved what it read, and the 150 bills not read go first in the next nightly)');
    expect(both).not.toContain('tomorrow');
    expect(both).toContain('and it could not get a usable answer from Congress.gov for 10 of 200 bills (10 with an error status)');
  });
});

test('a DONE line listing four kinds parses each of them', () => {
  const t = parseRelatedTrouble(
    [
      START,
      'sync\tUNKNOWN STEP\t2026-11-19T22:59:21.0000000Z RELATED DONE: looked up 194 of 200 planned (6 failed: 1 no answer, 1 an error status, 3 an unreadable answer, 1 a misshapen answer; 522 candidate bills, 522 with coverage); 0 relation(s) added, 0 removed; 16 bills carry an identical bill (16 before tonight); pruned 0 bill(s) and 0 twin row(s) no longer in data/bills.json. Congress.gov requests: 201. Cost: $0.',
    ].join('\n')
  );
  expect(t.done!.kinds).toEqual({ noAnswer: 1, status: 1, unreadable: 3, shape: 1 });
});
