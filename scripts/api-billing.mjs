/**
 * api-billing.mjs — "did that failed Anthropic call actually cost anything?"
 *
 * WHY THIS EXISTS (the Sep 9-10 2026 credit outage)
 * -------------------------------------------------
 * scripts/newsdesk-match.mjs's chargeableDecode prices the ATTEMPT, not the
 * win, and that was right for the failure it was built for: a decode that
 * reaches the model, gets a reply, and fails its shape check has already been
 * invoiced. Charging only on success let such a bill re-fire every hour, all
 * day, paying every time.
 *
 * But `decodeAttempted` is set immediately BEFORE the first request, so it is
 * also true for a request the API never generated anything for. When the
 * account's credit balance ran out, every decode threw a 400
 * `invalid_request_error` ("credit balance is too low"), nothing was billed —
 * and the caps counted all of it. Two hours of an outage ate the whole day's
 * NEWSDESK_DAILY_DECODE_CAP / TIER0_DAILY_DECODE_CAP, so the decodes were
 * still not running an hour after the credits were topped up. The failure ate
 * tomorrow's budget for work nobody paid for.
 *
 * WHAT COUNTS AS UNBILLED. Anthropic bills for generation. A request the API
 * rejects before it generates returns an error status with no content, and the
 * invoice never sees it:
 *   400 invalid_request_error — malformed request, and the credit-balance
 *       refusal, which arrives in exactly this shape
 *   401/403 — authentication_error / permission_error: the key never bought
 *       anything
 *   404 not_found_error — usually a model id that does not exist
 *   413 request_too_large / 422 — rejected at the door
 *   429 rate_limit_error — refused, not served
 *   5xx api_error / overloaded_error — the request died server-side and
 *       returns an error body instead of content
 *
 * WHAT STAYS BILLED, and this is the conservative half on purpose: anything
 * without an HTTP status. A plain `Error('bad decode shape')` thrown by our own
 * parser, a JSON parse failure, a connection that dropped mid-generation — all
 * of those either did, or plausibly did, get generated. Guessing "unbilled"
 * there would re-open the unbounded-paid-retry hole the cap was built to close,
 * so the default is: charge it.
 *
 * Pure and dependency-free (it never imports the SDK) so the specs can hand it
 * plain objects — tests/run-honesty.unit.spec.ts.
 */

/** HTTP statuses on which the API rejects a request before generating. */
export const UNBILLED_STATUSES = new Set([400, 401, 403, 404, 413, 422, 429]);

const CREDIT_BALANCE = /credit balance is too low/i;

/** Pull the API's own error `type` out of whichever envelope the SDK attached. */
function apiErrorType(err) {
  return (
    err?.error?.error?.type ??
    err?.error?.type ??
    (typeof err?.type === 'string' ? err.type : null) ??
    null
  );
}

function apiErrorMessage(err) {
  return `${err?.error?.error?.message ?? ''} ${err?.error?.message ?? ''} ${err?.message ?? ''}`;
}

/**
 * Classify a thrown Anthropic error.
 *
 * @param {unknown} err
 * @returns {{status: number|null, apiType: string|null, kind: string,
 *            unbilled: boolean, creditBalance: boolean}}
 *   `unbilled` true means the request was refused before generation, so it cost
 *   nothing and must not be charged to a spend cap. `kind` is a short stable
 *   label for counters and log lines.
 */
export function classifyApiError(err) {
  const status = typeof err?.status === 'number' ? err.status : null;
  const apiType = apiErrorType(err);
  const creditBalance = CREDIT_BALANCE.test(apiErrorMessage(err));

  if (status === null) {
    // No HTTP status: our own throw, a parse failure, or a dropped socket.
    // Conservative — treat it as paid for.
    return { status, apiType, kind: apiType ?? 'no_http_status', unbilled: false, creditBalance };
  }
  if (status >= 500) {
    return { status, apiType, kind: apiType ?? 'server_error', unbilled: true, creditBalance };
  }
  if (UNBILLED_STATUSES.has(status)) {
    return { status, apiType, kind: apiType ?? `http_${status}`, unbilled: true, creditBalance };
  }
  return { status, apiType, kind: apiType ?? `http_${status}`, unbilled: false, creditBalance };
}

/** Shorthand: was this failure free? */
export function isUnbilledApiError(err) {
  return classifyApiError(err).unbilled;
}

/** Shorthand: is this the "top up the account" failure specifically? */
export function isCreditBalanceError(err) {
  return classifyApiError(err).creditBalance;
}
