import { expect, test } from '@playwright/test';
// Imported from the nightly script ITSELF, not a copy - this is the exact
// arithmetic scripts/sync-bills.mjs uses to decide where data/sync-state.json's
// `lastSync` lands. (The import also re-tests the argv[1] guard that wraps
// that script's body; see tests/sync-abort.unit.spec.ts.)
import { resolveNextSync } from '../scripts/sync-bills.mjs';

/*
 * Pins the nightly cursor decision - the arithmetic that decides whether a
 * bill is ever seen again.
 *
 * THE BUG THIS FILE EXISTS FOR. The ascending backlog pass processes the
 * OLDEST MAX_UPDATES (500) bills of whatever Congress.gov reports since the
 * cursor. Everything past that line was simply dropped: nothing marked the
 * run incomplete, so an otherwise-clean night persisted `runStart` as the new
 * cursor and the deferred tail fell outside every future window - permanently
 * skipped unless Congress.gov happened to touch those bills again. One missed
 * nightly is enough to trigger it (measured live 2026-08-08 against the
 * tracked bill types: 24h ~337 bills, 2 days ~504, 3 days ~674), so every
 * catch-up run quietly ate the bills it was catching up on.
 *
 * The fix folds truncation into the same decision as `frozen`: either one
 * pins the cursor to the high-water mark - the newest bill the run actually
 * finished - so the tail reopens in tomorrow's window.
 */

type Args = {
  since: string;
  highWater: string;
  runStart: string;
  frozen?: boolean;
  truncated?: boolean;
};
type Verdict = { lastSync: string; reason: string; stalled: boolean; clamped: boolean };
const resolve = resolveNextSync as (a: Args) => Verdict;

// verify-sync.mjs pins EXACTLY this shape, and both other shapes have shipped
// a multi-day outage: a bare date 400s Congress.gov (2026-06-25/07-01), and so
// do Date.toISOString() milliseconds (2026-07-17/07-22).
const CURSOR_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const SINCE = '2026-08-06T00:00:00Z';
const HIGH_WATER = '2026-08-07T00:00:00Z';
const RUN_START = '2026-08-09T07:31:12.482Z'; // as Date.toISOString() emits it

test.describe('resolveNextSync (nightly ascending-pass cursor)', () => {
  test('a complete run catches the cursor up to this run start', () => {
    const v = resolve({ since: SINCE, highWater: HIGH_WATER, runStart: RUN_START });
    expect(v.lastSync).toBe('2026-08-09T07:31:12Z'); // milliseconds stripped
    expect(v.reason).toBe('clean');
    expect(v.stalled).toBe(false);
  });

  test('a TRUNCATED window stops the cursor at the last bill actually processed', () => {
    // The regression itself. 674 bills reported, 500 processed, 174 deferred:
    // before the fix this returned runStart and those 174 were never seen
    // again. The high-water mark keeps them inside tomorrow's window.
    const v = resolve({ since: SINCE, highWater: HIGH_WATER, runStart: RUN_START, truncated: true });
    expect(v.lastSync).toBe(HIGH_WATER);
    expect(v.lastSync).not.toBe('2026-08-09T07:31:12Z');
    expect(v.reason).toBe('truncated');
    expect(v.stalled).toBe(false); // the cursor did move forward, just not to runStart
  });

  test('a frozen run still behaves exactly as it did before truncation was tracked', () => {
    const v = resolve({ since: SINCE, highWater: HIGH_WATER, runStart: RUN_START, frozen: true });
    expect(v.lastSync).toBe(HIGH_WATER);
    expect(v.reason).toBe('frozen');
  });

  test('frozen AND truncated is still one cursor, reported as both', () => {
    const v = resolve({
      since: SINCE, highWater: HIGH_WATER, runStart: RUN_START, frozen: true, truncated: true,
    });
    expect(v.lastSync).toBe(HIGH_WATER);
    expect(v.reason).toBe('frozen+truncated');
  });

  test('a truncated window that made no progress is reported as stalled', () => {
    // Only reachable when 500+ tracked bills share the cursor's own timestamp
    // (Congress.gov's bill-list updateDate is a bare DATE, so: one calendar
    // day overflowing the cap). The cursor is deliberately NOT nudged past
    // `since` to break the tie - that would skip real bills. The caller warns
    // and scripts/check-cursor-age.mjs's 10-day ceiling reds the run within
    // ten nights (post-commit since 2026-08-12: the night's data still lands).
    const v = resolve({ since: SINCE, highWater: SINCE, runStart: RUN_START, truncated: true });
    expect(v.lastSync).toBe(SINCE);
    expect(v.stalled).toBe(true);
  });

  test('a frozen run sitting on its own cursor is NOT a stall - that is the decode backlog draining', () => {
    // Long-standing, intended behavior: the first bill in the window needs a
    // decode the budget can't pay for tonight, so the cursor holds until it
    // can. Flagging that as a stall would cry wolf every night of a backlog.
    const v = resolve({ since: SINCE, highWater: SINCE, runStart: RUN_START, frozen: true });
    expect(v.lastSync).toBe(SINCE);
    expect(v.stalled).toBe(false);
  });

  test('a bare-date high-water mark is normalized, never persisted raw', () => {
    // Congress.gov's bill-list `updateDate` IS a bare date, and a bare-date
    // fromDateTime 400s every request (the 2026-06-25/07-01 outage).
    const v = resolve({ since: SINCE, highWater: '2026-08-07', runStart: RUN_START, truncated: true });
    expect(v.lastSync).toBe('2026-08-07T00:00:00Z');
  });

  test('every branch emits the exact format verify-sync.mjs accepts', () => {
    const cases: Args[] = [
      { since: SINCE, highWater: HIGH_WATER, runStart: RUN_START },
      { since: SINCE, highWater: HIGH_WATER, runStart: RUN_START, frozen: true },
      { since: SINCE, highWater: HIGH_WATER, runStart: RUN_START, truncated: true },
      { since: SINCE, highWater: '2026-08-07', runStart: RUN_START, truncated: true },
      { since: SINCE, highWater: SINCE, runStart: '2026-08-09T07:31:12Z', frozen: true, truncated: true },
    ];
    for (const c of cases) expect(resolve(c).lastSync).toMatch(CURSOR_FORMAT);
  });

  /* ------------------------------------------------------------------ *
   * THE MONOTONIC GUARD (2026-08-12) — and the live incident that earned
   * it, which the test below this block used to CLAIM to cover and did
   * not: every case it passed had a high-water mark at or after `since`,
   * so it could only ever pass. The one shape that breaks the invariant
   * was never handed to it.
   *
   * WHAT HAPPENED. Congress.gov's bill-list `updateDate` is a BARE DATE,
   * so `toISODateTime` normalizes it to that day's MIDNIGHT. On the run
   * of 2026-08-11 the cursor started at 2026-08-10T08:55:10Z and the
   * truncated window's newest finished bill carried updateDate
   * "2026-08-10" -> 2026-08-10T00:00:00Z. The run persisted a cursor 8h55m
   * BEHIND the one it was handed (origin/main:data/sync-state.json,
   * commit bcec170), which re-buys a window this run already paid for and
   * hands lib/freshness-state.ts a staler `lastSync` than the truth.
   * ------------------------------------------------------------------ */
  test('THE 2026-08-11 REGRESSION: a bare-date mark BEHIND the cursor is clamped, never persisted', () => {
    const v = resolve({
      since: '2026-08-10T08:55:10Z',
      highWater: '2026-08-10', // exactly what Congress.gov returned
      runStart: RUN_START,
      truncated: true,
    });
    expect(v.lastSync).toBe('2026-08-10T08:55:10Z'); // held, not moved back
    expect(v.lastSync).not.toBe('2026-08-10T00:00:00Z'); // what shipped
    expect(v.clamped).toBe(true);
    // The clamp lands exactly ON `since`, which is what `stalled` tests for,
    // so the no-forward-progress warning still fires. A clamp must never
    // silence the alarm that says the window is not moving.
    expect(v.stalled).toBe(true);
  });

  test('the clamp is not a general nudge — a mark that really moved is untouched', () => {
    const v = resolve({ since: SINCE, highWater: HIGH_WATER, runStart: RUN_START, truncated: true });
    expect(v.lastSync).toBe(HIGH_WATER);
    expect(v.clamped).toBe(false);
  });

  test('an unparseable `since` leaves the mark alone rather than guessing at a floor', () => {
    // A hand-edited state file, or a corpus predating the cursor. With no
    // floor to measure against there is nothing to clamp to, and inventing
    // one would be worse than passing the mark through.
    const v = resolve({ since: 'not a date', highWater: HIGH_WATER, runStart: RUN_START, frozen: true });
    expect(v.lastSync).toBe(HIGH_WATER);
    expect(v.clamped).toBe(false);
  });

  test('the cursor never runs backwards past where the run started scanning', () => {
    // The invariant itself, now including the shapes that can actually break
    // it: a bare-date mark inside the cursor's own day (both freeze causes),
    // and a runStart behind the cursor (a clock skew or a future-dated state
    // file — the clean branch is guarded too, so the rule is total).
    for (const c of [
      { since: SINCE, highWater: SINCE, runStart: RUN_START, frozen: true },
      { since: SINCE, highWater: HIGH_WATER, runStart: RUN_START, truncated: true },
      { since: SINCE, highWater: HIGH_WATER, runStart: RUN_START },
      { since: '2026-08-10T08:55:10Z', highWater: '2026-08-10', runStart: RUN_START, truncated: true },
      { since: '2026-08-10T08:55:10Z', highWater: '2026-08-10', runStart: RUN_START, frozen: true },
      { since: '2026-08-10T08:55:10Z', highWater: '2026-08-09', runStart: '2026-08-10T00:00:00Z' },
    ]) {
      expect(Date.parse(resolve(c).lastSync), JSON.stringify(c)).toBeGreaterThanOrEqual(
        Date.parse(c.since)
      );
    }
  });
});
