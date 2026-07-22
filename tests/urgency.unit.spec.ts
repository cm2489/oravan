import { expect, test } from '@playwright/test';
// Relative import of the plain .mjs module (no 'server-only'), the same file
// lib/core/bills.ts and the sync scripts import — the curve tested here is
// the curve that ships everywhere.
import { STATUS_BASE, TERMINAL_STATUSES, effectiveUrgency } from '../lib/urgency.mjs';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/*
 * These tests PIN the urgency curve: base per status, freshness bonus,
 * staleness decay, clamps, and 3-decimal rounding. If a value here surprises
 * you, the curve changed — retune deliberately (docs/solutions/
 * stale-urgency-freeze.md has the history), then update the pins.
 */

test.describe('STATUS_BASE (per-status base urgency)', () => {
  test('pins every status base', () => {
    expect(STATUS_BASE).toEqual({
      floor_vote: 0.9,
      passed_chamber: 0.75,
      conference: 0.75,
      markup: 0.65,
      committee: 0.45,
      signed: 0.3,
      vetoed: 0.3,
      introduced: 0.2,
    });
  });

  test('no action date returns the bare base, per status', () => {
    for (const [status, base] of Object.entries(STATUS_BASE)) {
      expect(effectiveUrgency(status, null), status).toBe(base);
    }
  });

  test('unknown status falls back to the introduced-level base', () => {
    expect(effectiveUrgency('some_future_status', null)).toBe(0.2);
  });
});

test.describe('freshness bonus', () => {
  test('+0.1 inside 3 days, for every status (capped at 1)', () => {
    expect(effectiveUrgency('committee', daysAgo(1))).toBe(0.55);
    expect(effectiveUrgency('markup', daysAgo(1))).toBe(0.75);
    expect(effectiveUrgency('introduced', daysAgo(1))).toBe(0.3);
    expect(effectiveUrgency('floor_vote', daysAgo(1))).toBe(1); // 0.9 + 0.1, ceiling clamp
  });

  test('+0.05 between 3 and 7 days', () => {
    expect(effectiveUrgency('committee', daysAgo(5))).toBe(0.5);
    expect(effectiveUrgency('floor_vote', daysAgo(5))).toBe(0.95);
  });

  test('no bonus and no decay in the 7-14 day plateau', () => {
    for (const [status, base] of Object.entries(STATUS_BASE)) {
      expect(effectiveUrgency(status, daysAgo(10)), status).toBe(base);
    }
  });
});

test.describe('staleness decay (0.015/day after day 14, capped at 0.45)', () => {
  test('20 days = base − 0.09, rounded to 3 decimals', () => {
    expect(effectiveUrgency('committee', daysAgo(20))).toBe(0.36);
    expect(effectiveUrgency('markup', daysAgo(20))).toBe(0.56);
    expect(effectiveUrgency('floor_vote', daysAgo(20))).toBe(0.81);
  });

  test('50 days hits the 0.45 decay cap; a stale floor placement ranks below an active committee fight', () => {
    expect(effectiveUrgency('floor_vote', daysAgo(50))).toBe(0.45);
    expect(effectiveUrgency('floor_vote', daysAgo(50))).toBeLessThan(
      effectiveUrgency('committee', daysAgo(1))
    );
  });

  test('decay bottoms out at the 0.05 floor', () => {
    expect(effectiveUrgency('committee', daysAgo(50))).toBe(0.05);
    expect(effectiveUrgency('introduced', daysAgo(50))).toBe(0.05);
  });
});

test.describe('input hygiene', () => {
  test('future or unparseable dates fall back to the base', () => {
    expect(effectiveUrgency('committee', daysAgo(-2))).toBe(0.45);
    expect(effectiveUrgency('committee', 'not-a-date')).toBe(0.45);
  });
});

test.describe('injectable clock (third param, tests/corpus.ts only)', () => {
  test('omitting `now` and passing Date.now() are the same call', () => {
    const date = daysAgo(5);
    expect(effectiveUrgency('committee', date, Date.now())).toBe(
      effectiveUrgency('committee', date)
    );
  });

  test('`now` shifts the whole curve: the same date reads fresher at an earlier clock', () => {
    const date = daysAgo(5);
    // Rewind the clock 4 days: a 5-day-old action becomes 1 day old (+0.1 bonus).
    expect(effectiveUrgency('committee', date, Date.now() - 4 * 86_400_000)).toBe(0.55);
    // Advance 20 days: 25 days old, decay (25−14) × 0.015 = 0.165.
    expect(effectiveUrgency('committee', date, Date.now() + 20 * 86_400_000)).toBe(0.285);
  });

  test('dateless and unparseable inputs ignore the clock entirely', () => {
    expect(effectiveUrgency('committee', null, 0)).toBe(0.45);
    expect(effectiveUrgency('committee', 'not-a-date', 0)).toBe(0.45);
  });
});

test('terminal statuses are exactly signed + vetoed', () => {
  expect([...TERMINAL_STATUSES].sort()).toEqual(['signed', 'vetoed']);
});
