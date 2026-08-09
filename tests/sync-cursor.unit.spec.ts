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
type Verdict = { lastSync: string; reason: string; stalled: boolean };
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
    // and verify-sync.mjs's 10-day cursor ceiling fails the run within ten
    // nights.
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

  test('the cursor never runs backwards past where the run started scanning', () => {
    // Whatever the reason, `lastSync` is either runStart (forward) or the
    // high-water mark, which the ascending pass only ever advances from
    // `since`. Nothing here may hand back a cursor older than `since`.
    for (const c of [
      { since: SINCE, highWater: SINCE, runStart: RUN_START, frozen: true },
      { since: SINCE, highWater: HIGH_WATER, runStart: RUN_START, truncated: true },
      { since: SINCE, highWater: HIGH_WATER, runStart: RUN_START },
    ]) {
      expect(Date.parse(resolve(c).lastSync)).toBeGreaterThanOrEqual(Date.parse(SINCE));
    }
  });
});
