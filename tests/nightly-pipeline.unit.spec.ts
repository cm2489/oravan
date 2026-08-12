import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CURSOR_MAX_AGE_DAYS, cursorAgeVerdict } from '../scripts/check-cursor-age.mjs';

/*
 * THE SHAPE OF THE NIGHTLY RUN — the three things reshaped on 2026-08-12
 * (owner rulings N8-A2, N8-B1, D8), pinned where they can be read rather than
 * inferred.
 *
 * These are WORKFLOW-FILE assertions, which this repo already does once
 * (tests/hot-bill-visibility.unit.spec.ts pins hot-bills.yml's phasing). They
 * exist because each of the three failures they cover was invisible in a diff
 * and expensive in production:
 *
 *   1. A PROGRESS check sitting before the commit threw away a night of
 *      already-paid decodes every time it fired, and made the backlog it was
 *      complaining about worse. What must never drift back is the ORDER: every
 *      integrity check before the commit, the cursor-age alarm after it.
 *   2. A weekly job sharing a concurrency group with an HOURLY one is not
 *      serialised, it is evicted — a pending run is cancelled the moment a
 *      newer run queues, and a cancelled scheduled run notifies nobody.
 *   3. A cron string that a `run:` body matches LITERALLY is load-bearing
 *      twice; moving the cron without moving the match turns moment-watch's
 *      weekly digest into a second push run, silently.
 *
 * Regex over the YAML rather than a parser: this repo ships no YAML
 * dependency, the assertions are about ORDER and PRESENCE, and a failing
 * regex here fails loudly rather than passing vacuously (each one is asserted
 * to have found its anchor first).
 */

const wf = (name: string) => readFileSync(join(process.cwd(), '.github/workflows', name), 'utf8');
const syncBills = wf('sync-bills.yml');
const momentWatch = wf('moment-watch.yml');
const refreshLegislators = wf('refresh-legislators.yml');
const hotBills = wf('hot-bills.yml');

/* ------------------------------------------------------------------ *
 * 1 · N8-A2 — the cursor-age judgement itself.
 * ------------------------------------------------------------------ */
test.describe('cursorAgeVerdict (the post-commit progress alarm)', () => {
  const at = (isoDays: number) => Date.parse('2026-08-12T00:00:00Z') + isoDays * 86_400_000;

  test('a cursor inside the ceiling passes', () => {
    const v = cursorAgeVerdict({ lastSync: '2026-08-10T00:00:00Z', now: at(0) });
    expect(v.ok).toBe(true);
    expect(v.ageDays).toBeCloseTo(2, 5);
  });

  test('the ceiling is 10 days, and it is the SAME number the site\'s dead window sits above', () => {
    // lib/freshness-state.ts's FRESHNESS_DEAD_WINDOW_DAYS is 21 and reads the
    // same lastSync. This alarm has to fire well before a visitor could ever
    // see a dishonest "quiet week" from it.
    expect(CURSOR_MAX_AGE_DAYS).toBe(10);
    expect(cursorAgeVerdict({ lastSync: '2026-08-02T00:00:00Z', now: at(0) }).ok).toBe(true); // exactly 10
    expect(cursorAgeVerdict({ lastSync: '2026-08-01T23:00:00Z', now: at(0) }).ok).toBe(false); // 10.04
  });

  test('the failure names the ONE thing that changed: the data shipped anyway', () => {
    const v = cursorAgeVerdict({ lastSync: '2026-07-01T00:00:00Z', now: at(0) });
    expect(v.ok).toBe(false);
    expect(v.message).toContain('42 days old');
    expect(v.message).toContain('COMMITTED');
    expect(v.message).toContain('max_updates');
  });

  test('an unparseable cursor is reported as the pre-commit gate having been bypassed, not as an age', () => {
    // This alarm never judges the cursor's SHAPE — verify-sync.mjs does, before
    // the commit. Reaching here with something undateable means that gate was
    // skipped, so say so rather than invent an age. (A bare date like
    // "2026-08-10" is deliberately NOT this case: it parses, so it gets a real
    // age here and is failed for its format over there.)
    for (const bad of [null, undefined, '', 'yesterday', 42]) {
      const v = cursorAgeVerdict({ lastSync: bad as unknown as string, now: at(0) });
      expect(v.ok, String(bad)).toBe(false);
      expect(v.ageDays, String(bad)).toBeNull();
      expect(v.message).toContain('verify-sync.mjs');
    }
    expect(cursorAgeVerdict({ lastSync: '2026-08-10', now: at(0) }).ageDays).toBeCloseTo(2, 5);
  });
});

/* ------------------------------------------------------------------ *
 * 2 · N8-A2 — which check lives where, and in what order.
 * ------------------------------------------------------------------ */
test.describe('the integrity/progress split survives', () => {
  const verifySyncSource = readFileSync(join(process.cwd(), 'scripts/verify-sync.mjs'), 'utf8');
  const cursorSource = readFileSync(join(process.cwd(), 'scripts/check-cursor-age.mjs'), 'utf8');

  test('the age ceiling lives in check-cursor-age.mjs and NOWHERE in verify-sync.mjs', () => {
    expect(cursorSource).toContain('CURSOR_MAX_AGE_DAYS = 10');
    expect(verifySyncSource).not.toContain('CURSOR_MAX_AGE_DAYS');
    expect(verifySyncSource).not.toContain('cursorAgeDays');
  });

  test('the cursor FORMAT check stays pre-commit — a bare-date cursor is damage, not lateness', () => {
    // It 400s Congress.gov on every request and has shipped two multi-day
    // outages (2026-06-25/07-01 and 07-17/22). That belongs in front of the
    // commit with the rest of the corruption checks.
    expect(verifySyncSource).toContain('seconds-precision ISO-8601 datetime');
  });

  test('THE ORDER: verify-sync before the commit, the cursor alarm after it', () => {
    const verifyAt = syncBills.indexOf('run: node scripts/verify-sync.mjs');
    const commitAt = syncBills.indexOf('- name: Commit data');
    const alarmAt = syncBills.indexOf('run: node scripts/check-cursor-age.mjs');
    expect(verifyAt, 'verify-sync step not found').toBeGreaterThan(0);
    expect(commitAt, 'commit step not found').toBeGreaterThan(0);
    expect(alarmAt, 'cursor-age step not found').toBeGreaterThan(0);
    expect(verifyAt).toBeLessThan(commitAt);
    expect(alarmAt).toBeGreaterThan(commitAt);
  });

  test('the alarm is LAST, so a red progress signal cannot skip the deploy check or the CI dispatch', () => {
    // A failing step skips every later step whose `if:` does not name a status
    // function - which is all three of the post-commit steps. The alarm has to
    // be the final one or it takes them with it.
    const alarmAt = syncBills.indexOf('- name: Cursor-progress alarm');
    expect(alarmAt).toBeGreaterThan(syncBills.indexOf('- name: Verify the deploy landed'));
    expect(alarmAt).toBeGreaterThan(syncBills.indexOf('- name: Dispatch CI against the pushed data'));
    expect(alarmAt).toBeGreaterThan(syncBills.indexOf('- name: Pre-generate top-band call scripts'));
  });

  test('the alarm runs even when something upstream already failed', () => {
    expect(syncBills.slice(syncBills.indexOf('- name: Cursor-progress alarm'))).toContain('if: always()');
  });
});

/* ------------------------------------------------------------------ *
 * 3 · N9-A2 — the journey tripwire files an issue; only vacuity is hard.
 * ------------------------------------------------------------------ */
test.describe('the journey-corpus tripwire no longer costs the night', () => {
  const stepAt = syncBills.indexOf('- name: Journey-corpus tripwire');
  const nextStepAt = syncBills.indexOf('- name: A sweep that proved nothing still fails the night');

  test('the sweep step is continue-on-error', () => {
    expect(stepAt).toBeGreaterThan(0);
    expect(syncBills.slice(stepAt, nextStepAt)).toContain('continue-on-error: true');
  });

  test('the hard gate is an ALLOW-LIST — a sweep that could not run is not a pass', () => {
    // continue-on-error makes every unhandled shape green, so the guard has to
    // name what is ACCEPTABLE, not what is fatal. A deny-list on 'vacuous'
    // alone would let a crashed sweep (verdict 'error') and a sweep that died
    // before writing a verdict (empty) sail through as an all-clear.
    expect(nextStepAt).toBeGreaterThan(stepAt);
    expect(syncBills.slice(nextStepAt)).toContain(
      "steps.journey.outputs.verdict != 'clean' && steps.journey.outputs.verdict != 'novel'"
    );
  });

  test('the job can actually open that issue', () => {
    // A workflow that files an issue needs `issues: write` on its own
    // GITHUB_TOKEN, and this one had never needed it before. Without it the
    // step 403s at the label-create — at 3am, on the one night in months when
    // Congress writes a sentence nobody has read.
    expect(/permissions:[\s\S]*?issues:\s*write/.test(syncBills)).toBe(true);
  });

  test('a novel floor text opens a labeled issue, search-first', () => {
    const issueAt = syncBills.indexOf('- name: Open a journey-corpus issue');
    expect(issueAt).toBeGreaterThan(0);
    const step = syncBills.slice(issueAt, syncBills.indexOf('- name: Sync Senate nominations'));
    expect(step).toContain("steps.journey.outputs.verdict == 'novel'");
    expect(step).toContain('gh label create journey-corpus');
    expect(step).toContain('gh issue list'); // search-first: no duplicate issues
    expect(step).toContain('gh issue comment');
  });

  test('the sweep still runs before the commit, so its issue names TONIGHT\'s corpus', () => {
    expect(stepAt).toBeLessThan(syncBills.indexOf('- name: Commit data'));
  });
});

/* ------------------------------------------------------------------ *
 * 4 · N8-B1 — the weekly job left the contended group.
 * ------------------------------------------------------------------ */
test.describe('concurrency groups', () => {
  const groupOf = (yml: string) => /concurrency:[\s\S]*?group:\s*(\S+)/.exec(yml)?.[1];

  test('refresh-legislators is NOT in data-sync — an hourly challenger evicts a weekly job', () => {
    expect(groupOf(refreshLegislators)).toBe('data-sync-legislators');
  });

  test('everything that writes data/bills.json still shares one group', () => {
    // The group exists for exactly one reason: sync-bills, hot-bills and
    // newsdesk all commit to the corpus, and moment-watch READS it while they
    // do. Disjoint files is what let the weekly job out; these four are not.
    expect(groupOf(syncBills)).toBe('data-sync');
    expect(groupOf(hotBills)).toBe('data-sync');
    expect(groupOf(wf('newsdesk.yml'))).toBe('data-sync');
    expect(groupOf(momentWatch)).toBe('data-sync');
  });
});

/* ------------------------------------------------------------------ *
 * 5 · D8 — the nightly reads the same day's floor record.
 * ------------------------------------------------------------------ */
test.describe('nightly phasing (Congress.gov publishes 13:35-14:00 UTC)', () => {
  const cronsOf = (yml: string) =>
    [...yml.matchAll(/-\s*cron:\s*'(\d+)\s+(\d+)\s+([^']+)'/g)].map((m) => ({
      minute: Number(m[1]),
      hour: Number(m[2]),
      rest: m[3].trim(),
      utcMinutes: Number(m[2]) * 60 + Number(m[1]),
      raw: `${m[1]} ${m[2]} ${m[3]}`,
    }));

  const sync = cronsOf(syncBills);
  const watch = cronsOf(momentWatch);

  test('the nightly sync fires after the publication window has closed', () => {
    expect(sync).toHaveLength(1);
    // GitHub's scheduler on this repo drifts +17min to +3h27m but NEVER fires
    // early, so a nominal slot at or after 14:00 can never start inside the
    // band. This is the same invariant hot-bills.yml is pinned on.
    expect(sync[0].utcMinutes).toBeGreaterThanOrEqual(14 * 60);
  });

  test('moment-watch reads what the sync commits, so it fires well after it', () => {
    const nightly = watch.find((c) => c.rest === '* * *');
    expect(nightly, 'no daily moment-watch cron').toBeTruthy();
    // The sync has taken 11-72 minutes across its last 12 runs. The gap has to
    // cover the worst of that, or moment-watch sits PENDING in the shared
    // data-sync group - and a pending run there is what newsdesk's hourly cron
    // evicts (observed 2026-08-08).
    expect(nightly!.utcMinutes - sync[0].utcMinutes).toBeGreaterThan(72);
  });

  test('the Monday digest still runs after that day\'s push run', () => {
    const nightly = watch.find((c) => c.rest === '* * *')!;
    const weekly = watch.find((c) => c.rest.endsWith('* 1'));
    expect(weekly, 'no Monday moment-watch cron').toBeTruthy();
    expect(weekly!.utcMinutes).toBeGreaterThan(nightly.utcMinutes);
  });

  test('THE LOAD-BEARING STRING: the mode selector matches the weekly cron exactly', () => {
    // `github.event.schedule` is compared literally in the "Select mode" step.
    // A cron moved without its match silently turns the weekly digest into a
    // second push run - no error, no annotation, just a missing digest.
    const weekly = watch.find((c) => c.rest.endsWith('* 1'))!;
    expect(momentWatch).toContain(`[ "$SCHEDULE" = "${weekly.raw}" ]`);
  });

  test('no re-phased slot sits at the top or half of the hour', () => {
    // hot-bills.yml's measurement: the scheduler's backlog, and therefore its
    // drift, is worst at :00 and :30.
    for (const c of [...sync, ...watch]) {
      expect(c.minute % 30, `cron minute ${c.minute}`).not.toBe(0);
    }
  });
});
