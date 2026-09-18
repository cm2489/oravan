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
 * It also watches the OTHER direction (2026-08). One 28-day window is read
 * instead of an 8-day one — one MGET either way — and the 8-day arrays the
 * spike math needs are its first 8 values, so the spike path's inputs are
 * unchanged. On top of that window: a 7-day-block DECLINE check on total
 * MCP calls, and a per-tool "went dark" check. The reason the decline half
 * exists is that MCP traffic fell ~95% on 2026-08-04 (609 calls in a week
 * → 32 the next) and the spike-only detector reported nothing for eleven
 * days, because a collapse is never above a threshold.
 *
 * TWO DIFFERENT ISSUE SHAPES, deliberately. A spike is an EVENT — it is
 * over by the next morning — so it keeps one dated issue per occurrence. A
 * decline is a STATE, so it gets ONE standing issue whose body is rewritten
 * each day it persists, with a dated comment appended, closed automatically
 * the day it clears. Same lesson refresh-legislators.yml's redistricting
 * watch already banked: a state that files one issue per run leaves ten
 * near-identical issues open and stops being read.
 *
 * The decline check runs on total MCP calls only, not on script
 * generations. Script generations are the paid path (real Anthropic spend
 * per cache-miss), where a fall is a cost saving rather than an incident —
 * and the DECLINE_BASELINE_MIN_SUM gate means that series could not fire
 * anyway at its real volume. The spike/cost tripwire on it is unchanged.
 *
 * ISSUE HYGIENE (2026-08) rides along on the same run, because this job
 * already reads the issue list every morning. It appends an "Awaiting your
 * word" section to the digest comment, and it closes stale traffic-spike
 * alerts — ITS OWN alerts, past SPIKE_ISSUE_TTL_DAYS, matching the exact
 * title it wrote, and carrying none of NEVER_CLOSE_LABELS. It closes
 * nothing else, ever: closing a `moment-candidate` issue is how the owner
 * DECLINES a candidate — the issue body tells him to (scripts/moment-watch.mjs's
 * "To decline" section) and moment-watch.yml's filed-check reads `--state all`
 * so a closed one never gets re-filed — so an auto-close there would perform
 * his decline for him and bury the candidate. The whole hygiene
 * path is additive — any failure warns, omits the section and closes
 * nothing, never failing the digest and never inventing "0 open items".
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
 * @vercel/analytics client script, which CLAUDE.md permanently bans. This is
 * disclosed in the digest body itself every day, not silently omitted.
 *
 * CORRECTED 2026-09-18. The second half of that disclosure used to read
 * "Vercel's server-side Observability has no REST API at all
 * (dashboard/CSV-export only)", and that stopped being true: `vercel metrics`
 * (CLI, --format json, public beta 2026, requires Observability Plus) exposes
 * the compliant server-side numbers programmatically, and runtime logs can be
 * aggregated over the API as well. The honest statement is the one this file
 * and the digest now make: a compliant programmatic source EXISTS, and this
 * digest does not read it yet. The reason to fix the wording rather than
 * quietly leave it is the same duty CLAUDE.md's "Constitutional conflicts"
 * section names — a shipped claim that has stopped being true is a conflict,
 * not a detail. Adopting the source is a separate decision (it needs a plan
 * tier and a token) and is deliberately NOT made here.
 *
 * PIPELINE HEALTH (2026-09) rides along on this same run, the same way issue
 * hygiene does and for the same reason: this is the job that already runs
 * every morning holding the token it needs. It appends one "Pipeline health"
 * section to the digest comment and maintains ONE standing issue. Additive by
 * construction — any failure warns, omits the section, touches no issue, and
 * never fails the digest.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// MCP_TOOL_NAMES comes from lib/usage.ts, not lib/core/mcp.ts's TOOL_NAMES
// directly — lib/core/mcp.ts transitively imports 'server-only' (via
// lib/freshness.ts), which only resolves inside Next's own bundler, not
// under tsx. See lib/usage.ts's header/MCP_TOOL_NAMES comments.
import { MCP_TOOL_NAMES, readMcpClientDay, readUsageWindow } from '../lib/usage';
import {
  MCP_SPIKE_FLOOR,
  SCRIPT_SPIKE_FLOOR,
  SPIKE_WINDOW_DAYS,
  awaitingYourWordSection,
  closableIssues,
  darkTools,
  declineClearedComment,
  declineClearedReason,
  declineIssueContent,
  declineIssueTitle,
  declineStats,
  declineStillDecliningComment,
  declineWindowDays,
  formatDigestBody,
  seriesStats,
  spikeClosedComment,
  spikeIssueContent,
  sumWindows,
} from '../lib/traffic-metrics.mjs';
import {
  HEALTH_ISSUE_LABEL,
  HEALTH_ISSUE_TITLE,
  formatHealthAlarmComment,
  formatHealthIssueBody,
  formatHealthSection,
} from '../lib/pipeline-health.mjs';
import { buildReport } from './pipeline-health.mjs';

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
 * The standing decline issue, looked up by its EXACT (date-free) title —
 * the same `gh issue list --search 'in:title "..."'` + exact-title-match
 * mechanics ensureSpikeIssue uses, just against a title that never changes,
 * because a decline is one state rather than a series of events.
 * @returns {{ number: number, url: string } | null}
 */
function findOpenDeclineIssue(series) {
  const title = declineIssueTitle(series);
  const raw = gh([
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
  const matches = raw ? JSON.parse(raw) : [];
  return matches.find((m) => m.title === title) ?? null;
}

/** True when this issue already carries a comment with `marker` — the same
 *  re-run guard postOrEditTodaysComment uses on the pinned digest issue, so
 *  an accidental workflow_dispatch never doubles a day's comment. */
function hasCommentWithMarker(issueNumber, marker) {
  const raw = gh(['issue', 'view', String(issueNumber), '--repo', REPO, '--json', 'comments']).trim();
  const comments = JSON.parse(raw).comments ?? [];
  return comments.some((c) => typeof c.body === 'string' && c.body.includes(marker));
}

/**
 * Open (or keep) the ONE standing decline issue. On the first day: create
 * it, labeled, body written. On every day it persists: REWRITE the body
 * with today's numbers and append one dated "Still declining" comment —
 * never a second issue. Returns the issue's URL either way, for the digest
 * line.
 */
function ensureDeclineIssue({ series, date, stats, darkTools: dark }) {
  const { title, body } = declineIssueContent({ series, date, stats, darkTools: dark });
  const bodyFile = writeTempFile(body);
  const existing = findOpenDeclineIssue(series);
  if (!existing) {
    const url = gh([
      'issue',
      'create',
      '--repo',
      REPO,
      '--title',
      title,
      '--label',
      'traffic-decline',
      '--body-file',
      bodyFile,
    ]).trim();
    console.log(`opened the standing decline issue for ${series}: ${url}`);
    return url;
  }
  gh(['issue', 'edit', String(existing.number), '--repo', REPO, '--body-file', bodyFile]);
  const marker = `<!-- traffic-decline:${date} -->`;
  if (hasCommentWithMarker(existing.number, marker)) {
    console.log(`decline issue for ${series} already has today's (${date}) comment — body refreshed only`);
  } else {
    const commentFile = writeTempFile(declineStillDecliningComment({ series, date, stats }));
    gh(['issue', 'comment', String(existing.number), '--repo', REPO, '--body-file', commentFile]);
    console.log(`decline for ${series} persists — body rewritten and ${date} comment appended: ${existing.url}`);
  }
  return existing.url;
}

/**
 * Close the standing decline issue when the state clears, with the REASON
 * spelled out — 'recovered' and 'no_baseline' are never collapsed into one
 * "resolved", because only one of them means the traffic came back. A no-op
 * when no decline issue is open (the common case, every ordinary day).
 */
function resolveDeclineIssue({ series, date, stats, reason }) {
  const existing = findOpenDeclineIssue(series);
  if (!existing) return;
  const commentFile = writeTempFile(declineClearedComment({ reason, series, date, stats }));
  gh(['issue', 'comment', String(existing.number), '--repo', REPO, '--body-file', commentFile]);
  gh(['issue', 'close', String(existing.number), '--repo', REPO]);
  console.log(`closed the standing decline issue for ${series} (${reason}): ${existing.url}`);
}

/**
 * Issue hygiene (2026-08), folded into this job rather than given a workflow
 * of its own — this is the one thing that already reads the issue list every
 * morning, and it needs no permission it does not already hold.
 *
 * ADDITIVE BY CONSTRUCTION. Every failure mode here — `gh` missing, the API
 * refusing, unparseable JSON — logs a ::warning:: and returns null, which
 * omits the section entirely and closes nothing. It never fails the digest
 * and, critically, it never renders an invented "0 open items": an absent
 * section means the read failed, and it said so in the log.
 *
 * That is the OPPOSITE posture to the counters read in main(), which stays
 * fail-LOUD, and the difference is deliberate: a wrong usage number is a
 * lie about the product, while a missing hygiene section is a missing
 * convenience.
 *
 * @param {Date} now
 * @returns {{ section: string, closable: import('../lib/traffic-metrics.mjs').ClosableSpikeIssue[] } | null}
 */
function collectIssueHygiene(now) {
  try {
    // --limit 100: gh's default page is 30, and this repo has never been
    // near 30, let alone 100. If it ever passes 100 the section
    // under-reports rather than mis-reports, and nothing extra gets closed.
    const raw = gh([
      'issue',
      'list',
      '--repo',
      REPO,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,labels,createdAt',
    ]).trim();
    const issues = raw ? JSON.parse(raw) : [];
    const closable = closableIssues(issues, { now });
    // The section is rendered from the issues this run is NOT closing: a
    // comment that lists an issue as "awaiting your word" three lines above
    // closing it would be telling the owner two different things at once.
    const closing = new Set(closable.map((c) => c.number));
    const section = awaitingYourWordSection(
      issues.filter((i) => !closing.has(i.number)),
      { now }
    );
    return { section, closable };
  } catch (e) {
    console.log(
      `::warning::issue hygiene skipped — could not read the open-issue list (${e.message}). The digest itself is unaffected: no section appended, nothing closed.`
    );
    return null;
  }
}

/**
 * Close the stale traffic-spike alerts closableIssues() cleared — and only
 * those. Runs AFTER the digest comment is posted, and every close is
 * individually guarded, so a GitHub hiccup mid-cleanup can never cost the
 * day's digest.
 *
 * @returns {number} how many actually closed — NOT how many were eligible.
 *   The run log reports this number, so a partial cleanup reads as partial.
 */
function closeStaleSpikeIssues(closable, { digestIssue }) {
  let closed = 0;
  for (const issue of closable) {
    try {
      const commentFile = writeTempFile(
        spikeClosedComment({ date: issue.reportedDate, ageDays: issue.ageDays, digestIssue })
      );
      gh(['issue', 'comment', String(issue.number), '--repo', REPO, '--body-file', commentFile]);
      gh(['issue', 'close', String(issue.number), '--repo', REPO]);
      closed += 1;
      console.log(
        `closed stale spike issue #${issue.number} (${issue.series}, reported ${issue.reportedDate}, ${issue.ageDays}d old)`
      );
    } catch (e) {
      console.log(`::warning::could not close stale spike issue #${issue.number} (${e.message}) — left open, will retry tomorrow.`);
    }
  }
  return closed;
}

/**
 * PIPELINE HEALTH — collection. Same additive posture as collectIssueHygiene
 * above, and the same reason: a missing health section is a missing
 * convenience, while the counters read stays fail-LOUD because a wrong usage
 * number is a lie about the product.
 *
 * buildReport() guards each of its own reads individually and renders a
 * failed one as "not found", so reaching the catch here means something
 * structural broke (gh gone, the repo unreadable). Either way the digest
 * posts exactly as it did before this existed.
 *
 * @returns {{ report: object, section: string } | null}
 */
function collectPipelineHealth() {
  try {
    const report = buildReport();
    return { report, section: formatHealthSection(report) };
  } catch (e) {
    console.log(
      `::warning::pipeline health skipped — the report could not be built (${e.message}). The digest itself is unaffected: no section appended, no issue touched.`
    );
    return null;
  }
}

/**
 * The ONE standing health issue. A pipeline's condition is a STATE, so it
 * gets a single issue whose body is rewritten every run — the same shape rule
 * the traffic-decline issue follows, and for the reason
 * refresh-legislators.yml's redistricting watch banked first: a state that
 * files one issue per run leaves ten near-identical issues open and stops
 * being read.
 *
 * The dated comment is the exception, and it is reserved: it appears ONLY on
 * a day with a ⛔ condition, because a comment is a notification and a
 * notification that arrives every morning is one nobody opens.
 *
 * Every step is individually guarded and runs AFTER the digest comment is
 * posted. The digest is the job; this is the courtesy, and the courtesy must
 * never be able to cost the job.
 */
function maintainHealthIssue(report) {
  try {
    const raw = gh([
      'issue',
      'list',
      '--repo',
      REPO,
      '--state',
      'open',
      '--search',
      `in:title "${HEALTH_ISSUE_TITLE}"`,
      '--json',
      'number,title,url',
    ]).trim();
    const matches = raw ? JSON.parse(raw) : [];
    const existing = matches.find((m) => m.title === HEALTH_ISSUE_TITLE) ?? null;
    const bodyFile = writeTempFile(formatHealthIssueBody(report));

    let issueNumber;
    let issueUrl;
    if (existing) {
      gh(['issue', 'edit', String(existing.number), '--repo', REPO, '--body-file', bodyFile]);
      issueNumber = existing.number;
      issueUrl = existing.url;
      console.log(`pipeline health: standing issue #${issueNumber} body rewritten`);
    } else {
      issueUrl = gh([
        'issue',
        'create',
        '--repo',
        REPO,
        '--title',
        HEALTH_ISSUE_TITLE,
        '--label',
        HEALTH_ISSUE_LABEL,
        '--body-file',
        bodyFile,
      ]).trim();
      issueNumber = Number.parseInt(issueUrl.split('/').pop() ?? '', 10);
      console.log(`pipeline health: opened the standing issue ${issueUrl}`);
      // Pinning is best-effort: GitHub allows at most three pinned issues per
      // repo, so a full board must not turn a healthy run red.
      try {
        gh(['issue', 'pin', '--repo', REPO, String(issueNumber)]);
      } catch (e) {
        console.log(`::warning::pipeline health: could not pin the standing issue (${e.message}) — body is still current.`);
      }
    }

    const list = report.alarms ?? [];
    if (!list.length) {
      console.log('pipeline health: no ⛔ conditions — body refreshed, no comment posted');
      return issueUrl;
    }
    const date = (report.generatedAt ?? new Date().toISOString()).slice(0, 10);
    const marker = `<!-- pipeline-health:${date} -->`;
    if (Number.isFinite(issueNumber) && hasCommentWithMarker(issueNumber, marker)) {
      console.log(`pipeline health: today's (${date}) ⛔ comment already posted — body refreshed only`);
      return issueUrl;
    }
    const commentFile = writeTempFile(
      formatHealthAlarmComment({ date, alarms: list, runUrl: process.env.HEALTH_RUN_URL })
    );
    gh(['issue', 'comment', String(issueNumber), '--repo', REPO, '--body-file', commentFile]);
    console.log(`pipeline health: ${list.length} ⛔ condition(s) — dated comment appended to ${issueUrl}`);
    return issueUrl;
  } catch (e) {
    console.log(
      `::warning::pipeline health: the standing issue could not be maintained (${e.message}) — the digest comment still carries the section.`
    );
    return null;
  }
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

  // ONE window, 28 days, day-1 (yesterday) first — still a single MGET in
  // lib/usage.ts. The 8-day arrays the spike math reads are its first 8
  // values (see SPIKE_WINDOW_DAYS / declineWindowDays), so nothing about
  // the spike path's inputs changed when this widened.
  const days = declineWindowDays(); // day-1 (yesterday) .. day-28
  const date = days[0];

  const window = await readUsageWindow(days);
  if (!window.ok) {
    console.error(
      '::error::could not read the usage window from the counters database — refusing to post a digest with an invented number'
    );
    process.exit(1);
    return;
  }

  // Day-1's initialize-handshake counts by client software name — a
  // descriptive digest line only, never spike-checked (see
  // formatMcpClientsLine). Same fail-LOUD posture as readUsageWindow
  // above: a read failure must never quietly render as "none recorded",
  // which would be an invented zero.
  const clientHandshakes = await readMcpClientDay(date);
  if (!clientHandshakes.ok) {
    console.error(
      '::error::could not read the MCP client-handshake counts from the counters database — refusing to post a digest with an invented number'
    );
    process.exit(1);
    return;
  }

  // The aggregate series, full 28 days — the spike half slices its first 8
  // below, the decline half reads all of it.
  const totalWindow = sumWindows(MCP_TOOL_NAMES.map((tool) => window.mcp[tool]));

  // The spike half, on the 8-day prefix — identical inputs to when this
  // script read an 8-day window directly.
  //
  // Per-tool stats here are informational only (floor Infinity => .spike is
  // always false) — the design deliberately spike-checks the two aggregate
  // series only, not each of the 5 tools individually (low/uneven per-tool
  // volumes would be noisy and prone to false alarms). The per-tool signal
  // that IS actionable is darkTools below, which asks a different question:
  // not "is this tool busy today" but "did this tool have callers and then
  // stop having them."
  const spikeWindow = (series) => series.slice(0, SPIKE_WINDOW_DAYS);
  const mcpTools = MCP_TOOL_NAMES.map((tool) => ({
    tool,
    stats: seriesStats(spikeWindow(window.mcp[tool]), Infinity),
  }));
  const mcpTotal = seriesStats(spikeWindow(totalWindow), MCP_SPIKE_FLOOR);
  const script = seriesStats(spikeWindow(window.script), SCRIPT_SPIKE_FLOOR);

  const spikeIssueUrls = {};
  if (mcpTotal.spike) {
    spikeIssueUrls.mcp = ensureSpikeIssue({ series: 'total MCP calls', date, stats: mcpTotal, floor: MCP_SPIKE_FLOOR });
  }
  if (script.spike) {
    spikeIssueUrls.script = ensureSpikeIssue({ series: 'script generations', date, stats: script, floor: SCRIPT_SPIKE_FLOOR });
  }

  // The decline half, on the full 28 days. MCP total only — see this file's
  // header for why script generations are deliberately not decline-checked.
  const DECLINE_SERIES = 'total MCP calls';
  const mcpDecline = declineStats(totalWindow);
  const dark = darkTools(MCP_TOOL_NAMES.map((tool) => ({ tool, window: window.mcp[tool] })));

  let declineIssueUrl;
  if (mcpDecline.declining) {
    declineIssueUrl = ensureDeclineIssue({
      series: DECLINE_SERIES,
      date,
      stats: mcpDecline,
      darkTools: dark,
    });
  } else {
    // No-op on an ordinary day (nothing open to close); on the day it
    // clears, this states WHICH way it cleared.
    resolveDeclineIssue({
      series: DECLINE_SERIES,
      date,
      stats: mcpDecline,
      reason: declineClearedReason(mcpDecline),
    });
  }

  const body = formatDigestBody({
    date,
    mcpTools,
    mcpTotal,
    script,
    mcpClients: clientHandshakes.clients,
    spikeIssueUrls,
    mcpDecline,
    darkTools: dark,
    declineIssueUrl,
  });

  // Issue hygiene, read once and appended to the SAME comment — one place
  // to look each morning rather than a second notification. Null on any
  // failure, in which case the digest posts exactly as it did before this
  // existed.
  const hygiene = collectIssueHygiene(new Date());

  // Pipeline health, read once and appended to the SAME comment — one place
  // to look each morning rather than a third notification. Null on any
  // failure, in which case the digest posts exactly as it did before this
  // existed.
  const health = collectPipelineHealth();

  const sections = [body, hygiene?.section, health?.section].filter(Boolean);
  postOrEditTodaysComment(issueNumber, date, sections.join('\n\n'));

  // The standing health issue is maintained AFTER the digest comment lands,
  // for the same reason the stale-spike cleanup is: the digest is the job.
  const healthIssueUrl = health ? maintainHealthIssue(health.report) : null;

  // Closes happen AFTER the digest is safely posted: the digest is the job,
  // the cleanup is the courtesy, and the courtesy must never be able to
  // cost the job.
  const closedCount = hygiene ? closeStaleSpikeIssues(hygiene.closable, { digestIssue: issueNumber }) : 0;

  console.log(
    `daily metrics digest posted for ${date} (mcp total ${mcpTotal.latest}${mcpTotal.spike ? ', SPIKE' : ''}; script ${script.latest}${script.spike ? ', SPIKE' : ''}; 28d ${mcpDecline.recent} vs baseline ${mcpDecline.baseline}${mcpDecline.declining ? ', DECLINING' : ''}${dark.length ? `; dark tools: ${dark.map((d) => d.tool).join(', ')}` : ''}${hygiene ? `; hygiene: ${closedCount}/${hygiene.closable.length} stale spike issue(s) closed` : '; hygiene: SKIPPED'}${health ? `; health: ${health.report.alarms.length} ⛔${healthIssueUrl ? ` at ${healthIssueUrl}` : ' (issue not updated)'}` : '; health: SKIPPED'})`
  );
}

main().catch((e) => {
  console.error(`::error::daily metrics digest crashed: ${e.message}`);
  process.exit(1);
});
