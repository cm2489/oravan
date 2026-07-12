import { expect, test } from '@playwright/test';
// Relative import of the plain .mjs module - same pattern as
// tests/verify-salt.unit.spec.ts importing lib/salt.mjs / tests/
// redistricting-watch.unit.spec.ts importing lib/redistricting-watch.mjs:
// the logic tested here is exactly what scripts/daily-metrics.mjs runs
// nightly against the real counters database.
import {
  formatDigestBody,
  formatPercent,
  isoDateDaysAgo,
  MCP_SPIKE_FLOOR,
  median,
  SCRIPT_SPIKE_FLOOR,
  seriesStats,
  spikeIssueContent,
  SPIKE_MULTIPLIER,
  sumWindows,
  trailingWindowDays,
  weekOverWeek,
} from '../lib/traffic-metrics.mjs';

/*
 * Traffic-watch design (2026-07): pins the digest math independently of any
 * network/GitHub call — median (odd/even), week-over-week (including the
 * zero-median/zero-latest edge cases that motivate the floor constants),
 * the spike gate (must exceed BOTH the floor AND 3x the trailing median),
 * and the digest/spike-issue text formatting.
 */

test.describe('median', () => {
  test('odd-length array: the exact middle value after sorting', () => {
    expect(median([9, 4, 38])).toBe(9);
    expect(median([3, 1, 2])).toBe(2);
  });

  test('even-length array: average of the two middle values', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  test('empty array: 0, never NaN or a throw', () => {
    expect(median([])).toBe(0);
  });

  test('does not mutate its input', () => {
    const input = [5, 1, 3];
    median(input);
    expect(input).toEqual([5, 1, 3]);
  });
});

test.describe('weekOverWeek', () => {
  test('normal case: rounded percent change vs. the same weekday one week ago', () => {
    expect(weekOverWeek(12, 9)).toBe(33);
    expect(weekOverWeek(9, 12)).toBe(-25);
  });

  test('zero-to-zero: 0, not N/A, not a division error', () => {
    expect(weekOverWeek(0, 0)).toBe(0);
  });

  test('zero-to-nonzero: null ("N/A") — cannot be expressed as a normal percent, never a misleading number', () => {
    expect(weekOverWeek(7, 0)).toBeNull();
  });
});

test.describe('formatPercent', () => {
  test('positive gets an explicit +, negative keeps its own -, null renders N/A', () => {
    expect(formatPercent(33)).toBe('+33%');
    expect(formatPercent(-25)).toBe('-25%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(null)).toBe('N/A');
  });
});

test.describe('seriesStats', () => {
  test('rejects a window that is not exactly 8 values (day-1..day-8)', () => {
    expect(() => seriesStats([1, 2, 3], 10)).toThrow(/exactly 8/);
  });

  test('the trailing-7-day median excludes day-1 (latest) itself', () => {
    // day-1 = 100 (an outlier); day-2..day-8 = a stable week of 10s.
    const window = [100, 10, 10, 10, 10, 10, 10, 10];
    const stats = seriesStats(window, 1000); // floor high enough to isolate the median check
    expect(stats.latest).toBe(100);
    expect(stats.med).toBe(10);
  });

  test('WoW compares day-1 against day-8 specifically (the same-weekday comparator), not the median', () => {
    const window = [20, 5, 5, 5, 5, 5, 5, 16]; // day-8 = 16
    const stats = seriesStats(window, 1000);
    expect(stats.wow).toBe(25); // (20-16)/16
  });

  test('no spike below the floor even when the multiplier alone would trip', () => {
    // median ~1, 3x median = 3 - latest (10) clears the multiplier easily,
    // but sits under a much higher floor - the floor must still gate it.
    const window = [10, 1, 1, 1, 1, 1, 1, 1];
    const stats = seriesStats(window, MCP_SPIKE_FLOOR, SPIKE_MULTIPLIER);
    expect(stats.latest).toBeLessThan(MCP_SPIKE_FLOOR);
    expect(stats.spike).toBe(false);
  });

  test('no spike above the floor when under 3x the median (real, organic growth)', () => {
    // latest clears the floor comfortably but stays under 3x a healthy median.
    const window = [80, 60, 65, 70, 55, 60, 62, 58];
    const stats = seriesStats(window, MCP_SPIKE_FLOOR, SPIKE_MULTIPLIER);
    expect(stats.latest).toBeGreaterThan(MCP_SPIKE_FLOOR);
    expect(stats.latest).toBeLessThan(stats.threshold);
    expect(stats.spike).toBe(false);
  });

  test('spike: exceeds BOTH the floor and 3x the trailing median', () => {
    const window = [200, 20, 22, 18, 21, 19, 20, 20]; // median ~20, 3x = 60, latest 200
    const stats = seriesStats(window, MCP_SPIKE_FLOOR, SPIKE_MULTIPLIER);
    expect(stats.latest).toBeGreaterThan(MCP_SPIKE_FLOOR);
    expect(stats.latest).toBeGreaterThan(stats.threshold);
    expect(stats.spike).toBe(true);
  });

  test('zero-to-something transition: without the floor, the first handful of real calls would "spike" against a ~0 median — the floor exists specifically to survive this', () => {
    const window = [5, 0, 0, 0, 0, 0, 0, 0]; // pre-launch: near-zero trailing history
    const noFloor = seriesStats(window, 0, SPIKE_MULTIPLIER); // 3x median(0) = 0, so 5 > 0 -> would spike
    expect(noFloor.spike).toBe(true);
    const withRealFloor = seriesStats(window, MCP_SPIKE_FLOOR, SPIKE_MULTIPLIER);
    expect(withRealFloor.spike).toBe(false);
  });

  test('Infinity floor (the digest\'s per-tool display stats) never spikes, regardless of the window', () => {
    const window = [1000, 1, 1, 1, 1, 1, 1, 1];
    const stats = seriesStats(window, Infinity);
    expect(stats.spike).toBe(false);
  });
});

test.describe('sumWindows', () => {
  test('elementwise sum across multiple same-length windows, preserving day order', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8];
    const b = [10, 10, 10, 10, 10, 10, 10, 10];
    expect(sumWindows([a, b])).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);
  });

  test('rejects mismatched window lengths rather than silently truncating', () => {
    expect(() => sumWindows([[1, 2], [1, 2, 3]])).toThrow(/same length/);
  });

  test('empty input: an empty array, not a throw', () => {
    expect(sumWindows([])).toEqual([]);
  });
});

test.describe('isoDateDaysAgo / trailingWindowDays', () => {
  test('isoDateDaysAgo: UTC calendar arithmetic, YYYY-MM-DD', () => {
    const now = new Date('2026-07-12T03:00:00Z');
    expect(isoDateDaysAgo(1, now)).toBe('2026-07-11');
    expect(isoDateDaysAgo(8, now)).toBe('2026-07-04');
  });

  test('trailingWindowDays: exactly 8 days, day-1 first, day-8 exactly 7 days before day-1 (same weekday)', () => {
    const now = new Date('2026-07-12T03:00:00Z');
    const days = trailingWindowDays(now);
    expect(days).toHaveLength(8);
    expect(days[0]).toBe('2026-07-11');
    expect(days[7]).toBe('2026-07-04');
    // Same weekday: 2026-07-11 and 2026-07-04 are both Saturdays.
    expect(new Date(`${days[0]}T00:00:00Z`).getUTCDay()).toBe(new Date(`${days[7]}T00:00:00Z`).getUTCDay());
  });
});

test.describe('formatDigestBody / spikeIssueContent', () => {
  const mcpTools = [
    { tool: 'lookup_representatives', stats: seriesStats([12, 9, 9, 9, 9, 9, 9, 9], Infinity) },
    { tool: 'get_bill', stats: seriesStats([41, 38, 38, 38, 38, 38, 38, 38], Infinity) },
  ];
  const mcpTotal = seriesStats([68, 59, 59, 59, 59, 59, 59, 59], MCP_SPIKE_FLOOR);
  const script = seriesStats([14, 11, 11, 11, 11, 11, 11, 11], SCRIPT_SPIKE_FLOOR);

  test('embeds the day marker for same-day idempotency and both floors, no spike case', () => {
    const body = formatDigestBody({ date: '2026-07-11', mcpTools, mcpTotal, script });
    expect(body).toContain('<!-- daily-metrics:2026-07-11 -->');
    expect(body).toContain('📊 Daily metrics — 2026-07-11');
    expect(body).toContain('lookup_representatives');
    expect(body).toContain('get_bill');
    expect(body).toContain(`no spike (floor ${MCP_SPIKE_FLOOR}`);
    expect(body).toContain(`no spike (floor ${SCRIPT_SPIKE_FLOOR}`);
    // Site traffic disclosure must always be present - never silently omitted.
    expect(body).toContain('Site page-view traffic: not measured');
    expect(body).toContain('@vercel/analytics');
  });

  test('spike case includes the spike issue URL when one was opened', () => {
    const spikingTotal = seriesStats([500, 20, 22, 18, 21, 19, 20, 20], MCP_SPIKE_FLOOR);
    const body = formatDigestBody({
      date: '2026-07-11',
      mcpTools,
      mcpTotal: spikingTotal,
      script,
      spikeIssueUrls: { mcp: 'https://github.com/cm2489/oravan/issues/999' },
    });
    expect(body).toContain('SPIKE');
    expect(body).toContain('https://github.com/cm2489/oravan/issues/999');
  });

  test('spikeIssueContent: unique title per series+date, discloses the self-reported/spoofable posture', () => {
    const { title, body } = spikeIssueContent({
      series: 'total MCP calls',
      date: '2026-07-11',
      stats: mcpTotal,
      floor: MCP_SPIKE_FLOOR,
    });
    expect(title).toBe('Traffic spike: total MCP calls — 2026-07-11');
    expect(body).toContain('unauthenticated and self-reported');
    expect(body).toContain(String(mcpTotal.latest));
  });
});
