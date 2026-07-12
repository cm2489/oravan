/*
 * Daily-metrics digest math — the ONE copy (traffic-watch design, 2026-07).
 * Plain .mjs with JSDoc types, no side effects, following lib/salt.mjs's
 * pattern so scripts/daily-metrics.mjs (which runs nightly against real
 * Upstash data) and tests/traffic-metrics.unit.spec.ts (which exercises
 * this against fixtures, including the zero-median edge case) import the
 * exact same logic — never two copies of the spike/median/formatting math
 * drifting apart.
 *
 * Trailing-window shape (8 values per series, oldest last):
 *   index 0        "day-1"  = yesterday — the value this digest reports
 *   index 1..6     "day-2".."day-7" — 6 of the 7-day median window
 *   index 7        "day-8"  = the trailing-7-day median window's 7th day,
 *                              AND the WoW same-weekday comparator (exactly
 *                              7 days before day-1, so the same weekday)
 *
 * scripts/daily-metrics.mjs is the only caller and owns building this
 * array from real dates; every function below is order-agnostic beyond
 * "index 0 is latest, index 1..7 is the trailing week."
 */

/** Spike check multiplier: latest must exceed BOTH the floor and this many
 *  times the trailing-7-day median to count as a spike. */
export const SPIKE_MULTIPLIER = 3;

// Tunable, NOT derived from real demand — the product is pre-public-launch
// (STATUS.md: soft-public launch M14), so real MCP/script volume today is
// near-zero and a trailing-7-day median of ~0 would make `3 × median = 0`
// — without a floor, the first handful of real calls would "spike." These
// exist specifically to survive the zero-to-something transition; revisit
// once there's a real baseline.
export const MCP_SPIKE_FLOOR = 50; // total MCP calls/day, all 5 tools summed
export const SCRIPT_SPIKE_FLOOR = 20; // script generations/day

/**
 * @param {number[]} nums
 * @returns {number} the median, 0 for an empty array
 */
export function median(nums) {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Week-over-week percent change, latest vs. the same weekday one week ago.
 * `null` (rendered "N/A") when the comparator is 0 and latest is also 0 —
 * a real percentage cannot be computed from 0-vs-0, and reporting "+0%"
 * would falsely imply a measured baseline existed. 0 -> nonzero is +Infinity
 * in real percentage terms; reported as `null` too (same "cannot be
 * expressed as a normal percent" reasoning), left to the caller to render
 * as "new" rather than a misleading number.
 * @param {number} latest
 * @param {number} weekAgo
 * @returns {number | null} rounded to the nearest whole percent
 */
export function weekOverWeek(latest, weekAgo) {
  if (weekAgo === 0) return latest === 0 ? 0 : null;
  return Math.round(((latest - weekAgo) / weekAgo) * 100);
}

/**
 * @typedef {Object} SeriesStats
 * @property {number} latest
 * @property {number} med - trailing-7-day median (day-2..day-8)
 * @property {number | null} wow - week-over-week percent, or null ("N/A")
 * @property {number} threshold - SPIKE_MULTIPLIER * med, for display
 * @property {boolean} spike - latest exceeds BOTH floor and threshold
 */

/**
 * @param {number[]} window - exactly 8 values, day-1 first through day-8 last
 * @param {number} floor
 * @param {number} multiplier
 * @returns {SeriesStats}
 */
export function seriesStats(window, floor, multiplier = SPIKE_MULTIPLIER) {
  if (window.length !== 8) {
    throw new Error(`seriesStats expects exactly 8 values (day-1..day-8), got ${window.length}`);
  }
  const [latest, ...rest] = window; // rest = day-2..day-8, 7 values
  const weekAgo = window[7]; // day-8
  const med = median(rest);
  const threshold = multiplier * med;
  return {
    latest,
    med,
    wow: weekOverWeek(latest, weekAgo),
    threshold,
    spike: latest > floor && latest > threshold,
  };
}

/** Elementwise sum of same-length windows — used to build the "total MCP
 *  calls" aggregate series from the 5 per-tool windows before running
 *  seriesStats on it once (spike-checked in aggregate, not per-tool — see
 *  the design's own disclosed rationale: per-tool volumes are low/uneven
 *  and would false-alarm). */
export function sumWindows(windows) {
  const length = windows[0]?.length ?? 0;
  const out = new Array(length).fill(0);
  for (const w of windows) {
    if (w.length !== length) throw new Error('sumWindows: all windows must be the same length');
    for (let i = 0; i < length; i++) out[i] += w[i];
  }
  return out;
}

/** "+33%" / "-12%" / "0%" / "N/A" */
export function formatPercent(wow) {
  if (wow === null) return 'N/A';
  return `${wow > 0 ? '+' : ''}${wow}%`;
}

function pad(s, n) {
  return String(s).padEnd(n);
}

/**
 * @param {Object} input
 * @param {string} input.date - YYYY-MM-DD, the date this digest reports (day-1)
 * @param {Array<{ tool: string, stats: SeriesStats }>} input.mcpTools - 5 entries, TOOL_NAMES order
 * @param {SeriesStats} input.mcpTotal
 * @param {SeriesStats} input.script
 * @param {{ mcp?: string, script?: string }} [input.spikeIssueUrls] - populated only when that aggregate tripped and an issue was filed/found
 * @returns {string} the full digest comment body, markdown, with the day marker embedded
 */
export function formatDigestBody({ date, mcpTools, mcpTotal, script, spikeIssueUrls = {} }) {
  const nameWidth = Math.max(...mcpTools.map((t) => t.tool.length), '── total'.length) + 2;
  const toolLines = mcpTools.map(
    ({ tool, stats }) =>
      `  ${pad(tool, nameWidth)}${pad(stats.latest, 6)}(7d median ${stats.med}, WoW ${formatPercent(stats.wow)})`
  );
  const totalNote = mcpTotal.spike
    ? `— ⚠ SPIKE (floor ${MCP_SPIKE_FLOOR}, 3× median ${mcpTotal.threshold})${
        spikeIssueUrls.mcp ? ` — see ${spikeIssueUrls.mcp}` : ''
      }`
    : `— no spike (floor ${MCP_SPIKE_FLOOR}, 3× median ${mcpTotal.threshold})`;
  const totalLine = `  ${pad('── total', nameWidth)}${pad(mcpTotal.latest, 6)}(7d median ${mcpTotal.med}, WoW ${formatPercent(
    mcpTotal.wow
  )})  ${totalNote}`;

  const scriptNote = script.spike
    ? `— ⚠ SPIKE (floor ${SCRIPT_SPIKE_FLOOR}, 3× median ${script.threshold})${
        spikeIssueUrls.script ? ` — see ${spikeIssueUrls.script}` : ''
      }`
    : `— no spike (floor ${SCRIPT_SPIKE_FLOOR}, 3× median ${script.threshold})`;
  const scriptLine = `  ${pad(script.latest, 4)}(7d median ${script.med}, WoW ${formatPercent(script.wow)})  ${scriptNote}`;

  return [
    `<!-- daily-metrics:${date} -->`,
    `📊 Daily metrics — ${date}`,
    '',
    '```',
    'MCP tool calls (production)',
    ...toolLines,
    totalLine,
    '',
    'Script generations (production, cache-miss only)',
    scriptLine,
    '```',
    '',
    'Site page-view traffic: not measured. Vercel\'s Web Analytics API needs the ' +
      '@vercel/analytics client script, which CLAUDE.md permanently bans. Vercel\'s ' +
      'server-side Observability (Edge Requests, no client script) has no REST API ' +
      '— dashboard-only. See the pinned issue\'s first comment for the full note.',
    '',
    '_MCP/script counts are unauthenticated and self-reported, spoofable-in-volume ' +
      'like every other counters-DB write in this repo — best-effort operating ' +
      'signal, never audited or fraud-proof._',
  ].join('\n');
}

/**
 * @param {Object} input
 * @param {'total MCP calls' | 'script generations'} input.series
 * @param {string} input.date
 * @param {SeriesStats} input.stats
 * @param {number} input.floor
 * @returns {{ title: string, body: string }}
 */
export function spikeIssueContent({ series, date, stats, floor }) {
  const title = `Traffic spike: ${series} — ${date}`;
  const body = [
    `**${series}** on ${date}: **${stats.latest}**, trailing-7-day median **${stats.med}** ` +
      `(threshold 3× median = ${stats.threshold}, floor = ${floor}).`,
    '',
    `Week-over-week (same weekday): ${formatPercent(stats.wow)}.`,
    '',
    'Tunables: `SPIKE_MULTIPLIER = 3`, floor is a placeholder with zero real-traffic ' +
      'basis (pre-launch product) — see `lib/traffic-metrics.mjs`.',
    '',
    '_MCP/script counts are unauthenticated and self-reported — spoofable-in-volume ' +
      'like every other counters-DB write in this repo, same threat model as the ' +
      'rate-limit counters and impression counts. Best-effort, never audited or ' +
      'fraud-proof._',
  ].join('\n');
  return { title, body };
}

/** UTC calendar date, YYYY-MM-DD, `daysAgo` days before `now`. */
export function isoDateDaysAgo(daysAgo, now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo));
  return d.toISOString().slice(0, 10);
}

/** The 8 calendar-date strings this digest needs, day-1 (yesterday) first
 *  through day-8 last — the exact order every function above expects. */
export function trailingWindowDays(now = new Date()) {
  return Array.from({ length: 8 }, (_, i) => isoDateDaysAgo(i + 1, now));
}
