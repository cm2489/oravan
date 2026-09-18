import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyApiError, isCreditBalanceError, UNBILLED_STATUSES } from '../scripts/api-billing.mjs';
import { chargeableDecode } from '../scripts/newsdesk-match.mjs';
import { runHonestyVerdict } from '../scripts/check-run-honesty.mjs';

/*
 * A RUN THAT DIED CAN NO LONGER END GREEN — and a failure nobody was billed
 * for can no longer eat tomorrow's budget.
 *
 * Three things are pinned here, each of which shipped as a silent failure:
 *
 *   1. THE BILLING SPLIT (scripts/api-billing.mjs). The decode caps price the
 *      ATTEMPT, because the attempt is what the invoice prices — except when
 *      the API refuses a request before generating anything, which it does not
 *      invoice at all. On 2026-09-09/10 a credit-balance outage threw that
 *      shape on every decode and the caps counted all of them, so the decodes
 *      were still not running an hour after the account was topped up.
 *   2. THE CAP LEDGER (chargeableDecode). Same function, one new exemption,
 *      and the shape-check failure it was originally built for must stay
 *      charged — that is what stops a deterministic failure re-firing hourly.
 *   3. THE ALARM (runHonestyVerdict). Post-commit, like the cursor-age one and
 *      for the same N8-A2 reason. What matters as much as what it fires on is
 *      what it REFUSES to fire on: a false alarm at 3am teaches everyone to
 *      ignore the real one.
 */

/* ------------------------------------------------------------------ *
 * 1 · Which failures were free.
 * ------------------------------------------------------------------ */
test.describe('classifyApiError (was that failure billed?)', () => {
  /** The shape the Anthropic SDK throws: an HTTP status plus the parsed body. */
  const apiError = (status: number, type: string, message: string) =>
    Object.assign(new Error(message), {
      status,
      error: { type: 'error', error: { type, message } },
    });

  test('the credit-balance refusal is unbilled, and is named as such', () => {
    const err = apiError(
      400,
      'invalid_request_error',
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'
    );
    const v = classifyApiError(err);
    expect(v.unbilled).toBe(true);
    expect(v.creditBalance).toBe(true);
    expect(v.apiType).toBe('invalid_request_error');
    expect(isCreditBalanceError(err)).toBe(true);
  });

  test('every pre-generation rejection status is unbilled', () => {
    for (const status of UNBILLED_STATUSES) {
      expect(classifyApiError(apiError(status, 'invalid_request_error', 'no')).unbilled, String(status)).toBe(true);
    }
    // 5xx: the request died server-side and returns an error body, not content.
    for (const status of [500, 502, 503, 529]) {
      expect(classifyApiError(apiError(status, 'api_error', 'boom')).unbilled, String(status)).toBe(true);
    }
  });

  test('OUR OWN throw stays billed — this is the conservative half', () => {
    // 'bad decode shape' is thrown by bill-decode.mjs's parser AFTER a reply
    // arrived, so it was generated and invoiced. It carries no HTTP status,
    // and anything without one is charged: guessing "free" here would re-open
    // the unbounded-paid-retry hole chargeableDecode was built to close.
    const v = classifyApiError(new Error('bad decode shape'));
    expect(v.unbilled).toBe(false);
    expect(v.creditBalance).toBe(false);
    expect(v.kind).toBe('no_http_status');
  });

  test('a dropped connection stays billed — it may have been generated', () => {
    expect(classifyApiError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })).unbilled).toBe(false);
  });

  test('a non-Error and undefined do not throw', () => {
    expect(classifyApiError(undefined).unbilled).toBe(false);
    expect(classifyApiError('nope' as unknown).unbilled).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 2 · The cap ledger exempts what nobody was billed for.
 * ------------------------------------------------------------------ */
test.describe('chargeableDecode (the caps price the BILLED attempt)', () => {
  test('a decode that reached the model and was billed is charged', () => {
    expect(chargeableDecode({ outcome: 'added', slug: 'hr-1-119', decodeAttempted: true })).toBe(true);
    // The shape-check failure: attempted, billed, failed. Still charged — this
    // is the 2026-08-09 fix and it must not regress.
    expect(
      chargeableDecode({ outcome: 'failed', slug: 'hr-1-119', decodeAttempted: true, unbilledApiError: false })
    ).toBe(true);
  });

  test('a decode the API refused before generating is NOT charged', () => {
    expect(
      chargeableDecode({ outcome: 'failed', slug: 'hr-1-119', decodeAttempted: true, unbilledApiError: true })
    ).toBe(false);
  });

  test('the free outcomes are still free', () => {
    for (const outcome of ['refreshed', 'gated', 'budget', 'skipped_no_text', 'missing']) {
      expect(chargeableDecode({ outcome, slug: 'hr-1-119', decodeAttempted: false }), outcome).toBe(false);
    }
  });

  test('the exemption also releases the day-long retry lock', () => {
    // scripts/newsdesk.mjs sets failedDecodeKey INSIDE the chargeableDecode
    // branch, so an unbilled failure no longer locks a slug out of retrying
    // for the rest of the UTC day either. Pinned on the source, because the
    // coupling is the point: if the lock ever moves outside that branch, a
    // two-hour outage goes back to costing a whole day of re-decodes.
    const src = readFileSync(join(process.cwd(), 'scripts/newsdesk.mjs'), 'utf8');
    for (const block of src.split('if (chargeableDecode(result)) {').slice(1)) {
      expect(block.slice(0, 400)).toContain('failedDecodeKey');
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3 · The alarm.
 * ------------------------------------------------------------------ */
test.describe('runHonestyVerdict (the post-commit run alarm)', () => {
  test('a healthy nightly passes', () => {
    const v = runHonestyVerdict(
      { billsAdded: 4, billsFailed: 1, decodeAttempts: 5, preflightFailed: 0 },
      { job: 'nightly' }
    );
    expect(v.ok).toBe(true);
    expect(v.failures).toEqual([]);
  });

  test('a credit-balance failure reds the run and says the data still landed', () => {
    const v = runHonestyVerdict(
      { apiErrors: 60, apiUnbilledErrors: 60, apiCreditBalanceErrors: 60, apiInvalidRequestErrors: 60, billsAdded: 0, billsFailed: 60, decodeAttempts: 60 },
      { job: 'nightly' }
    );
    expect(v.ok).toBe(false);
    expect(v.failures.join(' ')).toContain('CREDIT BALANCE');
    expect(v.failures.join(' ')).toContain('Top up');
  });

  test('an invalid_request_error that is NOT the credit balance is reported separately', () => {
    const v = runHonestyVerdict({ apiInvalidRequestErrors: 3, apiCreditBalanceErrors: 0 }, { job: 'nightly' });
    expect(v.ok).toBe(false);
    expect(v.failures.join(' ')).toContain('code or configuration fault');
    // ...and is not double-counted when both kinds happened in one run.
    const both = runHonestyVerdict({ apiInvalidRequestErrors: 5, apiCreditBalanceErrors: 5 }, { job: 'nightly' });
    expect(both.failures).toHaveLength(1);
  });

  test('a nightly that reached the model and landed nothing is a dead decode path', () => {
    const v = runHonestyVerdict({ decodeAttempts: 12, billsAdded: 0, billsFailed: 12 }, { job: 'nightly' });
    expect(v.ok).toBe(false);
    expect(v.failures.join(' ')).toContain('dead decode path');
  });

  test('a NORMAL refresh-only night does not fire — this is the false alarm it must not raise', () => {
    // Most nights add zero brand-new bills, and a single transient
    // Congress.gov 500 in the middle of one is not a decode failure. Without
    // the decode-attempts condition this rule would red half the year.
    const v = runHonestyVerdict({ decodeAttempts: 0, billsAdded: 0, billsFailed: 2, billsRefreshed: 310 }, { job: 'nightly' });
    expect(v.ok).toBe(true);
  });

  test('a disabled preflight reds the run and says exactly what did and did not land', () => {
    const v = runHonestyVerdict({ preflightFailed: 1, billsRefreshed: 300, billsAdded: 0 }, { job: 'nightly' });
    expect(v.ok).toBe(false);
    expect(v.failures.join(' ')).toContain('DECODED NOTHING');
    expect(v.failures.join(' ')).toContain('are real and complete');
  });

  test('a dead t3 call reds the newsdesk run', () => {
    const v = runHonestyVerdict({ t3Batched: 7, t3Resolved: 0, t3Failed: 1 }, { job: 'newsdesk' });
    expect(v.ok).toBe(false);
    expect(v.failures.join(' ')).toContain('t3 disambiguation call DIED');
  });

  test('t3 answering "none of these" is NOT a failure — it is the model doing its job', () => {
    const v = runHonestyVerdict({ t3Batched: 7, t3Resolved: 0, t3Failed: 0 }, { job: 'newsdesk' });
    expect(v.ok).toBe(true);
    expect(v.notes.join(' ')).toContain('legitimate answer');
  });

  test('an empty t3 batch is silence, not an alarm', () => {
    // The common case by far: most hourly runs have nothing ambiguous and
    // never make the call at all.
    expect(runHonestyVerdict({ t3Batched: 0, t3Failed: 0, billsRefreshed: 2 }, { job: 'newsdesk' }).ok).toBe(true);
  });

  test('the nightly rules do not judge a newsdesk run, or vice versa', () => {
    // decodeAttempts>0 with nothing added is normal for the newsdesk: its
    // decodes are RE-decodes, which land as 'redecoded', not as billsAdded.
    expect(runHonestyVerdict({ decodeAttempts: 3, billsAdded: 0, billsFailed: 3 }, { job: 'newsdesk' }).ok).toBe(true);
    expect(runHonestyVerdict({ t3Batched: 5, t3Failed: 2 }, { job: 'nightly' }).ok).toBe(true);
  });

  test('NO counters at all is unmeasured, not a pass', () => {
    const v = runHonestyVerdict({}, { job: 'nightly', instrumented: false });
    expect(v.ok).toBe(false);
    expect(v.failures.join(' ')).toContain('instrumentation broke');
  });

  test('an unknown job fails rather than silently checking nothing', () => {
    const v = runHonestyVerdict({ apiCreditBalanceErrors: 99 }, { job: 'hot-bills' });
    expect(v.ok).toBe(false);
    expect(v.failures.join(' ')).toContain('unknown job');
  });
});
