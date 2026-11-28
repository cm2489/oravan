/**
 * A PER-BILL FAILURE LIMIT for paid decodes (2026-11-28, the independent
 * check of PR #581, defect 5).
 *
 * THE FAILURE IT STOPS. A decode that reaches the model and then fails — a
 * reply that fails the publish shape check, a split bill whose fourth chunk
 * call errors after three were paid for — leaves no decode, so the bill is
 * nominated again the next night and paid for again. For a NEW bill the
 * cursor also freezes on it (lib/decode-batch.mjs `unresolvedSlugs`), so one
 * bill that can never succeed stalls the backlog scan for good. Before #581
 * the dearest such decode cost ~$0.09 a night; a split bill costs ~$1.
 *
 * THE RULE. A bill whose decode fails, BILLED, on DECODE_FAILURE_LIMIT nights
 * for the SAME text is PARKED: the nightly stops trying it, treats it as
 * resolved for the cursor (the scan moves on), and prints an alarm line every
 * night it stays parked — never silence. It leaves the park by itself the
 * moment Congress publishes a different text version (a different document
 * is a fresh chance), when a decode of it succeeds, or when the owner forces
 * it (FORCE_DECODE_SLUGS / FORCE_REDECODE_SLUGS bypass the park).
 *
 * WHAT COUNTS. Only a failure the API billed: a refusal before generation (a
 * credit-balance 400, a 429, a 5xx — scripts/api-billing.mjs `unbilled`)
 * costs nothing and says nothing about the bill, so an outage night can never
 * park the queue. A failure before the first model call (a Congress.gov
 * timeout) is free and not counted either.
 *
 * WHERE IT LIVES: data/decode-failures.json, ONE writer (the nightly sync,
 * inside the data-sync concurrency group), committed with the cursor like
 * data/decode-batch-parked.json. It holds slugs, counts, dates and short
 * labels this repo generates — never model output, never an error message.
 * The same file carries `waiting`: new bills the spend ceiling left for the
 * next night, so the nightly fetches them directly even if no window holds
 * them (the parked-batch direct fetch, extended).
 *
 * Pure: every function takes the state and returns a new one.
 */

export const DECODE_FAILURES_PATH = 'data/decode-failures.json';
export const DECODE_FAILURES_SCHEMA = 'decode-failures/v1';
/** Billed failures, on separate nights, for the same text, before a bill is parked. */
export const DECODE_FAILURE_LIMIT = 3;
/** An unparked failure count this old is forgotten: the failures were not in a row. */
export const FAILURE_FORGET_MS = 30 * 24 * 3_600_000;
/** A ceiling-deferred bill not decoded after this long is dropped from `waiting`
 *  (it re-enters through its own updateDate like any bill). */
export const WAITING_FORGET_MS = 14 * 24 * 3_600_000;

const SLUG_RE = /^[a-z]+-\d+-\d+$/;

/** @returns {{ schema: string, bills: Record<string, any>, waiting: Record<string, any> }} */
export function emptyFailureState() {
  return { schema: DECODE_FAILURES_SCHEMA, bills: {}, waiting: {} };
}

/** The text a failure is pinned to: the version's date, or null when unknown. */
export function textKeyOf(version) {
  if (version && typeof version === 'object') return version.date ?? null;
  return typeof version === 'string' ? version : null;
}

/**
 * Parse fail-closed per entry: a malformed entry is dropped and reported. A
 * dropped entry costs at most one more paid retry; a trusted bad one could
 * park the wrong bill.
 */
export function normalizeFailureState(raw, log = () => {}) {
  const state = emptyFailureState();
  if (raw === null || raw === undefined) return state;
  const bills = raw?.bills && typeof raw.bills === 'object' ? raw.bills : {};
  for (const [slug, e] of Object.entries(bills)) {
    const ok = SLUG_RE.test(slug) && e && Number.isInteger(e.failures) && e.failures > 0 &&
      Number.isFinite(Date.parse(e.lastFailureAt)) &&
      (e.textDate === null || typeof e.textDate === 'string') &&
      (e.parkedAt === undefined || e.parkedAt === null || Number.isFinite(Date.parse(e.parkedAt)));
    if (!ok) { log(`::warning::decode-failures: dropped an unreadable entry for ${JSON.stringify(slug).slice(0, 60)}`); continue; }
    state.bills[slug] = {
      failures: e.failures, firstFailureAt: e.firstFailureAt ?? e.lastFailureAt, lastFailureAt: e.lastFailureAt,
      textDate: e.textDate ?? null, parkedAt: e.parkedAt ?? null, lastKind: typeof e.lastKind === 'string' ? e.lastKind.slice(0, 40) : null,
    };
  }
  const waiting = raw?.waiting && typeof raw.waiting === 'object' ? raw.waiting : {};
  for (const [slug, w] of Object.entries(waiting)) {
    if (SLUG_RE.test(slug) && w && Number.isFinite(Date.parse(w.since))) state.waiting[slug] = { since: w.since, reason: 'ceiling' };
  }
  return state;
}

/** True when this bill's decode is parked for THIS text. */
export function isFailureParked(state, slug, version) {
  const e = state?.bills?.[slug];
  return Boolean(e?.parkedAt) && e.textDate === textKeyOf(version);
}

/**
 * Book one BILLED failure. A different text than the one on record starts the
 * count again. Returns the new state and whether this failure parked the bill.
 */
export function recordFailure(state, slug, version, { now = Date.now(), kind = null } = {}) {
  const at = new Date(now).toISOString();
  const key = textKeyOf(version);
  const prev = state.bills[slug];
  const same = prev && prev.textDate === key;
  const failures = (same ? prev.failures : 0) + 1;
  const parkedAt = same && prev.parkedAt ? prev.parkedAt : failures >= DECODE_FAILURE_LIMIT ? at : null;
  const entry = {
    failures,
    firstFailureAt: same ? prev.firstFailureAt : at,
    lastFailureAt: at,
    textDate: key,
    parkedAt,
    lastKind: kind ? String(kind).slice(0, 40) : null,
  };
  return {
    state: { ...state, bills: { ...state.bills, [slug]: entry } },
    parkedNow: Boolean(parkedAt) && !(same && prev.parkedAt),
    entry,
  };
}

/** A decode of this bill landed: its record is cleared. */
export function recordSuccess(state, slug) {
  if (!state.bills[slug] && !state.waiting[slug]) return state;
  const bills = { ...state.bills };
  const waiting = { ...state.waiting };
  delete bills[slug];
  delete waiting[slug];
  return { ...state, bills, waiting };
}

/** Remember new bills the ceiling left for the next night. */
export function addWaiting(state, slugs, { now = Date.now() } = {}) {
  const waiting = { ...state.waiting };
  for (const s of slugs) if (SLUG_RE.test(s) && !waiting[s]) waiting[s] = { since: new Date(now).toISOString(), reason: 'ceiling' };
  return { ...state, waiting };
}

/** Forget a waiting bill (it landed, or tonight found it needs no decode). */
export function dropWaiting(state, slugs) {
  const waiting = { ...state.waiting };
  let changed = false;
  for (const s of slugs) if (waiting[s]) { delete waiting[s]; changed = true; }
  return changed ? { ...state, waiting } : state;
}

/** Drop what is over: unparked counts older than FAILURE_FORGET_MS, waiting
 *  entries older than WAITING_FORGET_MS, anything already in the corpus
 *  (except a parked RE-decode, which is in the corpus by definition). */
export function pruneFailureState(state, { now = Date.now(), inCorpus = () => false } = {}) {
  const bills = {};
  for (const [slug, e] of Object.entries(state.bills)) {
    if (!e.parkedAt && now - Date.parse(e.lastFailureAt) > FAILURE_FORGET_MS) continue;
    bills[slug] = e;
  }
  const waiting = {};
  for (const [slug, w] of Object.entries(state.waiting)) {
    if (inCorpus(slug) || now - Date.parse(w.since) > WAITING_FORGET_MS) continue;
    waiting[slug] = w;
  }
  return { ...state, bills, waiting };
}

/** Every parked bill, for the nightly alarm. */
export function parkedFailures(state) {
  return Object.entries(state?.bills ?? {})
    .filter(([, e]) => e.parkedAt)
    .map(([slug, e]) => ({ slug, ...e }));
}

/** The alarm line, one per parked bill, printed every night it stays parked. */
export function failureParkedLine(p) {
  return `::warning::DECODE PARKED AFTER REPEATED FAILURES: ${p.slug} - ${p.failures} billed failure(s) on separate nights for the text of ${p.textDate ?? 'an unknown date'} (parked ${String(p.parkedAt).slice(0, 10)}); not retried until Congress publishes a new text version or the slug is forced`;
}
