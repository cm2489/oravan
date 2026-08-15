import { expect, test } from '@playwright/test';
// Relative import of the plain .mjs module - same pattern as
// tests/verify-salt.unit.spec.ts importing lib/salt.mjs / tests/
// redistricting-watch.unit.spec.ts importing lib/redistricting-watch.mjs:
// the logic tested here is exactly what scripts/daily-metrics.mjs runs
// nightly against the real counters database.
import {
  darkTools,
  DARK_TOOL_MIN_CALLS,
  DARK_TOOL_ZERO_DAYS,
  DECLINE_BASELINE_MIN_SUM,
  DECLINE_RATIO,
  DECLINE_WINDOW_DAYS,
  declineClearedComment,
  declineClearedReason,
  declineIssueContent,
  declineIssueTitle,
  declineStats,
  declineStillDecliningComment,
  declineWindowDays,
  formatDarkToolsLine,
  formatDeclineLine,
  formatDigestBody,
  formatMcpClientsLine,
  formatPercent,
  isoDateDaysAgo,
  MCP_CLIENTS_LINE_MAX,
  MCP_SPIKE_FLOOR,
  median,
  SCRIPT_SPIKE_FLOOR,
  seriesStats,
  spikeIssueContent,
  SPIKE_MULTIPLIER,
  SPIKE_WINDOW_DAYS,
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
 *
 * Extended 2026-08 with the decline half: the same math run against the
 * REAL daily total-MCP series recorded on the pinned digest issue (#81),
 * which contains the event this feature exists for — a ~95% level shift on
 * 2026-08-04/05 that the spike-only detector never surfaced.
 */

/*
 * The real recorded daily totals (all 5 MCP tools summed), copied from the
 * pinned digest issue's own comments. Days outside this range are not
 * "zero" in reality, they are simply outside what was recorded; the window
 * builder pads them with 0, which only ever makes a decline HARDER to
 * detect (a padded block sum is smaller, so the baseline gate is stricter).
 */
const REAL_MCP_TOTALS: Record<string, number> = {
  '2026-07-26': 76,
  '2026-07-27': 79,
  '2026-07-28': 28,
  '2026-07-29': 78,
  '2026-07-30': 165,
  '2026-07-31': 82,
  '2026-08-01': 104,
  '2026-08-02': 114,
  '2026-08-03': 54,
  '2026-08-04': 12,
  '2026-08-05': 4,
  '2026-08-06': 4,
  '2026-08-07': 5,
  '2026-08-08': 5,
  '2026-08-09': 4,
  '2026-08-10': 4,
  '2026-08-11': 6,
  '2026-08-12': 6,
  '2026-08-13': 10,
  '2026-08-14': 2,
};

/** The 28-day window the digest would have read on the morning of `runDate`
 *  (day-1 = the day before it), from the real series above. */
function realWindow(runDate: string, extra: Record<string, number> = {}): number[] {
  const totals = { ...REAL_MCP_TOTALS, ...extra };
  return declineWindowDays(new Date(`${runDate}T13:00:00Z`)).map((d) => totals[d] ?? 0);
}

/** N consecutive days at the same level, for the clearly-synthetic
 *  continuations below (labeled as such at every use). */
function level(from: string, days: number, value: number): Record<string, number> {
  const out: Record<string, number> = {};
  const start = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < days; i += 1) {
    out[new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10)] = value;
  }
  return out;
}

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
    // Re-scaled with the 2026-08 floor recalibration (50 -> 150) — the shape
    // under test is unchanged, only the level it has to clear.
    const window = [200, 160, 165, 170, 155, 160, 162, 158];
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

test.describe('spike floors', () => {
  test('MCP floor is the recalibrated 150 and the script floor stays 20 (the paid-path cost tripwire)', () => {
    expect(MCP_SPIKE_FLOOR).toBe(150);
    expect(SCRIPT_SPIKE_FLOOR).toBe(20);
  });

  test('the July directory-crawler plateau no longer clears the floor', () => {
    // The plateau's ordinary days (76-114 total calls) fired four zero-action
    // alerts under the old floor of 50. Under 150 the floor alone stops them,
    // before the multiplier is even consulted.
    for (const day of [76, 79, 78, 82, 104, 114]) {
      expect(day).toBeGreaterThan(50); // would have cleared the OLD floor
      expect(day).toBeLessThan(MCP_SPIKE_FLOOR); // does not clear the new one
    }
  });

  test('the 165 peak still fires — the floor retires the plateau, never a real burst', () => {
    // The real 8-day window the digest read on 2026-07-30 (#81): the plateau
    // was four days old, the week before it near-zero, so the trailing median
    // was 28 and 3× median = 84. 165 clears BOTH gates — by design. The
    // recalibration retires #127–#129 (76/79/78) and would have kept #130.
    const stats = seriesStats([165, 78, 28, 79, 76, 19, 6, 9], MCP_SPIKE_FLOOR);
    expect(stats.med).toBe(28);
    expect(stats.spike).toBe(true);
  });
});

test.describe('declineStats (the real #81 series)', () => {
  test('fires on the Aug-12 digest shape: 32 calls in the last 7 days against 609 the week before', () => {
    const stats = declineStats(realWindow('2026-08-12'));
    expect(stats.recent).toBe(32); // Aug 11 back through Aug 5
    expect(stats.prior).toBe(609); // Aug 4 back through Jul 29
    expect(stats.baseline).toBe(609);
    expect(stats.hasBaseline).toBe(true);
    expect(stats.threshold).toBe(DECLINE_RATIO * 609);
    expect(stats.declining).toBe(true);
  });

  test("fires on today's shape too — the state has persisted, which is why it is one standing issue", () => {
    const stats = declineStats(realWindow('2026-08-15'));
    expect(stats.recent).toBe(37); // Aug 14 back through Aug 8
    expect(stats.prior).toBe(297); // Aug 7 back through Aug 1
    expect(stats.baseline).toBe(508); // days 15-21 are the higher block here
    expect(stats.declining).toBe(true);
  });

  test('does NOT fire before the break — the same detector on Aug-03 reports nothing', () => {
    const stats = declineStats(realWindow('2026-08-03'));
    expect(stats.recent).toBe(650);
    expect(stats.declining).toBe(false);
    expect(declineClearedReason(stats)).toBe('recovered');
  });

  test('the baseline is max(prior, prior-prior), so ONE quiet week cannot silence a real decline', () => {
    const window = [
      ...new Array(7).fill(1), // B0: collapsed
      ...new Array(7).fill(2), // B1: also low — a quiet week
      ...new Array(7).fill(40), // B2: the real baseline, 280
      ...new Array(7).fill(0),
    ];
    const stats = declineStats(window);
    expect(stats.prior).toBe(14);
    expect(stats.priorPrior).toBe(280);
    expect(stats.baseline).toBe(280);
    expect(stats.declining).toBe(true);
  });

  test('sums, not medians: the real break is nearly invisible to a median and obvious to a sum', () => {
    const window = realWindow('2026-08-15');
    const b0 = window.slice(0, 7);
    const b1 = window.slice(7, 14);
    // Medians: 5 vs 12 — a 2.4x gap, under the 3x the spike side calls
    // meaningful, because a median throws away the four big days that were
    // the entire baseline. Sums: 37 vs 297, an 8x collapse.
    expect(median(b0)).toBe(5);
    expect(median(b1)).toBe(12);
    expect(median(b1) / median(b0)).toBeLessThan(SPIKE_MULTIPLIER);
    expect(declineStats(window).prior / declineStats(window).recent).toBeGreaterThan(SPIKE_MULTIPLIER);
    expect(declineStats(window).declining).toBe(true);
  });

  test(`rejects a window that is not exactly ${DECLINE_WINDOW_DAYS} values`, () => {
    expect(() => declineStats(new Array(8).fill(1))).toThrow(new RegExp(`exactly ${DECLINE_WINDOW_DAYS}`));
  });
});

test.describe('declineStats baseline gate (the near-zero series can never fire)', () => {
  test('an all-zero series (script generations today) can never report a decline', () => {
    const stats = declineStats(new Array(DECLINE_WINDOW_DAYS).fill(0));
    expect(stats.baseline).toBe(0);
    expect(stats.hasBaseline).toBe(false);
    expect(stats.declining).toBe(false);
  });

  test('a series that collapses to zero from a level that was never a real baseline still cannot fire', () => {
    // 9/day is a 63-per-week block — under DECLINE_BASELINE_MIN_SUM (70), so
    // "it fell" cannot be asserted no matter how completely it fell.
    const window = [...new Array(7).fill(0), ...new Array(21).fill(9)];
    const stats = declineStats(window);
    expect(stats.recent).toBe(0);
    expect(stats.baseline).toBe(63);
    expect(stats.baseline).toBeLessThan(DECLINE_BASELINE_MIN_SUM);
    expect(stats.declining).toBe(false);
  });

  test('one call/day more, and the same collapse DOES fire — the gate is the baseline, nothing else', () => {
    const window = [...new Array(7).fill(0), ...new Array(21).fill(10)];
    const stats = declineStats(window);
    expect(stats.baseline).toBe(70);
    expect(stats.baseline).toBeGreaterThanOrEqual(DECLINE_BASELINE_MIN_SUM);
    expect(stats.declining).toBe(true);
  });
});

test.describe('declineClearedReason — two distinct reasons, never one "resolved"', () => {
  // Both continuations below are SYNTHETIC extensions of the real series
  // (nothing after 2026-08-14 was recorded); they exist to exercise the two
  // exits, not to claim a future.
  test('recovered: the recent block climbs back above the trigger while a baseline still stands', () => {
    const stats = declineStats(realWindow('2026-08-29', level('2026-08-15', 14, 60)));
    expect(stats.recent).toBe(420);
    expect(stats.hasBaseline).toBe(true);
    expect(stats.declining).toBe(false);
    expect(declineClearedReason(stats)).toBe('recovered');
  });

  test('no_baseline: the big weeks age out, traffic is flat and low, and the comparison can no longer be made', () => {
    const stats = declineStats(realWindow('2026-08-29', level('2026-08-15', 14, 5)));
    expect(stats.recent).toBe(35);
    expect(stats.prior).toBe(35); // flat — emphatically NOT a recovery
    expect(stats.hasBaseline).toBe(false);
    expect(declineClearedReason(stats)).toBe('no_baseline');
  });

  test('null while the decline is live — a live state is never "cleared"', () => {
    expect(declineClearedReason(declineStats(realWindow('2026-08-15')))).toBeNull();
  });
});

test.describe('darkTools', () => {
  const zeros = (n: number) => new Array(n).fill(0);

  test('a tool with real history and then 14 consecutive zero days is dark', () => {
    const window = [...zeros(DARK_TOOL_ZERO_DAYS), 3, 2, 1, ...zeros(DECLINE_WINDOW_DAYS - DARK_TOOL_ZERO_DAYS - 3)];
    const [found] = darkTools([{ tool: 'whats_moving', window }]);
    expect(found).toEqual({ tool: 'whats_moving', calls: 6, zeroDays: DARK_TOOL_ZERO_DAYS });
  });

  test('a tool that was NEVER active is not dark — "nobody ever called this" is a product fact, not an incident', () => {
    expect(darkTools([{ tool: 'get_representative', window: zeros(DECLINE_WINDOW_DAYS) }])).toEqual([]);
  });

  test(`under ${DARK_TOOL_MIN_CALLS} lifetime calls in the window is not enough history to call it dark`, () => {
    const window = [...zeros(20), 1, 1, 1, 1, ...zeros(4)]; // 4 calls, then 20 zero days
    expect(darkTools([{ tool: 'search_bills', window }])).toEqual([]);
  });

  test(`${DARK_TOOL_ZERO_DAYS - 1} zero days is not yet dark — the rule is two FULL weeks`, () => {
    const window = [...zeros(DARK_TOOL_ZERO_DAYS - 1), 9, ...zeros(DECLINE_WINDOW_DAYS - DARK_TOOL_ZERO_DAYS)];
    expect(darkTools([{ tool: 'get_bill', window }])).toEqual([]);
  });

  test('a currently-active tool is never dark, however lumpy', () => {
    const window = [4, ...zeros(26), 30];
    expect(darkTools([{ tool: 'lookup_representatives', window }])).toEqual([]);
  });

  test('finds the one broken tool inside an otherwise healthy set — an aggregate total cannot', () => {
    const healthy = new Array(DECLINE_WINDOW_DAYS).fill(20);
    const broken = [...zeros(DARK_TOOL_ZERO_DAYS), ...new Array(DECLINE_WINDOW_DAYS - DARK_TOOL_ZERO_DAYS).fill(9)];
    const found = darkTools([
      { tool: 'lookup_representatives', window: healthy },
      { tool: 'whats_moving', window: broken },
      { tool: 'get_bill', window: healthy },
    ]);
    expect(found.map((d) => d.tool)).toEqual(['whats_moving']);
    // The aggregate stays comfortably healthy the whole time — which is the point.
    expect(declineStats(sumWindows([healthy, broken, healthy])).declining).toBe(false);
  });

  test('rejects a window that is not the full decline window', () => {
    expect(() => darkTools([{ tool: 'get_bill', window: [0, 0, 0] }])).toThrow(new RegExp(`exactly ${DECLINE_WINDOW_DAYS}`));
  });
});

test.describe('formatDeclineLine / formatDarkToolsLine', () => {
  test('declining: prints the three block sums, the baseline, the trigger, and the issue link', () => {
    const stats = declineStats(realWindow('2026-08-15'));
    const line = formatDeclineLine(stats, 'https://github.com/cm2489/oravan/issues/999');
    expect(line).toContain('DECLINE');
    expect(line).toContain('last 7d 37');
    expect(line).toContain('prior 7d 297');
    expect(line).toContain('baseline 508');
    expect(line).toContain('https://github.com/cm2489/oravan/issues/999');
  });

  test('healthy: still prints the sums, so the line is readable on an ordinary day too', () => {
    const line = formatDeclineLine(declineStats(realWindow('2026-08-03')));
    expect(line).toContain('no decline');
    expect(line).toContain('last 7d 650');
  });

  test('no baseline: says so explicitly rather than implying an all-clear', () => {
    const line = formatDeclineLine(declineStats(new Array(DECLINE_WINDOW_DAYS).fill(0)));
    expect(line).toContain('no baseline to fall from');
    expect(line).toContain(String(DECLINE_BASELINE_MIN_SUM));
  });

  test('dark-tools line names the tool with its call count and zero streak; empty list renders nothing', () => {
    expect(formatDarkToolsLine([])).toBe('');
    const line = formatDarkToolsLine([{ tool: 'whats_moving', calls: 12, zeroDays: 18 }]);
    expect(line).toContain('whats_moving');
    expect(line).toContain('12 calls');
    expect(line).toContain('0 for 18d');
  });
});

test.describe('declineIssueContent / declineStillDecliningComment / declineClearedComment', () => {
  const stats = declineStats(realWindow('2026-08-15'));

  test('the title is date-free and stable — ONE standing issue, never one per day', () => {
    const first = declineIssueContent({ series: 'total MCP calls', date: '2026-08-12', stats });
    const later = declineIssueContent({ series: 'total MCP calls', date: '2026-08-15', stats });
    expect(first.title).toBe('Traffic decline: total MCP calls (standing)');
    expect(first.title).toBe(later.title);
    expect(first.title).toBe(declineIssueTitle('total MCP calls'));
    expect(first.title).not.toContain('2026-08');
  });

  test('the body carries the numbers, the date it was last rewritten, and the self-reported disclosure', () => {
    const { body } = declineIssueContent({
      series: 'total MCP calls',
      date: '2026-08-15',
      stats,
      darkTools: [{ tool: 'whats_moving', calls: 12, zeroDays: 18 }],
    });
    expect(body).toContain('**37**');
    expect(body).toContain('297');
    expect(body).toContain('**508**');
    expect(body).toContain('2026-08-15');
    expect(body).toContain('whats_moving');
    expect(body).toContain('one standing issue for a STATE, not one issue per day');
    expect(body).toContain('unauthenticated and self-reported');
  });

  test('the persistence comment is dated and carries a same-day re-run marker', () => {
    const comment = declineStillDecliningComment({ series: 'total MCP calls', date: '2026-08-15', stats });
    expect(comment).toContain('<!-- traffic-decline:2026-08-15 -->');
    expect(comment).toContain('Still declining — 2026-08-15');
    expect(comment).toContain('37');
    expect(comment).toContain('508');
  });

  test('recovered and no_baseline read as DIFFERENT outcomes, both with their numbers', () => {
    const recovered = declineClearedComment({
      reason: 'recovered',
      series: 'total MCP calls',
      date: '2026-08-29',
      stats: declineStats(realWindow('2026-08-29', level('2026-08-15', 14, 60))),
    });
    const agedOut = declineClearedComment({
      reason: 'no_baseline',
      series: 'total MCP calls',
      date: '2026-08-29',
      stats: declineStats(realWindow('2026-08-29', level('2026-08-15', 14, 5))),
    });

    expect(recovered).toContain('Recovered');
    expect(recovered).toContain('420');
    expect(recovered).not.toContain('NOT a recovery');

    expect(agedOut).toContain('NOT a recovery');
    expect(agedOut).toContain('no baseline left to compare against');
    expect(agedOut).toContain('35');

    expect(recovered).not.toBe(agedOut);
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

  test('the count param defaults to the 8-day spike window — existing callers are unaffected', () => {
    const now = new Date('2026-07-12T03:00:00Z');
    expect(SPIKE_WINDOW_DAYS).toBe(8);
    expect(trailingWindowDays(now)).toEqual(trailingWindowDays(now, SPIKE_WINDOW_DAYS));
    expect(trailingWindowDays(now, 3)).toEqual(['2026-07-11', '2026-07-10', '2026-07-09']);
  });

  test(`declineWindowDays: ${DECLINE_WINDOW_DAYS} days, and its first 8 ARE trailingWindowDays()`, () => {
    const now = new Date('2026-07-12T03:00:00Z');
    const wide = declineWindowDays(now);
    expect(wide).toHaveLength(DECLINE_WINDOW_DAYS);
    expect(wide[0]).toBe('2026-07-11');
    expect(wide[DECLINE_WINDOW_DAYS - 1]).toBe('2026-06-14');
    expect(wide.slice(0, SPIKE_WINDOW_DAYS)).toEqual(trailingWindowDays(now));
  });
});

test.describe('the widened read leaves the spike math byte-identical', () => {
  test('seriesStats on the 28-day window\'s 8-day prefix === seriesStats on an 8-day window', () => {
    const now = new Date('2026-08-15T13:00:00Z');
    const eight = trailingWindowDays(now).map((d) => REAL_MCP_TOTALS[d] ?? 0);
    const twentyEight = declineWindowDays(now).map((d) => REAL_MCP_TOTALS[d] ?? 0);

    expect(twentyEight.slice(0, SPIKE_WINDOW_DAYS)).toEqual(eight);
    expect(seriesStats(twentyEight.slice(0, SPIKE_WINDOW_DAYS), MCP_SPIKE_FLOOR)).toEqual(
      seriesStats(eight, MCP_SPIKE_FLOOR)
    );
  });

  test('summing 28-day windows then slicing === slicing then summing (the aggregate total path)', () => {
    const a = Array.from({ length: DECLINE_WINDOW_DAYS }, (_, i) => i);
    const b = Array.from({ length: DECLINE_WINDOW_DAYS }, (_, i) => i * 2);
    const sliceThenSum = sumWindows([a.slice(0, SPIKE_WINDOW_DAYS), b.slice(0, SPIKE_WINDOW_DAYS)]);
    const sumThenSlice = sumWindows([a, b]).slice(0, SPIKE_WINDOW_DAYS);
    expect(sumThenSlice).toEqual(sliceThenSum);
  });
});

test.describe('formatMcpClientsLine', () => {
  test('descending by count, "name: N" comma-joined, exact line shape', () => {
    expect(
      formatMcpClientsLine([
        { client: 'glama', count: 3 },
        { client: 'claude-ai', count: 12 },
      ])
    ).toBe('MCP client handshakes yesterday: claude-ai: 12, glama: 3');
  });

  test('equal counts tie-break alphabetically (a stable line, not map-order luck)', () => {
    expect(
      formatMcpClientsLine([
        { client: 'unknown', count: 3 },
        { client: 'glama', count: 3 },
      ])
    ).toBe('MCP client handshakes yesterday: glama: 3, unknown: 3');
  });

  test(`caps at ${MCP_CLIENTS_LINE_MAX} clients — the top ones by count, the rest silently omitted`, () => {
    const clients = Array.from({ length: 8 }, (_, i) => ({ client: `client-${i}`, count: i + 1 }));
    const line = formatMcpClientsLine(clients);
    expect(line).toBe(
      'MCP client handshakes yesterday: client-7: 8, client-6: 7, client-5: 6, client-4: 5, client-3: 4'
    );
    expect(line).not.toContain('client-0'); // the smallest counts fall off, never the biggest
  });

  test('empty input: honest "none recorded" fallback, never an empty-looking half-line', () => {
    expect(formatMcpClientsLine([])).toBe('MCP client handshakes yesterday: none recorded');
  });

  test('zero-count entries are dropped — an all-zero day reads as none recorded, not "x: 0"', () => {
    expect(formatMcpClientsLine([{ client: 'claude-ai', count: 0 }])).toBe(
      'MCP client handshakes yesterday: none recorded'
    );
  });

  test('does not mutate its input', () => {
    const input = [
      { client: 'b', count: 1 },
      { client: 'a', count: 2 },
    ];
    formatMcpClientsLine(input);
    expect(input.map((c) => c.client)).toEqual(['b', 'a']);
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

  test('includes the MCP client-handshake line, with the honest fallback when none were recorded', () => {
    const withClients = formatDigestBody({
      date: '2026-07-11',
      mcpTools,
      mcpTotal,
      script,
      mcpClients: [
        { client: 'claude-ai', count: 12 },
        { client: 'glama', count: 3 },
      ],
    });
    expect(withClients).toContain('MCP client handshakes yesterday: claude-ai: 12, glama: 3');

    // mcpClients omitted entirely (and the pre-handshake-family call shape):
    // the line still appears, honestly empty — never silently missing.
    const without = formatDigestBody({ date: '2026-07-11', mcpTools, mcpTotal, script });
    expect(without).toContain('MCP client handshakes yesterday: none recorded');
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

  test('the 28-day trend line prints EVERY day, healthy or not', () => {
    const healthy = formatDigestBody({
      date: '2026-08-04',
      mcpTools,
      mcpTotal,
      script,
      mcpDecline: declineStats(realWindow('2026-08-03')),
    });
    expect(healthy).toContain('28d trend: no decline');
    expect(healthy).toContain('last 7d 650');

    const declining = formatDigestBody({
      date: '2026-08-15',
      mcpTools,
      mcpTotal,
      script,
      mcpDecline: declineStats(realWindow('2026-08-15')),
      declineIssueUrl: 'https://github.com/cm2489/oravan/issues/998',
    });
    expect(declining).toContain('28d trend: ⚠ DECLINE');
    expect(declining).toContain('last 7d 37');
    expect(declining).toContain('https://github.com/cm2489/oravan/issues/998');
  });

  test('a missing 28-day window says so out loud — never a silently absent line', () => {
    const body = formatDigestBody({ date: '2026-08-15', mcpTools, mcpTotal, script });
    expect(body).toContain('28d trend: not computed');
  });

  test('the dark-tools line appears only when something is dark', () => {
    const base = { date: '2026-08-15', mcpTools, mcpTotal, script, mcpDecline: declineStats(realWindow('2026-08-15')) };
    expect(formatDigestBody({ ...base, darkTools: [] })).not.toContain('Dark tools');
    const withDark = formatDigestBody({
      ...base,
      darkTools: [{ tool: 'whats_moving', calls: 12, zeroDays: 18 }],
    });
    expect(withDark).toContain('Dark tools');
    expect(withDark).toContain('whats_moving (12 calls');
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
