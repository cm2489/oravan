import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { alarms, parseShortTitlesTrouble, shortTitlesSummaryExpected } from '../lib/pipeline-health.mjs';
import { readTitlesAnswer, serializeShortTitles } from '../lib/short-titles.mjs';
import { Refused, runShortTitlesNight, settleNight, stopReason, TransportFailure, verifyShortTitlesFiles } from '../lib/short-titles-night.mjs';
import {
  FALL_MIN,
  LOST_TONIGHT_ALARM,
  nextTrend,
  nightSummary,
  parseShortTitlesSummary,
  serializeTrend,
  shortTitlesAlarms,
  shortTitlesStepStarted,
  STALE_READ_DAYS,
  summaryLine,
  TREND_NIGHTS,
  trendAgo,
  trendFileWarnings,
  trendHasNights,
  verifyShortTitlesTrend,
} from '../lib/short-titles-summary.mjs';

/*
 * THE STATE-BASED SAFETY NET (2026-11-17; the owner's card 194, Nov 15, 2026,
 * option a): one summary line a night, a 14-night history, and four checks in
 * the daily health report. The reviewer's scenarios, driven night by night
 * with the network stubbed, through the same functions the script runs
 * (runShortTitlesNight, settleNight, nightSummary, summaryLine), and read back
 * the way the health report reads them (parseShortTitlesSummary, alarms).
 */

const LIVE = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/congress-gov-titles-hr-9770-119.json'), 'utf8'));
const OFFICIAL = LIVE.titles.filter((t: { titleType: string }) => !/^Short/.test(t.titleType));
type Bill = { bill_type: string; bill_number: number; congress_number: number; last_action_date: string; urgency_score: number };
const bill = (n: number, last = '2026-10-01', urgency = 0.5): Bill => ({ bill_type: 'hr', bill_number: n, congress_number: 119, last_action_date: last, urgency_score: urgency });
const slug = (n: number) => `hr-${n}-119`;
const range = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);
const day = (start: string, plus: number) => new Date(Date.parse(`${start}T00:00:00Z`) + plus * 86_400_000).toISOString().slice(0, 10);
/** 40% of bills carry a short title in the record. */
const isTitled = (n: number) => n % 5 < 2;

function answer(n: number, shortType = 'Short Title(s) as Introduced') {
  const titles = [...OFFICIAL, ...(isTitled(n) ? [{ title: `Fixture hr${n} Act`, titleType: shortType, titleTypeCode: 101, updateDate: 'x' }] : [])];
  return { pagination: { count: titles.length }, request: { billNumber: String(n), billType: 'hr', congress: '119' }, titles };
}

type State = { file: Record<string, { titles: string[]; as_of: string | null; read_on: string }>; retry: Record<string, unknown>; trend: { nights: Array<{ day: string; titled: number; bills: number; allow_drop?: true }> } };

/** An established corpus: every bill read, reads spread over the last 56 days, a steady 14-night history. */
function established(bills: Bill[], start: string, skip: Set<number> = new Set()): State {
  const file: State['file'] = {};
  for (const b of bills) {
    if (skip.has(b.bill_number)) continue;
    file[slug(b.bill_number)] = { titles: isTitled(b.bill_number) ? [`Fixture hr${b.bill_number} Act`] : [], as_of: b.last_action_date, read_on: day(start, -1 - (b.bill_number % 56)) };
  }
  const titledNow = Object.values(file).filter((e) => e.titles.length > 0).length;
  let trend: State['trend'] = { nights: [] };
  for (let i = TREND_NIGHTS; i >= 1; i--) trend = nextTrend(trend, { day: day(start, -i), titled: titledNow, bills: bills.length });
  return { file, retry: {}, trend };
}

/** One night, exactly as the script runs it, with the summary read back the way the health report reads it. */
async function oneNight(state: State, bills: Bill[], today: string, fetchPage: (b: { bill_number: number }, offset: number) => Promise<unknown>, allowDrop = false) {
  const night = await runShortTitlesNight({ bills, file: state.file, retry: state.retry, today, fetchPage });
  const settled = settleNight({ night, bills, before: Object.keys(state.file).length ? state.file : null, allowDrop });
  const titlesAfter = settled.write?.titles ? JSON.parse(settled.write.text) : state.file;
  const retryAfter = settled.write ? JSON.parse(settled.write.retryText) : state.retry;
  const used = Boolean(settled.write && settled.overrideUsed);
  const fields = nightSummary({ day: today, bills, titles: titlesAfter, retry: retryAfter, trend: state.trend, read: night.read, lost: night.dropped, allowDrop: used });
  state.file = titlesAfter;
  state.retry = retryAfter;
  state.trend = nextTrend(state.trend, { day: today, titled: fields.titled, bills: bills.length, allow_drop: used });
  const log = [
    ...settled.troubles.map((t) => `SHORT TITLES TROUBLE: ${t.reason}`),
    summaryLine({ ...fields, outcome: 'done' }),
  ].join('\n');
  const summary = parseShortTitlesSummary(log);
  return { night, settled, summary, log };
}

/** The four new checks' codes for a night's summary. */
const newAlarms = (summary: unknown, disable: string[] = []) => shortTitlesAlarms(summary as Record<string, unknown>, { checked: true, disable }).map((a) => a.code);

// --- the line, the history, the checks --------------------------------------------------

test('the summary line round-trips, unknowns included, through the parser the health report uses', () => {
  const line = summaryLine({ day: '2026-11-17', outcome: 'done', titled: 1333, titled_7_nights_ago: null, bills: 3322, newest_read_on: '2026-11-17', retry: 15, read_tonight: 82, lost_all_titles_tonight: 0 });
  expect(line).toBe(
    'SHORT TITLES SUMMARY: day=2026-11-17 outcome=done titled=1333 titled_7_nights_ago=unknown bills_7_nights_ago=unknown day_7_nights_ago=unknown bills=3322 newest_read_on=2026-11-17 retry=15 read_tonight=82 lost_all_titles_tonight=0 drop_approved_on=unknown unread=unknown',
  );
  const actionsLog = `nightly\tRead the record's short titles\t2026-11-17T14:40:00.0Z ${line}`;
  expect(parseShortTitlesSummary(actionsLog)).toEqual({
    day: '2026-11-17', outcome: 'done', titled: 1333, titled_7_nights_ago: null, bills_7_nights_ago: null, day_7_nights_ago: null, bills: 3322, newest_read_on: '2026-11-17', retry: 15, read_tonight: 82, lost_all_titles_tonight: 0, drop_approved_on: null, unread: null,
  });
  expect(parseShortTitlesSummary('nothing here')).toBeNull();
});

test('the history keeps one entry a day, the last 14, and finds "a week ago"; its gate refuses a damaged file', () => {
  let trend = { nights: [] as Array<{ day: string; titled: number; bills: number }> };
  for (let i = 0; i < 20; i++) trend = nextTrend(trend, { day: day('2026-11-01', i), titled: 100 + i, bills: 300 });
  trend = nextTrend(trend, { day: day('2026-11-01', 19), titled: 999, bills: 999 }); // the same day again replaces it
  expect(trend.nights).toHaveLength(TREND_NIGHTS);
  expect(trend.nights[trend.nights.length - 1]).toEqual({ day: '2026-11-20', titled: 999, bills: 999 });
  expect(trendAgo(trend, '2026-11-20')).toEqual({ day: '2026-11-13', titled: 112, bills: 300 });
  expect(trendAgo({ nights: [] }, '2026-11-20')).toBeNull();
  expect(verifyShortTitlesTrend({ data: trend }).failures).toEqual([]);
  for (const bad of [[], { nights: 'x' }, { nights: [{ day: 'x', titled: 1, bills: 1 }] }, { nights: [{ day: '2026-11-02', titled: 1, bills: 1 }, { day: '2026-11-01', titled: 1, bills: 1 }] }, { nights: [{ day: '2026-11-01', titled: 5, bills: 1 }] }, { nights: [], extra: 1 }]) {
    expect(verifyShortTitlesTrend({ data: bad }).failures.length, JSON.stringify(bad)).toBeGreaterThan(0);
  }
});

test('each check fires on its own input, in plain words, and none on an ordinary night', () => {
  const ordinary = { day: '2026-11-17', titled: 1340, titled_7_nights_ago: 1320, bills_7_nights_ago: 3300, bills: 3322, newest_read_on: '2026-11-17', lost_all_titles_tonight: 1 };
  expect(newAlarms(ordinary)).toEqual([]);
  expect(newAlarms(null)).toEqual(['short-titles-summary-missing']);
  expect(shortTitlesAlarms(null, { checked: false })).toEqual([]);
  expect(newAlarms({ ...ordinary, titled: 1290 })).toEqual(['short-titles-falling']); // 30 > max(10, 27)
  expect(newAlarms({ ...ordinary, titled: 1294 })).toEqual([]); // 26: not more than 27
  expect(newAlarms({ ...ordinary, lost_all_titles_tonight: LOST_TONIGHT_ALARM })).toEqual(['short-titles-lost-tonight']);
  expect(newAlarms({ ...ordinary, lost_all_titles_tonight: LOST_TONIGHT_ALARM - 1 })).toEqual([]);
  expect(newAlarms({ ...ordinary, newest_read_on: day('2026-11-17', -(STALE_READ_DAYS + 1)) })).toEqual(['short-titles-not-read']);
  expect(newAlarms({ ...ordinary, newest_read_on: day('2026-11-17', -STALE_READ_DAYS) })).toEqual([]);
  // A small corpus: the floor is FALL_MIN.
  expect(newAlarms({ ...ordinary, titled_7_nights_ago: 100, titled: 100 - FALL_MIN - 1, bills_7_nights_ago: 3322 })).toEqual(['short-titles-falling']);
  // Bills that left the corpus are not a fall.
  expect(newAlarms({ ...ordinary, titled_7_nights_ago: 200, titled: 176, bills_7_nights_ago: 200, bills: 176 })).toEqual([]);
  // Each alarm, its own code, in plain words, ending with the runbook section, which exists and names the code.
  const runbook = readFileSync(join(process.cwd(), 'docs/runbooks/new-congress-switch.md'), 'utf8');
  const all = [...shortTitlesAlarms({ ...ordinary, titled: 1000, lost_all_titles_tonight: 50, newest_read_on: '2026-11-01' }), ...shortTitlesAlarms(null)];
  expect(new Set(all.map((a) => a.code)).size).toBe(4);
  for (const a of all) {
    expect(a.text.length).toBeGreaterThan(60);
    expect(a.text).not.toMatch(/undefined|NaN|null/);
    const section = /section "([^"]+)"$/.exec(a.text)?.[1];
    expect(section, a.code).toBe('The nightly summary line and the four state alarms');
    expect(runbook).toContain(`### ${section}`);
    expect(runbook).toContain(`| \`${a.code}\` |`);
  }
});

test('(2) the step skipped or killed: the health report alarms that morning; with no nightly log read, it claims nothing', () => {
  const log = 'nightly\tSync bills\t2026-11-17T14:20:00.0Z DONE: 340 refreshed\n(no short-titles step ran)';
  // The step was expected (round 6: its run line was in the log, or the history held a night).
  const report = { nightly: { conclusion: 'success' }, shortTitlesSummaryChecked: true, shortTitlesSummaryExpected: true, shortTitlesSummary: parseShortTitlesSummary(log) };
  expect(alarms(report).map((a) => a.code)).toContain('short-titles-summary-missing');
  expect(alarms({ nightly: { conclusion: 'success' }, shortTitlesSummaryChecked: false, shortTitlesSummary: null }).map((a) => a.code)).not.toContain('short-titles-summary-missing');
  // The report reads the line from the same nightly log as every other nightly counter.
  const script = readFileSync(join(process.cwd(), 'scripts/pipeline-health.mjs'), 'utf8');
  const block = script.slice(script.indexOf('const nightlyLog = pickNightlyLog(nightlyReads);'), script.indexOf('pregen = parsePregen(log);'));
  expect(block).toContain('shortTitlesSummary = parseShortTitlesSummary(log);');
  expect(block).toContain('shortTitlesSummaryChecked = true;');
  expect(block).toContain('shortTitlesSummaryExpectedHere = shortTitlesSummaryExpected({');
  expect(block).toContain("trendText: existsSync(SHORT_TITLES_TREND_PATH) ? readFileSync(SHORT_TITLES_TREND_PATH, 'utf8') : null,");
  expect(script).toContain('shortTitlesSummaryExpected: shortTitlesSummaryExpectedHere,');
});

test('F1: "the source has changed" from ANY trouble line, every distinct reason carried (bounded)', () => {
  const log = [
    'SHORT TITLES TROUBLE: the source has changed: 300 of 300 answers tonight from bills not already retrying were refused for the same reason ("x")',
    'SHORT TITLES TROUBLE: 600 of 3322 bills are waiting to be read again (more than 333); the most common reason is "x"',
    'SHORT TITLES TROUBLE: 600 of 3322 bills are waiting to be read again (more than 333); the most common reason is "x"',
  ].join('\n');
  const parsed = parseShortTitlesTrouble(log)!;
  expect(parsed.sourceChanged).toBe(true);
  expect(parsed.reasons).toHaveLength(2);
  expect(parsed.text).toContain('the source has changed');
  expect(parsed.text).toContain('waiting to be read again');
  expect(alarms({ nightly: { conclusion: 'success' }, shortTitlesTrouble: parsed }).map((a) => a.code)).toContain('short-titles-source-changed');
  const many = range(9).map((i) => `SHORT TITLES TROUBLE: reason ${i}`).join('\n');
  expect(parseShortTitlesTrouble(many)!.text).toMatch(/^reason 1 \| reason 2 \| reason 3 \| reason 4 \| and 5 more$/);
});

test('F4: a retry entry dated after today is due now, said once', async () => {
  const bills = range(3).map((n) => bill(n));
  const night = await runShortTitlesNight({
    bills,
    file: {},
    retry: { [slug(2)]: { failures: 4, last_tried: '2027-06-01', reason: 'HTTP 404' } },
    today: '2026-11-17',
    fetchPage: async (b: { bill_number: number }) => answer(b.bill_number),
  });
  expect(night.read).toBe(3);
  expect(night.lines.filter((l: string) => /dated after today; treated as due now/.test(l))).toHaveLength(1);
});

// --- the reviewer's scenarios -----------------------------------------------------------

test('(1) Congress.gov renames its short-title type on a 3,322-bill corpus: an alarm within 3 nights by (c), and within 7 by (b) alone', async () => {
  for (const disable of [[], ['short-titles-lost-tonight']]) {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const START = '2027-03-01';
    const bills = range(3322).map((n) => bill(n, '2027-01-15', rand()));
    const state = established(bills, START);
    expect(state.trend.nights).toHaveLength(TREND_NIGHTS);
    const renamed = async (b: { bill_number: number }) => answer(b.bill_number, 'Title (Short) as Introduced');
    let firstAlarm: { night: number; codes: string[] } | null = null;
    for (let i = 0; i < 7 && !firstAlarm; i++) {
      const today = day(START, i);
      for (let k = 0; k < 60; k++) bills[Math.floor(rand() * bills.length)].last_action_date = today;
      const { summary, settled } = await oneNight(state, bills, today, renamed);
      expect(settled.troubles, 'no event-based TROUBLE line catches this').toEqual([]);
      const codes = newAlarms(summary, disable);
      if (codes.length) firstAlarm = { night: i + 1, codes };
    }
    expect(firstAlarm, `disabled: ${disable.join() || 'none'}`).not.toBeNull();
    if (disable.length === 0) {
      expect(firstAlarm!.night).toBeLessThanOrEqual(3);
      expect(firstAlarm!.codes).toContain('short-titles-lost-tonight');
    } else {
      expect(firstAlarm!.night).toBeLessThanOrEqual(7);
      expect(firstAlarm!.codes).toEqual(['short-titles-falling']);
    }
  }
});

test('(3) 365 ordinary nights: 15 bills that always 404, 10 new and 60 moved a day, an outage night now and then: no alarm from the new checks, and the true refresh bound', async () => {
  test.setTimeout(240_000);
  let seed = 99;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const START = '2027-02-01';
  const bad = new Set(range(15, 90001));
  const bills: Bill[] = range(3000).map((n) => bill(n, '2027-01-10', rand()));
  const state = established(bills, START);
  for (const n of bad) bills.push(bill(n, '2027-01-10', rand())); // the bad ones arrive new, never read
  let next = 50001; // record bill numbers have at most 5 digits
  const outageNights = new Set([20, 61, 102, 143, 184, 225, 266, 307, 348]);
  const outage = async () => {
    throw new TransportFailure('HTTP 503');
  };
  const ok = async (b: { bill_number: number }) => {
    if (bad.has(b.bill_number)) throw new Refused('HTTP 404');
    return answer(b.bill_number);
  };
  const falseAlarms: string[] = [];
  const troubleNights: number[] = [];
  let maxGap = 0;
  for (let i = 0; i < 365; i++) {
    const today = day(START, i);
    for (let k = 0; k < 10; k++) bills.push(bill(next++, today, rand()));
    for (let k = 0; k < 60; k++) bills[Math.floor(rand() * bills.length)].last_action_date = today;
    const previous = new Map(Object.entries(state.file).map(([k, v]) => [k, v.read_on]));
    const { summary, settled } = await oneNight(state, bills, today, outageNights.has(i) ? outage : ok);
    for (const code of newAlarms(summary)) falseAlarms.push(`night ${i + 1}: ${code}`);
    for (const f of settled.failures) falseAlarms.push(`night ${i + 1}: gate refused: ${f}`);
    if (settled.troubles.length) troubleNights.push(i);
    for (const [k, v] of Object.entries(state.file)) {
      const was = previous.get(k);
      if (was && v.read_on !== was) maxGap = Math.max(maxGap, Math.round((Date.parse(`${v.read_on}T00:00:00Z`) - Date.parse(`${was}T00:00:00Z`)) / 86_400_000));
    }
  }
  expect(falseAlarms).toEqual([]);
  // Only the outage nights printed a TROUBLE line (the breaker), an event the existing alarm reports.
  expect(troubleNights).toEqual([...outageNights].sort((a, b) => a - b));
  // THE TRUE REFRESH BOUND: due 56 days after a read, read on the 57th when an outage fell on the night it came due.
  test.info().annotations.push({ type: 'longest gap between reads (days)', description: String(maxGap) });
  expect(maxGap).toBe(57);
});

test('(4) the 12-night first fill (titled rising from 0): no alarm on any night', async () => {
  const bills = range(3322).map((n) => bill(n, '2027-01-10', (n % 97) / 97));
  const state: State = { file: {}, retry: {}, trend: { nights: [] } };
  const fired: string[] = [];
  for (let i = 0; i < 12; i++) {
    const { summary, settled } = await oneNight(state, bills, day('2027-04-01', i), async (b: { bill_number: number }) => answer(b.bill_number));
    for (const code of newAlarms(summary)) fired.push(`night ${i + 1}: ${code}`);
    expect(settled.troubles).toEqual([]);
  }
  expect(fired).toEqual([]);
  expect(Object.keys(state.file)).toHaveLength(3322);
});

test('(5) 24 of 200 titled bills leave the corpus: no stall, no alarm; the script path and verify-sync agree (F2)', async () => {
  const START = '2027-05-01';
  const all = range(200).map((n) => bill(n * 5)); // every bill number a multiple of 5: all titled
  const state = established(all, START);
  const bills = all.slice(24);
  // The same input through both gates: the step's settleNight and verify-sync's verifyShortTitlesFiles.
  const before = state.file;
  const night = await runShortTitlesNight({ bills, file: before, retry: {}, today: START, fetchPage: async (b: { bill_number: number }) => answer(b.bill_number) });
  const settled = settleNight({ night, bills, before });
  expect(settled.failures).toEqual([]);
  expect(settled.troubles).toEqual([]);
  const precommit = verifyShortTitlesFiles({ titles: JSON.parse(serializeShortTitles(night.file as State['file'], bills)), retry: JSON.parse(settled.write!.retryText), trendText: serializeTrend(state.trend), bills, before });
  expect(precommit.failures).toEqual([]);
  // And a committed file still holding the 24 (a night that read nothing) passes both, as a note.
  const stale = verifyShortTitlesFiles({ titles: before, retry: {}, trendText: serializeTrend(state.trend), bills, before });
  expect(stale.failures).toEqual([]);
  expect(stale.notes.join('\n')).toContain('no longer holds');
  // The other way round: entries for bills no longer in the corpus do not hide a real drop among the bills it holds.
  const held = range(30).map((n) => bill(n * 5));
  const gone = range(30, 1000).map((n) => n * 5);
  const masked = Object.fromEntries([
    ...held.map((b) => [slug(b.bill_number), { titles: [], as_of: b.last_action_date, read_on: START }]),
    ...gone.map((n) => [slug(n), { titles: [`Fixture hr${n} Act`], as_of: '2026-10-01', read_on: START }]),
  ]);
  const heldBefore = Object.fromEntries(held.map((b) => [slug(b.bill_number), { titles: [`Fixture hr${b.bill_number} Act`], as_of: b.last_action_date, read_on: START }]));
  expect(verifyShortTitlesFiles({ titles: masked, retry: null, trendText: null, bills: held, before: heldBefore }).failures.join('\n')).toContain('bills with a short title fell 30 -> 0');
  // Eight nights on: no alarm.
  for (let i = 0; i < 8; i++) {
    const { summary, settled: s } = await oneNight(state, bills, day(START, i), async (b: { bill_number: number }) => answer(b.bill_number));
    expect(s.troubles).toEqual([]);
    expect(newAlarms(summary), `night ${i + 1}`).toEqual([]);
  }
});

test('(6) a reshaped source for 5 nights: the alarm code stays "source changed" every night', async () => {
  const bills = range(3322).map((n) => bill(n, '2027-01-10', (n % 89) / 89));
  const state = established(bills, '2027-06-01');
  const reshaped = async (b: { bill_number: number }) => ({ request: { billNumber: String(b.bill_number), billType: 'hr', congress: '119' }, data: { titles: [] } });
  for (let i = 0; i < 5; i++) {
    // Bills keep moving, so each night has fresh answers to judge.
    for (let k = 0; k < 400; k++) bills[(i * 400 + k) % bills.length].last_action_date = day('2027-06-01', i);
    const { log } = await oneNight(state, bills, day('2027-06-01', i), reshaped);
    const codes = alarms({ nightly: { conclusion: 'success' }, shortTitlesTrouble: parseShortTitlesTrouble(log) }).map((a) => a.code);
    expect(codes, `night ${i + 1}`).toContain('short-titles-source-changed');
  }
});

test('the per-title check refuses what the gate would refuse (unchanged by this round)', () => {
  expect(readTitlesAnswer({ ...answer(1), titles: [...OFFICIAL, { title: 'Bad\tAct', titleType: 'Short Title(s) as Introduced' }], pagination: { count: OFFICIAL.length + 1 } }, bill(1)).ok).toBe(false);
});

// --- round 6 (the fifth independent check; the owner's card 195, Nov 17, 2026) ---------

/*
 * THE FALSE ALARM. A cut of the REAL log of nightly run 43978722399 (Nov 16,
 * 2026), read with `gh run view --log`: every line begins
 * "sync<TAB>UNKNOWN STEP<TAB><timestamp> ", a byte-order mark sits inside the
 * first line just before its timestamp, and a step begins with its run line
 * ("##[group]Run node scripts/…"). That nightly ran before the short-titles
 * step existed, as the first nightly a report reads after the merge will.
 */
const REAL = readFileSync(join(process.cwd(), 'tests/fixtures/nightly-log-43978722399-cut.txt'), 'utf8');
const RUN_LINE = 'sync\tUNKNOWN STEP\t2026-11-16T23:28:54.5300000Z ##[group]Run node scripts/sync-short-titles.mjs';
const summaryAlarms = (log: string, trendText: string | null) =>
  alarms({
    nightly: { conclusion: 'success' },
    shortTitlesSummaryChecked: true,
    shortTitlesSummary: parseShortTitlesSummary(log),
    shortTitlesSummaryExpected: shortTitlesSummaryExpected({ log, trendText }),
  })
    .map((a) => a.code)
    .filter((c) => c.startsWith('short-titles-'));

test('round 6, the real log shape: tab-prefixed lines, a byte-order mark before the first timestamp, step run lines', () => {
  const lines = REAL.split('\n').filter(Boolean);
  for (const l of lines) expect(l).toMatch(/^sync\tUNKNOWN STEP\t(?:﻿)?\d{4}-\d{2}-\d{2}T[\d:.]+Z /);
  expect(lines[0]).toContain('\tUNKNOWN STEP\t﻿2026-11-16T23:22:33');
  expect(lines.some((l) => l.endsWith('##[group]Run node scripts/sync-votes.mjs'))).toBe(true);
  expect(REAL).not.toMatch(/SHORT TITLES|sync-short-titles/);
  // Nothing secret travels in the fixture.
  expect(REAL).not.toMatch(/_KEY|TOKEN|credentials|\*\*\*/i);
});

test('round 6 (1): the pre-change log raises nothing; with the step’s run line and no summary it raises; a history with one night raises; an ordinary night raises nothing', () => {
  // The log of a nightly from before the step: no alarm (the fifth check's false ⛔).
  expect(shortTitlesStepStarted(REAL)).toBe(false);
  expect(summaryAlarms(REAL, null)).toEqual([]);
  expect(summaryAlarms(REAL, '{\n "nights": []\n}\n')).toEqual([]);
  // The same log with the step's run line in the real shape and no summary: the step started and printed nothing.
  const started = REAL.replace('\n', `\n${RUN_LINE}\n`);
  expect(shortTitlesStepStarted(started)).toBe(true);
  expect(summaryAlarms(started, null)).toEqual(['short-titles-summary-missing']);
  // The run line as the very first line, behind the byte-order mark, is still read.
  expect(shortTitlesStepStarted(RUN_LINE.replace('\t2026', '\t﻿2026'))).toBe(true);
  // A history holding one night and a log with no short-titles line at all (step removed, skipped, or crashed at import).
  const oneNight = serializeTrend({ nights: [{ day: '2026-11-17', titled: 1200, bills: 3322 }] });
  expect(trendHasNights(oneNight)).toBe(true);
  expect(summaryAlarms(REAL, oneNight)).toEqual(['short-titles-summary-missing']);
  // A damaged history proves nothing by itself (the step will restart it).
  expect(trendHasNights('{"nights":"x"}')).toBe(false);
  expect(trendHasNights('not json')).toBe(false);
  // An ordinary night: the run line and a summary line in the real shape: nothing.
  const summary = summaryLine({
    day: '2026-11-18', outcome: 'done', titled: 1210, titled_7_nights_ago: 1190, bills_7_nights_ago: 3300, day_7_nights_ago: '2026-11-11',
    bills: 3322, newest_read_on: '2026-11-18', retry: 12, read_tonight: 80, lost_all_titles_tonight: 0, drop_approved_on: null,
  });
  const ordinary = `${started}sync\tUNKNOWN STEP\t2026-11-16T23:29:10.0000000Z ${summary}\n`;
  expect(summaryAlarms(ordinary, oneNight)).toEqual([]);
});

test('round 6 (2): no state of the history file fails the nightly’s pre-commit check; each is a warning, and a good one is silent', () => {
  const corpus = range(3).map((n) => bill(n));
  const states: Array<[string, string]> = [
    ['not JSON', '{"nights": ['],
    ['a list', '[]'],
    ['nights not a list', '{"nights":"x"}'],
    ['an extra key', '{"nights":[],"x":1}'],
    ['an entry with a stray field', '{"nights":[{"day":"2026-11-17","titled":1,"bills":2,"note":"x"}]}'],
    ['more titled than bills', '{"nights":[{"day":"2026-11-17","titled":3,"bills":2}]}'],
    ['days out of order', '{"nights":[{"day":"2026-11-17","titled":1,"bills":2},{"day":"2026-11-16","titled":1,"bills":2}]}'],
    ['too many nights', serializeTrend({ nights: range(20).map((i) => ({ day: day('2026-10-01', i), titled: 1, bills: 2 })) })],
    ['empty bytes', ''],
  ];
  for (const [label, text] of states) {
    const v = verifyShortTitlesFiles({ titles: null, retry: null, trendText: text, bills: corpus, before: null });
    expect(v.failures, label).toEqual([]);
    expect(v.warnings.length, label).toBeGreaterThan(0);
    expect(v.warnings.join(' '), label).toContain('starts the 14-night history afresh on its next run');
  }
  const good = serializeTrend({ nights: [{ day: '2026-11-16', titled: 1, bills: 3 }, { day: '2026-11-17', titled: 1, bills: 3, allow_drop: true }] });
  expect(verifyShortTitlesFiles({ titles: null, retry: null, trendText: good, bills: corpus, before: null })).toEqual({ failures: [], notes: [], warnings: [] });
  expect(trendFileWarnings(null)).toEqual([]);
  // verify-sync reads the raw bytes (never through `parse`, which fails the run) and only warns.
  const verify = readFileSync(join(process.cwd(), 'scripts/verify-sync.mjs'), 'utf8');
  const block = verify.slice(verify.indexOf('// --- short-titles:'), verify.indexOf('// --- question-press'));
  expect(block).toContain("trendText: existsSync(SHORT_TITLES_TREND_PATH) ? readFileSync(SHORT_TITLES_TREND_PATH, 'utf8') : null,");
  expect(block).toContain('for (const w of warnings) warn(w);');
  expect(block).not.toMatch(/readIf\(SHORT_TITLES_TREND_PATH\)/);
});

test('round 6 (2): CI refuses a damaged history in a pull request, accepts a good one, and its gate reads no clock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-short-titles-'));
  try {
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data/bills.json'), JSON.stringify([bill(1)]));
    const run = (text: string) => {
      writeFileSync(join(dir, 'data/short-titles-trend.json'), text);
      return spawnSync(process.execPath, [join(process.cwd(), 'scripts/check-short-titles.mjs')], { cwd: dir, encoding: 'utf8', env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '' } });
    };
    expect(run(serializeTrend({ nights: [{ day: '2026-11-17', titled: 1, bills: 1 }] })).status).toBe(0);
    const bad = run('{"nights":[{"day":"2026-11-17","titled":2,"bills":1}]}');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('short-titles-trend.json');
    expect(run('{"nights": [').status).toBe(1);
    // A valid retry file beside the history (the nightly writes one whenever a bill fails, so it is the usual
    // state): a damaged history is still refused, and a good one still passes.
    writeFileSync(join(dir, 'data/short-titles-retry.json'), '{}');
    for (const damaged of ['', '{"nights": [', '[]', '{"nights":[{"day":"2026-11-17","titled":2,"bills":1}]}', '{"nights":"x"}']) {
      const r = run(damaged);
      expect(r.status, `damaged history ${JSON.stringify(damaged)} beside a valid retry file`).toBe(1);
      expect(r.stderr).toContain('short-titles-trend.json');
    }
    expect(run(serializeTrend({ nights: [{ day: '2026-11-17', titled: 1, bills: 1 }] })).status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // No clock in the gate: a history it accepts today, it accepts on every later day.
  const lib = readFileSync(join(process.cwd(), 'lib/short-titles-summary.mjs'), 'utf8');
  const gate = lib.slice(lib.indexOf('export function verifyShortTitlesTrend'), lib.indexOf('const FIELDS'));
  expect(gate).not.toMatch(/Date\.now|new Date\(|today/);
  // And the self-test the gates job runs covers the history.
  const selfTest = spawnSync(process.execPath, ['scripts/check-short-titles.mjs', '--self-test'], { encoding: 'utf8' });
  expect(selfTest.status).toBe(0);
});

test('round 6 (2): every history the step writes passes CI’s gate, night after night, whatever it started from', async () => {
  // The step's own trend handling (scripts/sync-short-titles.mjs): a history the gate refuses is started afresh,
  // then tonight's night is added with nextTrend. Driven over 40 nights from each starting state, a clock skew included.
  const starts: Array<[string, State['trend'] | null]> = [
    ['empty', { nights: [] }],
    ['full', { nights: range(14).map((i) => ({ day: day('2027-01-01', i), titled: 10, bills: 20 })) }],
    ['dated ahead of the clock', { nights: [{ day: '2027-12-31', titled: 10, bills: 20 }] }],
    ['an override night', { nights: [{ day: '2027-01-14', titled: 10, bills: 20, allow_drop: true }] }],
    ['damaged', null],
  ];
  const bills = range(20).map((n) => bill(n));
  for (const [label, start] of starts) {
    let trend = start && verifyShortTitlesTrend({ data: start }).failures.length === 0 ? start : { nights: [] };
    for (let i = 0; i < 40; i++) {
      trend = nextTrend(trend, { day: day('2027-01-15', i), titled: i % 21, bills: 20, allow_drop: i === 3 });
      const written = JSON.parse(serializeTrend(trend));
      expect(verifyShortTitlesTrend({ data: written }).failures, `${label}, night ${i + 1}`).toEqual([]);
    }
    expect(bills).toHaveLength(20);
  }
});

test('round 6 (3): a stop says what happened: the hourly limit, a refused key, or no usable answer', () => {
  expect(stopReason(10, Array(10).fill('HTTP 429'))).toBe("stopped early: Congress.gov answered HTTP 429 to 10 requests in a row, so the key's hourly request limit was reached");
  expect(stopReason(10, Array(10).fill('HTTP 403: access refused (check CONGRESS_API_KEY)'))).toBe('stopped early: Congress.gov refused the key 10 times in a row (HTTP 403): check CONGRESS_API_KEY');
  expect(stopReason(10, [...Array(9).fill('HTTP 429'), 'HTTP 503'])).toMatch(/no usable answer from Congress\.gov \(no answer, an error page or a broken connection\)$/);
  // The alarm carries those words and how many bills read before it are kept.
  const line = `SHORT TITLES TROUBLE: ${stopReason(10, Array(10).fill('HTTP 429'))}; 42 bill(s) read before it are kept`;
  const a = alarms({ nightly: { conclusion: 'success' }, shortTitlesTrouble: parseShortTitlesTrouble(line) }).find((x) => x.code === 'short-titles-stopped')!;
  expect(a.text).toContain("the key's hourly request limit was reached; 42 bill(s) read before it are kept");
  expect(a.text).not.toContain('the source is down');
});

test('round 6 (3): the stop reads only the unbroken run of failures that ended the night', async () => {
  // 5 server errors, one good answer, then 10 rate-limit answers in a row: the night stopped on the hourly limit.
  const bills = range(20).map((n) => bill(n, '2026-10-01', 1 - n / 100));
  const night = await runShortTitlesNight({
    bills,
    file: {},
    retry: {},
    today: '2026-11-17',
    fetchPage: async (b: { bill_number: number }) => {
      if (b.bill_number <= 5) throw new TransportFailure('HTTP 503');
      if (b.bill_number === 6) return answer(6);
      throw new TransportFailure('HTTP 429');
    },
  });
  expect(night.read).toBe(1);
  expect(night.trouble).toBe(stopReason(10, Array(10).fill('HTTP 429')));
});

test('round 6 (3): the falling alarm prints the two dates it compares, after a gap in nightlies too', () => {
  // Nightlies missed Nov 9 to 12: the newest night at least 7 days back is Nov 5, twelve days back.
  let trend: State['trend'] = { nights: [] };
  for (const d of ['2026-11-01', '2026-11-03', '2026-11-05', '2026-11-13', '2026-11-15']) trend = nextTrend(trend, { day: d, titled: 1300, bills: 3322 });
  const fields = nightSummary({ day: '2026-11-17', bills: [], titles: {}, retry: {}, trend, read: 0, lost: 0 });
  expect(fields).toMatchObject({ titled_7_nights_ago: 1300, day_7_nights_ago: '2026-11-05', drop_approved_on: null });
  const [a] = shortTitlesAlarms({ ...fields, titled: 1200, bills: 3322, bills_7_nights_ago: 3322, newest_read_on: '2026-11-17' }).filter((x) => x.code === 'short-titles-falling');
  expect(a.text).toContain('fell from 1300 on 2026-11-05 to 1200 on 2026-11-17');
  expect(a.text).not.toContain('in a week');
});

test('round 6 (3): after a person’s one-run override the falling alarm says so for the week it repeats, then stops', async () => {
  const START = '2027-08-01';
  const all = range(300).map((n) => bill(n * 5)); // all titled
  const state = established(all, START);
  const ok = async (b: { bill_number: number }) => answer(b.bill_number);
  // The record really drops every title from 60 bills; the scheduled night refuses, then a person dispatches the override.
  const dropped = new Set(range(60).map((n) => n * 5));
  for (const b of all) if (dropped.has(b.bill_number)) b.last_action_date = START;
  const reshaped = async (b: { bill_number: number }) => (dropped.has(b.bill_number) ? { ...answer(b.bill_number), titles: OFFICIAL, pagination: { count: OFFICIAL.length } } : answer(b.bill_number));
  const refused = await oneNight(state, all, START, reshaped);
  expect(refused.settled.write).toBeNull();
  const through = await oneNight(state, all, day(START, 1), reshaped, true);
  expect(through.settled.overrideUsed).toBe(true);
  expect(state.trend.nights.at(-1)).toMatchObject({ day: day(START, 1), allow_drop: true });
  const said: string[] = [];
  for (let i = 2; i < 12; i++) {
    const { summary } = await oneNight(state, all, day(START, i), ok);
    const falling = shortTitlesAlarms(summary).find((x) => x.code === 'short-titles-falling');
    said.push(falling ? (falling.text.includes(`one-run override on ${day(START, 1)}`) ? 'override' : 'plain') : '-');
  }
  // It fires, in the override's own words, until the night compared with is the override night or later.
  expect(said.slice(0, 6)).toEqual(Array(6).fill('override'));
  expect(said.slice(7)).toEqual(['-', '-', '-']);
  expect(said).not.toContain('plain');
});

test('round 6 (4): the name rule is the same exact sentence in the code, the runbook and the direction page', () => {
  const SENTENCE =
    'A name opens a bill only when every bill Oravan tracks in that Congress has been read or tried, no other of those bills has a short title that makes the same name and no unread one has a stored title that makes it, and every Congress searched before that one (the tracked Congress first, then each ended Congress, most recently ended first) has been read or tried in full and does not hold the name.';
  const flat = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\n\s*\*\s?/g, ' ').replace(/\s+/g, ' ');
  for (const p of ['lib/short-address.ts', 'docs/runbooks/new-congress-switch.md', 'docs/current-direction.md']) expect(flat(p), p).toContain(SENTENCE);
  expect(flat('lib/short-address.ts')).not.toContain('A name opens a bill when no other bill Oravan tracks has a short title');
});

// --- the fill's progress on the summary line (hotfix, 2026-11-17) --------------------------

test('unread: the corpus bills with no entry in the titles file; a line without the field still parses, and no alarm reads it', () => {
  const bills = range(5).map((n) => bill(n));
  const file = { [slug(1)]: { titles: [], as_of: null, read_on: '2026-11-17' }, [slug(2)]: { titles: ['Fixture hr2 Act'], as_of: null, read_on: '2026-11-17' }, 'hr-999-119': { titles: [], as_of: null, read_on: '2026-11-17' } };
  const fields = nightSummary({ day: '2026-11-17', bills, titles: file, retry: {}, trend: { nights: [] }, read: 2, lost: 0 });
  expect(fields.unread).toBe(3); // hr-999 is not in the corpus, so it is not counted as read
  expect(summaryLine({ ...fields, outcome: 'done' })).toMatch(/ unread=3$/);
  // The same night's numbers without the field (a line printed before the hotfix): parsed, and the alarms are the same.
  const withField = parseShortTitlesSummary(summaryLine({ ...fields, outcome: 'done' }))!;
  const oldLine = summaryLine({ ...fields, outcome: 'done' }).replace(/ unread=\d+$/, '');
  const without = parseShortTitlesSummary(oldLine)!;
  expect(without.unread).toBeUndefined();
  expect(shortTitlesAlarms(without)).toEqual(shortTitlesAlarms(withField));
  const lib = readFileSync(join(process.cwd(), 'lib/short-titles-summary.mjs'), 'utf8');
  const alarmsBody = lib.slice(lib.indexOf('export function shortTitlesAlarms'), lib.indexOf('export function nightSummary'));
  expect(alarmsBody).not.toContain('unread');
});
