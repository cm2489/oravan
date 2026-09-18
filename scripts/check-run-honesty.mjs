/**
 * check-run-honesty.mjs — the SECOND post-commit alarm. A run whose core
 * function died can no longer end green.
 *
 * WHY IT RUNS AFTER THE COMMIT, like scripts/check-cursor-age.mjs and for the
 * identical reason (owner ruling 2026-08-12, N8-A2): what it measures is
 * whether the night WORKED, not whether the corpus is sound. A night whose
 * decodes all died on a credit-balance error still fetched real statuses, real
 * floor signals, real coverage — refusing that commit would throw away free,
 * correct data to protest a failure that has nothing to do with it, and would
 * freeze the site's own freshness signal at a value staler than the truth.
 * So: the data lands, and then the run goes red, loudly, naming what died.
 *
 * WHAT WAS GOING WRONG. Three real failures ended GREEN:
 *   1. Sep 9-10 2026 — every decode threw a 400 invalid_request_error (credit
 *      balance exhausted). Each decode is `continue-on-error`-shaped by
 *      construction: syncOneBill catches, returns 'failed', and the run walks
 *      on. Two nights in a row reported success while decoding nothing.
 *   2. The newsdesk's t3 disambiguation call catches its own errors and
 *      `return new Map()` — "degrade gracefully". That is right for the RUN
 *      (no headline should block a bill refresh) and wrong for the SIGNAL: a
 *      t3 tier that is dark every hour looks exactly like a quiet news day.
 *   3. A nightly that reached the model on every new bill and landed none of
 *      them — added 0, failed > 0 — is a dead decode path, not a slow night.
 *
 * WHAT IT DELIBERATELY DOES NOT FIRE ON, because a false alarm at 3am teaches
 * everyone to ignore the real one:
 *   - t3 answering "none of these" for a whole batch. That is the model doing
 *     its job; the tier only counts as dark when the CALL died (an API error or
 *     an unparseable reply), which is a counter of its own.
 *   - a nightly that added 0 bills because it never tried to decode one. Most
 *     nights are refreshes, and a transient Congress.gov 500 in the middle of
 *     one is not a decode failure. The rule needs decode attempts > 0.
 *
 * Counters come from scripts/run-counters.mjs (a JSON file in the runner temp
 * dir). A run that wrote NO counters is reported as unmeasured rather than
 * passed — see `runHonestyVerdict`.
 *
 * Pure judgement + a thin script body, the same split as cursorAgeVerdict:
 * tests/run-honesty.unit.spec.ts imports runHonestyVerdict directly.
 */
import { readCounters, countersPath } from './run-counters.mjs';

/** Jobs this alarm knows how to judge. Each names the rules that apply to it. */
export const HONESTY_JOBS = ['nightly', 'newsdesk'];

const n = (counters, key) => Number(counters?.[key]) || 0;

/**
 * @param {Record<string, unknown>} counters this run's counter file
 * @param {{job: string, instrumented?: boolean}} args `job` is 'nightly' or
 *   'newsdesk'; `instrumented` false means no counter file was ever written.
 * @returns {{ok: boolean, failures: string[], notes: string[]}}
 */
export function runHonestyVerdict(counters, { job, instrumented = true } = {}) {
  const failures = [];
  const notes = [];

  if (!HONESTY_JOBS.includes(job)) {
    return {
      ok: false,
      failures: [
        `check-run-honesty was asked to judge an unknown job "${job}" — it knows ${HONESTY_JOBS.join(' and ')}. Fix the workflow step rather than widening this list by accident.`,
      ],
      notes,
    };
  }

  if (!instrumented) {
    // Every instrumented step writes at least one counter, so an absent file
    // means the instrumentation itself broke. Silence is not a pass.
    return {
      ok: false,
      failures: [
        `no run counters were written this run (${job}). Every scripted step is supposed to record what it did, so an empty counter file means the instrumentation broke, not that the run was quiet — this alarm cannot tell you the run was healthy, so it refuses to say so.`,
      ],
      notes,
    };
  }

  // ---- Rule 1 (both jobs): a request the API refused before generating. ----
  // Free, so it never reaches an invoice — and therefore never reaches a
  // spend-shaped alarm either. This is the only thing that catches it.
  const credit = n(counters, 'apiCreditBalanceErrors');
  const invalid = n(counters, 'apiInvalidRequestErrors');
  if (credit > 0) {
    failures.push(
      `${credit} Anthropic call(s) failed on the account's CREDIT BALANCE. Everything downstream of the model was silently skipped tonight; the data that landed is the free half of the run. Top up the Anthropic account, then re-dispatch this workflow.`
    );
  }
  if (invalid > credit) {
    failures.push(
      `${invalid - credit} Anthropic call(s) failed with invalid_request_error for a reason other than credit balance — a malformed request, or a model id the account cannot reach. This is a code or configuration fault, not a transient one: it will fail identically on every run until someone changes something.`
    );
  }

  // ---- Rule 2 (newsdesk): the t3 tier went dark. ----
  if (job === 'newsdesk') {
    const batched = n(counters, 't3Batched');
    const failed = n(counters, 't3Failed');
    if (batched > 0 && failed > 0) {
      failures.push(
        `the t3 disambiguation call DIED with ${batched} ambiguous headline(s) waiting on it, so this run resolved ${n(counters, 't3Resolved')} of them. scripts/newsdesk.mjs catches that error and degrades to zero t3 matches on purpose — a dead tier must never cost the run its bill refreshes — which is exactly why it cannot be allowed to also look like a quiet news hour.`
      );
    } else if (batched > 0 && n(counters, 't3Resolved') === 0) {
      notes.push(
        `t3 offered ${batched} headline(s) and matched none of them — the call succeeded and the model said "none of these", which is a legitimate answer, not a failure.`
      );
    }
  }

  // ---- Rule 3 (nightly): every decode reached the model and none landed. ----
  if (job === 'nightly') {
    const attempts = n(counters, 'decodeAttempts');
    const added = n(counters, 'billsAdded');
    const failed = n(counters, 'billsFailed');
    if (attempts > 0 && added === 0 && failed > 0) {
      failures.push(
        `the nightly reached the model ${attempts} time(s), added+decoded 0 bills and failed ${failed}. A night with nothing new to decode is normal; a night that tried and landed none of them is a dead decode path. The per-bill reasons are in the "Sync bills" step's FAIL lines above.`
      );
    }
    if (n(counters, 'preflightFailed') > 0) {
      failures.push(
        `the Anthropic preflight failed, so this run refreshed bills but DECODED NOTHING (max_new_decodes was forced to 0). The refreshes, coverage, nominations and Moment updates on main are real and complete; the decode backlog simply did not move. The preflight step's own log names the error.`
      );
    }
  }

  return { ok: failures.length === 0, failures, notes };
}

// Script body only when executed directly — the same argv[1] guard the rest of
// scripts/ uses, so importing the judgement above reads no file.
if (/(^|\/)check-run-honesty\.mjs$/.test(process.argv[1] ?? '')) {
  const job = process.argv[2] ?? process.env.HONESTY_JOB ?? '';
  const path = countersPath();
  const counters = readCounters(path);
  const instrumented = path !== null && Object.keys(counters).length > 0;

  // Belt and braces on the preflight. The script writes `preflightFailed`
  // itself, but a hard crash inside it (before its own catch) would leave no
  // counter while still leaving decode_ok unset — which the sync step reads as
  // "decode nothing". The workflow therefore also hands us the step output, so
  // a night that decoded nothing can never end green for want of a counter.
  const decodeOk = process.env.PREFLIGHT_DECODE_OK;
  if (job === 'nightly' && decodeOk !== undefined && decodeOk !== 'true') {
    counters.preflightFailed = Math.max(1, Number(counters.preflightFailed) || 0);
  }
  const verdict = runHonestyVerdict(counters, { job, instrumented });

  console.log(`run counters (${job}): ${JSON.stringify(counters)}`);
  for (const note of verdict.notes) console.log(`  note: ${note}`);
  if (!verdict.ok) {
    for (const f of verdict.failures) console.error(`::error::${f}`);
    console.error(
      '::error::THE DATA THIS RUN PRODUCED IS COMMITTED — this alarm runs after the commit, on purpose (CLAUDE.md, N8-A2). What is broken is the run, not the corpus.'
    );
    process.exit(1);
  }
  console.log(`run honesty (${job}): nothing that was supposed to run came back dead`);
}
