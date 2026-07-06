import { expect, test } from '@playwright/test';
import {
  FRESHNESS_CLAIM_WINDOW_DAYS,
  FRESHNESS_DEAD_WINDOW_DAYS,
  emptyStateVerdict,
  freshnessAgeDays,
  freshnessState,
} from '../lib/freshness-state';

// One frozen clock for both the input timestamp and the function's `now`,
// so exact-boundary assertions can't flake on the milliseconds that elapse
// between two separate Date.now() reads.
const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

test.describe('freshnessState (KTD-2 fresh/stale/dead tri-state)', () => {
  test('fresh at 0 days and right at the claim-window boundary', () => {
    expect(freshnessState(daysAgo(0), NOW)).toBe('fresh');
    expect(freshnessState(daysAgo(FRESHNESS_CLAIM_WINDOW_DAYS), NOW)).toBe('fresh');
  });

  test('stale just past the claim window', () => {
    expect(freshnessState(daysAgo(FRESHNESS_CLAIM_WINDOW_DAYS + 1), NOW)).toBe('stale');
    expect(freshnessState(daysAgo(FRESHNESS_DEAD_WINDOW_DAYS), NOW)).toBe('stale');
  });

  test('dead once the pipeline has been silent past the dead window', () => {
    expect(freshnessState(daysAgo(FRESHNESS_DEAD_WINDOW_DAYS + 1), NOW)).toBe('dead');
    expect(freshnessState(daysAgo(90), NOW)).toBe('dead');
  });

  test('an unparseable timestamp fails toward stale, never toward a false fresh', () => {
    expect(freshnessAgeDays('not-a-date', NOW)).toBe(Infinity);
    expect(freshnessState('not-a-date', NOW)).toBe('dead');
  });
});

test.describe('emptyStateVerdict (the AE3 collapse rule)', () => {
  test('fresh data + empty band = quiet_week', () => {
    expect(emptyStateVerdict(daysAgo(0), NOW)).toBe('quiet_week');
    expect(emptyStateVerdict(daysAgo(FRESHNESS_CLAIM_WINDOW_DAYS), NOW)).toBe('quiet_week');
  });

  test("both 'stale' and 'dead' collapse to data_stale — never quiet on dead data", () => {
    expect(emptyStateVerdict(daysAgo(FRESHNESS_CLAIM_WINDOW_DAYS + 1), NOW)).toBe('data_stale');
    expect(emptyStateVerdict(daysAgo(FRESHNESS_DEAD_WINDOW_DAYS + 1), NOW)).toBe('data_stale');
    expect(emptyStateVerdict('not-a-date', NOW)).toBe('data_stale');
  });
});
