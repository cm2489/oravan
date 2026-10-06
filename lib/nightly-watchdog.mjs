/*
 * SHOULD THE WATCHDOG RE-DISPATCH THE NIGHTLY BILL SYNC? The one copy of the
 * decision, used by scripts/nightly-watchdog.mjs and pinned by
 * tests/nightly-pipeline.unit.spec.ts. Pure: it reads a run list it is handed
 * and the clock it is handed, and touches nothing.
 *
 * Why (2026-10-06). On 2026-10-05 the nightly (sync-bills.yml) fired seven
 * hours late, waited in the shared data-sync group, and was cancelled before it
 * got a runner (run 37376062791: zero jobs). No nightly ran that day and
 * nothing noticed until the pipeline doctor read the run list the next
 * morning, and the doctor's routine cannot dispatch a workflow (HTTP 403). The
 * data-sync group now queues instead of replacing (`queue: max`), which closes
 * that particular path, but two others stay open: GitHub's scheduler can drop
 * a scheduled run under load (its own documentation says so), and a runner can
 * fail to start (the 10-05 metrics digest: one job, runner_id 0, no steps).
 *
 * THE WINDOW. The nightly's slot is 14:15 UTC and GitHub's scheduler only ever
 * fires late: the scheduled nightly was created 3h41m to 7h13m after its slot
 * on every day from 2026-09-29 to 10-05 (run list read 2026-10-06), and the
 * worst lateness measured on any data-sync member is +9h31m (sync-bills.yml's
 * schedule comment). So a nightly is judged over the window that opens at
 * 14:00 UTC on the day it was due, and the watchdog may act only between 02:00
 * and 14:00 UTC the next day: 11h45m after the nominal slot, past the worst
 * lateness on record, and before the next day's own nightly is due. Outside
 * that band it never dispatches. The band sits inside one UTC day, so "once
 * per window" and "once per UTC day" are the same cap.
 *
 * WHAT STANDS IT DOWN, each one on its own:
 *   - any sync-bills.yml run that is not `completed`, on any branch and of any
 *     age (queued, waiting, pending, requested, in progress, or a status this
 *     code has never heard of): a nightly is already on its way;
 *   - an automatic dispatch already made in this UTC day (a workflow_dispatch
 *     run whose triggering actor is the Actions bot, or has no actor at all):
 *     the once-a-day cap, which holds even when that dispatch itself was lost;
 *   - a main-branch run in the window that SUCCEEDED: the night is done;
 *   - a main-branch run in the window that ended any other way than
 *     `cancelled` (failure, timed out, startup failure, ...): a red nightly
 *     often has its data on main already (the post-commit alarms), and one that
 *     failed for a reason would fail again after re-buying its decodes, so a
 *     person reads it first;
 *   - a cancelled run in the window that got a runner, or whose jobs are not
 *     known: a run that started work and was then stopped was stopped by a
 *     person or a timeout, not dropped.
 * What is left is the one case it exists for: no main-branch nightly was
 * created in the window, or every one that was ended `cancelled` without a
 * runner.
 *
 * FAILURE POSTURE: a run list or job list that cannot be read is not evidence
 * that nothing ran. The caller throws before reaching here, and anything
 * malformed here throws too, so a failed lookup never dispatches. That is the
 * safe direction for this guard: a missed dispatch costs at most one day of
 * freshness, which the cursor alarm and the daily doctor already report, while
 * a wrong one costs a second paid nightly.
 */

/** The workflow this guards, the branch it dispatches on, and the bot whose dispatches count against the cap. */
export const NIGHTLY_WORKFLOW = 'sync-bills.yml';
export const NIGHTLY_BRANCH = 'main';
export const ACTIONS_BOT = 'github-actions[bot]';

/** The window opens at this UTC hour on the day the nightly was due (its slot is 14:15). */
export const WINDOW_OPENS_HOUR_UTC = 14;
/** The watchdog may dispatch only from this UTC hour ... */
export const ACT_FROM_HOUR_UTC = 2;
/** ... until (not including) this one, when the next day's nightly is due. */
export const ACT_UNTIL_HOUR_UTC = 14;
/** At most this many automatic dispatches per UTC day. */
export const MAX_AUTO_DISPATCHES_PER_UTC_DAY = 1;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The window a check at `nowMs` judges.
 * @param {number} nowMs
 * @returns {{ inBand: boolean, utcDayStart: number, windowStart: number }}
 */
export function watchdogWindow(nowMs) {
  if (!Number.isFinite(nowMs)) throw new Error('watchdogWindow: now is not a time');
  const utcDayStart = Math.floor(nowMs / DAY) * DAY;
  const hour = Math.floor((nowMs - utcDayStart) / HOUR);
  return {
    inBand: hour >= ACT_FROM_HOUR_UTC && hour < ACT_UNTIL_HOUR_UTC,
    utcDayStart,
    // Yesterday's 14:00 UTC: the slot of the nightly this band can rescue.
    windowStart: utcDayStart - DAY + WINDOW_OPENS_HOUR_UTC * HOUR,
  };
}

const time = (iso, what) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new Error(`nightly-watchdog: ${what} has no readable created_at (${iso})`);
  return t;
};

/** Did any job of this run ever get a runner? null when the jobs are not known. */
export function gotARunner(jobs) {
  if (!Array.isArray(jobs)) return null;
  return jobs.some((j) => (Number(j?.runner_id) || 0) > 0 || (Array.isArray(j?.steps) && j.steps.length > 0));
}

/**
 * @param {{
 *   now: number,
 *   runs: Array<{ id: number, event: string, status: string, conclusion: string | null,
 *                 created_at: string, head_branch: string, triggering_actor?: { login?: string } | null }>,
 *   jobsByRunId?: Record<string, Array<{ runner_id?: number, steps?: unknown[] }>>,
 * }} input  `runs` is the REST list for sync-bills.yml, newest first, all branches.
 * @returns {{ dispatch: boolean, code: string, reason: string }}
 */
export function decideNightlyRescue({ now, runs, jobsByRunId = {} }) {
  if (!Array.isArray(runs)) throw new Error('nightly-watchdog: the run list is not a list');
  const { inBand, utcDayStart, windowStart } = watchdogWindow(now);
  const stand = (code, reason) => ({ dispatch: false, code, reason });

  if (!inBand) {
    return stand(
      'outside-band',
      `It is outside ${String(ACT_FROM_HOUR_UTC).padStart(2, '0')}:00-${ACT_UNTIL_HOUR_UTC}:00 UTC, when a late scheduled nightly may still fire.`
    );
  }

  const active = runs.find((r) => r?.status !== 'completed');
  if (active) {
    return stand('active', `Nightly run ${active.id} is ${active.status ?? 'in an unknown state'}; it will run.`);
  }

  const autoToday = runs.filter(
    (r) =>
      r.event === 'workflow_dispatch' &&
      time(r.created_at, `run ${r.id}`) >= utcDayStart &&
      (r.triggering_actor?.login ?? ACTIONS_BOT) === ACTIONS_BOT
  );
  if (autoToday.length >= MAX_AUTO_DISPATCHES_PER_UTC_DAY) {
    return stand('cap', `An automatic dispatch was already made today (run ${autoToday[0].id}); the cap is ${MAX_AUTO_DISPATCHES_PER_UTC_DAY} per UTC day.`);
  }

  const inWindow = runs.filter(
    (r) => r.head_branch === NIGHTLY_BRANCH && time(r.created_at, `run ${r.id}`) >= windowStart
  );
  const succeeded = inWindow.find((r) => r.conclusion === 'success');
  if (succeeded) return stand('succeeded', `Nightly run ${succeeded.id} succeeded in this window.`);

  const other = inWindow.find((r) => r.conclusion !== 'cancelled');
  if (other) {
    return stand(
      'needs-a-person',
      `Nightly run ${other.id} ended ${other.conclusion ?? 'with no conclusion'}; a person reads that before anything re-runs it.`
    );
  }

  for (const r of inWindow) {
    const ran = gotARunner(jobsByRunId[String(r.id)]);
    if (ran === null) return stand('jobs-unknown', `The jobs of cancelled run ${r.id} could not be read.`);
    if (ran) return stand('cancelled-after-start', `Run ${r.id} got a runner before it was cancelled; that was a person or a timeout, not a drop.`);
  }

  return inWindow.length === 0
    ? { dispatch: true, code: 'never-fired', reason: 'No nightly was created since 14:00 UTC yesterday.' }
    : {
        dispatch: true,
        code: 'dropped',
        reason: `Every nightly since 14:00 UTC yesterday was cancelled before it got a runner (${inWindow.map((r) => r.id).join(', ')}).`,
      };
}
