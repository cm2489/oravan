import { expect, test } from '@playwright/test';
// Imported from the nightly script ITSELF, not a copy - this is the exact
// arithmetic scripts/sync-bills.mjs uses to decide where data/sync-state.json's
// `lastSync` lands. (The import also re-tests the argv[1] guard that wraps
// that script's body; see tests/sync-abort.unit.spec.ts.)
import {
  endOfDayCursor,
  planAscendingWindow,
  resolveNextSync,
  updateDay,
} from '../scripts/sync-bills.mjs';

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
 *
 * THE SECOND BUG, 2026-09-18, which the first fix's own mechanism caused. The
 * high-water mark is the MIDNIGHT of the last finished bill's day, because the
 * bill-list `updateDate` is a bare date. When the cursor already sits INSIDE
 * that day, midnight is behind it, the monotonic clamp holds it where it was,
 * and the night makes literally zero progress - then does it again tomorrow.
 * That is what ran from 2026-09-08 to 2026-09-18: more than MAX_UPDATES tracked
 * bills carry the 2026-09-08 updateDate, so the oldest-500 slice could never
 * reach a later day, `lastSync` never moved, and the 09-18 nightly went red on
 * the cursor-age ceiling with no self-healing path.
 *
 * The second fix is to FINISH THE DAY (planAscendingWindow) and then take the
 * END of it (endOfDayCursor) rather than its midnight. The three pure pieces
 * that decision is made of are pinned below.
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
    // The verdict itself is unchanged: a truncated window whose mark never
    // got past `since` made no progress and says so. What changed on
    // 2026-09-18 is how a run REACHES this shape. It used to be the ordinary
    // consequence of one calendar day carrying more than MAX_UPDATES tracked
    // bills - the 2026-09-08 freeze, ten nights of it - and the caller now
    // finishes that day instead (planAscendingWindow). What is left is the
    // residue: a day over MAX_DAY_COMPLETION, or a decode budget frozen inside
    // one. The cursor is still deliberately NOT nudged past `since` to break a
    // tie - that would skip real bills. The caller warns, and
    // scripts/check-cursor-age.mjs's ceiling reds the run (post-commit since
    // 2026-08-12: the night's data still lands).
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

/* ------------------------------------------------------------------ *
 * THE SAME-TIMESTAMP FREEZE (2026-09-18) - the three pure pieces.
 * ------------------------------------------------------------------ */

type Plan = {
  count: number;
  extended: number;
  deferred: number;
  dayComplete: boolean;
  completedDay: string | null;
  ceilingHit: boolean;
};
const plan = planAscendingWindow as (a: {
  days: (string | null)[];
  maxUpdates?: number;
  maxDayCompletion?: number;
}) => Plan;
const day = updateDay as (v: unknown) => string | null;
const endOfDay = endOfDayCursor as (d: string | null) => string | null;
const runOf = (n: number, d: string) => Array.from({ length: n }, () => d);

test.describe('updateDay (the only grain the bill list offers)', () => {
  test('a bare date is the day; a full timestamp is its date half', () => {
    expect(day('2026-09-08')).toBe('2026-09-08');
    expect(day('2026-09-08T17:54:31Z')).toBe('2026-09-08');
    expect(day('2026-09-08T17:54:31.482Z')).toBe('2026-09-08');
  });

  test('anything unreadable is null, never a guess', () => {
    for (const bad of [null, undefined, '', 'yesterday', 42, {}, '26-09-08']) {
      expect(day(bad), String(bad)).toBeNull();
    }
  });
});

test.describe('endOfDayCursor (what "this day is finished" is worth)', () => {
  test('the end of a day is the start of the next one', () => {
    expect(endOfDay('2026-09-08')).toBe('2026-09-09T00:00:00Z');
  });

  test('month, year and leap-day rollovers - the cases string arithmetic gets wrong', () => {
    expect(endOfDay('2026-09-30')).toBe('2026-10-01T00:00:00Z');
    expect(endOfDay('2026-12-31')).toBe('2027-01-01T00:00:00Z');
    expect(endOfDay('2028-02-28')).toBe('2028-02-29T00:00:00Z'); // 2028 is a leap year
    expect(endOfDay('2027-02-28')).toBe('2027-03-01T00:00:00Z'); // 2027 is not
  });

  test('an unreadable day yields null rather than a fabricated cursor', () => {
    for (const bad of [null, '', 'someday', '2026-13-45']) {
      expect(endOfDay(bad as string), String(bad)).toBeNull();
    }
  });

  test('it emits the exact format verify-sync.mjs accepts - a mark is still a cursor', () => {
    for (const d of ['2026-09-08', '2026-12-31', '2028-02-28']) {
      expect(endOfDay(d)!).toMatch(CURSOR_FORMAT);
    }
  });
});

test.describe('planAscendingWindow (how much of the window a run processes)', () => {
  test('an empty window plans nothing', () => {
    const p = plan({ days: [] });
    expect(p).toEqual({
      count: 0, extended: 0, deferred: 0, dayComplete: false, completedDay: null, ceilingHit: false,
    });
  });

  test('a window under the cap is processed whole, with no day claimed finished', () => {
    // Nothing follows the last bill, so nothing PROVES its day ended here. Such
    // a run is `clean` in resolveNextSync's sense and advances to runStart on
    // its own; it must not also claim a day boundary it cannot see.
    const p = plan({ days: [...runOf(40, '2026-09-08'), ...runOf(20, '2026-09-09')], maxUpdates: 500 });
    expect(p.count).toBe(60);
    expect(p.deferred).toBe(0);
    expect(p.extended).toBe(0);
    expect(p.dayComplete).toBe(false);
  });

  test('ordinary truncation is unchanged: the oldest maxUpdates, the rest deferred', () => {
    const p = plan({ days: [...runOf(300, '2026-09-08'), ...runOf(400, '2026-09-09')], maxUpdates: 500 });
    expect(p.count).toBe(500);
    expect(p.extended).toBe(0); // the capped slice already spans two days
    expect(p.deferred).toBe(200);
    expect(p.dayComplete).toBe(false); // the cap landed part-way through 09-09
    expect(p.completedDay).toBeNull();
  });

  test('a cap that lands exactly on a day boundary finishes that day', () => {
    const p = plan({ days: [...runOf(500, '2026-09-08'), ...runOf(200, '2026-09-09')], maxUpdates: 500 });
    expect(p.count).toBe(500);
    expect(p.extended).toBe(0); // no extension needed - the day ended on its own
    expect(p.dayComplete).toBe(true);
    expect(p.completedDay).toBe('2026-09-08');
  });

  test('THE 2026-09-08 SHAPE: one oversized day is finished past the cap', () => {
    // The regression itself. 700 tracked bills carry 2026-09-08; the oldest 500
    // are all of them and none of them, because stopping there leaves the mark
    // at that day's own midnight - behind the cursor that started inside it.
    const p = plan({
      days: [...runOf(700, '2026-09-08'), ...runOf(100, '2026-09-09')],
      maxUpdates: 500,
      maxDayCompletion: 3000,
    });
    expect(p.count).toBe(700); // ran on to the end of the day
    expect(p.extended).toBe(200);
    expect(p.deferred).toBe(100);
    expect(p.dayComplete).toBe(true);
    expect(p.completedDay).toBe('2026-09-08');
    expect(p.ceilingHit).toBe(false);
    // And that is what finally moves the cursor off 2026-09-08T17:54:31Z.
    expect(endOfDay(p.completedDay)).toBe('2026-09-09T00:00:00Z');
  });

  test('the extension is bounded - a day past MAX_DAY_COMPLETION is reported, not chased', () => {
    const p = plan({ days: runOf(4000, '2026-09-08'), maxUpdates: 500, maxDayCompletion: 3000 });
    expect(p.count).toBe(3000);
    expect(p.extended).toBe(2500);
    expect(p.ceilingHit).toBe(true);
    expect(p.dayComplete).toBe(false); // still unfinished: nothing may claim otherwise
    expect(p.completedDay).toBeNull();
  });

  test('a single day that fits inside what was fetched needs no boundary to be safe', () => {
    // Everything fetched is one day and the fetch ran out of pages. The slice
    // covers all of it, so `deferred` is 0 and the caller's own
    // `unfetchedPagesRemain` decides whether this is a clean run. `dayComplete`
    // stays false because this function cannot see past the array it was given.
    const p = plan({ days: runOf(700, '2026-09-08'), maxUpdates: 500, maxDayCompletion: 3000 });
    expect(p.count).toBe(700);
    expect(p.deferred).toBe(0);
    expect(p.dayComplete).toBe(false);
  });

  test('unreadable dates never fabricate a finished day', () => {
    const p = plan({ days: [null, null, null], maxUpdates: 2 });
    expect(p.count).toBe(2);
    expect(p.dayComplete).toBe(false);
    expect(p.completedDay).toBeNull();
    expect(p.extended).toBe(0);
  });
});

test.describe('the freeze, end to end through the cursor decision', () => {
  test('THE LIVE 2026-09-08 RUN: before the fix it stalled; after it, the cursor leaves the day', () => {
    const since = '2026-09-08T17:54:31Z'; // ten nights of data/sync-state.json
    const runStart = '2026-09-18T17:40:29.074Z';

    // BEFORE: the oldest 500 all carry 2026-09-08, so the mark is that day's
    // own midnight - earlier than `since`, clamped back onto it, stalled.
    const before = resolve({ since, highWater: '2026-09-08', runStart, truncated: true });
    expect(before.lastSync).toBe(since);
    expect(before.clamped).toBe(true);
    expect(before.stalled).toBe(true);

    // AFTER: the run finishes 2026-09-08 and takes the END of it.
    const p = plan({
      days: [...runOf(718, '2026-09-08'), ...runOf(120, '2026-09-09')],
      maxUpdates: 500,
      maxDayCompletion: 3000,
    });
    expect(p.dayComplete).toBe(true);
    const after = resolve({
      since, highWater: endOfDay(p.completedDay)!, runStart, truncated: true,
    });
    expect(after.lastSync).toBe('2026-09-09T00:00:00Z');
    expect(after.clamped).toBe(false);
    expect(after.stalled).toBe(false);
    expect(after.lastSync).toMatch(CURSOR_FORMAT);
    // Forward, and only as far as the day that was actually finished - never
    // to runStart, because 120 bills of 09-09 are still deferred.
    expect(Date.parse(after.lastSync)).toBeGreaterThan(Date.parse(since));
    expect(Date.parse(after.lastSync)).toBeLessThan(Date.parse(runStart));
  });

  test('finishing a day never lets the cursor outrun a freeze inside a later one', () => {
    // The day-end mark is only ever taken for a day the run walked clean
    // through. A freeze on the next day still pins everything after it, and the
    // mark stays at the boundary between them.
    const since = '2026-09-08T17:54:31Z';
    const v = resolve({
      since, highWater: '2026-09-09T00:00:00Z', runStart: '2026-09-18T17:40:29.074Z',
      frozen: true, truncated: true,
    });
    expect(v.lastSync).toBe('2026-09-09T00:00:00Z');
    expect(v.reason).toBe('frozen+truncated');
    expect(v.stalled).toBe(false);
  });
});
