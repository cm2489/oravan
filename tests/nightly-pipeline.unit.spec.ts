import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CURSOR_MAX_AGE_DAYS, cursorAgeVerdict } from '../scripts/check-cursor-age.mjs';
import {
  ACT_FROM_HOUR_UTC,
  ACT_UNTIL_HOUR_UTC,
  MAX_AUTO_DISPATCHES_PER_UTC_DAY,
  WINDOW_OPENS_HOUR_UTC,
  decideNightlyRescue,
  gotARunner,
  watchdogWindow,
} from '../lib/nightly-watchdog.mjs';

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
 *      serialised, it is evicted — under GitHub's default (`queue: single`) a
 *      pending run is cancelled the moment a newer run queues, and a
 *      cancelled scheduled run notifies nobody. (Since 2026-10-06 the
 *      data-sync members set `queue: max` instead; test group 8 pins it.)
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
 * 2b · 2026-09-18 — the run-honesty alarm joins it, on the same side
 *      of the commit and for the same reason.
 * ------------------------------------------------------------------ */
test.describe('the run-honesty alarm (a run whose core function died goes red)', () => {
  const newsdesk = wf('newsdesk.yml');
  const honestyAt = syncBills.indexOf('- name: Run-honesty alarm');

  test('it runs AFTER the commit, like the cursor alarm', () => {
    // Identical N8-A2 reasoning: it judges whether the night WORKED, not
    // whether the corpus is sound. A credit-balance outage kills the decodes
    // and leaves every free refresh correct — refusing that commit would throw
    // away good data to protest an unrelated failure, and would freeze the
    // site's own freshness signal at a value staler than the truth.
    expect(honestyAt, 'run-honesty step not found').toBeGreaterThan(0);
    expect(honestyAt).toBeGreaterThan(syncBills.indexOf('- name: Commit data'));
    expect(honestyAt).toBeGreaterThan(syncBills.indexOf('- name: Dispatch CI against the pushed data'));
  });

  test('BOTH post-commit alarms carry if: always(), so neither can swallow the other', () => {
    // A failing step skips every later step whose `if:` does not name a status
    // function. Two alarms in a row is only safe while both are unconditional.
    const tail = syncBills.slice(honestyAt);
    expect(tail).toContain('if: always()');
    expect(tail.slice(tail.indexOf('- name: Cursor-progress alarm'))).toContain('if: always()');
  });

  test('each job is judged by name — the alarm never guesses which run it is in', () => {
    expect(syncBills).toContain('node scripts/check-run-honesty.mjs nightly');
    expect(newsdesk).toContain('node scripts/check-run-honesty.mjs newsdesk');
    expect(newsdesk.indexOf('- name: Run-honesty alarm')).toBeGreaterThan(newsdesk.indexOf('- name: Commit data'));
  });

  test('both jobs point their scripts at a counter file in the RUNNER temp dir', () => {
    // Runner temp, never the workspace: a counter file inside the repo would
    // be swept into `git add data/`'s sibling working tree on some future
    // refactor, and these counts are diagnostics, not corpus.
    for (const [name, yml] of [['sync-bills', syncBills], ['newsdesk', newsdesk]] as const) {
      expect(yml, name).toContain('RUN_COUNTERS_FILE=$RUNNER_TEMP/oravan-run-counters.json');
      expect(yml.indexOf('RUN_COUNTERS_FILE='), name).toBeLessThan(yml.indexOf('- name: Commit data'));
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2b′ · 2026-09-24 — roll-call votes (C1a): an additive sync, and an
 *       integrity gate that sits with the others, BEFORE the commit.
 * ------------------------------------------------------------------ */
test.describe('roll-call votes: sync step and pre-commit gate', () => {
  const stepOf = (name: string) => {
    const at = syncBills.indexOf(`- name: ${name}`);
    expect(at, `${name} step not found`).toBeGreaterThan(0);
    const rest = syncBills.slice(at);
    const next = rest.slice(1).search(/\n {6}- name:/);
    return { at, body: next === -1 ? rest : rest.slice(0, next + 1) };
  };

  test('the sync runs after the bill sync (tonight\'s new bills get their votes) and cannot cost the night', () => {
    const sync = stepOf('Sync roll-call votes');
    expect(sync.body).toContain('run: node scripts/sync-votes.mjs');
    expect(sync.body).toContain('continue-on-error: true');
    expect(sync.body).toContain('CONGRESS_API_KEY: ${{ secrets.CONGRESS_API_KEY }}');
    // $0 by construction: this step is never handed the Anthropic key.
    expect(sync.body).not.toContain('ANTHROPIC_API_KEY');
    expect(sync.at).toBeGreaterThan(syncBills.indexOf('- name: Sync bills'));
    expect(sync.at).toBeLessThan(syncBills.indexOf('- name: Verify the sync did its job'));
  });

  test('THE ORDER: the votes gate is pre-commit, beside verify-sync, and is NOT continue-on-error', () => {
    const gate = stepOf('Roll-call votes gate');
    expect(gate.body).toContain('node scripts/check-votes.mjs --self-test');
    // The data run itself, not only the self-test.
    expect(gate.body).toMatch(/node scripts\/check-votes\.mjs\s*$/m);
    expect(gate.body).not.toContain('continue-on-error');
    expect(gate.at).toBeGreaterThan(syncBills.indexOf('run: node scripts/verify-sync.mjs'));
    expect(gate.at).toBeLessThan(syncBills.indexOf('- name: Commit data'));
    expect(gate.at).toBeGreaterThan(stepOf('Sync roll-call votes').at);
  });

  test('the sync script refuses to WRITE a file the gate would fail (the nominations precedent)', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/sync-votes.mjs'), 'utf8');
    const gateAt = src.indexOf('verifyVotes({');
    // The one write of the file: temp file + rename since the 2026-09-29
    // back-fill, so a crash mid-write never leaves half a file.
    const writeAt = src.indexOf('writeAtomic(VOTES_PATH');
    expect(gateAt, 'pre-write verifyVotes call').toBeGreaterThan(0);
    expect(writeAt).toBeGreaterThan(gateAt);
    expect(src).not.toContain('writeFileSync(VOTES_PATH');
  });

  test('the gate pins the cursor FORMAT — a date is damage, not a roll-call cursor', () => {
    const core = readFileSync(join(process.cwd(), 'lib/votes-core.mjs'), 'utf8');
    expect(core).toContain('a date is not a roll-call cursor');
  });

  test('ci.yml runs the gate too, because refresh-legislators rewrites the file it joins on', () => {
    const ci = wf('ci.yml');
    expect(ci).toContain('node scripts/check-votes.mjs --self-test');
  });
});

/* ------------------------------------------------------------------ *
 * 2b″ · 2026-09-24 — the status re-derivation pass: after the bill sync,
 *       before every integrity check, and hard (its guard is a corpus claim).
 * ------------------------------------------------------------------ */
test.describe('status re-derivation: position and posture', () => {
  const rederiveRun = 'run: node scripts/rederive-status.mjs';
  const stepName = '- name: Re-derive every stored status';

  test('THE ORDER: after the bill sync, before verify-sync and the commit', () => {
    const at = syncBills.indexOf(rederiveRun);
    expect(at, 'rederive step not found').toBeGreaterThan(0);
    expect(at).toBeGreaterThan(syncBills.indexOf('run: node scripts/sync-bills.mjs'));
    expect(at).toBeLessThan(syncBills.indexOf('run: node scripts/verify-sync.mjs'));
    expect(at).toBeLessThan(syncBills.indexOf('- name: Commit data'));
    // Directly after the sync, so every later reader (the journey tripwire,
    // coverage, Moment updates) sees the corrected corpus.
    expect(at).toBeLessThan(syncBills.indexOf('- name: Journey-corpus tripwire'));
  });

  test('its guard reds the run: the step is NOT continue-on-error and runs without --dry-run', () => {
    const start = syncBills.indexOf(stepName);
    expect(start, 'rederive step name not found').toBeGreaterThan(0);
    const rest = syncBills.slice(start);
    const body = rest.slice(0, rest.slice(1).search(/\n {6}- name:/) + 1);
    expect(body).toContain(rederiveRun);
    expect(body).not.toContain('continue-on-error');
    expect(body).not.toContain('--dry-run');
    // $0 by construction: the only secret is the free Congress.gov key, used
    // to resolve the ambiguous sentences from the action before them.
    expect(body).toContain('CONGRESS_API_KEY: ${{ secrets.CONGRESS_API_KEY }}');
    expect(body).not.toContain('ANTHROPIC_API_KEY');
  });

  test('the guard lives in the script, not in verify-sync.mjs', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/rederive-status.mjs'), 'utf8');
    expect(src).toContain('MAX_CHANGE_FRACTION = 0.02');
    expect(readFileSync(join(process.cwd(), 'scripts/verify-sync.mjs'), 'utf8')).not.toContain('MAX_CHANGE_FRACTION');
  });
});

/* ------------------------------------------------------------------ *
 * 2c · 2026-09-18 — the preflight arms or disarms the decodes, and
 *      never the data.
 * ------------------------------------------------------------------ */
test.describe('the Anthropic preflight', () => {
  const preflightAt = syncBills.indexOf('- name: Anthropic preflight');

  test('it runs before the sync and cannot fail the job', () => {
    expect(preflightAt, 'preflight step not found').toBeGreaterThan(0);
    expect(preflightAt).toBeLessThan(syncBills.indexOf('- name: Sync bills'));
    expect(syncBills.slice(preflightAt, syncBills.indexOf('- name: Sync bills'))).toContain('continue-on-error: true');
  });

  test('a failed preflight zeroes the decode budget and NOTHING else', () => {
    // MAX_NEW_DECODES=0 makes syncOneBill's `allowDecode` false everywhere, so
    // every bill still takes its free Congress.gov refresh and every new one
    // comes back 'budget' — deferred, not failed. Coverage, nominations,
    // Moment updates and portraits are untouched by this value.
    const step = syncBills.slice(syncBills.indexOf('- name: Sync bills'), syncBills.indexOf('- name: Journey-corpus tripwire'));
    expect(step).toContain("steps.preflight.outputs.decode_ok == 'true'");
    expect(step).toMatch(/MAX_NEW_DECODES:.*\|\| '0' \}\}/);
  });

  test('a manual max_new_decodes can never turn decoding back ON', () => {
    // The dispatch input sits INSIDE the true branch, so it only ever chooses
    // between budgets the preflight already allowed.
    const line = /MAX_NEW_DECODES: \$\{\{ steps\.preflight\.outputs\.decode_ok == 'true' && \(inputs\.max_new_decodes \|\| '60'\) \|\| '0' \}\}/;
    expect(syncBills).toMatch(line);
  });

  test('the alarm is handed the preflight output as well as the counter', () => {
    // Belt and braces: a crash inside the preflight script would leave
    // decode_ok unset (so the sync decodes nothing) and no counter written.
    expect(syncBills.slice(syncBills.indexOf('- name: Run-honesty alarm'))).toContain(
      'PREFLIGHT_DECODE_OK: ${{ steps.preflight.outputs.decode_ok }}'
    );
  });
});

/* ------------------------------------------------------------------ *
 * 2d · 2026-09-18 — every data workflow checks out the branch TIP.
 * ------------------------------------------------------------------ */
test.describe('the stale-checkout race that killed two nightlies', () => {
  test('sync-bills, newsdesk and hot-bills all pin checkout to the branch, not the event SHA', () => {
    // Without `ref:`, actions/checkout takes `github.sha` — main's SHA when the
    // RUN WAS CREATED. A run queued in the data-sync group can start long
    // after that, against a corpus another member has already advanced; its
    // commit is then unpushable, because data/bills.json is single-line
    // minified JSON and every concurrent edit to it is a content conflict.
    // Runs 34886281500 (2026-09-14) and 35132794181 (2026-09-16) both died
    // that way, each throwing away a full night of paid work. hot-bills joined
    // the pin on 2026-10-06: under `queue: max` a pass that waits behind the
    // nightly always runs, and it rewrites data/bills.json too.
    for (const [name, yml] of [['sync-bills', syncBills], ['newsdesk', wf('newsdesk.yml')], ['hot-bills', hotBills]] as const) {
      const checkoutAt = yml.indexOf('- uses: actions/checkout@v7');
      expect(checkoutAt, `${name}: no checkout step`).toBeGreaterThan(0);
      expect(yml.slice(checkoutAt, checkoutAt + 2600), name).toContain('ref: ${{ github.ref_name }}');
    }
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
    // Sliced to the NEXT step (the scaffold-corpus tripwire since 2026-09-27),
    // so the assertions below cannot be satisfied by that step's own gh calls.
    const step = syncBills.slice(issueAt, syncBills.indexOf('- name: Scaffold-corpus tripwire'));
    expect(step.length).toBeGreaterThan(0);
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
 * 3b · The 2026-09-27 audit (SY-47) — the Moment-scaffold floor-action
 *      sweep left the PR suite for the nightly, with NO hard verdict.
 * ------------------------------------------------------------------ */
test.describe('the scaffold-corpus tripwire files an issue and never costs the night', () => {
  const stepOf = (name: string) => {
    const at = syncBills.indexOf(`- name: ${name}`);
    expect(at, `${name} step not found`).toBeGreaterThan(0);
    const rest = syncBills.slice(at);
    const next = rest.slice(1).search(/\n {6}- name:/);
    return { at, body: next === -1 ? rest : rest.slice(0, next + 1) };
  };
  const sweep = () => stepOf('Scaffold-corpus tripwire');
  const issue = () => stepOf('Open a scaffold-corpus issue');

  test('the sweep runs the script, and is continue-on-error', () => {
    const { body } = sweep();
    expect(body).toContain('id: scaffold');
    expect(body).toContain('run: node scripts/check-scaffold-corpus.mjs');
    expect(body).toContain('continue-on-error: true');
    // $0 by construction: plain node over a local file, never handed a key.
    expect(body).not.toMatch(/ANTHROPIC_API_KEY|CONGRESS_API_KEY|UPSTASH_/);
  });

  test('THE ORDER: after the status re-derivation and the journey sweep, before the commit', () => {
    const at = sweep().at;
    expect(at).toBeGreaterThan(syncBills.indexOf('run: node scripts/rederive-status.mjs'));
    expect(at).toBeGreaterThan(syncBills.indexOf('- name: Open a journey-corpus issue'));
    expect(at).toBeLessThan(syncBills.indexOf('- name: Commit data'));
    expect(issue().at).toBeGreaterThan(at);
    expect(issue().at).toBeLessThan(syncBills.indexOf('- name: Commit data'));
  });

  test('the issue step is an ALLOW-LIST on `clean` — a crashed or silent sweep files too', () => {
    const { body } = issue();
    expect(body).toContain("if: steps.scaffold.outputs.verdict != 'clean'");
    // A sweep that died before writing its report still gets a body.
    expect(body).toContain('if [ ! -s "$BODY" ]; then');
  });

  test('filing is labeled, search-first, and can never skip the commit', () => {
    const { body } = issue();
    expect(body).toContain('gh label create scaffold-corpus');
    expect(body).toContain('gh issue list');
    expect(body).toContain('gh issue comment');
    expect(body).toContain('continue-on-error: true');
  });

  test('no step fails the night on this sweep\'s verdict', () => {
    // Unlike the journey sweep's vacuity gate, nothing here is hard: the only
    // reads of the verdict are the issue step's `if:`.
    const reads = [...syncBills.matchAll(/steps\.scaffold\.outputs\.verdict/g)].length;
    const inIssueStep = [...issue().body.matchAll(/steps\.scaffold\.outputs\.verdict/g)].length;
    expect(reads).toBe(inIssueStep);
  });

  test('the corpus sweep is gone from the PR suite; the matcher fixtures stay', () => {
    const spec = readFileSync(join(process.cwd(), 'tests/moment-scaffold.unit.spec.ts'), 'utf8');
    expect(spec).not.toContain("test('the floor-action vocabulary is total over the corpus it is for");
    expect(spec).toContain('floorActionInRecord');
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
 * 5 · 2026-09-18 (newsdesk-delivery) — the hourly layer gets guaranteed
 *     fires on top of its own starved cron, and never races a scheduled run.
 * ------------------------------------------------------------------ */
test.describe('newsdesk is dispatched, not only scheduled', () => {
  const dispatchStep = (yml: string) => {
    const at = yml.indexOf('- name: Dispatch the newsdesk');
    expect(at, 'dispatch step not found').toBeGreaterThan(0);
    // Slice to the next top-level step (or EOF) so the assertions below can't
    // accidentally match a LATER step's `if:`/`run:` line.
    const rest = yml.slice(at);
    const nextStepAt = rest.slice(1).search(/\n {6}- name:/);
    return nextStepAt === -1 ? rest : rest.slice(0, nextStepAt + 1);
  };

  test('hot-bills.yml dispatches it, guarded to main and non-blocking', () => {
    const step = dispatchStep(hotBills);
    expect(step).toContain('gh workflow run newsdesk.yml --ref main');
    expect(step).toContain("github.ref == 'refs/heads/main'");
    expect(step).toContain('continue-on-error: true');
  });

  test('hot-bills.yml stands down while a nightly sync is waiting, so its dispatch cannot evict it', () => {
    // 2026-10-05: a pending nightly (run 37376062791) was evicted by this
    // step's dispatch. The lookup must run before the dispatch, read
    // sync-bills.yml's waiting runs, and exit 0 (never fail the job).
    const step = dispatchStep(hotBills);
    const lookup = step.indexOf('gh run list --repo "$GITHUB_REPOSITORY" --workflow sync-bills.yml');
    expect(lookup, 'waiting-nightly lookup not found').toBeGreaterThan(0);
    expect(lookup).toBeLessThan(step.indexOf('gh workflow run newsdesk.yml --ref main'));
    for (const status of ['queued', 'pending', 'waiting', 'requested']) {
      expect(step).toContain(`.status == "${status}"`);
    }
    expect(step).toContain('|| echo 0)');
    expect(step).toContain('exit 0');
  });

  test('sync-bills.yml dispatches it too, and only after the cursor-progress alarm', () => {
    const step = dispatchStep(syncBills);
    expect(step).toContain('gh workflow run newsdesk.yml --ref main');
    expect(step).toContain("github.ref == 'refs/heads/main'");
    expect(step).toContain('continue-on-error: true');
    // Same reasoning as "the alarm is LAST" above, one step further: nothing
    // in this job's normal work — including a red cursor-age alarm — may
    // skip the newsdesk its guaranteed fire.
    expect(syncBills.indexOf('- name: Dispatch the newsdesk')).toBeGreaterThan(
      syncBills.indexOf('- name: Cursor-progress alarm')
    );
  });

  test('both dispatch steps run even when something upstream already failed', () => {
    expect(dispatchStep(hotBills)).toContain('if: always()');
    expect(dispatchStep(syncBills)).toContain('if: always()');
  });

  test('the concurrency group already shared with newsdesk.yml is the only guard needed — no new one was invented', () => {
    // Pinned above too (test group 4): re-asserted here so a reader of THIS
    // block sees the guard the dispatch steps rely on without cross-referencing.
    const groupOf = (yml: string) => /concurrency:[\s\S]*?group:\s*(\S+)/.exec(yml)?.[1];
    expect(groupOf(wf('newsdesk.yml'))).toBe(groupOf(hotBills));
    expect(groupOf(wf('newsdesk.yml'))).toBe(groupOf(syncBills));
  });
});

/* ------------------------------------------------------------------ *
 * 6 · D8 — the nightly reads the same day's floor record.
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
    // data-sync group - where, until the group took `queue: max` on
    // 2026-10-06, a pending run was what newsdesk's hourly cron evicted
    // (observed 2026-08-08). It now waits its turn; the gap keeps it from
    // waiting at all.
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

/* ------------------------------------------------------------------ *
 * 7 · 2026-09-25 (Phase 0 of the real-time plan) — the vote sync runs
 *     INTRADAY, so the live layer can read a vote the day it is taken.
 *
 * On 2026-09-24 the Senate rejected H.Con.Res. 89 at 1:45 p.m. ET and the
 * "Where it stands" written 72 minutes later said no votes had been recorded:
 * scripts/sync-votes.mjs ran only in the nightly, and scripts/moment-updates.mjs
 * never read its file. The order below is what makes the fix work: the vote
 * sync must land data/votes.json BEFORE the collector reads it, on the hourly
 * path, without ever costing that path its headline refreshes.
 * ------------------------------------------------------------------ */
test.describe('newsdesk: intraday roll-call vote sync', () => {
  const newsdesk = wf('newsdesk.yml');
  const stepOf = (name: string) => {
    const at = newsdesk.indexOf(`- name: ${name}`);
    expect(at, `${name} step not found`).toBeGreaterThan(0);
    const rest = newsdesk.slice(at);
    const next = rest.slice(1).search(/\n {6}- name:/);
    return { at, body: next === -1 ? rest : rest.slice(0, next + 1) };
  };

  test('THE ORDER: after the newsdesk (the corpus it joins on), before the Moment updates (which read it), before the commit', () => {
    const votes = stepOf('Sync roll-call votes');
    expect(votes.at).toBeGreaterThan(stepOf('Run newsdesk').at);
    expect(votes.at).toBeLessThan(stepOf('Collect Moment updates').at);
    expect(votes.at).toBeLessThan(stepOf('Commit data').at);
  });

  test('it can never cost the hourly run, never spends, and never commits a cursor-only change', () => {
    const { body } = stepOf('Sync roll-call votes');
    expect(body).toContain('run: node scripts/sync-votes.mjs --only-new-rolls');
    expect(body).toContain('continue-on-error: true');
    expect(body).toContain('CONGRESS_API_KEY: ${{ secrets.CONGRESS_API_KEY }}');
    // $0 by construction: this step is never handed the Anthropic key.
    expect(body).not.toContain('ANTHROPIC_API_KEY');
  });

  test('--only-new-rolls really gates the WRITE (and the pre-write gate still runs first)', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/sync-votes.mjs'), 'utf8');
    expect(src).toContain("const ONLY_NEW_ROLLS = process.argv.includes('--only-new-rolls');");
    const gateAt = src.indexOf('verifyVotes({');
    const skipAt = src.indexOf('ONLY_NEW_ROLLS && h.stored + s.stored === 0');
    const writeAt = src.indexOf('writeAtomic(VOTES_PATH');
    expect(gateAt).toBeGreaterThan(0);
    expect(skipAt).toBeGreaterThan(gateAt);
    expect(writeAt).toBeGreaterThan(skipAt);
  });

  test('the nightly keeps its own vote sync WITHOUT the flag, so the cursor is still persisted nightly', () => {
    expect(syncBills).toMatch(/run: node scripts\/sync-votes\.mjs\s*\n/);
    expect(syncBills).not.toContain('sync-votes.mjs --only-new-rolls');
    // …and the newsdesk still shares the data-sync group, so the two writes serialize.
    expect(newsdesk).toMatch(/concurrency:[\s\S]*?group:\s*data-sync/);
  });
});

/* ------------------------------------------------------------------ *
 * 8 · 2026-10-06 — a waiting run in data-sync is never replaced.
 *
 * On 2026-10-05 the nightly (run 37376062791) waited behind a hot-bill pass
 * and was replaced two minutes later by a newsdesk run: cancelled, zero jobs,
 * no nightly that day. On 2026-10-03 the nightly itself replaced a waiting
 * scheduled newsdesk (run 37142332818). GitHub's default for a concurrency
 * group is one running run plus ONE pending run, and a newly queued run
 * cancels the pending one; a workflow-level key applies when the run is
 * queued, so a cron event cannot be guarded from inside a step. `queue: max`
 * lets up to 100 runs wait, first-in first-out. It is pinned on ALL four
 * members, so no member's setting differs from another's (what GitHub does
 * with a group whose members disagree is not documented).
 * ------------------------------------------------------------------ */
test.describe('data-sync queues, it never replaces', () => {
  /** The top-level `concurrency:` block's keys, comments stripped. */
  const concurrencyOf = (yml: string) => {
    const block = /^concurrency:\n((?:[ \t]+.*\n|[ \t]*\n)*)/m.exec(yml)?.[1];
    expect(block, 'no top-level concurrency block').toBeTruthy();
    const keys: Record<string, string> = {};
    for (const line of block!.split('\n')) {
      const m = /^\s+([a-z-]+):\s*([^#\s]+)/.exec(line);
      if (m) keys[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
    return keys;
  };
  const members = ['sync-bills.yml', 'hot-bills.yml', 'newsdesk.yml', 'moment-watch.yml'];

  for (const name of members) {
    test(`${name}: data-sync, queue: max, and never cancel-in-progress`, () => {
      const c = concurrencyOf(wf(name));
      expect(c.group).toBe('data-sync');
      expect(c.queue, `${name} must queue, not replace, a waiting run`).toBe('max');
      // GitHub rejects queue: max with cancel-in-progress: true, and a running
      // corpus write must never be cancelled anyway.
      expect(c['cancel-in-progress']).toBe('false');
    });
  }

  test('the key sits at WORKFLOW level, where it applies when a cron run is queued, not inside a job', () => {
    for (const name of members) {
      const yml = wf(name);
      const jobsAt = yml.search(/^jobs:/m);
      expect(yml.search(/^concurrency:/m), name).toBeGreaterThan(0);
      expect(yml.search(/^concurrency:/m), name).toBeLessThan(jobsAt);
      // and no job re-declares a concurrency of its own that could disagree
      expect(yml.slice(jobsAt), name).not.toMatch(/^\s+concurrency:/m);
    }
  });

  /**
   * Does this workflow put a run or a job in the group named exactly
   * `data-sync`? Comments are stripped first; the name may be bare or quoted,
   * may carry a trailing comment, and may sit under `group:` or be the
   * one-line `concurrency: data-sync` form. `data-sync-legislators` and the
   * like are other groups and do not match.
   */
  const joinsDataSync = (yml: string) =>
    /(?:\bgroup|^\s*concurrency)\s*:\s*(['"]?)data-sync\1\s*(?:[,}]|$)/m.test(
      yml
        .split('\n')
        .map((l) => l.replace(/\s#.*$|^#.*$/, ''))
        .join('\n')
    );

  test('the membership matcher catches every way of spelling the group, and nothing else', () => {
    for (const spelled of [
      'concurrency:\n  group: data-sync\n',
      "concurrency:\n  group: 'data-sync'\n",
      'concurrency:\n  group: "data-sync"\n',
      'concurrency:\n  group: data-sync # shared with the others\n',
      'concurrency:\n  group: data-sync   \n',
      'concurrency: data-sync\n',
      "concurrency: 'data-sync' # one line\n",
      'concurrency: { group: data-sync, cancel-in-progress: false }\n',
      'jobs:\n  x:\n    concurrency:\n      group: data-sync\n',
    ]) {
      expect(joinsDataSync(spelled), JSON.stringify(spelled)).toBe(true);
    }
    for (const other of [
      'concurrency:\n  group: data-sync-legislators\n',
      'concurrency:\n  group: data-sync-question-press\n',
      'concurrency:\n  # group: data-sync\n  group: nightly-watchdog\n',
      'concurrency:\n  group: nightly-watchdog # not data-sync\n',
      '        run: echo "waiting in the data-sync group"\n',
    ]) {
      expect(joinsDataSync(other), JSON.stringify(other)).toBe(false);
    }
  });

  test('every workflow that names data-sync is one of the four, so a fifth cannot join with the default queue', () => {
    const inGroup = readdirSync(join(process.cwd(), '.github/workflows'))
      .filter((n) => /\.ya?ml$/.test(n))
      .filter((n) => joinsDataSync(wf(n)))
      .sort();
    expect(inGroup).toEqual([...members].sort());
  });

  test('the hot-bills guard from #444 stays as the second line', () => {
    // Redundant while queue: max holds, kept so backing it out cannot reopen
    // 2026-10-05 on that path. Pinned in group 5; re-read here so a reader of
    // this block sees both lines.
    expect(hotBills).toContain('gh run list --repo "$GITHUB_REPOSITORY" --workflow sync-bills.yml');
  });
});

/* ------------------------------------------------------------------ *
 * 9 · 2026-10-06 — the watchdog re-dispatches a nightly that never ran.
 *
 * GitHub's scheduler can drop a scheduled run under load, a runner can fail
 * to start, and the daily doctor cannot dispatch (HTTP 403). The decision is
 * lib/nightly-watchdog.mjs; every guard and the cap are pinned below, each
 * against a case that would dispatch if that guard were removed.
 * ------------------------------------------------------------------ */
test.describe('nightly watchdog: the decision', () => {
  const T = (iso: string) => Date.parse(iso);
  // 2026-10-06 03:30Z: inside the band; the window opened 2026-10-05 14:00Z.
  const NOW = T('2026-10-06T03:30:00Z');
  type Run = {
    id: number;
    event: string;
    status: string;
    conclusion: string | null;
    created_at: string;
    head_branch: string;
    triggering_actor?: { login?: string } | null;
  };
  const run = (over: Partial<Run>): Run => ({
    id: 1,
    event: 'schedule',
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-10-04T18:08:55Z',
    head_branch: 'main',
    triggering_actor: { login: 'cm2489' },
    ...over,
  });
  // Yesterday's good nightly, outside today's window: on its own it never stands the watchdog down.
  const older = run({ id: 37223269918 });
  const evicted = run({ id: 37376062791, conclusion: 'cancelled', created_at: '2026-10-05T21:28:21Z' });
  const noJobs = { '37376062791': [] };

  test('the constants: window opens 14:00 the day before, acts 02:00-14:00, once a day', () => {
    expect(WINDOW_OPENS_HOUR_UTC).toBe(14);
    expect(ACT_FROM_HOUR_UTC).toBe(2);
    expect(ACT_UNTIL_HOUR_UTC).toBe(14);
    expect(MAX_AUTO_DISPATCHES_PER_UTC_DAY).toBe(1);
    // The band starts 11h45m after the 14:15 slot: later than the worst
    // lateness ever measured on a data-sync member (+9h31m).
    expect((ACT_FROM_HOUR_UTC + 24) * 60 - (14 * 60 + 15)).toBeGreaterThan(9 * 60 + 31);
    // and it ends before the next nightly is due
    expect(ACT_UNTIL_HOUR_UTC * 60).toBeLessThanOrEqual(14 * 60 + 15);
  });

  test('the window is computed from the clock, never from the runs', () => {
    const w = watchdogWindow(NOW);
    expect(new Date(w.windowStart).toISOString()).toBe('2026-10-05T14:00:00.000Z');
    expect(new Date(w.utcDayStart).toISOString()).toBe('2026-10-06T00:00:00.000Z');
    expect(w.inBand).toBe(true);
    expect(watchdogWindow(T('2026-10-06T01:59:59Z')).inBand).toBe(false);
    expect(watchdogWindow(T('2026-10-06T02:00:00Z')).inBand).toBe(true);
    expect(watchdogWindow(T('2026-10-06T13:59:59Z')).inBand).toBe(true);
    expect(watchdogWindow(T('2026-10-06T14:00:00Z')).inBand).toBe(false);
    expect(() => watchdogWindow(Number.NaN)).toThrow();
  });

  test('THE CASE IT EXISTS FOR: 2026-10-05, the only nightly evicted with zero jobs -> dispatch', () => {
    const v = decideNightlyRescue({ now: NOW, runs: [evicted, older], jobsByRunId: noJobs });
    expect(v).toMatchObject({ dispatch: true, code: 'dropped' });
  });

  test('a nightly the scheduler never fired -> dispatch', () => {
    expect(decideNightlyRescue({ now: NOW, runs: [older] })).toMatchObject({ dispatch: true, code: 'never-fired' });
    expect(decideNightlyRescue({ now: NOW, runs: [] })).toMatchObject({ dispatch: true, code: 'never-fired' });
  });

  test('a runner that never started (runner_id 0, no steps) is a drop too', () => {
    const v = decideNightlyRescue({
      now: NOW,
      runs: [evicted, older],
      jobsByRunId: { '37376062791': [{ runner_id: 0, steps: [] }] },
    });
    expect(v.dispatch).toBe(true);
  });

  test('GUARD band: never outside 02:00-14:00 UTC, when a late scheduled nightly may still fire', () => {
    for (const iso of ['2026-10-06T00:30:00Z', '2026-10-06T01:59:00Z', '2026-10-06T14:00:00Z', '2026-10-06T21:00:00Z']) {
      const v = decideNightlyRescue({ now: T(iso), runs: [older] });
      expect(v, iso).toMatchObject({ dispatch: false, code: 'outside-band' });
    }
  });

  test('GUARD active: never while ANY nightly is not completed, whatever its branch, age or status', () => {
    for (const status of ['queued', 'waiting', 'pending', 'requested', 'in_progress', 'a-status-github-adds-later']) {
      for (const over of [{}, { head_branch: 'some-branch' }, { created_at: '2026-09-01T00:00:00Z' }]) {
        const active = run({ id: 9, status, conclusion: null, ...over });
        const v = decideNightlyRescue({ now: NOW, runs: [active, evicted, older], jobsByRunId: noJobs });
        expect(v, `${status} ${JSON.stringify(over)}`).toMatchObject({ dispatch: false, code: 'active' });
      }
    }
  });

  test('CAP: at most one automatic dispatch per UTC day, even when that dispatch was itself lost', () => {
    const mine = run({
      id: 8,
      event: 'workflow_dispatch',
      conclusion: 'cancelled',
      created_at: '2026-10-06T02:24:00Z',
      triggering_actor: { login: 'github-actions[bot]' },
    });
    const v = decideNightlyRescue({ now: NOW, runs: [mine, evicted, older], jobsByRunId: { ...noJobs, '8': [] } });
    expect(v).toMatchObject({ dispatch: false, code: 'cap' });
    // an unknown actor counts against the cap (the safe reading) ...
    const unknown = { ...mine, triggering_actor: null };
    expect(decideNightlyRescue({ now: NOW, runs: [unknown, evicted, older], jobsByRunId: { ...noJobs, '8': [] } }).code).toBe('cap');
    // ... a person's own dispatch does not use the watchdog's one
    const owners = { ...mine, triggering_actor: { login: 'cm2489' } };
    expect(decideNightlyRescue({ now: NOW, runs: [owners, evicted, older], jobsByRunId: { ...noJobs, '8': [] } }).dispatch).toBe(true);
    // ... and yesterday's automatic dispatch does not block today
    const yesterdays = { ...mine, created_at: '2026-10-05T03:00:00Z' };
    expect(decideNightlyRescue({ now: NOW, runs: [evicted, yesterdays, older], jobsByRunId: noJobs }).dispatch).toBe(true);
  });

  test('GUARD succeeded: never when a main-branch nightly succeeded in the window', () => {
    const good = run({ id: 7, created_at: '2026-10-05T23:50:00Z' });
    expect(decideNightlyRescue({ now: NOW, runs: [good, evicted, older], jobsByRunId: noJobs })).toMatchObject({
      dispatch: false,
      code: 'succeeded',
    });
    // a success on another branch did not put tonight's data on main
    const branch = { ...good, head_branch: 'fix/something' };
    expect(decideNightlyRescue({ now: NOW, runs: [branch, evicted, older], jobsByRunId: noJobs }).dispatch).toBe(true);
    // the window opens at 14:00 yesterday, not at midnight
    const justIn = run({ id: 6, created_at: '2026-10-05T14:00:00Z' });
    expect(decideNightlyRescue({ now: NOW, runs: [justIn] }).code).toBe('succeeded');
    const justOut = run({ id: 6, created_at: '2026-10-05T13:59:59Z' });
    expect(decideNightlyRescue({ now: NOW, runs: [justOut] }).dispatch).toBe(true);
  });

  test('GUARD needs-a-person: a nightly that ended any other way than cancelled is not re-run', () => {
    for (const conclusion of ['failure', 'timed_out', 'startup_failure', 'action_required', 'neutral', 'skipped', null]) {
      const red = run({ id: 5, conclusion, created_at: '2026-10-05T18:00:00Z' });
      const v = decideNightlyRescue({ now: NOW, runs: [red, older] });
      expect(v, String(conclusion)).toMatchObject({ dispatch: false, code: 'needs-a-person' });
    }
  });

  test('GUARD cancelled-after-start: a run that got a runner was stopped, not dropped', () => {
    const jobs = { '37376062791': [{ runner_id: 1000004215, steps: [{}] }] };
    expect(decideNightlyRescue({ now: NOW, runs: [evicted, older], jobsByRunId: jobs })).toMatchObject({
      dispatch: false,
      code: 'cancelled-after-start',
    });
    expect(gotARunner([{ runner_id: 0, steps: [{ name: 'Set up job' }] }])).toBe(true);
    expect(gotARunner([{ runner_id: 0, steps: [] }])).toBe(false);
    expect(gotARunner([])).toBe(false);
  });

  test('FAIL SAFE: unknown jobs stand down, and a malformed run list throws rather than dispatching', () => {
    expect(decideNightlyRescue({ now: NOW, runs: [evicted, older] })).toMatchObject({ dispatch: false, code: 'jobs-unknown' });
    expect(gotARunner(undefined)).toBeNull();
    expect(() => decideNightlyRescue({ now: NOW, runs: undefined as unknown as Run[] })).toThrow();
    expect(() => decideNightlyRescue({ now: NOW, runs: [run({ created_at: 'not a date' })] })).toThrow();
  });
});

test.describe('nightly watchdog: the workflow and the script', () => {
  const watchdog = wf('nightly-watchdog.yml');
  const script = readFileSync(join(process.cwd(), 'scripts/nightly-watchdog.mjs'), 'utf8');

  test('its own group, NOT data-sync: it writes nothing, and two watchdog runs never overlap', () => {
    expect(/^concurrency:\n\s+group:\s*(\S+)/m.exec(watchdog)?.[1]).toBe('nightly-watchdog');
    expect(watchdog).toContain('cancel-in-progress: false');
    expect(watchdog).not.toMatch(/git (add|commit|push)/);
  });

  test('least privilege: contents read, actions write, nothing else; no secret; stdlib only', () => {
    const perms = /^permissions:\n((?:[ \t]+.*\n|[ \t]*\n)*)/m.exec(watchdog)?.[1] ?? '';
    const granted = [...perms.matchAll(/^\s+([a-z-]+):\s*(read|write|none)/gm)].map((m) => `${m[1]}:${m[2]}`).sort();
    expect(granted).toEqual(['actions:write', 'contents:read']);
    expect(watchdog).not.toMatch(/secrets\./);
    expect(watchdog).not.toMatch(/run: npm ci/);
    expect(watchdog).toContain('GH_TOKEN: ${{ github.token }}');
    expect(watchdog).toMatch(/timeout-minutes: \d+/);
  });

  test('a branch validation run never dispatches (the main-ref guard every dispatch step here carries)', () => {
    expect(watchdog).toContain("WATCHDOG_DISPATCH: ${{ github.ref == 'refs/heads/main' && '1' || '0' }}");
    expect(script).toContain("process.env.WATCHDOG_DISPATCH === '1'");
    expect(watchdog).toContain('run: node scripts/nightly-watchdog.mjs');
  });

  test('every slot can land in the 02:00-14:00 band, none on the hour or half hour', () => {
    const crons = [...watchdog.matchAll(/-\s*cron:\s*'(\d+)\s+([\d,]+)\s+\*\s+\*\s+\*'/g)];
    expect(crons).toHaveLength(1);
    const minute = Number(crons[0][1]);
    expect(minute % 30).not.toBe(0);
    const hours = crons[0][2].split(',').map(Number);
    expect(hours.length).toBeGreaterThanOrEqual(2);
    for (const h of hours) {
      expect(h).toBeGreaterThanOrEqual(ACT_FROM_HOUR_UTC);
      expect(h).toBeLessThan(ACT_UNTIL_HOUR_UTC);
    }
  });

  test('the script dispatches the nightly ONCE, on main, and never retries a dispatch', () => {
    expect(script.match(/'workflow', 'run'/g)).toHaveLength(1);
    expect(script).toContain("['workflow', 'run', NIGHTLY_WORKFLOW, '--repo', REPO, '--ref', NIGHTLY_BRANCH]");
    expect(script).not.toMatch(/for \(let attempt|ATTEMPTS/);
  });

  test('a failed lookup exits 1 BEFORE the decision, so it can never reach the dispatch', () => {
    const lookupFail = script.indexOf("could not read the nightly's runs");
    const decide = script.indexOf('decideNightlyRescue({ now, runs, jobsByRunId })');
    const dispatch = script.indexOf("'workflow', 'run'");
    expect(lookupFail).toBeGreaterThan(0);
    expect(lookupFail).toBeLessThan(decide);
    expect(decide).toBeLessThan(dispatch);
    expect(script.slice(lookupFail, decide)).toContain('process.exit(1)');
    // the decision's own throw is caught and exits 1 too, before the dispatch
    expect(script.slice(decide, dispatch)).toContain('process.exit(1)');
    expect(script.slice(decide, dispatch)).toContain('if (!verdict.dispatch)');
  });

  test('nothing else dispatches the nightly automatically, so the cap counts every bot dispatch there is', () => {
    const dispatchers = readdirSync(join(process.cwd(), '.github/workflows'))
      .filter((n) => /\.ya?ml$/.test(n))
      .filter((n) => /gh workflow run sync-bills\.yml|nightly-watchdog\.mjs/.test(wf(n)));
    expect(dispatchers).toEqual(['nightly-watchdog.yml']);
  });
});

/* ------------------------------------------------------------------ *
 * 10 · 2026-10-06 — the watchdog script itself, run against a stand-in gh.
 *
 * Group 9's static pins say where the exits are; these run the script for
 * real so that skipping the jobs fetch (which turns the 10-05 rescue into a
 * green "jobs-unknown" stand-down) or dropping the exit after a failed
 * dispatch (which turns a red run green and prints "dispatched") fails here.
 *
 * NOTHING HERE CAN REACH GITHUB. The stand-in `gh` is first on a PATH that is
 * otherwise only /usr/bin:/bin, and the test checks that `gh` resolves to it
 * before any run that sets WATCHDOG_DISPATCH=1. Beyond that: the environment
 * is built from scratch (no GH_TOKEN, no GITHUB_TOKEN, HOME and GH_CONFIG_DIR
 * are an empty temp folder), and the repository named does not exist. The
 * clock is fixed at 2026-10-06T03:30Z by a preload, so the band check does
 * not depend on when CI runs.
 * ------------------------------------------------------------------ */
test.describe('nightly watchdog: the script, run against a stand-in gh', () => {
  const FAKE_REPO = 'oravan-watchdog-test/no-such-repo';
  const evictedRun = {
    id: 37376062791,
    event: 'schedule',
    status: 'completed',
    conclusion: 'cancelled',
    created_at: '2026-10-05T21:28:21Z',
    head_branch: 'main',
    triggering_actor: { login: 'cm2489' },
  };
  const olderRun = { ...evictedRun, id: 37223269918, conclusion: 'success', created_at: '2026-10-04T18:08:55Z' };

  type Fixture = { runs: unknown[]; jobs: Record<string, unknown[]>; failJobs?: boolean; failDispatch?: boolean };

  const runWatchdog = (fixture: Fixture, dispatch: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), 'watchdog-gh-'));
    try {
      const bin = join(dir, 'bin');
      const home = join(dir, 'home');
      mkdirSync(bin);
      mkdirSync(home);
      writeFileSync(join(dir, 'fixture.json'), JSON.stringify(fixture));
      writeFileSync(
        join(dir, 'fake-gh.mjs'),
        [
          "import { appendFileSync, readFileSync } from 'node:fs';",
          'const args = process.argv.slice(2);',
          "appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');",
          "const f = JSON.parse(readFileSync(process.env.FAKE_GH_FIXTURE, 'utf8'));",
          "if (args[0] === 'api' && /\\/actions\\/workflows\\/sync-bills\\.yml\\/runs\\?/.test(args[1])) {",
          '  process.stdout.write(JSON.stringify({ workflow_runs: f.runs }));',
          "} else if (args[0] === 'api' && /\\/actions\\/runs\\/(\\d+)\\/jobs\\?/.test(args[1])) {",
          "  if (f.failJobs) { process.stderr.write('HTTP 502'); process.exit(1); }",
          '  const id = /\\/runs\\/(\\d+)\\/jobs/.exec(args[1])[1];',
          '  process.stdout.write(JSON.stringify({ jobs: f.jobs[id] ?? [] }));',
          "} else if (args[0] === 'workflow' && args[1] === 'run') {",
          "  if (f.failDispatch) { process.stderr.write('HTTP 500'); process.exit(1); }",
          '} else {',
          "  process.stderr.write('stand-in gh: unexpected call'); process.exit(2);",
          '}',
        ].join('\n')
      );
      const gh = join(bin, 'gh');
      writeFileSync(gh, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-gh.mjs')}" "$@"\n`);
      chmodSync(gh, 0o755);
      const clock = join(dir, 'clock.mjs');
      writeFileSync(clock, "const n = Date.parse('2026-10-06T03:30:00Z');\nDate.now = () => n;\n");
      const log = join(dir, 'calls.log');
      writeFileSync(log, '');
      const env: NodeJS.ProcessEnv = {
        NODE_ENV: 'test',
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: home,
        GH_CONFIG_DIR: home,
        GITHUB_REPOSITORY: FAKE_REPO,
        FAKE_GH_LOG: log,
        FAKE_GH_FIXTURE: join(dir, 'fixture.json'),
        WATCHDOG_DISPATCH: dispatch ? '1' : '0',
      };
      if (dispatch) {
        // The safety check this whole block rests on: `gh` must be the stand-in.
        const which = spawnSync('/bin/sh', ['-c', 'command -v gh'], { env, encoding: 'utf8' });
        expect(which.stdout.trim(), 'gh does not resolve to the stand-in; refusing to run with dispatch on').toBe(gh);
      }
      const r = spawnSync(
        process.execPath,
        ['--import', pathToFileURL(clock).href, join(process.cwd(), 'scripts/nightly-watchdog.mjs')],
        { env, encoding: 'utf8', timeout: 20_000 }
      );
      const calls = readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]);
      return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const dispatchCalls = (calls: string[][]) => calls.filter((c) => c[0] === 'workflow' && c[1] === 'run');
  const tenFive: Fixture = { runs: [evictedRun, olderRun], jobs: { '37376062791': [] } };

  test('THE 10-05 RESCUE, end to end: it reads the evicted run\'s jobs and would dispatch', () => {
    const r = runWatchdog(tenFive, false);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('WOULD dispatch sync-bills.yml (dropped)');
    // the jobs of the cancelled main-branch run in the window were read ...
    expect(r.calls.some((c) => c[0] === 'api' && c[1].includes('/actions/runs/37376062791/jobs'))).toBe(true);
    // ... the older successful run's were not, and nothing was dispatched
    expect(r.calls.some((c) => c[1]?.includes('/actions/runs/37223269918/jobs'))).toBe(false);
    expect(dispatchCalls(r.calls)).toHaveLength(0);
  });

  test('a jobs lookup that fails turns the run red and dispatches nothing', () => {
    const r = runWatchdog({ ...tenFive, failJobs: true }, true);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('Nothing was dispatched');
    expect(dispatchCalls(r.calls)).toHaveLength(0);
  });

  test('a dispatch that errors turns the run red, is tried once, and is never reported as dispatched', () => {
    const r = runWatchdog({ ...tenFive, failDispatch: true }, true);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('errored');
    expect(r.out).not.toContain('Nightly watchdog dispatched');
    expect(dispatchCalls(r.calls)).toEqual([['workflow', 'run', 'sync-bills.yml', '--repo', FAKE_REPO, '--ref', 'main']]);
  });

  test('a dispatch that lands is made once, on main, and reported', () => {
    const r = runWatchdog(tenFive, true);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('::notice::Nightly watchdog dispatched sync-bills.yml on main (dropped)');
    expect(dispatchCalls(r.calls)).toHaveLength(1);
  });

  test('a night that succeeded stands it down, with dispatch on', () => {
    const good = { ...olderRun, id: 7, created_at: '2026-10-05T23:50:00Z' };
    const r = runWatchdog({ runs: [good, evictedRun, olderRun], jobs: { '37376062791': [] } }, true);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('stood down (succeeded)');
    expect(dispatchCalls(r.calls)).toHaveLength(0);
  });
});
