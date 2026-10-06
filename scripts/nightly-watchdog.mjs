/**
 * RE-DISPATCH A NIGHTLY BILL SYNC THAT NEVER RAN (at most once per UTC day).
 *
 *   node scripts/nightly-watchdog.mjs
 *
 * Run by .github/workflows/nightly-watchdog.yml. The decision, its window and
 * every reason it stands down live in lib/nightly-watchdog.mjs; this file only
 * reads the run list, asks that module, and dispatches when it says so.
 *
 * Env:
 *   GH_TOKEN            the workflow's own GITHUB_TOKEN (`actions: write`)
 *   GITHUB_REPOSITORY   owner/repo
 *   WATCHDOG_DISPATCH   '1' to dispatch for real; anything else only reports
 *                       (a branch validation run, or a local read)
 *
 * FAILURE POSTURE: a run list or a job list that cannot be read exits 1
 * WITHOUT dispatching. Not knowing is never a reason to buy a second nightly;
 * the red run says the check could not be made. A dispatch that errors is
 * NOT retried: a 500 that in fact landed (dispatch-ci.mjs has the 2026-09-21
 * case) must never become two nightlies, so this exits 1 and says to read the
 * run list before dispatching by hand.
 *
 * $0: listing runs and dispatching are free on a public repo. What a nightly
 * it dispatches costs is the nightly's own bill, unchanged (see the workflow).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { NIGHTLY_BRANCH, NIGHTLY_WORKFLOW, decideNightlyRescue, watchdogWindow } from '../lib/nightly-watchdog.mjs';

const REPO = process.env.GITHUB_REPOSITORY || 'cm2489/oravan';
const DISPATCH = process.env.WATCHDOG_DISPATCH === '1';

const api = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));

const summary = (line) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
    } catch {
      /* a summary is a convenience, never the result */
    }
  }
};

function main() {
  const now = Date.now();
  let runs;
  const jobsByRunId = {};
  try {
    const list = api(`repos/${REPO}/actions/workflows/${NIGHTLY_WORKFLOW}/runs?per_page=50`);
    runs = list?.workflow_runs;
    if (!Array.isArray(runs)) throw new Error('the response has no workflow_runs list');
    // Jobs only for the runs the decision may need them for: cancelled
    // main-branch runs inside the window. Usually none, never more than a few.
    const { windowStart } = watchdogWindow(now);
    for (const r of runs) {
      if (r.conclusion === 'cancelled' && r.head_branch === NIGHTLY_BRANCH && Date.parse(r.created_at) >= windowStart) {
        const jobs = api(`repos/${REPO}/actions/runs/${r.id}/jobs?per_page=100`)?.jobs;
        if (!Array.isArray(jobs)) throw new Error(`the jobs of run ${r.id} came back without a list`);
        jobsByRunId[String(r.id)] = jobs;
      }
    }
  } catch (e) {
    console.log(`::error::nightly-watchdog: could not read the nightly's runs (${String(e.message).split('\n')[0]}). Nothing was dispatched.`);
    process.exit(1);
  }

  let verdict;
  try {
    verdict = decideNightlyRescue({ now, runs, jobsByRunId });
  } catch (e) {
    console.log(`::error::nightly-watchdog: the run list could not be judged (${e.message}). Nothing was dispatched.`);
    process.exit(1);
  }

  if (!verdict.dispatch) {
    summary(`Nightly watchdog stood down (${verdict.code}): ${verdict.reason}`);
    return;
  }
  if (!DISPATCH) {
    summary(`Nightly watchdog WOULD dispatch ${NIGHTLY_WORKFLOW} (${verdict.code}): ${verdict.reason} Not dispatched: WATCHDOG_DISPATCH is not 1 (a branch run or a local read).`);
    return;
  }
  try {
    execFileSync('gh', ['workflow', 'run', NIGHTLY_WORKFLOW, '--repo', REPO, '--ref', NIGHTLY_BRANCH], { encoding: 'utf8' });
  } catch (e) {
    console.log(
      `::error::nightly-watchdog: the dispatch of ${NIGHTLY_WORKFLOW} errored (${String(e.message).split('\n')[0]}). It may still have landed: read the run list before dispatching by hand. Not retried.`
    );
    process.exit(1);
  }
  summary(`::notice::Nightly watchdog dispatched ${NIGHTLY_WORKFLOW} on ${NIGHTLY_BRANCH} (${verdict.code}): ${verdict.reason}`);
}

main();
