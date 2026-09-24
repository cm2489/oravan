/**
 * DISPATCH CI AGAINST THE DATA A WORKFLOW JUST PUSHED.
 *
 *   node scripts/dispatch-ci.mjs
 *
 * Bot pushes (GITHUB_TOKEN) never trigger `on: push`, so without a dispatch
 * main's own suite never runs against a fresh corpus and test/corpus drift
 * lands on the next open PR instead (2026-07-25 incident). Four workflows do
 * this after their commit: sync-bills, hot-bills, newsdesk and
 * refresh-legislators.
 *
 * WHY THIS IS NOT A ONE-LINE `gh workflow run`, which is what it used to be.
 * On 2026-09-21 the nightly's dispatch step failed with
 *
 *     could not create workflow dispatch event: HTTP 500 …/dispatches
 *
 * and CI run 35648109859 was created at 19:58:11 — INSIDE that step's own
 * ten-second window. The dispatch landed; only the response errored. The cost
 * of treating that as a failure is paid twice: the night went red with its
 * data already safely on main, and — because a failing step skips every later
 * step whose `if:` does not name a status function — it also took out the
 * pregen step below it. One flaky API response, two wrong outcomes.
 *
 * So this asks whether the run actually appeared before retrying. Checking
 * first is what keeps a 500-that-worked from spawning duplicate CI runs, which
 * a bare retry loop would do. It still fails, loudly, when CI genuinely was
 * not dispatched — that is a real problem and the whole reason the step
 * exists. "The API said 500" is not by itself evidence either way, and this
 * script's job is to find out which it was rather than guess.
 *
 * $0: `gh run list` and `gh workflow run` are free on a public repo and the
 * workflows calling this already hold `actions: write`.
 */
import { execFileSync } from 'node:child_process';

const REPO = process.env.DISPATCH_REPO || process.env.GITHUB_REPOSITORY || 'cm2489/oravan';
const WORKFLOW = process.env.DISPATCH_WORKFLOW || 'ci.yml';
const REF = process.env.DISPATCH_REF || 'main';
const ATTEMPTS = 3;
/** Long enough for a created run to become visible to `gh run list`. */
const SETTLE_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The newest run id for the workflow on this ref, or null when the question
 * could not be answered. null is NOT 0: "I could not read the run list" and
 * "there are no runs" must not collapse into the same value, because the
 * second would make a missing read look like proof that nothing was created.
 */
function latestRunId() {
  try {
    const out = execFileSync(
      'gh',
      [
        'run',
        'list',
        '--repo',
        REPO,
        '--workflow',
        WORKFLOW,
        '--branch',
        REF,
        '--limit',
        '1',
        '--json',
        'databaseId',
        '--jq',
        '.[0].databaseId // empty',
      ],
      { encoding: 'utf8' }
    ).trim();
    return out === '' ? null : out;
  } catch (e) {
    console.log(`::warning::dispatch-ci: could not read the run list (${e.message.split('\n')[0]})`);
    return null;
  }
}

/**
 * Did a new run appear? Only ever true on two readable ids that differ — an
 * unreadable "before" or "after" answers "I don't know", which this treats as
 * "not proven", so the script retries rather than declaring success it cannot
 * demonstrate.
 */
export function appeared(before, after) {
  if (before === null || after === null) return false;
  return before !== after;
}

async function main() {
  const before = latestRunId();

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      execFileSync('gh', ['workflow', 'run', WORKFLOW, '--repo', REPO, '--ref', REF], { stdio: 'inherit' });
      console.log(`dispatch-ci: ${WORKFLOW} dispatched on ${REF} (attempt ${attempt}).`);
      return 0;
    } catch (e) {
      console.log(`dispatch-ci: attempt ${attempt} failed (${e.message.split('\n')[0]})`);
    }

    await sleep(SETTLE_MS);
    if (appeared(before, latestRunId())) {
      console.log(
        `::notice::dispatch-ci: the dispatch API errored but a new ${WORKFLOW} run appeared on ${REF} — treating it as dispatched, not retrying.`
      );
      return 0;
    }
  }

  console.log(
    `::error::dispatch-ci: ${WORKFLOW} was NOT dispatched on ${REF} after ${ATTEMPTS} attempts, and no new run appeared. main's suite has not run against the data this workflow just pushed.`
  );
  return 1;
}

// Importable for the unit test without firing a dispatch.
if (process.argv[1] && process.argv[1].endsWith('dispatch-ci.mjs')) {
  main().then((code) => process.exit(code));
}
