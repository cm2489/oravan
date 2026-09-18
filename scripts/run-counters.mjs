/**
 * run-counters.mjs — the small JSON file a run's scripts write so a LATER step
 * can judge whether the run actually did its job.
 *
 * WHY A FILE AND NOT THE LOGS. The post-commit alarm
 * (scripts/check-run-honesty.mjs) has to answer questions like "did any decode
 * die on a credit-balance error tonight" and "did the t3 disambiguation call
 * come back at all". Scraping the run's own step logs for that would need the
 * Actions API, a token, and a regex over prose that changes whenever a message
 * is reworded — a gate that silently stops matching is worse than no gate.
 * The scripts already know the answer; they just had nowhere to put it that
 * outlived their own process.
 *
 * WHERE IT LIVES. `RUN_COUNTERS_FILE`, which the workflows point at
 * `${{ runner.temp }}/oravan-run-counters.json`. The runner temp dir is wiped
 * with the runner, so nothing leaks between runs and nothing is ever committed.
 *
 * WITH THE VARIABLE UNSET — every local run, and every script anyone runs by
 * hand — every function here is a NO-OP that returns without touching the
 * filesystem. Instrumenting a script must never change what it does.
 *
 * NEVER THROWS. A counter is diagnostics; a corrupted or unwritable counter
 * file must not be able to kill a step that was otherwise about to commit a
 * night of paid work. Every failure degrades to "no counter" and says so once.
 *
 * NEVER HOLDS CONTENT. Counts and short stable kind labels only — no headline
 * text, no bill text, no error bodies (an API error message can echo request
 * content back). `noteKind` is called with labels this repo generates, never
 * with a server string.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const COUNTERS_ENV = 'RUN_COUNTERS_FILE';

/** Absolute path of this run's counter file, or null when instrumentation is off. */
export function countersPath() {
  const p = process.env[COUNTERS_ENV];
  return p && p.trim() !== '' ? p : null;
}

let warned = false;
function warnOnce(message) {
  if (warned) return;
  warned = true;
  console.warn(`::warning::run-counters: ${message}`);
}

/** Read the whole counter object. `{}` when there is no file yet or it is unreadable. */
export function readCounters(path = countersPath()) {
  if (!path) return {};
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {}; // first write of the run - not an error
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    warnOnce(`${path} does not parse (${e.message}); starting from empty counters`);
    return {};
  }
}

/**
 * Add `delta` to one counter. Read-modify-write, because the steps that write
 * these run one at a time in one job — there is no concurrent writer to lose.
 */
export function bumpCounter(name, delta = 1) {
  const path = countersPath();
  if (!path) return;
  try {
    const counters = readCounters(path);
    counters[name] = (Number(counters[name]) || 0) + delta;
    writeFileSync(path, JSON.stringify(counters, null, 2));
  } catch (e) {
    warnOnce(`could not write ${path} (${e.message}); this run's honesty alarm will judge on partial counters`);
  }
}

/** Set a counter to an absolute value (for a total the script already tracks). */
export function setCounter(name, value) {
  const path = countersPath();
  if (!path) return;
  try {
    const counters = readCounters(path);
    counters[name] = value;
    writeFileSync(path, JSON.stringify(counters, null, 2));
  } catch (e) {
    warnOnce(`could not write ${path} (${e.message}); this run's honesty alarm will judge on partial counters`);
  }
}

/**
 * Record one failed Anthropic call, already classified by
 * scripts/api-billing.mjs. Bumps the totals the alarm reads plus a per-kind
 * counter, so the run log says WHICH failure without the alarm having to parse
 * anything.
 *
 * @param {{kind: string, unbilled: boolean, creditBalance: boolean}} verdict
 */
export function recordApiError(verdict) {
  bumpCounter('apiErrors');
  if (verdict?.unbilled) bumpCounter('apiUnbilledErrors');
  if (verdict?.creditBalance) bumpCounter('apiCreditBalanceErrors');
  if (verdict?.apiType === 'invalid_request_error') bumpCounter('apiInvalidRequestErrors');
  if (typeof verdict?.kind === 'string' && verdict.kind !== '') {
    bumpCounter(`apiError_${verdict.kind}`);
  }
}
