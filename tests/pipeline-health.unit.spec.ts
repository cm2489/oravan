import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SIGNAL_STALE_HOURS } from '../lib/docket.mjs';
import {
  COVERAGE_STALE_DAYS,
  CURSOR_FROZEN_DAYS,
  FLOOR_SIGNAL_ALARM_HOURS,
  HEALTH_ISSUE_LABEL,
  HEALTH_ISSUE_TITLE,
  NEWSDESK_EXPECTED_SLOTS,
  alarms,
  ciRedStreak,
  countAnthropicErrors,
  countPortrait404s,
  countUpstashCacheFailures,
  coverageBillCount,
  coverageStaleness,
  cursorHealth,
  danglingConversationSlugs,
  durationMinutes,
  estimateDaySpend,
  floorSignalFreshness,
  formatHealthAlarmComment,
  formatHealthIssueBody,
  formatHealthSection,
  parseCoverageDone,
  parseFailingTests,
  parsePregen,
  parseSyncDone,
  parseT3,
  pressFeedHealth,
  stripLogPrefix,
} from '../lib/pipeline-health.mjs';

/*
 * THE PIPELINE-HEALTH REPORT, pinned where it can be read rather than inferred.
 *
 * Every parser here is fed a fixture cut from a REAL run log (tests/fixtures/
 * pipeline-health-*.log, `gh run view --log` output with request ids and batch
 * ids redacted). That is the point of the fixtures: a log parser tested only
 * against a string a human typed proves the string, not the pipeline. When a
 * script changes the wording of a line it prints, the fixture goes stale and
 * these tests are what notice.
 *
 * The rule the whole file exists to defend: A MISSING READING AND A HEALTHY
 * READING MUST NEVER LOOK THE SAME. A shape parser that cannot find its anchor
 * returns null and renders "not found"; it does not return 0. A counting
 * parser returns 0 only because it actually counted zero, and each one is
 * paired with a test proving it still counts something.
 */

const fixture = (name: string) => readFileSync(join(process.cwd(), 'tests/fixtures', name), 'utf8');
const NIGHTLY = fixture('pipeline-health-nightly.log');
const CREDIT = fixture('pipeline-health-credit-outage.log');
const NEWSDESK = fixture('pipeline-health-newsdesk.log');
const CI_FAILURE = fixture('pipeline-health-ci-failure.log');
const PREGEN_ABORT = fixture('pipeline-health-pregen-abort.log');

/* ------------------------------------------------------------------ *
 * 1 · Log-line normalisation
 * ------------------------------------------------------------------ */

test.describe('stripLogPrefix', () => {
  test('removes the job/step/timestamp prefix gh run view --log adds', () => {
    expect(stripLogPrefix('sync\tUNKNOWN STEP\t2026-09-17T18:18:19.6952127Z DONE: 1 refreshed')).toBe(
      'DONE: 1 refreshed'
    );
  });

  test('leaves a bare line alone, so a hand-trimmed excerpt still parses', () => {
    expect(stripLogPrefix('pregen: done — 5 cached, 0 failed')).toBe('pregen: done — 5 cached, 0 failed');
  });

  test('strips ANSI colour, which every gh log carries', () => {
    expect(stripLogPrefix('job\tstep\t2026-09-17T18:18:19.0000000Z [36;1mhello[0m')).toBe('hello');
  });
});

/* ------------------------------------------------------------------ *
 * 2 · The nightly's counters
 * ------------------------------------------------------------------ */

test.describe('parseSyncDone', () => {
  test('reads every counter off the real 2026-09-17 nightly line', () => {
    const done = parseSyncDone(NIGHTLY);
    expect(done).not.toBeNull();
    expect(done).toMatchObject({
      refreshed: 212,
      added: 11,
      gated: 366,
      queued: 0,
      ascendingFailed: 0,
      newFailed: 0,
      recentFailed: 0,
      forceFailed: 0,
      cursor: '2026-09-08T17:54:31Z',
      cursorReason: 'truncated',
      newSeen: 377,
      corpus: 2976,
    });
  });

  test('refuses the OTHER DONE lines in the same log — the decoy test', () => {
    // scripts/newsdesk.mjs's hot-bill refresh prints
    //   `DONE: 86 refreshed, 0 added+decoded; corpus 2978`
    // which shares this line's first two counters. Matching it as if it were a
    // nightly would report a full night off a five-minute headline refresh.
    // The newsdesk fixture contains exactly that line and nothing else.
    expect(parseSyncDone(NEWSDESK)).toBeNull();
  });

  test('a log with no sync line is null, never a zeroed record', () => {
    expect(parseSyncDone('nothing to see here')).toBeNull();
  });
});

test.describe('parseCoverageDone', () => {
  test('reads the coverage summary out of the same nightly log', () => {
    expect(parseCoverageDone(NIGHTLY)).toEqual({
      withCoverage: 90,
      checked: 600,
      articles: 194,
      carriedForward: 310,
    });
  });

  test('null when absent', () => {
    expect(parseCoverageDone(NEWSDESK)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 3 · Pregen
 * ------------------------------------------------------------------ */

test.describe('parsePregen', () => {
  test('reads the plan, the outcome and the script\'s OWN printed cost range', () => {
    // The cost range is the one number in the spend estimate that is not a
    // guess — the script computed it from its real generation count. Losing
    // this match would silently downgrade the estimate to guesswork.
    expect(parsePregen(NIGHTLY)).toEqual({
      topBills: 10,
      combos: 60,
      alreadyCached: 0,
      toGenerate: 60,
      cached: 60,
      failed: 0,
      costLow: 0.084,
      costHigh: 0.126,
      abortReason: null,
    });
  });

  test('every field independently null when pregen did not run', () => {
    expect(parsePregen(NEWSDESK)).toEqual({
      topBills: null,
      combos: null,
      alreadyCached: null,
      toGenerate: null,
      cached: null,
      failed: null,
      costLow: null,
      costHigh: null,
      abortReason: null,
    });
  });

  test('reads the refusal a night of nulls would otherwise hide', () => {
    // The 2026-09-19 and 2026-09-20 nightlies both ended here: pregen probed
    // the cache database, found it unconfigured, refused to spend and exited
    // 1 having printed none of its three counter lines. Every counter below
    // is null and SHOULD be — nothing ran. The reading is the reason.
    const pregen = parsePregen(PREGEN_ABORT);
    expect(pregen.abortReason).toBe(
      'cache database unreachable — the cache database is not configured in this environment (its two REST secrets are absent)'
    );
    expect(pregen.alreadyCached).toBeNull();
    expect(pregen.cached).toBeNull();
    expect(pregen.failed).toBeNull();
    expect(pregen.costLow).toBeNull();
  });

  test('a night that never armed pregen and a night pregen refused do not render alike', () => {
    // The whole point. Both nights parse to all-null counters, so before the
    // abort reading the two rows were the same four "not found"s.
    const disabled = formatHealthSection({ pregen: parsePregen(NEWSDESK) });
    const refused = formatHealthSection({ pregen: parsePregen(PREGEN_ABORT) });
    expect(disabled).toContain('pregen              not found already cached');
    expect(refused).toContain('pregen              FAILED — cache database unreachable');
    expect(refused).not.toContain('not found already cached');
  });

  test('a reason too long for the aligned block is capped, not wrapped', () => {
    const rendered = formatHealthSection({ pregen: { abortReason: 'x'.repeat(400) } });
    const line = rendered.split('\n').find((l) => l.startsWith('pregen'));
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThanOrEqual(20 + 'FAILED — '.length + 150);
    expect(line).toContain('…');
  });
});

/* ------------------------------------------------------------------ *
 * 4 · Counting parsers
 * ------------------------------------------------------------------ */

test.describe('countAnthropicErrors', () => {
  test('counts the real 2026-09-09 credit outage lines', () => {
    expect(countAnthropicErrors(CREDIT)).toEqual({
      creditBalance: 5,
      invalidRequestOther: 0,
      total: 5,
    });
  });

  test('a credit failure is NOT also counted as a generic invalid_request', () => {
    // Every one of those lines carries `invalid_request_error` too. Counting
    // both buckets would double every billing outage and make the ⛔ credit
    // alarm's number meaningless.
    const one = countAnthropicErrors(
      'FAIL hr-1-119: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'
    );
    expect(one).toEqual({ creditBalance: 1, invalidRequestOther: 0, total: 1 });
  });

  test('a genuine malformed-request rejection lands in the other bucket', () => {
    expect(
      countAnthropicErrors('FAIL s-2-119: 400 {"error":{"type":"invalid_request_error","message":"max_tokens too large"}}')
    ).toEqual({ creditBalance: 0, invalidRequestOther: 1, total: 1 });
  });

  test('a clean night counts zero — and the same function found 5 above, so the zero is real', () => {
    expect(countAnthropicErrors(NIGHTLY).total).toBe(0);
  });
});

test.describe('countPortrait404s / countUpstashCacheFailures', () => {
  test('counts only the per-member 404 lines, not the summary line beneath them', () => {
    // `mirror-portraits: 0 newly mirrored, 524 already mirrored (skipped), 15
    // failed, 525 total in manifest` sits in the fixture directly under the
    // 404s and must not be counted as a sixteenth.
    expect(countPortrait404s(NIGHTLY)).toBe(15);
  });

  test('counts the upstash cache fail-open lines', () => {
    expect(countUpstashCacheFailures(NIGHTLY)).toBe(4);
  });

  test('both are zero on a log that has neither', () => {
    expect(countPortrait404s(NEWSDESK)).toBe(0);
    expect(countUpstashCacheFailures(NEWSDESK)).toBe(0);
  });
});

test.describe('parseT3', () => {
  test('reads the batched/resolved pair off a real newsdesk run', () => {
    expect(parseT3(NEWSDESK)).toEqual({ batched: 25, resolved: 8, runs: 1 });
  });

  test('sums across the concatenated runs of a day', () => {
    expect(parseT3([NEWSDESK, NEWSDESK, NEWSDESK].join('\n'))).toEqual({ batched: 75, resolved: 24, runs: 3 });
  });

  test('a day with no newsdesk run is 0-of-0 with runs 0 — distinguishable from a failing matcher', () => {
    // 0 batched / 0 resolved / 0 runs is "nothing ran". 25 batched / 0
    // resolved / 1 run is the ⛔ condition. They must not collapse.
    expect(parseT3(NIGHTLY)).toEqual({ batched: 0, resolved: 0, runs: 0 });
  });
});

test.describe('parseFailingTests', () => {
  test('dedupes the two annotations Playwright writes for one failure', () => {
    // The github reporter emits `::error file=...` and `##[error] 1) ...` for
    // the same test, and the fixture holds both plus a repeat.
    expect(parseFailingTests(CI_FAILURE)).toEqual(['tests/freshness.spec.ts:175:7']);
  });

  test('a gate-step failure yields NO test names rather than a wrong one', () => {
    // The parity / naming / claim-truth gates fail before any browser starts,
    // so there is no spec to name. The collector reports the failing STEP for
    // those; inventing a spec name here would point at the wrong file.
    expect(parseFailingTests('test\tstep\t2026-09-18T18:01:09.8Z ##[error]check-naming: survivor in a headline')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 5 · File-derived readings
 * ------------------------------------------------------------------ */

test.describe('coverageStaleness', () => {
  const now = Date.parse('2026-09-18T00:00:00Z');
  const coverage = {
    _checkedAt: { 'hr-1-119': '2026-09-17' },
    _note: 'metadata, not a bill',
    'hr-1-119': [{ publishedAt: '2026-09-17' }],
    'hr-2-119': [{ publishedAt: '2026-01-01' }, { publishedAt: '2026-02-01' }],
    'hr-3-119': [{ publishedAt: 'not a date' }],
  };

  test('metadata keys are not bills', () => {
    expect(coverageBillCount(coverage)).toBe(3);
  });

  test('a bill is judged on its NEWEST article, and an undated one is its own bucket', () => {
    expect(coverageStaleness(coverage, { now })).toEqual({
      bills: 3,
      stale: 1,
      undated: 1,
      sharePct: 33.3,
    });
  });

  test('the staleness window is 30 days, the number CLAUDE.md\'s 2026-08-05 note measured against', () => {
    expect(COVERAGE_STALE_DAYS).toBe(30);
  });

  test('an empty corpus reports a null share, not 0% — nothing was measured', () => {
    expect(coverageStaleness({}, { now }).sharePct).toBeNull();
  });
});

test.describe('cursorHealth', () => {
  const now = Date.parse('2026-09-18T12:00:00Z');

  test('FROZEN is a conjunction: the pipeline RAN and the cursor did not move', () => {
    const h = cursorHealth(
      { lastSync: '2026-09-08T17:54:31Z', lastRun: '2026-09-17T18:12:13Z' },
      { now, previousSync: '2026-09-08T17:54:31Z' }
    );
    expect(h.frozen).toBe(true);
    expect(h.moved).toBe(false);
    expect(h.lastSyncAgeDays).toBeGreaterThan(9);
    expect(h.lastRunAgeHours).toBeLessThan(48);
  });

  test('a cursor walking a backlog forward is BEHIND, never FROZEN', () => {
    // The regression this pins (2026-09-22): the cursor advanced 09-09 → 09-16
    // → 09-18 on consecutive nights and the report called it FROZEN and "not
    // making progress" every one of those days, because it measured lastSync's
    // age and called that movement. Catching up and stalled are opposite
    // states and must never print the same word.
    const h = cursorHealth(
      { lastSync: '2026-09-14T00:00:00Z', lastRun: '2026-09-17T18:12:13Z' },
      { now, previousSync: '2026-09-09T00:00:00Z' }
    );
    expect(h.moved).toBe(true);
    expect(h.behind).toBe(true);
    expect(h.frozen).toBe(false);
    expect(h.movementUnknown).toBe(false);
  });

  test('a cursor that went BACKWARDS has not advanced', () => {
    const h = cursorHealth(
      { lastSync: '2026-09-09T00:00:00Z', lastRun: '2026-09-17T18:12:13Z' },
      { now, previousSync: '2026-09-14T00:00:00Z' }
    );
    expect(h.moved).toBe(false);
    expect(h.frozen).toBe(true);
  });

  test('no baseline reads as "not measured", never as movement', () => {
    // A dead-man's-switch that goes quiet for want of an input is the failure
    // it exists to catch, so an unreachable baseline still raises an alarm —
    // it just says what it actually knows.
    const h = cursorHealth({ lastSync: '2026-09-08T17:54:31Z', lastRun: '2026-09-17T18:12:13Z' }, { now });
    expect(h.moved).toBeNull();
    expect(h.frozen).toBe(false);
    expect(h.movementUnknown).toBe(true);
    expect(h.behind).toBe(true);
  });

  test('a pipeline that has ALSO stopped running is not called frozen', () => {
    // Nothing running is a different failure with a different fix, and the
    // nightly-missing alarm is what names it. Wearing the same word would
    // send the owner to drain a backlog that nothing is reading.
    expect(cursorHealth({ lastSync: '2026-09-01T00:00:00Z', lastRun: '2026-09-02T00:00:00Z' }, { now }).frozen).toBe(
      false
    );
  });

  test('a healthy night is not frozen', () => {
    expect(cursorHealth({ lastSync: '2026-09-18T06:00:00Z', lastRun: '2026-09-18T06:05:00Z' }, { now }).frozen).toBe(
      false
    );
  });

  test('an unparseable cursor measures nothing rather than guessing an age', () => {
    const h = cursorHealth({ lastSync: 'not a date', lastRun: 'not a date' }, { now });
    expect(h.lastSyncAgeDays).toBeNull();
    expect(h.lastRunAgeHours).toBeNull();
    expect(h.frozen).toBe(false);
  });

  test('the frozen threshold is 2 days — "two nights in a row"', () => {
    expect(CURSOR_FROZEN_DAYS).toBe(2);
  });
});

test.describe('floorSignalFreshness', () => {
  const now = Date.parse('2026-09-18T12:00:00Z');

  test('reads the stamp where the file actually keeps it (top-level fetched_at)', () => {
    const f = floorSignalFreshness({ fetched_at: '2026-09-18T09:00:00Z' }, { now, staleHours: SIGNAL_STALE_HOURS });
    expect(f.ageHours).toBeCloseTo(3, 5);
    expect(f.pastAlarm).toBe(false);
  });

  test('accepts a _meta.fetched_at too, so a schema move does not read as "no stamp"', () => {
    expect(floorSignalFreshness({ _meta: { fetched_at: '2026-09-18T09:00:00Z' } }, { now }).ageHours).toBeCloseTo(3, 5);
  });

  test('the digest alarm fires BEFORE the site stops trusting the signal', () => {
    // lib/docket.mjs's SIGNAL_STALE_HOURS is the point at which the site hides
    // a floor signal from readers. An alarm at or after that moment would only
    // ever tell the owner about something visitors had already seen.
    expect(FLOOR_SIGNAL_ALARM_HOURS).toBeLessThan(SIGNAL_STALE_HOURS);
    // 38 hours old: past the digest's 36h alarm, still inside the site's 48h
    // ceiling — the whole window this alarm exists to occupy.
    const f = floorSignalFreshness({ fetched_at: '2026-09-16T22:00:00Z' }, { now, staleHours: SIGNAL_STALE_HOURS });
    expect(f.ageHours).toBeCloseTo(38, 5);
    expect(f.pastAlarm).toBe(true);
    expect(f.pastSiteCeiling).toBe(false);
  });

  test('a missing stamp is null, not age 0', () => {
    expect(floorSignalFreshness({}, { now }).ageHours).toBeNull();
  });
});

test('danglingConversationSlugs names only the slugs the corpus has lost', () => {
  const dangling = danglingConversationSlugs(
    { slugs: { 'hr-1-119': {}, 'hr-999-119': {} } },
    new Set(['hr-1-119'])
  );
  expect(dangling).toEqual(['hr-999-119']);
});

test.describe('pressFeedHealth — the newsdesk basket, read from data/conversation.json', () => {
  const now = Date.parse('2026-09-29T13:00:00Z');
  const withStatus = (source_status: object) => ({ _meta: { schema: 'conversation/v1', source_status }, slugs: {} });
  const WT_DARK = {
    status: 'dark',
    url: 'https://www.washingtontimes.com/rss/headlines/news/politics/',
    domain: 'washingtontimes.com',
    lean: 'right',
    last_live: null,
    first_dark: '2026-09-26',
    dark_days: 3,
    last_error: 'HTTP 403',
  };
  const FOX_OK = { status: 'ok', domain: 'foxnews.com', lean: 'right', last_live: '2026-09-29', first_dark: null, dark_days: 0, last_error: null };

  test('names each dark feed with a day count recomputed from its dates', () => {
    const press = pressFeedHealth(
      withStatus({ feeds: { 'Washington Times Politics': { ...WT_DARK, first_dark: '2026-09-20', dark_days: 3 }, 'Fox News Politics': FOX_OK } }),
      { now }
    );
    expect(press?.tracked).toBe(2);
    expect(press?.darkFeeds).toEqual([
      { name: 'Washington Times Politics', domain: 'washingtontimes.com', lean: 'right', darkDays: 9, since: '2026-09-20', lastError: 'HTTP 403' },
    ]);
    expect(press?.darkLeans).toEqual([]);
  });

  test('a file that predates the per-feed alarm reads "not tracked", never "all live"', () => {
    const press = pressFeedHealth(withStatus({ press: { status: 'ok' }, leans: { right: { status: 'ok', last_live: '2026-09-29', dark_days: 0 } } }), { now });
    expect(press?.tracked).toBeNull();
    expect(formatHealthSection({ pressFeeds: press })).toContain('not tracked yet');
    expect(formatHealthSection({ pressFeeds: null })).toMatch(/press feeds\s+not found/);
  });

  test('a dead feed is a ⛔; a healthy basket is not', () => {
    const healthyPress = pressFeedHealth(withStatus({ feeds: { 'Fox News Politics': FOX_OK } }), { now });
    expect(alarms({ nightly: { conclusion: 'success' }, pressFeeds: healthyPress }).map((a) => a.code)).toEqual([]);
    const darkPress = pressFeedHealth(withStatus({ feeds: { 'Washington Times Politics': WT_DARK, 'Fox News Politics': FOX_OK } }), { now });
    const raised = alarms({ nightly: { conclusion: 'success' }, pressFeeds: darkPress });
    expect(raised.map((a) => a.code)).toEqual(['press-feed-dark']);
    expect(raised[0].text).toContain('Washington Times Politics (washingtontimes.com, right) 3d');
    const rendered = formatHealthSection({ pressFeeds: darkPress, alarms: raised });
    expect(rendered).toMatch(/press feeds\s+1\/2 live · DARK: Washington Times Politics/);
  });

  test('a dark LEAN is its own ⛔ — the digest used to read neither', () => {
    const press = pressFeedHealth(
      withStatus({ feeds: {}, leans: { right: { status: 'dark', last_live: '2026-09-20', dark_days: 7 } } }),
      { now }
    );
    expect(press?.darkLeans).toEqual([{ lean: 'right', darkDays: 9, lastLive: '2026-09-20' }]);
    expect(alarms({ nightly: { conclusion: 'success' }, pressFeeds: press }).map((a) => a.code)).toEqual(['press-lean-dark']);
  });

  test('no source_status at all is null, not an empty healthy reading', () => {
    expect(pressFeedHealth({ slugs: {} }, { now })).toBeNull();
    expect(pressFeedHealth(null, { now })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 6 · Actions-run judgements
 * ------------------------------------------------------------------ */

test.describe('ciRedStreak', () => {
  test('counts consecutive failures at the head of a newest-first list', () => {
    const s = ciRedStreak([
      { conclusion: 'failure', status: 'completed', createdAt: '2026-09-18T00:00:00Z' },
      { conclusion: 'failure', status: 'completed', createdAt: '2026-09-17T00:00:00Z' },
      { conclusion: 'success', status: 'completed', createdAt: '2026-09-16T00:00:00Z' },
    ]);
    expect(s.count).toBe(2);
    expect(s.latest).toBe('failure');
    // `since` is the OLDEST run in the streak — the moment main went red.
    expect(s.since).toBe('2026-09-17T00:00:00Z');
  });

  test('a cancelled run is skipped, not counted and not treated as green', () => {
    // House rule: a zero-step `cancelled` job is a lost runner, not a result.
    // Counting it red inflates a streak nobody can act on; counting it green
    // would end a real streak early.
    const s = ciRedStreak([
      { conclusion: 'cancelled', status: 'completed', createdAt: '2026-09-18T00:00:00Z' },
      { conclusion: 'failure', status: 'completed', createdAt: '2026-09-17T00:00:00Z' },
      { conclusion: 'failure', status: 'completed', createdAt: '2026-09-16T00:00:00Z' },
    ]);
    expect(s.count).toBe(2);
    expect(s.latest).toBe('failure');
  });

  test('an in-progress run is not a verdict', () => {
    const s = ciRedStreak([
      { conclusion: null as unknown as string, status: 'in_progress' },
      { conclusion: 'success', status: 'completed' },
    ]);
    expect(s.count).toBe(0);
    expect(s.latest).toBe('success');
  });

  test('a green head is a zero streak', () => {
    expect(ciRedStreak([{ conclusion: 'success', status: 'completed' }]).count).toBe(0);
  });
});

test('durationMinutes is null rather than 0 on an unusable pair of stamps', () => {
  expect(durationMinutes('2026-09-17T18:11:48Z', '2026-09-17T18:41:48Z')).toBe(30);
  expect(durationMinutes('2026-09-17T18:11:48Z', undefined)).toBeNull();
});

test('newsdesk is expected 24 times a day, matching its own hourly cron', () => {
  // newsdesk.yml is `cron: '7 * * * *'`. If that cron changes, this constant
  // and the "N/24 scheduled slots" row both have to move with it.
  expect(NEWSDESK_EXPECTED_SLOTS).toBe(24);
});

/* ------------------------------------------------------------------ *
 * 7 · Spend estimate
 * ------------------------------------------------------------------ */

test.describe('estimateDaySpend', () => {
  test('prices t3 per RUN, not per headline', () => {
    // scripts/newsdesk.mjs sends ONE messages.create carrying every ambiguous
    // headline, capped at max_tokens 1024 for the whole reply. Pricing it per
    // headline multiplies one prompt's overhead by its own contents.
    const oneRun = estimateDaySpend({ t3Batched: 100, t3Runs: 1 });
    const tenRuns = estimateDaySpend({ t3Batched: 100, t3Runs: 10 });
    expect(tenRuns.t3Usd).toBeGreaterThan(oneRun.t3Usd);
    expect(oneRun.assumptions.t3MaxOutputTokensPerRun).toBe(1024);
  });

  test('pregen uses the script\'s own printed range verbatim, never a re-derivation', () => {
    const s = estimateDaySpend({ pregen: { costLow: 0.084, costHigh: 0.126 } });
    expect(s.pregenUsd).toEqual({ low: 0.084, high: 0.126 });
    expect(s.totalLow).toBeCloseTo(0.084, 5);
    expect(s.totalHigh).toBeCloseTo(0.126, 5);
  });

  test('a night with no pregen line reports no pregen cost, not $0 of pregen', () => {
    expect(estimateDaySpend({ decodes: 1 }).pregenUsd).toBeNull();
  });

  test('every guessed token shape is carried into the output, and the figure is labelled an estimate', () => {
    // The only defensible way to publish a guess is to publish how it was made.
    const s = estimateDaySpend({ decodes: 10, t3Batched: 20, t3Runs: 2 });
    expect(s.labelled).toBe('estimate');
    expect(s.assumptions.decodeModel).toBe('claude-sonnet-5');
    expect(s.assumptions.t3Model).toBe('claude-haiku-4-5');
    expect(s.assumptions.decodeInputTokens).toBeGreaterThan(0);
    expect(s.assumptions.decodeOutputTokens).toBeGreaterThan(0);
  });

  test('a day that ran nothing costs nothing', () => {
    expect(estimateDaySpend({}).totalLow).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 8 · Alarms
 * ------------------------------------------------------------------ */

test.describe('alarms', () => {
  const healthy = {
    nightly: { conclusion: 'success', durationMin: 24, url: 'https://example.invalid/run' },
    anthropic: { creditBalance: 0, invalidRequestOther: 0 },
    newsdesk: { t3: { batched: 25, resolved: 8, runs: 1 } },
    ci: { latest: 'success', consecutiveRed: 0, redForHours: null },
    cursor: { frozen: false, lastSyncAgeDays: 0.2 },
    floorSignals: { pastAlarm: false, ageHours: 3, alarmHours: FLOOR_SIGNAL_ALARM_HOURS },
  };

  test('a clean pipeline raises nothing', () => {
    expect(alarms(healthy)).toEqual([]);
  });

  test('a cursor that is behind but advancing raises nothing', () => {
    // Lateness is check-cursor-age.mjs's business (10-day ceiling), not a ⛔
    // here. Raising one daily for a backlog that is draining on schedule is
    // how an owner learns to scroll past this issue.
    expect(alarms({ ...healthy, cursor: { frozen: false, behind: true, moved: true, lastSyncAgeDays: 4.6 } })).toEqual(
      []
    );
  });

  test('every ⛔ condition in the contract fires', () => {
    const codes = (r: object) => alarms(r).map((a) => a.code);
    expect(codes({ ...healthy, nightly: { conclusion: 'failure' } })).toContain('nightly-not-success');
    expect(codes({ ...healthy, nightly: null })).toContain('nightly-missing');
    expect(codes({ ...healthy, nightly: { conclusion: 'cancelled' } })).toContain('nightly-not-success');
    expect(codes({ ...healthy, anthropic: { creditBalance: 12, invalidRequestOther: 0 } })).toContain(
      'anthropic-credit'
    );
    expect(codes({ ...healthy, newsdesk: { t3: { batched: 25, resolved: 0, runs: 1 } } })).toContain('t3-zero');
    expect(codes({ ...healthy, ci: { latest: 'failure', consecutiveRed: 9, redForHours: 100 } })).toContain(
      'ci-red-24h'
    );
    expect(codes({ ...healthy, cursor: { frozen: true, lastSyncAgeDays: 10 } })).toContain('cursor-frozen');
    expect(codes({ ...healthy, cursor: { frozen: false, movementUnknown: true, lastSyncAgeDays: 10 } })).toContain(
      'cursor-movement-unknown'
    );
    expect(codes({ ...healthy, floorSignals: { pastAlarm: true, ageHours: 40, alarmHours: 36 } })).toContain(
      'floor-signals-stale'
    );
  });

  test('a nightly still in flight is not an alarm', () => {
    // The digest fires at 13:00 UTC and the nightly's cron is 14:15 UTC, so
    // they normally never overlap — but a queued runner can make them, and a
    // run with no verdict yet is a scheduling coincidence, not a fault.
    expect(alarms({ ...healthy, nightly: { conclusion: 'still running', running: true } })).toEqual([]);
  });

  test('t3 resolving none of NOTHING is not an alarm', () => {
    // A quiet hour with no ambiguous headlines resolves 0 of 0 and is fine.
    // Only 0 of a non-zero batch means the matcher came back empty-handed.
    expect(alarms({ ...healthy, newsdesk: { t3: { batched: 0, resolved: 0, runs: 3 } } })).toEqual([]);
  });

  test('CI red for under a day is reported but not alarmed', () => {
    // One red run is a PR to fix, not a morning interruption.
    expect(alarms({ ...healthy, ci: { latest: 'failure', consecutiveRed: 1, redForHours: 4 } })).toEqual([]);
  });

  test('deliberately NOT alarms: portrait 404s, cache fail-opens, coverage staleness', () => {
    // Each is a known, owner-acknowledged state tracked as a number in the
    // body. Promoting one to a daily notification would train the owner to
    // ignore the notification.
    expect(
      alarms({ ...healthy, portrait404s: 15, upstashCacheFailures: 120, coverage: { sharePct: 91.5 } })
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 9 · Rendering
 * ------------------------------------------------------------------ */

test.describe('formatHealthSection', () => {
  test('renders an absent reading as "not found", never as a number', () => {
    // THE central rule of this file. An empty report must read as "we could
    // not measure", not as "everything is zero".
    const rendered = formatHealthSection({});
    expect(rendered).toContain('not found');
    expect(rendered).toContain('no recent run');
    expect(rendered).toContain('not found in the log');
  });

  test('says so out loud when the per-run log cap truncated the counters', () => {
    const rendered = formatHealthSection({ logsRead: 16, logsSkipped: 9 });
    expect(rendered).toContain('9 SKIPPED');
    expect(rendered).toContain('partial');
  });

  test('a clean day states that it is clean rather than staying silent', () => {
    expect(formatHealthSection({ alarms: [] })).toContain('✅ No ⛔ conditions.');
  });

  test('every alarm reaches the reader', () => {
    const rendered = formatHealthSection({ alarms: [{ code: 'x', text: 'the roof is on fire' }] });
    expect(rendered).toContain('⛔ the roof is on fire');
  });

  test('the spend figure always carries its "estimate, not a bill" disclaimer', () => {
    expect(formatHealthSection({})).toContain('ESTIMATE');
    expect(formatHealthSection({})).toContain('Anthropic console');
  });

  test('when Anthropic errors exist, the section names which workflow produced them', () => {
    const rendered = formatHealthSection({
      anthropic: {
        creditBalance: 7,
        invalidRequestOther: 1,
        byWorkflow: { 'Nightly bill sync': { creditBalance: 7, invalidRequestOther: 1 } },
      },
    });
    expect(rendered).toContain('Nightly bill sync');
  });
});

test.describe('the standing issue', () => {
  test('one fixed title and label — the find-or-create key', () => {
    expect(HEALTH_ISSUE_TITLE).toBe('🩺 Pipeline health');
    expect(HEALTH_ISSUE_LABEL).toBe('pipeline-health');
  });

  test('the body says plainly that nothing here is a gate', () => {
    // Guarding against a future reader mistaking a report for an enforcement
    // point and moving a real gate into it.
    const body = formatHealthIssueBody({ generatedAt: '2026-09-18T13:00:00Z' });
    expect(body).toContain('read-only report');
    expect(body).toContain('verify-sync.mjs');
    expect(body).toContain('check-cursor-age.mjs');
  });

  test('the dated comment carries a date marker, so a re-run cannot double it', () => {
    const comment = formatHealthAlarmComment({
      date: '2026-09-18',
      alarms: [{ code: 'x', text: 'something broke' }],
      runUrl: undefined,
    });
    expect(comment).toContain('<!-- pipeline-health:2026-09-18 -->');
    expect(comment).toContain('- something broke');
  });
});

/* ------------------------------------------------------------------ *
 * 10 · Workflow wiring
 * ------------------------------------------------------------------ */

test.describe('daily-metrics.yml', () => {
  const wf = readFileSync(join(process.cwd(), '.github/workflows/daily-metrics.yml'), 'utf8');

  test('grants actions: read — without it the whole report reads nothing', () => {
    expect(wf).toMatch(/permissions:[\s\S]*?actions: read/);
  });

  test('checks out enough history for the corpus/coverage deltas to resolve', () => {
    // A depth-1 checkout leaves both deltas permanently "not found".
    expect(wf).toMatch(/fetch-depth: \d+/);
    const depth = Number.parseInt(wf.match(/fetch-depth: (\d+)/)?.[1] ?? '1', 10);
    expect(depth).toBeGreaterThan(1);
  });

  test('upserts the pipeline-health label the standing issue needs', () => {
    expect(wf).toContain(`gh label create ${HEALTH_ISSUE_LABEL}`);
  });

  test('the secrets-health step is dispatch-gated and off by default', () => {
    expect(wf).toContain("github.event_name == 'workflow_dispatch' && inputs.secrets_health");
    expect(wf).toMatch(/secrets_health:[\s\S]*?default: false/);
  });

  test('the secrets-health step can print a status and a host fragment, and nothing else', () => {
    const step = wf.slice(wf.indexOf('Secrets health'));
    // The body goes to /dev/null and only %{http_code} is written out, so no
    // reply text can reach the log.
    expect(step).toContain("-o /dev/null -w '%{http_code}'");
    expect(step).toContain('cut -c1-8');
    // No echo of a URL or a token variable anywhere in the step.
    expect(step).not.toMatch(/echo[^\n]*\$\{?(COUNTERS|CACHE|TENANCY)_(URL|TOKEN)/);
    expect(step).not.toMatch(/printf[^\n]*\$\{?(COUNTERS|CACHE|TENANCY)_TOKEN/);
  });

  test('the page-view disclaimer no longer claims no programmatic source exists', () => {
    // Corrected 2026-09-18: `vercel metrics --format json` exists. The ban on
    // @vercel/analytics is unchanged and is still the honest reason.
    expect(wf).not.toContain('has no REST API — dashboard/CSV-export only');
    expect(wf).toContain('vercel metrics');
    expect(wf).toContain('@vercel/analytics');
  });
});

test('the digest body carries the corrected page-view disclaimer too', () => {
  const traffic = readFileSync(join(process.cwd(), 'lib/traffic-metrics.mjs'), 'utf8');
  expect(traffic).toContain('vercel metrics');
  expect(traffic).toContain('does not read it yet');
});
