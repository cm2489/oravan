import { test } from '@playwright/test';

/*
 * A FIXED CLOCK FOR ONE SPEC FILE (re-check of #523, round 7).
 *
 * No test may read the real clock: a reading taken against today turns stale
 * a fortnight after its fixtures' dates and the unit check goes red on every
 * branch. Where a function takes `now`, pass it. Some of the site's functions
 * read the clock with no way to pass it (lib/journey.ts liveCallTarget,
 * settledDecision; lib/scriptprompt.ts through statusKeyFor's default). For a
 * spec that calls them, `fixClock(at)` makes `Date.now()` and `new Date()`
 * with no argument return `at` for that file's tests, and puts the real
 * `Date` back after them. `new Date(value)` and `Date.parse` are untouched.
 */
export function fixClock(at: number): void {
  const Real = Date;
  class Fixed extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(at);
      else super(...(args as [string | number | Date]));
    }
    static now(): number {
      return at;
    }
  }
  test.beforeAll(() => {
    globalThis.Date = Fixed as DateConstructor;
  });
  test.afterAll(() => {
    globalThis.Date = Real;
  });
}
