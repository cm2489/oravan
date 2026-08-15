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
 *
 * DECLINE WINDOW (added 2026-08). The spike math above only ever asks "is
 * today unusually BIG?" — so the one thing that actually happened to this
 * product's MCP traffic went unreported for eleven days. The real daily
 * totals on the pinned digest issue (#81) ran 76/79/28/78/165/82/104/114/54
 * through Aug 3 and then 12/4/4/5/5/4/4/6/6/10/2 from Aug 4 onward: a ~95%
 * level shift that no spike detector can see, because a collapse is never
 * above a threshold. The decline half below reads a 28-value window of the
 * SAME shape (index 0 = day-1 = yesterday, oldest last) and compares
 * 7-day BLOCK SUMS, never percentages and never medians — across that
 * break the two weeks' medians are 5 and 12, which says almost nothing,
 * while their sums are 37 and 297, which says the channel died. See
 * declineStats for the full reasoning.
 *
 * The 8-day trailing window the spike math needs is exactly the first 8
 * values of the 28-day window, so scripts/daily-metrics.mjs reads ONE
 * window and slices it — the spike path's inputs are byte-identical to what
 * they were when it read 8 days directly.
 */

/** Spike check multiplier: latest must exceed BOTH the floor and this many
 *  times the trailing-7-day median to count as a spike. */
export const SPIKE_MULTIPLIER = 3;

// Both floors exist first to survive the zero-to-something transition: a
// trailing-7-day median of ~0 makes `3 × median = 0`, so without a floor
// the first handful of real calls would "spike."
//
// MCP_SPIKE_FLOOR: 50 → 150, recalibrated 2026-08 (owner-approved) against
// the first month of REAL data on the pinned digest issue (#81) rather than
// the pre-launch guess it started as. BASIS: the July 2026 directory-
// crawler plateau ran at 76–114 calls/day, peaked at 165, and fired four
// consecutive alerts that produced zero action (#127–#130) before it
// drained away on its own. 150 retires that noise — the plateau's ordinary
// days all sit under it — while still alarming at roughly 25× today's
// median (~6/day). Stated precisely so nobody has to re-derive it: the one
// 165 day IS above 150, and stays quiet only because the second gate holds
// there (a plateau raises its own trailing median, so a single peak inside
// one does not clear 3× median). The floor retires the plateau; the
// multiplier retires its peak.
export const MCP_SPIKE_FLOOR = 150; // total MCP calls/day, all 5 tools summed

// SCRIPT_SPIKE_FLOOR: unchanged at 20, deliberately. BASIS: it is not a
// traffic signal, it is the cost tripwire on the only paid path in the
// product — /api/script counts real cache-MISS generations, i.e. actual
// Anthropic spend (lib/usage.ts). A low bar there is the point; it is meant
// to be noticed, and there has been no false alarm to retire.
export const SCRIPT_SPIKE_FLOOR = 20; // script generations/day

// --- decline detection tunables (2026-08) -----------------------------------
//
// Owner-approved values. Each carries its own basis; none is a placeholder.

// DECLINE_WINDOW_DAYS: 28. BASIS: the smallest window that holds three
// full 7-day blocks (the compared block plus TWO priors) with a week of
// slack, and short enough to stay well inside lib/usage.ts's 90-day counter
// TTL. Three blocks matter: one prior block alone would let a single quiet
// holiday week erase the baseline and silence the alarm.
export const DECLINE_WINDOW_DAYS = 28;

// DECLINE_BLOCK_DAYS: 7. BASIS: whole weeks are the only unit that cancels
// this traffic's weekday/weekend shape — the same reason the spike math
// compares day-1 against day-8 rather than day-1 against day-2.
export const DECLINE_BLOCK_DAYS = 7;

// DECLINE_BASELINE_MIN_SUM: 70. BASIS: a real ~10/day baseline must have
// EXISTED before "it fell" means anything. 70 calls across a 7-day block is
// that baseline. This is the gate that makes the whole check safe to run on
// a pre-launch product: a series that has always been near zero — script
// generations today, or MCP before it had any clients — can never satisfy
// it, so it can never file a decline issue about traffic it never had.
export const DECLINE_BASELINE_MIN_SUM = 70;

// DECLINE_RATIO: 0.25. BASIS: the real event this was built for was a ~95%
// drop (609 calls in a week → 32 the next). A quarter of the baseline is
// far below ordinary week-to-week movement — organic weeks in the same
// record moved by tens of percent, never by 75% — so this fires on a
// channel dying, not on a slow week.
export const DECLINE_RATIO = 0.25;

// DARK_TOOL_MIN_CALLS: 5. BASIS: a tool needs a real usage history before
// its silence is information; below a handful of lifetime calls in the
// window, "zero this fortnight" is indistinguishable from "nobody ever
// used it," which is a product fact, not an incident.
export const DARK_TOOL_MIN_CALLS = 5;

// DARK_TOOL_ZERO_DAYS: 14. BASIS: two full weeks of exact zeros. One week
// is a holiday; two consecutive weeks with not one call, on a tool that
// demonstrably had callers inside the same 28 days, is a broken tool or a
// dropped integration.
export const DARK_TOOL_ZERO_DAYS = 14;

/** Length of the trailing window the SPIKE math reads — the first 8 values
 *  of the 28-day decline window. */
export const SPIKE_WINDOW_DAYS = 8;

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

function sum(nums) {
  return nums.reduce((a, b) => a + b, 0);
}

/**
 * @typedef {Object} DeclineStats
 * @property {number} recent - sum of block B0, days 1-7 (the most recent week)
 * @property {number} prior - sum of block B1, days 8-14
 * @property {number} priorPrior - sum of block B2, days 15-21
 * @property {number} baseline - max(prior, priorPrior), the block it "fell from"
 * @property {number} threshold - DECLINE_RATIO * baseline, the trigger level
 * @property {boolean} hasBaseline - baseline >= DECLINE_BASELINE_MIN_SUM
 * @property {boolean} declining - hasBaseline AND recent <= threshold
 */

/**
 * Is this series in a sustained DECLINE? Compares the most recent 7-day
 * block against the better of the two 7-day blocks before it.
 *
 * SUMS, never percentages and never medians. A median is the wrong
 * instrument here by construction, and the real numbers say so exactly: the
 * two weeks either side of this product's break have medians of 5 and 12 —
 * a 2.4× gap, UNDER the 3× the spike half already treats as meaningful —
 * while their sums are 37 and 297, an 8× collapse. A median throws away the
 * four big days that WERE the baseline. (Pinned by
 * tests/traffic-metrics.unit.spec.ts.) Percentages fail in the other
 * direction: 2 calls against 1 is +100%.
 *
 * The baseline is max(B1, B2), not B1 alone, so ONE quiet week cannot erase
 * the thing being compared against and silence a real decline — and
 * DECLINE_BASELINE_MIN_SUM gates the whole check on a real baseline having
 * existed at all, which is what keeps a series that has always been near
 * zero (script generations today) from ever reporting that it "fell."
 *
 * @param {number[]} window - exactly DECLINE_WINDOW_DAYS values, day-1 first
 * @returns {DeclineStats}
 */
export function declineStats(window) {
  if (window.length !== DECLINE_WINDOW_DAYS) {
    throw new Error(
      `declineStats expects exactly ${DECLINE_WINDOW_DAYS} values (day-1..day-${DECLINE_WINDOW_DAYS}), got ${window.length}`
    );
  }
  const block = (n) => window.slice(n * DECLINE_BLOCK_DAYS, (n + 1) * DECLINE_BLOCK_DAYS);
  const recent = sum(block(0)); // B0: days 1-7, the most recent week
  const prior = sum(block(1)); // B1: days 8-14
  const priorPrior = sum(block(2)); // B2: days 15-21
  const baseline = Math.max(prior, priorPrior);
  const threshold = DECLINE_RATIO * baseline;
  const hasBaseline = baseline >= DECLINE_BASELINE_MIN_SUM;
  return {
    recent,
    prior,
    priorPrior,
    baseline,
    threshold,
    hasBaseline,
    declining: hasBaseline && recent <= threshold,
  };
}

/**
 * Why an open decline has cleared, or `null` while it is still declining.
 * The two reasons are deliberately DISTINCT and never collapsed into one
 * "resolved": only one of them is good news.
 *
 *   'recovered'    — the most recent week climbed back above the trigger
 *                    while a real baseline still stands. Traffic came back.
 *   'no_baseline'  — the comparison window no longer holds a baseline to
 *                    fall from: the big weeks aged out past day-21, so the
 *                    test can no longer be made. Traffic did NOT come back;
 *                    the decline simply became the new normal.
 *
 * @param {DeclineStats} stats
 * @returns {'recovered' | 'no_baseline' | null}
 */
export function declineClearedReason(stats) {
  if (stats.declining) return null;
  return stats.hasBaseline ? 'recovered' : 'no_baseline';
}

/**
 * @typedef {Object} DarkTool
 * @property {string} tool
 * @property {number} calls - total calls across the whole window
 * @property {number} zeroDays - consecutive zero days ending at day-1
 */

/**
 * Tools that HAD callers inside the window and then went completely silent:
 * at least DARK_TOOL_MIN_CALLS across the window, and exactly zero for the
 * last DARK_TOOL_ZERO_DAYS consecutive days. Never a tool that was always
 * quiet — "nobody has ever called this" is a product fact, not an incident,
 * and reporting it every day would be the same zero-action noise the spike
 * floor was just recalibrated to retire.
 *
 * Aggregate spike/decline math cannot see this: one of five tools breaking
 * is invisible in a total that the other four hold up.
 *
 * @param {Array<{ tool: string, window: number[] }>} perTool - each window exactly DECLINE_WINDOW_DAYS values, day-1 first
 * @returns {DarkTool[]} in the input's order
 */
export function darkTools(perTool) {
  const out = [];
  for (const { tool, window } of perTool) {
    if (window.length !== DECLINE_WINDOW_DAYS) {
      throw new Error(
        `darkTools expects exactly ${DECLINE_WINDOW_DAYS} values per tool, got ${window.length} for ${tool}`
      );
    }
    const calls = sum(window);
    if (calls < DARK_TOOL_MIN_CALLS) continue;
    let zeroDays = 0;
    while (zeroDays < window.length && window[zeroDays] === 0) zeroDays += 1;
    if (zeroDays < DARK_TOOL_ZERO_DAYS) continue;
    out.push({ tool, calls, zeroDays });
  }
  return out;
}

/** "+33%" / "-12%" / "0%" / "N/A" */
export function formatPercent(wow) {
  if (wow === null) return 'N/A';
  return `${wow > 0 ? '+' : ''}${wow}%`;
}

/** Max client names shown on the digest's handshake line. */
export const MCP_CLIENTS_LINE_MAX = 5;

/**
 * "MCP client handshakes yesterday: claude-ai: 12, glama: 3" — top
 * MCP_CLIENTS_LINE_MAX client-software names by count, descending (ties
 * alphabetical), with an honest "none recorded" fallback when nothing was
 * counted. These are initialize HANDSHAKES (client connections),
 * deliberately NOT tool calls: the stateless MCP transport makes
 * initialize-time clientInfo unreachable at tools/call time (see
 * app/api/mcp/[transport]/route.ts's countClientHandshakes comment), so
 * connections are the honest unit. Descriptive context only — no spike
 * check on this line, ever; the aggregate MCP series carries the one spike
 * gate, unchanged.
 * @param {Array<{ client: string, count: number }>} clients
 * @param {number} [max]
 * @returns {string} one digest line
 */
export function formatMcpClientsLine(clients, max = MCP_CLIENTS_LINE_MAX) {
  const shown = [...clients]
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || (a.client < b.client ? -1 : a.client > b.client ? 1 : 0))
    .slice(0, max);
  if (shown.length === 0) return 'MCP client handshakes yesterday: none recorded';
  return `MCP client handshakes yesterday: ${shown.map((c) => `${c.client}: ${c.count}`).join(', ')}`;
}

/**
 * The digest's 28-day trend line. Printed EVERY day, declining or not —
 * the same reason the spike line prints "no spike" every day rather than
 * appearing only on the bad ones: a line that only shows up when something
 * is wrong is a line nobody learns to read, and its absence is
 * indistinguishable from the check having quietly broken.
 *
 * Always prints the three block sums, so the number the decision rests on
 * is on the page rather than behind a percentage.
 *
 * @param {DeclineStats} stats
 * @param {string} [issueUrl] - the standing decline issue, when one is open
 * @returns {string}
 */
export function formatDeclineLine(stats, issueUrl) {
  const shape = `last 7d ${stats.recent}, prior 7d ${stats.prior}, 7d before that ${stats.priorPrior}`;
  const trigger = `baseline ${stats.baseline}, trigger ≤${stats.threshold} (${DECLINE_RATIO}× baseline)`;
  if (stats.declining) {
    return `28d trend: ⚠ DECLINE — ${shape} — ${trigger}${issueUrl ? ` — see ${issueUrl}` : ''}`;
  }
  if (!stats.hasBaseline) {
    return `28d trend: no decline — ${shape} — no baseline to fall from (best prior block ${stats.baseline} < ${DECLINE_BASELINE_MIN_SUM})`;
  }
  return `28d trend: no decline — ${shape} — ${trigger}`;
}

/**
 * The dark-tools line, or '' when nothing is dark — the ONE line in this
 * digest that is conditional, because unlike the trend line above it has no
 * meaningful "all clear" form: the honest all-clear is the four other tools
 * already printed with their own counts directly above it.
 *
 * @param {DarkTool[]} dark
 * @returns {string} '' when the list is empty
 */
export function formatDarkToolsLine(dark) {
  if (dark.length === 0) return '';
  const parts = dark.map((d) => `${d.tool} (${d.calls} calls in ${DECLINE_WINDOW_DAYS}d, then 0 for ${d.zeroDays}d)`);
  return `Dark tools (≥${DARK_TOOL_MIN_CALLS} calls in ${DECLINE_WINDOW_DAYS}d, then ≥${DARK_TOOL_ZERO_DAYS}d of zero): ${parts.join(', ')}`;
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
 * @param {Array<{ client: string, count: number }>} [input.mcpClients] - day-1's initialize-handshake counts by client software name (lib/usage.ts readMcpClientDay); rendered by formatMcpClientsLine, honest "none recorded" when empty/omitted
 * @param {{ mcp?: string, script?: string }} [input.spikeIssueUrls] - populated only when that aggregate tripped and an issue was filed/found
 * @param {DeclineStats} [input.mcpDecline] - the total-MCP 28-day decline check; its line prints every day
 * @param {DarkTool[]} [input.darkTools] - per-tool go-dark findings; its line prints only when non-empty
 * @param {string} [input.declineIssueUrl] - the standing decline issue, when one is open
 * @returns {string} the full digest comment body, markdown, with the day marker embedded
 */
export function formatDigestBody({
  date,
  mcpTools,
  mcpTotal,
  script,
  mcpClients = [],
  spikeIssueUrls = {},
  mcpDecline,
  darkTools: dark = [],
  declineIssueUrl,
}) {
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

  // The trend line prints every day. When no 28-day window was supplied it
  // says so out loud rather than vanishing — a missing line and a healthy
  // line must never look the same.
  const declineLine = mcpDecline
    ? formatDeclineLine(mcpDecline, declineIssueUrl)
    : '28d trend: not computed (no 28-day window supplied)';
  const darkLine = formatDarkToolsLine(dark);

  return [
    `<!-- daily-metrics:${date} -->`,
    `📊 Daily metrics — ${date}`,
    '',
    '```',
    'MCP tool calls (production)',
    ...toolLines,
    totalLine,
    '',
    declineLine,
    ...(darkLine ? [darkLine] : []),
    '',
    formatMcpClientsLine(mcpClients),
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
    // Corrected 2026-08 alongside the floor recalibration: this line used to
    // say the floor was "a placeholder with zero real-traffic basis
    // (pre-launch product)", which stopped being true the moment
    // MCP_SPIKE_FLOOR was set from a month of real digest data. Each floor
    // now carries its own recorded basis, so the issue points at it rather
    // than disclaiming it.
    'Tunables: `SPIKE_MULTIPLIER = 3`; the floor is per-series and each one records ' +
      'its own basis — see `lib/traffic-metrics.mjs`.',
    '',
    '_MCP/script counts are unauthenticated and self-reported — spoofable-in-volume ' +
      'like every other counters-DB write in this repo, same threat model as the ' +
      'rate-limit counters and impression counts. Best-effort, never audited or ' +
      'fraud-proof._',
  ].join('\n');
  return { title, body };
}

// --- the standing decline issue ---------------------------------------------
//
// A decline is a STATE, not an event, so it gets exactly one standing issue
// whose body is rewritten every day it persists — the same shape
// lib/redistricting-watch.mjs settled on after the per-state-per-week
// variant left ten near-identical issues open in six weeks. The spike
// issues above are the opposite case and correctly stay one-per-day: a
// spike IS an event, it is over by the next morning.

/** The standing issue's title. scripts/daily-metrics.mjs looks this up EXACTLY. */
export function declineIssueTitle(series) {
  return `Traffic decline: ${series} (standing)`;
}

const SELF_REPORTED_DISCLOSURE =
  '_MCP/script counts are unauthenticated and self-reported — spoofable-in-volume ' +
  'like every other counters-DB write in this repo, same threat model as the ' +
  'rate-limit counters and impression counts. Best-effort, never audited or ' +
  'fraud-proof._';

/**
 * The standing issue's BODY — rebuilt from today's numbers on every run
 * that the decline persists, so the top of the issue is always current
 * rather than the day it happened to open.
 *
 * @param {Object} input
 * @param {string} input.series - e.g. 'total MCP calls'
 * @param {string} input.date - the date this run reports (day-1)
 * @param {DeclineStats} input.stats
 * @param {DarkTool[]} [input.darkTools]
 * @returns {{ title: string, body: string }}
 */
export function declineIssueContent({ series, date, stats, darkTools: dark = [] }) {
  const title = declineIssueTitle(series);
  const darkLine = formatDarkToolsLine(dark);
  const body = [
    `**${series}** has fallen and stayed down, as of **${date}**.`,
    '',
    `| 7-day block | calls |`,
    `| --- | ---: |`,
    `| days 1–7 (through ${date}) | **${stats.recent}** |`,
    `| days 8–14 | ${stats.prior} |`,
    `| days 15–21 | ${stats.priorPrior} |`,
    '',
    `Baseline (the higher of the two prior blocks): **${stats.baseline}**. ` +
      `Trigger: the most recent block at or under ${DECLINE_RATIO}× that baseline = **${stats.threshold}**, ` +
      `with the baseline itself at least ${DECLINE_BASELINE_MIN_SUM} (a real ~10/day week has to have existed to fall from).`,
    '',
    ...(darkLine ? [darkLine, ''] : []),
    'Block SUMS, not medians and not percentages — a median of a collapsed week ' +
      'and a median of the week before it can be the same single-digit number, ' +
      'which is exactly how this went unreported.',
    '',
    '**This is one standing issue for a STATE, not one issue per day.** The body ' +
      'above is rewritten every day the decline persists, with a dated comment ' +
      'appended, and it closes itself the day the state clears — either the ' +
      'recent block recovers above the trigger, or the big weeks age out of the ' +
      '28-day window and there is no longer a baseline to compare against. Those ' +
      'two are reported separately when it closes; only one of them is good news.',
    '',
    'Tunables: `DECLINE_WINDOW_DAYS`, `DECLINE_BLOCK_DAYS`, `DECLINE_BASELINE_MIN_SUM`, ' +
      '`DECLINE_RATIO` — see `lib/traffic-metrics.mjs`, where each carries its basis.',
    '',
    SELF_REPORTED_DISCLOSURE,
  ].join('\n');
  return { title, body };
}

/**
 * The dated "still declining" comment appended on each day the state
 * persists. Carries a day marker so an accidental workflow_dispatch re-run
 * edits nothing and adds nothing.
 *
 * @param {Object} input
 * @param {string} input.series
 * @param {string} input.date
 * @param {DeclineStats} input.stats
 * @returns {string}
 */
export function declineStillDecliningComment({ series, date, stats }) {
  return [
    `<!-- traffic-decline:${date} -->`,
    `**Still declining — ${date}.** ${series}: last 7 days **${stats.recent}**, ` +
      `against a baseline of ${stats.baseline} (prior 7d ${stats.prior}, the 7 before that ${stats.priorPrior}). ` +
      `Trigger is ≤${stats.threshold}.`,
  ].join('\n');
}

/**
 * The closing comment. `reason` is never collapsed: 'recovered' means the
 * traffic came back, 'no_baseline' means it did NOT and the comparison
 * simply aged out — a distinction that decides whether the owner does
 * anything, so it is stated in words AND in numbers rather than left to a
 * green checkmark.
 *
 * @param {Object} input
 * @param {'recovered' | 'no_baseline'} input.reason
 * @param {string} input.series
 * @param {string} input.date
 * @param {DeclineStats} input.stats
 * @returns {string}
 */
export function declineClearedComment({ reason, series, date, stats }) {
  if (reason === 'recovered') {
    return [
      `<!-- traffic-decline-cleared:${date} -->`,
      `**Recovered — ${date}.** ${series}: last 7 days **${stats.recent}**, back above the ` +
        `trigger of ${stats.threshold} (${DECLINE_RATIO}× baseline ${stats.baseline}; prior 7d ${stats.prior}, ` +
        `the 7 before that ${stats.priorPrior}). Closing. A fresh standing issue opens if it falls again.`,
    ].join('\n');
  }
  return [
    `<!-- traffic-decline-cleared:${date} -->`,
    `**Closed — ${date} — no baseline left to compare against. This is NOT a recovery.** ` +
      `${series}: last 7 days **${stats.recent}**, essentially unchanged. What changed is the ` +
      `comparison: the ${DECLINE_WINDOW_DAYS}-day window's prior blocks are now ${stats.prior} and ` +
      `${stats.priorPrior}, and the higher of them (${stats.baseline}) is under the ` +
      `${DECLINE_BASELINE_MIN_SUM} minimum, so "it fell from a real baseline" can no longer be ` +
      `asserted at all. The old volume aged out of the window; the low level is now the normal ` +
      `this check measures against.`,
  ].join('\n');
}

/** UTC calendar date, YYYY-MM-DD, `daysAgo` days before `now`. */
export function isoDateDaysAgo(daysAgo, now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo));
  return d.toISOString().slice(0, 10);
}

/** The calendar-date strings this digest needs, day-1 (yesterday) first
 *  through day-`count` last — the exact order every function above expects.
 *  `count` defaults to the 8-day spike window; declineWindowDays below asks
 *  for 28. The spike window is exactly the first 8 of the 28, which is why
 *  scripts/daily-metrics.mjs can read ONE window and slice it. */
export function trailingWindowDays(now = new Date(), count = SPIKE_WINDOW_DAYS) {
  return Array.from({ length: count }, (_, i) => isoDateDaysAgo(i + 1, now));
}

/** The 28 calendar-date strings the decline/dark-tool checks need, day-1
 *  first. `.slice(0, SPIKE_WINDOW_DAYS)` is exactly trailingWindowDays(). */
export function declineWindowDays(now = new Date()) {
  return trailingWindowDays(now, DECLINE_WINDOW_DAYS);
}
