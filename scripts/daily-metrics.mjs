/**
 * Daily metrics digest (traffic-watch design, 2026-07).
 *
 *   npx tsx scripts/daily-metrics.mjs
 *
 * Computes MCP tool-call / script-generation usage from the counters
 * database's usage family (lib/usage.ts) against a trailing-7-day median +
 * week-over-week comparator (lib/traffic-metrics.mjs), posts one comment
 * per day on the pinned "📊 Daily metrics" issue, and opens a labeled spike
 * issue when either AGGREGATE series (total MCP calls, script generations
 * — not per-tool, see lib/traffic-metrics.mjs's header comment) exceeds
 * both its floor and 3× its trailing median.
 *
 * MUST run via `npx tsx`, not plain `node` — same reason as
 * scripts/pregen-scripts.mjs: it imports lib/usage.ts (and transitively
 * lib/upstash.ts, lib/core/mcp.ts) unchanged, reusing the SAME key-builder
 * and read logic the live routes' writes use rather than a second,
 * independently-maintained copy of the key format that could silently
 * drift out of sync. Node's native TS type-stripping does not resolve
 * those modules' extensionless relative imports (verified directly, same
 * failure pregen-scripts.mjs's own header comment documents).
 *
 * Env:
 *   UPSTASH_COUNTERS_REST_URL/TOKEN  absent -> ::notice, exit 0 (dark-ship,
 *                                     same posture as scripts/verify-salt.mjs)
 *   DIGEST_ISSUE_NUMBER              the pinned issue's number — the
 *                                     workflow's "Ensure labels + pinned
 *                                     digest issue exist" step's output
 *   GITHUB_TOKEN                     inherited by the `gh` CLI automatically
 *
 * GitHub interaction goes through the `gh` CLI via child_process (same tool
 * refresh-legislators.yml already shells out to directly from bash) rather
 * than a raw REST fetch — the conditional edit-vs-create / search-before-
 * create logic here is more involved than that workflow's simple jq loops,
 * and `gh` is preinstalled and already authenticated via GITHUB_TOKEN on
 * every GitHub-hosted runner.
 *
 * Site page-view traffic is deliberately NOT in this digest — see the
 * traffic-watch design's §1: Vercel's Web Analytics REST API requires the
 * @vercel/analytics client script, which CLAUDE.md permanently bans, and
 * Vercel's server-side Observability (the compliant data source) has no
 * REST API at all (dashboard/CSV-export only). This is disclosed in the
 * digest body itself every day, not silently omitted.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// MCP_TOOL_NAMES comes from lib/usage.ts, not lib/core/mcp.ts's TOOL_NAMES
// directly — lib/core/mcp.ts transitively imports 'server-only' (via
// lib/freshness.ts), which only resolves inside Next's own bundler, not
// under tsx. See lib/usage.ts's header/MCP_TOOL_NAMES comments.
import { MCP_TOOL_NAMES, readUsageWindow } from '../lib/usage';
import {
  MCP_SPIKE_FLOOR,
  SCRIPT_SPIKE_FLOOR,
  formatDigestBody,
  seriesStats,
  spikeIssueContent,
  sumWindows,
  trailingWindowDays,
} from '../lib/traffic-metrics.mjs';

const REPO = 'cm2489/oravan';

let tmpCounter = 0;
/** gh's --body-file avoids every shell-quoting hazard a --body string would carry. */
function writeTempFile(content) {
  const file = join(tmpdir(), `daily-metrics-${process.pid}-${tmpCounter++}.md`);
  writeFileSync(file, content, 'utf8');
  return file;
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

/**
 * Title uniqueness (date embedded) is the de-dup mechanism — cheaper than
 * the vacancy/redistricting-watch issues' own "never re-file" tracking
 * since GitHub's own search does the work. Returns the issue's URL either
 * way (existing or newly created).
 */
function ensureSpikeIssue({ series, date, stats, floor }) {
  const { title, body } = spikeIssueContent({ series, date, stats, floor });
  const existingRaw = gh([
    'issue',
    'list',
    '--repo',
    REPO,
    '--state',
    'open',
    '--search',
    `in:title "${title}"`,
    '--json',
    'number,title,url',
  ]).trim();
  const matches = existingRaw ? JSON.parse(existingRaw) : [];
  const match = matches.find((m) => m.title === title);
  if (match) {
    console.log(`spike issue already open for ${series} on ${date}: ${match.url}`);
    return match.url;
  }
  const bodyFile = writeTempFile(body);
  const url = gh([
    'issue',
    'create',
    '--repo',
    REPO,
    '--title',
    title,
    '--label',
    'traffic-spike',
    '--body-file',
    bodyFile,
  ]).trim();
  console.log(`opened spike issue for ${series} on ${date}: ${url}`);
  return url;
}

/**
 * Same-day idempotency (an accidental workflow_dispatch re-run on a day
 * that already posted): if the pinned issue's LAST comment already carries
 * today's `<!-- daily-metrics:YYYY-MM-DD -->` marker, edit it in place
 * (--edit-last targets "the last comment of the current user" — safe here
 * because a marker match means that comment WAS posted by this same
 * workflow identity). Any other case (a prior day's digest, or no
 * comments yet) posts a fresh comment — different days always get
 * distinct comments, a running history to scroll through.
 */
function postOrEditTodaysComment(issueNumber, date, body) {
  const marker = `<!-- daily-metrics:${date} -->`;
  const commentsRaw = gh(['issue', 'view', issueNumber, '--repo', REPO, '--json', 'comments']).trim();
  const comments = JSON.parse(commentsRaw).comments ?? [];
  const last = comments[comments.length - 1];
  const bodyFile = writeTempFile(body);
  if (last && typeof last.body === 'string' && last.body.includes(marker)) {
    gh(['issue', 'comment', issueNumber, '--repo', REPO, '--edit-last', '--body-file', bodyFile]);
    console.log(`edited today's existing digest comment (idempotent re-run for ${date})`);
  } else {
    gh(['issue', 'comment', issueNumber, '--repo', REPO, '--body-file', bodyFile]);
    console.log(`posted a new digest comment for ${date}`);
  }
}

async function main() {
  const url = process.env.UPSTASH_COUNTERS_REST_URL;
  const token = process.env.UPSTASH_COUNTERS_REST_TOKEN;
  if (!url || !token) {
    console.log(
      '::notice::daily metrics digest SKIPPED — UPSTASH_COUNTERS_REST_URL/TOKEN not in this environment. Add both as Actions secrets to arm it.'
    );
    return;
  }

  const issueNumber = process.env.DIGEST_ISSUE_NUMBER;
  if (!issueNumber) {
    console.error("::error::DIGEST_ISSUE_NUMBER is missing — the workflow's setup step must run first");
    process.exit(1);
    return;
  }

  const days = trailingWindowDays(); // day-1 (yesterday) .. day-8
  const date = days[0];

  const window = await readUsageWindow(days);
  if (!window.ok) {
    console.error(
      '::error::could not read the usage window from the counters database — refusing to post a digest with an invented number'
    );
    process.exit(1);
    return;
  }

  // Per-tool stats are informational only (floor Infinity => .spike is
  // always false) — the design deliberately spike-checks the two aggregate
  // series only, not each of the 5 tools individually (low/uneven per-tool
  // volumes would be noisy and prone to false alarms).
  const mcpTools = MCP_TOOL_NAMES.map((tool) => ({
    tool,
    stats: seriesStats(window.mcp[tool], Infinity),
  }));
  const totalWindow = sumWindows(MCP_TOOL_NAMES.map((tool) => window.mcp[tool]));
  const mcpTotal = seriesStats(totalWindow, MCP_SPIKE_FLOOR);
  const script = seriesStats(window.script, SCRIPT_SPIKE_FLOOR);

  const spikeIssueUrls = {};
  if (mcpTotal.spike) {
    spikeIssueUrls.mcp = ensureSpikeIssue({ series: 'total MCP calls', date, stats: mcpTotal, floor: MCP_SPIKE_FLOOR });
  }
  if (script.spike) {
    spikeIssueUrls.script = ensureSpikeIssue({ series: 'script generations', date, stats: script, floor: SCRIPT_SPIKE_FLOOR });
  }

  const body = formatDigestBody({ date, mcpTools, mcpTotal, script, spikeIssueUrls });
  postOrEditTodaysComment(issueNumber, date, body);

  console.log(
    `daily metrics digest posted for ${date} (mcp total ${mcpTotal.latest}${mcpTotal.spike ? ', SPIKE' : ''}; script ${script.latest}${script.spike ? ', SPIKE' : ''})`
  );
}

main().catch((e) => {
  console.error(`::error::daily metrics digest crashed: ${e.message}`);
  process.exit(1);
});
