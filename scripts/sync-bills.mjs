/**
 * Nightly bill sync. Static-first pipeline: updates data/*.json from
 * Congress.gov + Anthropic, then CI commits the diff and Vercel redeploys.
 *
 *   node --env-file=.env.local scripts/sync-bills.mjs
 *
 * Needs CONGRESS_API_KEY + ANTHROPIC_API_KEY.
 *
 * Policy:
 * - Existing bills: status/action/urgency/tags refresh freely (no AI cost).
 * - NEW bills are decode-before-publish AND priority-gated: a new bill only
 *   spends a decode if it clears the priority gate (real legislative
 *   motion — see scripts/decode-gate.mjs) or is explicitly force-listed.
 *   Bills that clear the gate enter the corpus only once their EN+ES
 *   summary and headline exist, so the feed never shows undecoded entries.
 *   At most MAX_NEW_DECODES per run (cost ceiling); the rest wait for the
 *   next night.
 *
 * PRIORITY DECODE GATE (2026-07-16, owner directive: reduce spend, focus on
 * a priority set of legislation — "the majority of the 2,147 bills is junk
 * with high odds of never going anywhere"). A brand-new bill is decoded
 * ONLY if `decode-gate.mjs`'s `passesGate(status)` says so (markup or
 * later — NOT mere "referred to committee", which the gate treats as no
 * real motion; see that module's header comment for the full status-
 * distribution numbers and reasoning behind the line). This is enforced in
 * ONE place, `bill-decode.mjs`'s `syncOneBill`, shared by BOTH the
 * recent-first pass and the ascending backlog pass below, so the gate can't
 * drift between them. Gate-skipped bills are NOT stored anywhere and count
 * as fully handled: the ascending pass's cursor advances past them exactly
 * as if they'd been decoded — this is what drains the multi-week decode
 * backlog nearly for free, since ~80% of the corpus never had a real
 * chance of clearing MAX_NEW_DECODES anyway. If a gated bill later gets
 * real legislative motion, Congress.gov bumps its updateDate past
 * wherever the cursor then sits, so the update feed resurfaces it on a
 * later run and the gate re-evaluates against its new status — nothing
 * about being gated out once is permanent.
 *
 * FORCE_DECODE_SLUGS (comma-separated slugs, e.g. "hr-1234-119,s-45-119")
 * bypasses the gate for exactly those slugs — for a manual/workflow_dispatch
 * catch-up run, or set in-process by scripts/newsdesk.mjs when a headline
 * trigger decides a brand-new bill is newsworthy enough to decode outside
 * the gate's own status-based test (see decode-gate.mjs's parseForceSlugs).
 * A listed slug must name the Congress this build tracks: an entry ending in
 * any other Congress is skipped with a ::warning:: rather than fetched as the
 * same-numbered bill of the tracked one — see forceSlugTarget.
 *
 * Two-pass fetch (2026-07-16, audit §5 item 2). Congress.gov is queried
 * TWICE per run, in this order:
 *   1. Recent-first: `sort=updateDate+desc, limit=RECENT_FETCH_LIMIT` - the
 *      ~100 most-recently-touched bills in the whole 119th Congress, no
 *      cursor floor. Already-known bills refresh for free; brand-new bills
 *      decode within a RESERVED sub-budget (RECENT_DECODE_RESERVE, carved
 *      OUT of MAX_NEW_DECODES, not additional) AND must clear the priority
 *      gate above. This exists because the ascending backlog scan below
 *      structurally reaches the newest bills LAST - on a night with a deep
 *      backlog (or a busy legislative day) a floor vote that just happened
 *      would otherwise lose the race against both MAX_UPDATES and
 *      MAX_NEW_DECODES every single night, which is exactly how HR 7378
 *      (and the whole "worth a call" feed) went stale for weeks even on
 *      clean, successful runs (see the audit).
 *   2. Ascending backlog: `fromDateTime: lastSync, sort=updateDate+asc` -
 *      unchanged from before, drains the historical backlog oldest-first
 *      with whatever decode budget the recent-first pass didn't use. A bill
 *      already handled by pass 1 this run is skipped here (deduped, not
 *      re-fetched or re-decoded).
 *
 * CURSOR SEMANTICS (load-bearing, KTD-pinned): `state.lastSync`'s freeze-
 * on-incomplete-work high-water mark is advanced ONLY by the ascending pass
 * below. The recent-first pass never reads or writes `cursor`/`frozen` - it
 * can find and decode a bill from last week while the ascending backlog is
 * still stuck in May, and the cursor must keep meaning "the backlog scan has
 * fully processed through here", not silently jump forward just because a
 * recent bill happened to get handled out of order. See
 * docs/solutions/pinned-sync-cursor.md for why an all-or-nothing cursor is
 * exactly the failure this preserves the fix for.
 *
 * A TRUNCATED WINDOW IS UNFINISHED WORK TOO (2026-08-09). The ascending
 * pass fetches at most MAX_UPDATES (500) bills per run and processes
 * `updated.slice(0, MAX_UPDATES)` - the OLDEST 500 of whatever Congress.gov
 * reports since the cursor. Everything past that line used to be dropped on
 * the floor: nothing set `frozen`, so a run that was otherwise clean
 * persisted `runStart` as the new cursor and the deferred tail - bills the
 * API had just told us about - fell permanently outside every future
 * window, unless Congress.gov happened to touch them again. Not a corner
 * case: a single missed nightly overflows the cap (measured live 2026-08-08
 * against the tracked types - 24h ~337 bills, 2 days ~504, 3 days ~674), so
 * every catch-up run silently ate ~174 bills. The window being cut short is
 * now tracked in its own flag and folded into the SAME cursor decision as
 * `frozen` (see resolveNextSync): the cursor advances only to the newest
 * bill this run actually processed, so tomorrow's window reopens on the
 * tail instead of stepping over it.
 *
 * It is a separate flag rather than a reuse of `frozen` for one concrete
 * reason: `frozen` is read INSIDE the processing loop (`else if (!frozen...)`)
 * to stop the high-water mark, so anything that sets it before or during the
 * loop pins the cursor at `since` and stalls the backlog outright - the exact
 * 24-day failure docs/solutions/pinned-sync-cursor.md exists for. Truncation
 * is known before the loop runs. Two flags, one decision function, no
 * ordering trap for whoever edits this next.
 *
 * WHAT IS ON DISK WHEN PASS 2 THROWS (2026-08-09). The corpus files are
 * written TWICE now: once after the recent-first pass, once at the end.
 * Pass 2's very first act is a paginated Congress.gov call, and cg()
 * exhausting its five retries during a 5xx window throws out of the whole
 * script - which used to discard everything pass 1 had already PAID
 * Anthropic for (up to RECENT_DECODE_RESERVE new bills, two model calls
 * each), because the only write was at the bottom of this file. The
 * mid-run write persists the corpus ONLY - data/sync-state.json is
 * deliberately left alone, because pass 2 is what earns the cursor and it
 * did not run. So the crash leaves a corpus that gained bills and a cursor
 * that did not move: the night's decodes land in sync-bills.yml's salvage
 * bundle instead of dying with the runner, and re-running simply re-scans
 * the same window and refreshes (free) the bills already in it.
 */
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync } from 'node:fs';
import { loadJSON, syncOneBill } from './bill-decode.mjs';
import {
  BILL_TYPES,
  CONGRESS,
  cg,
  fetchRecentlyUpdated,
  slugOf,
  toISODateTime,
  updateSlug,
} from './congress-fetch.mjs';
import { parseForceSlugs } from './decode-gate.mjs';

const MAX_UPDATES = Number(process.env.MAX_UPDATES ?? 500);
// Lowered 120 -> 60 (2026-07-16, priority-decode-gate spec): with the gate
// above now doing the REAL limiting (only ~20.5% of bills - markup or
// later - are even eligible to spend a decode), MAX_NEW_DECODES reverts to
// a pure safety ceiling rather than the primary cost control it was when
// every new bill was decode-eligible. 60 comfortably covers a busy night's
// worth of genuinely-moving bills (441 gate-eligible bills total in the
// corpus today) without needing the 120 headroom that existed only to
// out-run an unfiltered ~373-418/night inflow of mostly just-introduced,
// zero-motion bills.
const MAX_NEW_DECODES = Number(process.env.MAX_NEW_DECODES ?? 60);
// The recent-first pass's fetch window (audit §5 item 2 / §4 Alt A) - same
// rough size as the twice-daily hot-bills.mjs refresh pass.
const RECENT_FETCH_LIMIT = Number(process.env.RECENT_FETCH_LIMIT ?? 100);
// New-bill decode budget RESERVED for the recent-first pass, carved out of
// (not additional to) MAX_NEW_DECODES - a night with zero brand-new bills in
// the last ~100 updates leaves the full MAX_NEW_DECODES for the ascending
// backlog pass; a night with several leaves proportionally less.
const RECENT_DECODE_RESERVE = Number(process.env.RECENT_DECODE_RESERVE ?? 20);
// See the header comment above and decode-gate.mjs. Empty by default.
const forceSlugs = parseForceSlugs(process.env.FORCE_DECODE_SLUGS);

// ---- the "mostly failed" abort predicate (exported so it can be tested) --
// A majority-failed run must not reach the commit step, but "majority" only
// carries a signal once the sample is big enough to HAVE one. The ascending
// pass's `updated` window is whatever Congress.gov touched since the cursor,
// and now that the cursor is caught up that is routinely one or two bills on
// a quiet night - so ONE transient 500 from Congress.gov satisfied
// `failed > updated.length / 2` and exited 1. That exit costs far more than
// it looks: this script is the FIRST step of sync-bills.yml, so a non-zero
// exit here throws away the AI decodes this run already paid for (written to
// data/ at the bottom of this file, then discarded uncommitted with the
// runner) AND skips every step downstream of it - nominations, coverage,
// Moment updates, portraits - for the whole night.
//
// The floor is 8. Below it "more than half" can be satisfied by one or two
// failures, which is noise rather than a broken night; at 8 or more it takes
// 5 independent failures, which no transient produces. Waiting for that much
// evidence weakens nothing, because this was never the only guard: a night
// that really did break still fails loudly at scripts/verify-sync.mjs
// (corpus parses, EN/ES parity, >2% count drop, lastRun advanced), which
// runs before anything is committed.
export const MOSTLY_FAILED_FLOOR = 8;

export function shouldAbortMostlyFailed(failed, total) {
  return total >= MOSTLY_FAILED_FLOOR && failed > total / 2;
}

/**
 * The whole abort decision, numerator included - exported so the SCOPE of
 * that numerator is a tested property of the code rather than a comment
 * asking to be believed.
 *
 * The predicate above compares failures against `updated.length`, the
 * ascending pass's window. The counter fed to it also absorbed failures
 * from the force-slug direct-fetch loop, which is not part of that window
 * at all: one bad FORCE_DECODE_SLUGS entry (a typo, a bill in a Congress we
 * don't track) counted against a denominator it never contributed to, and
 * on a quiet night - window of 2, one bad slug - that alone satisfied
 * "more than half" and ended a run whose real work was fine. Force-slug
 * failures are an owner-input problem, so they are counted, reported, and
 * kept out of the arithmetic; they still can't freeze the cursor either
 * (see the force loop below).
 *
 * @param {{ascendingFailed?: number, forceFailed?: number, windowSize?: number}} tallies
 * @returns {{abort: boolean, underFloor: boolean, ignoredForceFailures: number}}
 */
export function mostlyFailedVerdict({ ascendingFailed = 0, forceFailed = 0, windowSize = 0 } = {}) {
  const abort = shouldAbortMostlyFailed(ascendingFailed, windowSize);
  return {
    abort,
    // Over half, but the sample is too small for "majority" to carry a
    // signal - logged, never fatal. See MOSTLY_FAILED_FLOOR above.
    underFloor: !abort && ascendingFailed > windowSize / 2,
    ignoredForceFailures: forceFailed,
  };
}

/**
 * What a FORCE_DECODE_SLUGS entry actually points at - exported pure so the
 * one place an owner-supplied string becomes a Congress.gov fetch can be
 * tested without a live sync.
 *
 * THE HOLE THIS CLOSES (2026-08-11). The force loop used to match
 * `/^([a-z]+)-(\d+)-\d+$/` and throw the third segment away, then fetch
 * `/bill/${CONGRESS}/${type}/${number}` - so forcing `s-1776-118` silently
 * fetched S.1776 of the 119th Congress instead, wrote it under whatever slug
 * the decode produced, and reported success. A typo'd or copy-pasted
 * previous-Congress slug was the ONE live path by which a bill nobody asked
 * for could enter the corpus, and it left no trace saying so. There is no
 * honest way to serve the request (this build tracks one Congress; see
 * CONGRESS in congress-fetch.mjs), so the entry is skipped with a
 * ::warning:: naming it rather than quietly answered with a different bill.
 *
 * Malformed slugs keep their existing treatment exactly - `{ok: false,
 * reason: 'malformed'}`, logged and skipped, uncounted.
 *
 * @param {string} slug lower-cased slug, as parseForceSlugs emits
 * @returns {{ok: true, type: string, number: string, congress: number}
 *          | {ok: false, reason: 'malformed'}
 *          | {ok: false, reason: 'wrong-congress', congress: number}}
 */
export function forceSlugTarget(slug, congress = CONGRESS) {
  const m = String(slug ?? '').match(/^([a-z]+)-(\d+)-(\d+)$/);
  if (!m) return { ok: false, reason: 'malformed' };
  const slugCongress = Number(m[3]);
  if (slugCongress !== congress) return { ok: false, reason: 'wrong-congress', congress: slugCongress };
  return { ok: true, type: m[1], number: m[2], congress: slugCongress };
}

/**
 * Where the ascending pass's cursor lands at the end of a run - the one
 * place `state.lastSync` is decided, extracted pure so the arithmetic that
 * governs whether a bill is EVER seen again can be unit-tested without a
 * live sync.
 *
 * Three inputs can each stop the cursor short of "we're caught up":
 *   - `frozen`: a bill INSIDE the processed window still needs work (decode
 *     budget exhausted, or a new bill whose decode failed). Long-standing
 *     behavior; the high-water mark stops at the bill before it.
 *   - `truncated`: the window itself was cut short at MAX_UPDATES, so bills
 *     Congress.gov reported were never processed. Added 2026-08-09 - see the
 *     header comment. Same consequence, different cause, and both must pin
 *     the cursor to the high-water mark rather than jump to `runStart`.
 *   - neither: a genuinely complete run advances to `runStart`.
 *
 * `stalled` is reported (never acted on here) for the one shape that makes
 * no forward progress: a truncated window whose high-water mark didn't get
 * past `since`, i.e. 500+ tracked bills sharing the cursor's own timestamp.
 * Congress.gov's bill-list `updateDate` is a bare DATE, so that means one
 * calendar day overflowing the cap - well above the ~337/day measured, but
 * possible, and it would re-scan the same window nightly forever. The caller
 * warns; verify-sync.mjs's CURSOR_MAX_AGE_DAYS=10 fails the run outright
 * within ten nights. Deliberately NOT "advance a second past `since` to
 * break the tie": that would skip real bills, and nothing here knows the
 * sub-day precision Congress.gov compares `fromDateTime` against.
 *
 * Both branches pass through toISODateTime because BOTH have shipped an
 * outage: a bare-date cursor 400s (2026-06-25/07-01) and so do
 * Date.toISOString() milliseconds, which `runStart` carries (07-17/07-22).
 *
 * @param {{since: string, highWater: string, runStart: string, frozen?: boolean, truncated?: boolean}} args
 * @returns {{lastSync: string, reason: 'clean'|'frozen'|'truncated'|'frozen+truncated', stalled: boolean}}
 */
export function resolveNextSync({ since, highWater, runStart, frozen = false, truncated = false }) {
  if (!frozen && !truncated) {
    return { lastSync: toISODateTime(runStart), reason: 'clean', stalled: false };
  }
  const lastSync = toISODateTime(highWater);
  const reason = frozen ? (truncated ? 'frozen+truncated' : 'frozen') : 'truncated';
  return {
    lastSync,
    reason,
    stalled: truncated && Date.parse(lastSync) <= Date.parse(toISODateTime(since)),
  };
}

// Everything below runs ONLY when this file is executed as a script
// (`node scripts/sync-bills.mjs`, which is how sync-bills.yml runs it) - the
// same argv[1] guard scripts/moment-updates.mjs uses. Importing this module
// for the helper above must never fire a live sync. Top-level await keeps
// working inside this block (it is still module top level), so a rejection
// still ends the process non-zero exactly as before. If this guard ever
// stopped matching, the sync would no-op rather than misbehave - and
// verify-sync.mjs fails the run when lastRun didn't advance, so even that
// lands as a loud failure rather than a silent one.
if (/(^|\/)sync-bills\.mjs$/.test(process.argv[1] ?? '')) {
  const anthropic = new Anthropic({ maxRetries: 8 });

  const bills = loadJSON('data/bills.json');
  const es = loadJSON('data/bills-es.json');
  const state = loadJSON('data/sync-state.json');
  const bySlug = new Map(bills.map((b) => [slugOf(b), b]));

  if (forceSlugs.size) {
    console.log(`FORCE_DECODE_SLUGS active (gate bypassed for): ${[...forceSlugs].join(', ')}`);
  }

  // toISODateTime (the fromDateTime cursor normalizer that closed the
  // 2026-06-25/07-01 and 2026-07-17/07-22 outages) moved to
  // congress-fetch.mjs on 2026-08-06, unchanged byte for byte, and is now
  // imported above. It moved because scripts/sync-nominations.mjs needs the
  // exact same normalization and a second copy would be free to re-learn both
  // outages on its own. The full explanation lives with the function.

  // ---- main ----
  const since = state.lastSync;
  const runStart = new Date().toISOString();
  console.log(`sync since ${since}`);

  // Shared new-bill decode-budget counter and gate counter - both passes
  // below decrement/increment into these ONE pools (RECENT_DECODE_RESERVE is
  // a ceiling on the recent-first pass's share of `added`, not a separate
  // allowance; see the header comment).
  let added = 0;
  let refreshed = 0; // combined total across both passes (log-only, not gated)
  let gated = 0; // combined total across both passes - no real legislative motion
  let partialSkipped = 0; // combined - unreadable payload, bill left untouched
  let noTextSkipped = 0; // combined - real bill, no published text yet, so not decoded
  let newFailed = 0; // new-bill decode failures specifically (subset of `failed` below)

  const ctxBase = { bills, es, bySlug, anthropic, forceSlugs };

  // The corpus pair, always written together: syncOneBill fills es[slug] and
  // pushes the bill in the same synchronous breath after a decode returns, so
  // any snapshot taken between bills already satisfies verify-sync.mjs's
  // EN/ES parity check. Plain writeFileSync, matching every other script in
  // scripts/ (and backfill-search-inputs.mjs's mid-run checkpoint precedent);
  // there is no temp-file-and-rename convention in this repo to match, and
  // inventing one here would leave a stray data/*.tmp for `git add data/` to
  // sweep into the salvage commit on exactly the crash path this exists for.
  const writeCorpus = () => {
    writeFileSync('data/bills.json', JSON.stringify(bills));
    writeFileSync('data/bills-es.json', JSON.stringify(es));
  };

  // ---- Pass 1: recent-first (audit §5 item 2) ----------------------------
  // Guarantees this run always sees the most recently-touched bills in
  // Congress, no matter how deep the ascending backlog is. `handledSlugs`
  // tracks everything this pass fully resolved (refreshed, added, OR gated -
  // a gate verdict is a resolution too) so pass 2 can dedupe without
  // re-fetching or re-deciding - see updateSlug/refreshBillFields.
  const handledSlugs = new Set();
  const recentDecodeCap = Math.min(RECENT_DECODE_RESERVE, MAX_NEW_DECODES);
  console.log(`recent-first pass: fetching up to ${RECENT_FETCH_LIMIT} most-recently-updated bills (decode reserve ${recentDecodeCap})`);
  const recentBills = await fetchRecentlyUpdated(RECENT_FETCH_LIMIT);
  let recentRefreshed = 0, recentAdded = 0, recentGated = 0, recentDeferred = 0, recentPartial = 0, recentNoText = 0, recentFailed = 0;
  for (const u of recentBills) {
    const result = await syncOneBill(u, { ...ctxBase, allowDecode: added < recentDecodeCap });
    if (result.outcome === 'refreshed') {
      refreshed++; recentRefreshed++; handledSlugs.add(result.slug);
    } else if (result.outcome === 'added') {
      added++; recentAdded++; handledSlugs.add(result.slug);
    } else if (result.outcome === 'gated') {
      gated++; recentGated++; handledSlugs.add(result.slug);
    } else if (result.outcome === 'budget') {
      recentDeferred++; // new bill, gate cleared but reserve exhausted - left for pass 2 (same run) or next run
    } else if (result.outcome === 'skipped_partial') {
      // Unreadable payload: nothing written either way - an existing bill was
      // left untouched, a new one was not created. Deliberately NOT added to
      // handledSlugs - the skip is not a resolution, so pass 2 may re-fetch it
      // this same run and land a good payload the second time.
      partialSkipped++; recentPartial++;
    } else if (result.outcome === 'skipped_no_text') {
      // A real bill with no published text yet: refused rather than decoded
      // from its title. Handled exactly like 'gated' — a resolution, not a
      // deferral — so it IS added to handledSlugs: pass 2 re-fetching it this
      // same run would ask the same /text endpoint the same question and spend
      // two more API calls to get the same empty answer.
      noTextSkipped++; recentNoText++; handledSlugs.add(result.slug);
    } else {
      recentFailed++; // logged only; deliberately NOT folded into the abort check below
    }
  }
  console.log(`recent-first pass: ${recentRefreshed} refreshed, ${recentAdded} added+decoded, ${recentGated} gated (no real motion), ${recentDeferred} deferred (reserve exhausted), ${recentPartial} skipped (partial payload), ${recentNoText} skipped (no bill text published yet), ${recentFailed} failed`);

  // PERSIST WHAT PASS 1 ALREADY PAID FOR, before pass 2 gets the chance to
  // throw. Corpus only - the cursor belongs to pass 2 and pass 2 hasn't run.
  // See "WHAT IS ON DISK WHEN PASS 2 THROWS" in the header comment.
  writeCorpus();
  console.log(`recent-first pass persisted to data/ (corpus only; the cursor stays at ${since} until the backlog pass finishes)`);

  // ---- Pass 2: ascending backlog scan from the cursor ---------------------
  // Unchanged shape from before the two-pass fetch - see the header comment.
  // The freeze-on-incomplete-work cursor logic below is tied ONLY to this
  // pass; pass 1 above never touches `cursor`/`frozen`.
  const updated = [];
  let offset = 0;
  // Did Congress.gov still have pages we chose not to fetch when we stopped?
  // `pagination.next` at the moment the MAX_UPDATES cap ends the loop is the
  // only honest answer: the cap, not the API, ended the scan.
  let unfetchedPagesRemain = false;
  // The API's own count for this window. Reported as-is and labelled as such
  // in the truncation warning, because it counts EVERY bill type - including
  // the hres/sres this pipeline deliberately doesn't track - so it is an
  // upper bound on the deferred tail, never a measurement of it.
  let reportedWindowTotal = null;
  for (;;) {
    const page = await cg(`/bill/${CONGRESS}`, {
      // Space, not "+": URLSearchParams turns the space into the "+" the API
      // expects; a literal "+" becomes %2B and the sort is silently ignored
      // (the 2026-07-23 inert-recent-pass bug; this pass survived only because
      // the ignored-sort default happens to be ascending).
      fromDateTime: since, sort: 'updateDate asc', limit: 250, offset,
    });
    const items = page.bills ?? [];
    updated.push(...items.filter((b) => BILL_TYPES.has((b.type ?? '').toLowerCase())));
    offset += 250;
    if (Number.isFinite(page.pagination?.count)) reportedWindowTotal = page.pagination.count;
    const morePages = Boolean(page.pagination?.next);
    // Same two break conditions as before, split apart only so the cap-side
    // exit can record whether anything was left unfetched behind it.
    if (updated.length >= MAX_UPDATES) {
      unfetchedPagesRemain = morePages;
      break;
    }
    if (!morePages) break;
  }
  // Bills the API handed us that this run will not process: the slice below
  // takes the oldest MAX_UPDATES and stops. Anything past that line, plus any
  // page we never fetched, is the deferred tail the cursor must not step over.
  const deferredInWindow = Math.max(0, updated.length - MAX_UPDATES);
  const windowTruncated = deferredInWindow > 0 || unfetchedPagesRemain;
  console.log(`${updated.length} updated bills (capped at ${MAX_UPDATES})`);

  let queued = 0, failed = 0;
  // High-water mark: advance the cursor over every bill we fully handle, and
  // freeze it the instant we hit one that still needs work (decode budget
  // exhausted, or a new bill whose decode failed). A transient *refresh* failure
  // on a bill already in the corpus is idempotent and self-heals on its next
  // update, so it doesn't freeze us. A GATED bill is likewise fully handled
  // (not "still needs work") - it's deliberately not stored, and re-enters
  // naturally via Congress.gov's own updateDate if it later moves - so it
  // advances the cursor too. This dual property (transient-refresh-failure
  // tolerance + gate-skip-is-handled) is what drains the backlog fast instead
  // of freezing on the ~80% of bills that were never going to clear the gate
  // anyway.
  let cursor = since;
  let frozen = false;
  for (const u of updated.slice(0, MAX_UPDATES)) {
    const slug = updateSlug(u);
    let needsWork = false;
    if (handledSlugs.has(slug)) {
      // Already fully resolved by the recent-first pass this run - dedupe,
      // don't re-fetch/re-decide. Resolved is resolved, so the cursor may
      // still advance over it exactly as if pass 2 had handled it itself.
    } else {
      const result = await syncOneBill(u, { ...ctxBase, allowDecode: added < MAX_NEW_DECODES });
      if (result.outcome === 'refreshed') {
        refreshed++; handledSlugs.add(result.slug);
      } else if (result.outcome === 'added') {
        added++; handledSlugs.add(result.slug);
      } else if (result.outcome === 'gated') {
        gated++; handledSlugs.add(result.slug); // real legislative motion absent - fully handled, NOT queued/frozen
      } else if (result.outcome === 'budget') {
        queued++; // decode budget exhausted; revisit next run
        needsWork = true;
      } else if (result.outcome === 'skipped_partial') {
        // Treated by the cursor exactly like a gated bill: nothing was stored
        // (an existing bill left byte-identical, a new one not created), so
        // there is nothing to retry and nothing to freeze for - Congress.gov's
        // own updateDate resurfaces it on its next real move. A new bill that
        // skips here is therefore NOT counted in newSeen below: we never
        // established a readable record to have seen.
        partialSkipped++;
      } else if (result.outcome === 'skipped_no_text') {
        // Same cursor treatment as 'gated', for the same reason: the bill is
        // real and its payload was readable, we simply refused to summarize a
        // document Congress.gov hasn't published. Nothing was stored, so there
        // is nothing to retry and nothing to freeze for - Congress.gov bumps
        // updateDate when the text lands and the feed brings it back then.
        // Counted in newSeen below (unlike 'skipped_partial'): we really did
        // read this bill's record, so saying we saw it is honest.
        noTextSkipped++; handledSlugs.add(result.slug);
      } else {
        failed++;
        // A new bill that failed to decode must be retried; a failed refresh of
        // a known bill is idempotent and re-touches on its next update.
        if (result.isNew) { needsWork = true; newFailed++; }
      }
    }
    if (needsWork) frozen = true;
    else if (!frozen && u.updateDate) cursor = toISODateTime(u.updateDate);
  }

  // ---- Force-slug direct fetch (2026-07-23) ------------------------------
  // FORCE_DECODE_SLUGS used to be only a gate bypass for bills the two passes
  // happened to ENCOUNTER - a forced bill whose last update predates the
  // cursor window was silently never fetched at all (the hr-7296/hr-22
  // catch-up gap: "0 failed", bills absent). A force list is an explicit
  // owner order: any listed slug the passes didn't resolve gets fetched
  // directly by number. Failures log loudly but never freeze the cursor -
  // a bad slug must not stall the nightly backlog. They are counted in their
  // OWN tally for the same reason they don't freeze anything: this loop is
  // not part of the ascending window the abort at the bottom judges. See
  // mostlyFailedVerdict.
  let forceFailed = 0;
  let forceWrongCongress = 0;
  for (const slug of forceSlugs) {
    if (handledSlugs.has(slug)) continue;
    const target = forceSlugTarget(slug);
    if (!target.ok) {
      if (target.reason === 'wrong-congress') {
        // The fetch below is pinned to CONGRESS, so honoring this entry would
        // return a DIFFERENT bill wearing the same number - see
        // forceSlugTarget's comment. Skipped, never silently substituted.
        forceWrongCongress++;
        console.log(
          `::warning::force direct-fetch: SKIPPED ${slug} - it names the ${target.congress}th Congress and this build tracks only the ${CONGRESS}th. Nothing was fetched: fetching it would have returned the ${CONGRESS}th Congress's bill of the same number, which is a different bill. Fix the slug (or bump CONGRESS in scripts/congress-fetch.mjs if the tracked Congress really changed).`
        );
      } else {
        console.log(`force direct-fetch: SKIPPED malformed slug ${JSON.stringify(slug)}`);
      }
      continue;
    }
    const result = await syncOneBill({ type: target.type, number: target.number }, { ...ctxBase, allowDecode: true });
    console.log(`force direct-fetch: ${slug} -> ${result.outcome}`);
    if (result.outcome === 'refreshed') refreshed++;
    else if (result.outcome === 'added') added++;
    else if (result.outcome === 'skipped_partial') partialSkipped++;
    else if (result.outcome === 'skipped_no_text') noTextSkipped++;
    else if (result.outcome === 'failed') forceFailed++;
    handledSlugs.add(slug);
  }
  if (forceFailed) {
    console.log(
      `::warning::${forceFailed} FORCE_DECODE_SLUGS entr(ies) failed their direct fetch (reasons in the FAIL lines above; ${forceSlugs.size} slug(s) were listed, and any the two passes already resolved were never direct-fetched). Check the slugs. This does NOT count toward the mostly-failed abort and never freezes the cursor.`
    );
  }

  // Where the cursor lands. A run that left nothing behind advances to
  // runStart; a frozen one, or one whose window was truncated at MAX_UPDATES,
  // advances only to the high-water mark - the newest bill this run actually
  // processed - so the deferred tail re-enters tomorrow's window instead of
  // falling out of every future one. The arithmetic (and why the two causes
  // share one decision) is in resolveNextSync near the top of this file.
  const next = resolveNextSync({ since, highWater: cursor, runStart, frozen, truncated: windowTruncated });
  state.lastSync = next.lastSync;
  state.lastRun = runStart;

  if (windowTruncated) {
    const why = [];
    if (deferredInWindow) why.push(`${deferredInWindow} already-fetched bill(s) went unprocessed`);
    if (unfetchedPagesRemain) why.push('Congress.gov still had pages this run never fetched');
    if (reportedWindowTotal !== null) {
      why.push(`the API reported ${reportedWindowTotal} record(s) in this window (ALL bill types, including the ones we don't track - an upper bound on the tail, not a count of it)`);
    }
    console.log(
      `::warning::backlog window truncated at MAX_UPDATES=${MAX_UPDATES}: ${why.join('; ')}. The cursor advances only to ${next.lastSync} (the newest bill this run finished), so the deferred tail comes back tomorrow instead of being skipped forever. A cap hit on consecutive nights means the backlog is outrunning the cap - raise MAX_UPDATES for a catch-up run.`
    );
  }
  if (next.stalled) {
    console.log(
      `::warning::the truncated window made NO forward progress: the cursor stays at ${next.lastSync} because every bill this run finished shares that timestamp (over ${MAX_UPDATES} tracked bills on one Congress.gov updateDate). Tomorrow re-scans the same window. Raise MAX_UPDATES to clear it; verify-sync.mjs fails the run outright once the cursor passes 10 days.`
    );
  }

  writeCorpus();
  writeFileSync('data/sync-state.json', JSON.stringify(state, null, 2));

  // New bills seen this run, deduped across both passes: every new-bill slug
  // this run touched resolves to exactly one of added/gated/queued/newFailed
  // by the time we get here (a pass-1 'budget' deferral that pass 2 later
  // resolves is NOT double-counted - see recentDeferred's comment above).
  // The one exception is 'skipped_partial', counted in partialSkipped instead:
  // its payload was unreadable, so we can't honestly say we saw a bill at all.
  // 'skipped_no_text' IS counted: that bill's record read fine and the bill is
  // real - only its text is missing, so we saw it and declined to decode it.
  const newSeen = added + gated + queued + newFailed + noTextSkipped;
  console.log(
    `DONE: ${refreshed} refreshed, ${added} added+decoded, ${gated} gated (no real legislative motion), ${queued} queued for next run, ${partialSkipped} skipped: partial payload (left untouched), ${noTextSkipped} skipped: no bill text published yet (not decoded), ${forceWrongCongress} skipped: force slug naming another Congress (never fetched), ${failed} failed in the ascending pass (${newFailed} new), ${recentFailed} in the recent-first pass, ${forceFailed} force-slug; cursor -> ${state.lastSync} (${next.reason}); new bills seen this run: ${newSeen}; corpus ${bills.length}`
  );
  // Mostly-failed run: don't let CI commit garbage. Judged on the ascending
  // pass ALONE - its own failures against its own window - so neither the
  // recent-first pass (logged separately, different window) nor a bad
  // FORCE_DECODE_SLUGS entry (owner input, not a window at all) can end a
  // night whose backlog scan was healthy. The minimum-sample floor - and why
  // a single transient failure must not be allowed to end the night - is at
  // shouldAbortMostlyFailed near the top of this file.
  const verdict = mostlyFailedVerdict({ ascendingFailed: failed, forceFailed, windowSize: updated.length });
  if (verdict.abort) {
    console.error(
      `::error::mostly-failed run: ${failed} of ${updated.length} bills in the ascending pass failed. Nothing is committed tonight.`
    );
    process.exit(1);
  }
  if (verdict.underFloor) {
    console.log(
      `${failed} of ${updated.length} ascending-pass bills failed - over half, but under the ${MOSTLY_FAILED_FLOOR}-bill floor where "mostly failed" carries any signal, so this run continues to the gates.`
    );
  }
}
