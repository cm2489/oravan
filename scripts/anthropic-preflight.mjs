/**
 * anthropic-preflight.mjs — one minimal Anthropic call before the night spends
 * anything, so a dead key or an empty account is found in one second instead of
 * sixty failed decodes later.
 *
 * WHAT IT IS FOR. On Sep 9-10 2026 the account's credit balance ran out. Every
 * decode that night threw a 400, each one caught and logged by syncOneBill, and
 * the run walked on to the end and went green. The decodes were also CHARGED to
 * the daily caps on the way past (fixed separately, in scripts/api-billing.mjs)
 * so the first hour after the top-up still decoded nothing.
 *
 * WHAT IT MUST NEVER DO. Block the data refresh. Congress.gov statuses, floor
 * signals, coverage, nominations and portrait mirroring are free and correct
 * whether or not the model is reachable, and a night that ships them is
 * strictly better than a night that ships nothing. So this script NEVER fails
 * the job:
 *   - it writes `decode_ok=true|false` to $GITHUB_OUTPUT, which the sync step
 *     reads to decide whether to hand the scripts a decode budget at all
 *   - on failure it records `preflightFailed` in the run counters, and the
 *     post-commit alarm (scripts/check-run-honesty.mjs) is what reds the run —
 *     after the data has landed
 *   - it exits 0 either way; the workflow step also carries continue-on-error
 *     so a crash in THIS file cannot cost the night either
 *
 * COST. One request, `max_tokens: 1`, on the cheapest model this repo already
 * calls (Haiku). ~12 input tokens at $1/MTok plus 1 output token at $5/MTok =
 * about $0.000017 per night, i.e. under two cents a century. The model string
 * is deliberately the SAME one scripts/newsdesk.mjs and scripts/sync-coverage.mjs
 * already call successfully every hour: a preflight that false-alarms on an
 * unfamiliar model id would cost the night its decodes for nothing, so it is
 * pinned to a string this repo has proven in production rather than to a newer
 * one nobody here has called.
 *
 * NO KEY AT ALL is reported as a failure, because on this workflow the key is
 * always supposed to be there. Locally, with no key, it says so and still
 * exits 0.
 */
import Anthropic from '@anthropic-ai/sdk';
import { appendFileSync } from 'node:fs';
import { classifyApiError } from './api-billing.mjs';
import { bumpCounter, setCounter } from './run-counters.mjs';

/** Same Haiku the newsdesk's t3 tier and the coverage sync already call. */
export const PREFLIGHT_MODEL = 'claude-haiku-4-5-20251001';

function emit(ok) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  try {
    appendFileSync(out, `decode_ok=${ok ? 'true' : 'false'}\n`);
  } catch (e) {
    console.warn(`::warning::preflight could not write GITHUB_OUTPUT (${e.message})`);
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('::error::preflight: ANTHROPIC_API_KEY is not set — this run will refresh bills but decode nothing.');
    setCounter('preflightFailed', 1);
    emit(false);
    return;
  }

  // maxRetries 2, not the decode path's 8: this call exists to answer a
  // question fast, and an account-level failure is not going to improve on the
  // eighth attempt.
  const anthropic = new Anthropic({ maxRetries: 2 });
  try {
    await anthropic.messages.create({
      model: PREFLIGHT_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ok' }],
    });
    console.log(`preflight: ${PREFLIGHT_MODEL} reachable — decodes are armed for this run`);
    setCounter('preflightFailed', 0);
    emit(true);
  } catch (e) {
    const v = classifyApiError(e);
    // The message is the SDK's, and an Anthropic error message never echoes the
    // API key. It can echo the request, which here is the three characters
    // above, so there is nothing to redact.
    console.error(
      `::error::preflight FAILED (${v.kind}${v.status === null ? '' : `, HTTP ${v.status}`}): ${e.message}`
    );
    if (v.creditBalance) {
      console.error('::error::preflight: this is the credit-balance refusal — top up the Anthropic account.');
    }
    console.error(
      '::error::preflight: decodes are DISABLED for this run (max_new_decodes forced to 0). Every free refresh still runs and still commits; the post-commit honesty alarm reds the run.'
    );
    setCounter('preflightFailed', 1);
    bumpCounter('apiErrors');
    if (v.creditBalance) bumpCounter('apiCreditBalanceErrors');
    emit(false);
  }
}

if (/(^|\/)anthropic-preflight\.mjs$/.test(process.argv[1] ?? '')) {
  // Never rejects: a throw here would fail the step, which is the one thing
  // this file is not allowed to do. Not awaited at the top level — a
  // top-level await in a scripts/*.mjs breaks Playwright's transform when a
  // spec imports it (see scripts/merge-sync-state.mjs's guard comment).
  main().catch((e) => {
    console.error(`::error::preflight crashed (${e.message}) — decodes disabled for this run out of caution.`);
    setCounter('preflightFailed', 1);
    emit(false);
  });
}
