import { expect, test } from '@playwright/test';
import {
  FRESHNESS_CLAIM_WINDOW_DAYS,
  FRESHNESS_DEAD_WINDOW_DAYS,
  emptyStateVerdict,
  freshnessAgeDays,
  freshnessState,
  type FreshnessSignals,
} from '../lib/freshness-state';

// One frozen clock for both the input timestamp and the function's `now`,
// so exact-boundary assertions can't flake on the milliseconds that elapse
// between two separate Date.now() reads.
const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

// All three signals fresh by default; each test overrides only the one
// signal it's exercising, so a failure clearly pins down which signal caused
// the verdict to flip.
const signals = (overrides: Partial<FreshnessSignals> = {}): FreshnessSignals => ({
  checkedAt: daysAgo(0),
  completeThrough: daysAgo(0),
  newestAction: daysAgo(0),
  ...overrides,
});

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

// 2026-07-16 (audit §5 item 4): emptyStateVerdict's signature changed here,
// from a single `checkedAt` string to a FreshnessSignals object. Before this
// fix the verdict looked ONLY at checkedAt (lastRun) — "did the job run
// tonight" — so a pipeline that ran and committed every night but made no
// real forward progress (a frozen sync cursor, or a corpus with nothing
// genuinely new for weeks) still read as "fresh" and the site confidently
// claimed "quiet week" over data that was actually a month stale. That's the
// exact bug the audit found live: lastSync AND the corpus's newest
// last_action_date were both 29 days old while lastRun was only 2 days old.
// completeThrough and newestAction now independently gate the verdict too —
// see emptyStateVerdict's own doc comment for why they use the wider dead
// window rather than the tight claim window checkedAt uses.
test.describe('emptyStateVerdict (the AE3 collapse rule)', () => {
  test('every signal fresh + empty band = quiet_week', () => {
    expect(emptyStateVerdict(signals(), NOW)).toBe('quiet_week');
    expect(emptyStateVerdict(signals({ checkedAt: daysAgo(FRESHNESS_CLAIM_WINDOW_DAYS) }), NOW)).toBe('quiet_week');
  });

  test("checkedAt 'stale' or 'dead' collapses to data_stale — never quiet when the job itself hasn't run recently", () => {
    expect(emptyStateVerdict(signals({ checkedAt: daysAgo(FRESHNESS_CLAIM_WINDOW_DAYS + 1) }), NOW)).toBe('data_stale');
    expect(emptyStateVerdict(signals({ checkedAt: daysAgo(FRESHNESS_DEAD_WINDOW_DAYS + 1) }), NOW)).toBe('data_stale');
    expect(emptyStateVerdict(signals({ checkedAt: 'not-a-date' }), NOW)).toBe('data_stale');
  });

  test('a dead-window-stale sync cursor overrides a fresh checkedAt — never quiet on a frozen cursor', () => {
    expect(
      emptyStateVerdict(signals({ completeThrough: daysAgo(FRESHNESS_DEAD_WINDOW_DAYS + 1) }), NOW)
    ).toBe('data_stale');
  });

  test('a dead-window-stale newestAction overrides a fresh checkedAt — never quiet when nothing in the corpus is current', () => {
    expect(
      emptyStateVerdict(signals({ newestAction: daysAgo(FRESHNESS_DEAD_WINDOW_DAYS + 1) }), NOW)
    ).toBe('data_stale');
  });

  test('completeThrough/newestAction may lag WITHIN the dead window without tripping data_stale', () => {
    // The sync cursor legitimately trails checkedAt by real days while the
    // ascending backlog scan drains (lib/freshness.ts's own doc comment,
    // scripts/sync-bills.mjs's two-pass fetch design note) — gating this
    // signal on the tight claim window would make the site cry "data stale"
    // most nights even when the recent-first pass kept things genuinely
    // current. Right at the dead-window boundary is still quiet_week.
    expect(
      emptyStateVerdict(
        signals({ completeThrough: daysAgo(FRESHNESS_DEAD_WINDOW_DAYS), newestAction: daysAgo(FRESHNESS_DEAD_WINDOW_DAYS) }),
        NOW
      )
    ).toBe('quiet_week');
  });
});
