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

const anthropic = new Anthropic({ maxRetries: 8 });

const bills = loadJSON('data/bills.json');
const es = loadJSON('data/bills-es.json');
const state = loadJSON('data/sync-state.json');
const bySlug = new Map(bills.map((b) => [slugOf(b), b]));

if (forceSlugs.size) {
  console.log(`FORCE_DECODE_SLUGS active (gate bypassed for): ${[...forceSlugs].join(', ')}`);
}

// Congress.gov's bill-list `updateDate` field is date-only (e.g. "2026-06-04"),
// not a full timestamp. Persisting it as-is breaks the next run's fromDateTime
// query, which Congress.gov 400s on - the 2026-06-25/07-01 outage. Always
// normalize to a full ISO-8601 datetime before it becomes the next cursor.
function toISODateTime(d) {
  return /T/.test(d) ? d : `${d}T00:00:00Z`;
}

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
let newFailed = 0; // new-bill decode failures specifically (subset of `failed` below)

const ctxBase = { bills, es, bySlug, anthropic, forceSlugs };

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
let recentRefreshed = 0, recentAdded = 0, recentGated = 0, recentDeferred = 0, recentFailed = 0;
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
  } else {
    recentFailed++; // logged only; deliberately NOT folded into the abort check below
  }
}
console.log(`recent-first pass: ${recentRefreshed} refreshed, ${recentAdded} added+decoded, ${recentGated} gated (no real motion), ${recentDeferred} deferred (reserve exhausted), ${recentFailed} failed`);

// ---- Pass 2: ascending backlog scan from the cursor ---------------------
// Unchanged shape from before the two-pass fetch - see the header comment.
// The freeze-on-incomplete-work cursor logic below is tied ONLY to this
// pass; pass 1 above never touches `cursor`/`frozen`.
const updated = [];
let offset = 0;
for (;;) {
  const page = await cg(`/bill/${CONGRESS}`, {
    fromDateTime: since, sort: 'updateDate+asc', limit: 250, offset,
  });
  const items = page.bills ?? [];
  updated.push(...items.filter((b) => BILL_TYPES.has((b.type ?? '').toLowerCase())));
  offset += 250;
  if (!page.pagination?.next || updated.length >= MAX_UPDATES) break;
}
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
      refreshed++;
    } else if (result.outcome === 'added') {
      added++;
    } else if (result.outcome === 'gated') {
      gated++; // real legislative motion absent - fully handled, NOT queued/frozen
    } else if (result.outcome === 'budget') {
      queued++; // decode budget exhausted; revisit next run
      needsWork = true;
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

// Clean run (nothing left behind) advances to runStart; otherwise advance to
// the high-water mark so we still make forward progress instead of re-scanning
// the same window forever.
state.lastSync = frozen ? cursor : runStart;
state.lastRun = runStart;

writeFileSync('data/bills.json', JSON.stringify(bills));
writeFileSync('data/bills-es.json', JSON.stringify(es));
writeFileSync('data/sync-state.json', JSON.stringify(state, null, 2));

// New bills seen this run, deduped across both passes: every new-bill slug
// this run touched resolves to exactly one of added/gated/queued/newFailed
// by the time we get here (a pass-1 'budget' deferral that pass 2 later
// resolves is NOT double-counted - see recentDeferred's comment above).
const newSeen = added + gated + queued + newFailed;
console.log(
  `DONE: ${refreshed} refreshed, ${added} added+decoded, ${gated} gated (no real legislative motion), ${queued} queued for next run, ${failed} failed (${newFailed} new); new bills seen this run: ${newSeen}; corpus ${bills.length}`
);
// Mostly-failed run: don't let CI commit garbage. Scoped to the ascending
// pass's own failed/updated.length exactly as before the two-pass fetch -
// the recent-first pass's (much smaller, logged-separately) failures don't
// feed this check.
if (failed > updated.length / 2) process.exit(1);
