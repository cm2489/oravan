/**
 * PIPELINE HEALTH — the collector.
 *
 *   node scripts/pipeline-health.mjs --md     # the digest section
 *   node scripts/pipeline-health.mjs --json   # the machine shape
 *
 * Answers one question every morning: is the machine running clean. It reads
 * the Actions run list and the run logs the scripts already print, the data
 * files already committed, and the open-issue list — nothing new is fetched,
 * nothing paid is called, no secret is needed beyond the `gh` token the job
 * already holds. Cost: $0 in API spend; roughly one to two Actions minutes a
 * day for the log downloads, which is the whole bill.
 *
 * WHY A SCRIPT AND NOT A DASHBOARD. Every number here is already somewhere —
 * in a run log, in a data file, in a workflow's conclusion. The problem was
 * never that the pipeline was silent; it was that reading it meant opening
 * eight workflows and scrolling. This puts one deterministic report where the
 * owner already looks (the daily digest comment) and in one standing issue a
 * daily doctor agent can read without a browser.
 *
 * WHAT IT IS NOT. Not a gate. It fails nothing, blocks nothing, closes
 * nothing. The gates are unchanged and stay where they are:
 * scripts/verify-sync.mjs before the nightly commit, scripts/check-cursor-age.mjs
 * after it, and the gate list in .github/workflows/ci.yml.
 *
 * FAILURE POSTURE. Every collector below is individually guarded and returns
 * null on failure, and null renders as "not found" rather than as a number.
 * That is deliberate and it is the opposite of scripts/daily-metrics.mjs's
 * counters read, which is fail-LOUD: a wrong usage number is a lie about the
 * product, while a missing health row is a missing convenience. The one thing
 * this must never do is render an invented zero.
 *
 * Plain `node`, no tsx: it imports lib/pipeline-health.mjs (pure ESM) and
 * lib/docket.mjs for SIGNAL_STALE_HOURS, both of which resolve under node.
 * lib/pregen.ts is deliberately NOT imported — see MODEL_PRICE_PER_MTOK's
 * comment in lib/pipeline-health.mjs for the constraint and for the pricing
 * discrepancy it refuses to resolve silently.
 *
 * Env:
 *   GITHUB_TOKEN   picked up by `gh` automatically on a runner; locally the
 *                  script uses whatever `gh auth` already has.
 *   HEALTH_REPO    override the repo (defaults to cm2489/oravan).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { SIGNAL_STALE_HOURS } from '../lib/docket.mjs';
import {
  NEWSDESK_EXPECTED_SLOTS,
  alarms,
  ciRedStreak,
  countAnthropicErrors,
  countPortrait404s,
  countUpstashCacheFailures,
  coverageBillCount,
  coverageStaleness,
  cursorHealth,
  danglingConversationSlugs,
  durationMinutes,
  estimateDaySpend,
  floorSignalFreshness,
  formatHealthSection,
  parseCoverageDone,
  parseFailingTests,
  parsePregen,
  parseSyncDone,
  parseT3,
} from '../lib/pipeline-health.mjs';

const REPO = process.env.HEALTH_REPO || 'cm2489/oravan';

/**
 * Log downloads are the only expensive thing here. The cap exists so a day
 * with an unusual number of runs cannot quietly turn a two-minute job into a
 * twenty-minute one; when it bites, the report says how many runs it skipped
 * rather than pretending it read them.
 */
const MAX_LOG_FETCHES = 16;

/** Data workflows whose logs carry the counters this report is made of. */
const DATA_WORKFLOWS = new Set([
  'Nightly bill sync',
  'Newsdesk headline trigger',
  'Hot-bill refresh',
  'Moment watch',
  'Weekly legislators refresh',
]);

/** Workflows reported as a bare conclusion, no log read needed. */
const SIDE_WORKFLOWS = ['Hot-bill refresh', 'Moment watch', 'Weekly legislators refresh'];

const warn = (msg) => console.log(`::warning::pipeline-health: ${msg}`);

/**
 * Every external call goes through here. `gh` and `git` both exit non-zero for
 * ordinary conditions (no such ref, an in-progress run), so a throw is not an
 * emergency — it is a null with a line in the log saying which read failed.
 */
function run(bin, args, { maxBuffer = 64 * 1024 * 1024 } = {}) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', maxBuffer });
  } catch (e) {
    warn(`\`${bin} ${args.slice(0, 3).join(' ')}…\` failed (${e.message.split('\n')[0]})`);
    return null;
  }
}

function ghJson(args) {
  const raw = run('gh', args);
  if (raw === null) return null;
  try {
    return JSON.parse(raw.trim() || 'null');
  } catch (e) {
    warn(`could not parse gh JSON (${e.message})`);
    return null;
  }
}

function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    warn(`could not read ${path} (${e.message})`);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

const RUN_FIELDS = 'databaseId,workflowName,conclusion,status,event,createdAt,startedAt,updatedAt,url,headBranch';

/** All runs created since `sinceIso`, newest first. */
function listRuns(sinceIso) {
  return (
    ghJson([
      'run',
      'list',
      '--repo',
      REPO,
      '--created',
      `>=${sinceIso.slice(0, 10)}`,
      '--limit',
      '400',
      '--json',
      RUN_FIELDS,
    ]) ?? []
  );
}

const within = (runs, sinceMs) => runs.filter((r) => Date.parse(r.createdAt ?? '') >= sinceMs);

/**
 * A run's full log. Only for COMPLETED runs: `gh run view --log` on an
 * in-progress run errors, and an in-progress nightly has not printed its DONE
 * line yet anyway.
 */
function runLog(entry) {
  if (entry.status !== 'completed') return null;
  return run('gh', ['run', 'view', String(entry.databaseId), '--repo', REPO, '--log']);
}

/* ------------------------------------------------------------------ *
 * git-derived deltas
 * ------------------------------------------------------------------ */

/**
 * A data file's contents at the commit BEFORE the one that last touched it —
 * the baseline every delta in this report is measured against.
 *
 * Returns null, loudly, when the history cannot reach two commits that touched
 * the file. That is the normal outcome on a shallow checkout, and it must
 * read as "no delta available" rather than as a delta of zero: a wrong number
 * here would be indistinguishable from a quiet night. daily-metrics.yml checks
 * out with `fetch-depth: 25` for exactly this reason.
 *
 * @param {string} path
 * @returns {string | null}
 */
function previousBlob(path) {
  const revs = run('git', ['rev-list', '-2', 'HEAD', '--', path]);
  if (!revs) return null;
  const [, previousCommit] = revs.trim().split('\n');
  if (!previousCommit) {
    warn(`no second commit touching ${path} is reachable (shallow checkout?) — its delta reads "not found", not 0`);
    return null;
  }
  return run('git', ['show', `${previousCommit}:${path}`]);
}

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

export function buildReport({ now = Date.now() } = {}) {
  const dayMs = 24 * 3_600_000;
  const since24h = now - dayMs;
  const since7d = now - 7 * dayMs;
  const allRuns = listRuns(new Date(since7d).toISOString());
  const runs24h = within(allRuns, since24h);

  /* -- nightly ---------------------------------------------------- */
  const nightlyRun = runs24h.find((r) => r.workflowName === 'Nightly bill sync') ?? null;
  const nightly = nightlyRun
    ? {
        conclusion: nightlyRun.conclusion ?? nightlyRun.status ?? 'unknown',
        durationMin: durationMinutes(nightlyRun.startedAt, nightlyRun.updatedAt),
        url: nightlyRun.url,
        runId: nightlyRun.databaseId,
      }
    : null;

  /* -- logs ------------------------------------------------------- */
  // One pass over the day's data-workflow runs. Each log is read ONCE and
  // every counting parser runs over it, so a day costs one download per run
  // regardless of how many numbers the report wants out of it.
  // The nightly is sorted to the FRONT, not left in chronological order: it
  // is the only run whose log carries the sync counters, the coverage
  // summary, pregen and the portrait mirror, so on a day busy enough to hit
  // MAX_LOG_FETCHES it must never be the log that gets dropped.
  const logTargets = runs24h
    .filter((r) => DATA_WORKFLOWS.has(r.workflowName) && r.status === 'completed')
    .sort((a, b) => Number(b.workflowName === 'Nightly bill sync') - Number(a.workflowName === 'Nightly bill sync'));
  const skippedLogs = Math.max(0, logTargets.length - MAX_LOG_FETCHES);
  const anthropic = { creditBalance: 0, invalidRequestOther: 0, total: 0 };
  const anthropicByWorkflow = {};
  const t3 = { batched: 0, resolved: 0, runs: 0 };
  let sync = null;
  let coverageDone = null;
  let pregen = null;
  let portrait404s = null;
  let upstashCacheFailures = null;

  for (const r of logTargets.slice(0, MAX_LOG_FETCHES)) {
    const log = runLog(r);
    if (log === null) continue;
    const errs = countAnthropicErrors(log);
    if (errs.total) {
      anthropic.creditBalance += errs.creditBalance;
      anthropic.invalidRequestOther += errs.invalidRequestOther;
      anthropic.total += errs.total;
      const bucket = (anthropicByWorkflow[r.workflowName] ??= { creditBalance: 0, invalidRequestOther: 0 });
      bucket.creditBalance += errs.creditBalance;
      bucket.invalidRequestOther += errs.invalidRequestOther;
    }
    const runT3 = parseT3(log);
    t3.batched += runT3.batched;
    t3.resolved += runT3.resolved;
    t3.runs += runT3.runs;
    if (r.workflowName === 'Nightly bill sync') {
      sync = parseSyncDone(log);
      coverageDone = parseCoverageDone(log);
      pregen = parsePregen(log);
      portrait404s = countPortrait404s(log);
      upstashCacheFailures = countUpstashCacheFailures(log);
    }
  }

  /* -- side workflows --------------------------------------------- */
  const workflows = {};
  for (const name of SIDE_WORKFLOWS) {
    // Weekly legislators refresh fires Mondays, so a 24h window will usually
    // miss it. Fall back to the 7-day list and say when it ran rather than
    // reporting an absence that is just the schedule.
    const recent = runs24h.find((r) => r.workflowName === name) ?? allRuns.find((r) => r.workflowName === name);
    if (!recent) continue;
    workflows[name] = {
      conclusion: recent.conclusion ?? recent.status ?? 'unknown',
      at: recent.createdAt,
      url: recent.url,
      within24h: Date.parse(recent.createdAt ?? '') >= since24h,
    };
  }

  /* -- newsdesk slots --------------------------------------------- */
  const newsdeskScheduled = runs24h.filter(
    (r) => r.workflowName === 'Newsdesk headline trigger' && r.event === 'schedule'
  ).length;

  /* -- CI on main -------------------------------------------------- */
  const ciRuns = allRuns.filter((r) => r.workflowName === 'CI' && (r.headBranch ?? 'main') === 'main');
  const streak = ciRedStreak(ciRuns);
  let failing = [];
  if (streak.latest === 'failure') {
    const newestFailure = ciRuns.find((r) => r.conclusion === 'failure');
    if (newestFailure) {
      const ciLog = run('gh', ['run', 'view', String(newestFailure.databaseId), '--repo', REPO, '--log-failed']);
      if (ciLog !== null) {
        failing = parseFailingTests(ciLog);
        if (!failing.length) {
          // A gate step, not a Playwright spec: name the step instead. That is
          // the honest answer for the parity / naming / claim-truth gates,
          // which fail before any browser starts.
          const jobs = ghJson(['run', 'view', String(newestFailure.databaseId), '--repo', REPO, '--json', 'jobs']);
          failing = (jobs?.jobs ?? [])
            .flatMap((j) => j.steps ?? [])
            .filter((s) => s.conclusion === 'failure')
            .map((s) => `step: ${s.name}`);
        }
      }
    }
  }
  const ci = {
    latest: streak.latest,
    consecutiveRed: streak.count,
    redSince: streak.since,
    redForHours: streak.since ? (now - Date.parse(streak.since)) / 3_600_000 : null,
    failing,
  };

  /* -- data files -------------------------------------------------- */
  const state = readJsonFile('data/sync-state.json');
  const coverage = readJsonFile('data/coverage.json');
  const signals = readJsonFile('data/floor-signals.json');
  const conversation = readJsonFile('data/conversation.json');

  // data/bills.json is ~10MB. Read it ONCE: count by marker (cheap, and the
  // count is all the corpus row needs), then parse the same string for the id
  // set the dangling-slug check compares against.
  let corpusBills = null;
  const billIds = new Set();
  try {
    const raw = readFileSync('data/bills.json', 'utf8');
    corpusBills = (raw.match(/"full_identifier":/g) ?? []).length;
    for (const b of JSON.parse(raw)) {
      if (b?.full_identifier) billIds.add(b.full_identifier);
    }
  } catch (e) {
    warn(`could not read data/bills.json (${e.message})`);
  }
  // Counting a marker substring rather than JSON.parse for the 10MB corpus:
  // the count is all the delta needs, so parsing it a second time buys nothing.
  const previousBillsBlob = previousBlob('data/bills.json');
  const previousBills = previousBillsBlob === null ? null : (previousBillsBlob.match(/"full_identifier":/g) ?? []).length;

  const coverageBills = coverage ? coverageBillCount(coverage) : null;
  const previousCoverageBills = (() => {
    const blob = previousBlob('data/coverage.json');
    if (blob === null) return null;
    try {
      return coverageBillCount(JSON.parse(blob));
    } catch (e) {
      warn(`the previous data/coverage.json did not parse (${e.message}) — its delta reads "not found"`);
      return null;
    }
  })();

  const staleness = coverage ? coverageStaleness(coverage, { now }) : null;

  const report = {
    generatedAt: new Date(now).toISOString(),
    windowHours: 24,
    nightly,
    sync,
    coverageRun: coverageDone,
    corpus: {
      bills: corpusBills,
      delta: corpusBills !== null && previousBills !== null ? corpusBills - previousBills : null,
    },
    cursor: state ? cursorHealth(state, { now }) : null,
    coverage: staleness
      ? {
          bills: coverageBills,
          delta: coverageBills !== null && previousCoverageBills !== null ? coverageBills - previousCoverageBills : null,
          stale: staleness.stale,
          undated: staleness.undated,
          sharePct: staleness.sharePct,
        }
      : null,
    anthropic: { ...anthropic, byWorkflow: anthropicByWorkflow },
    newsdesk: { scheduledRuns: newsdeskScheduled, expectedSlots: NEWSDESK_EXPECTED_SLOTS, t3 },
    floorSignals: signals ? floorSignalFreshness(signals, { now, staleHours: SIGNAL_STALE_HOURS }) : null,
    workflows,
    ci,
    pregen,
    upstashCacheFailures,
    portrait404s,
    conversation: conversation
      ? { slugs: Object.keys(conversation.slugs ?? {}).length, dangling: danglingConversationSlugs(conversation, billIds) }
      : null,
    momentCandidates: readMomentCandidates(now),
    logsRead: Math.min(logTargets.length, MAX_LOG_FETCHES),
    logsSkipped: skippedLogs,
  };

  report.spend = estimateDaySpend({
    decodes: sync?.added ?? 0,
    t3Batched: t3.batched,
    t3Runs: t3.runs,
    pregen,
  });
  report.alarms = alarms(report);
  return report;
}

/** Open `moment-candidate` issues and how long they have been waiting. */
function readMomentCandidates(now) {
  const issues = ghJson([
    'issue',
    'list',
    '--repo',
    REPO,
    '--state',
    'open',
    '--label',
    'moment-candidate',
    '--limit',
    '50',
    '--json',
    'number,title,createdAt',
  ]);
  if (issues === null) return null;
  return issues.map((i) => ({
    number: i.number,
    ageDays: Math.floor((now - Date.parse(i.createdAt)) / 86_400_000),
  }));
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

// Script body only when executed directly — the same argv[1] guard
// scripts/check-cursor-age.mjs uses, so importing buildReport reads nothing.
if (/(^|\/)pipeline-health\.mjs$/.test(process.argv[1] ?? '')) {
  const wantJson = process.argv.includes('--json');
  const report = buildReport();
  if (wantJson) console.log(JSON.stringify(report, null, 2));
  else console.log(formatHealthSection(report));
}
