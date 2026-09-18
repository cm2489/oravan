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
 * A DAY THAT CANNOT BE FINISHED IS A CURSOR THAT CANNOT MOVE (2026-09-18).
 * The truncation rule above pins the cursor to the high-water mark - and the
 * high-water mark is `toISODateTime(u.updateDate)`, the MIDNIGHT of the last
 * finished bill's own day, because Congress.gov's bill-list `updateDate` is a
 * bare DATE. When the cursor already sits INSIDE that day, midnight resolves
 * EARLIER than the cursor, the monotonic clamp holds it where it was, and the
 * night makes exactly zero progress. Tomorrow re-scans the identical window and
 * does it again. That is not a corner case: it ran from 2026-09-08 to
 * 2026-09-18 (ten nights, `lastSync` frozen at 2026-09-08T17:54:31Z), because
 * more than MAX_UPDATES tracked bills share the 2026-09-08 updateDate, so the
 * oldest-500 slice could never reach a later day. Every night refreshed the
 * same 500 bills, gated the same ~330 new ones, and moved nothing. The 2026-09-18
 * run went red on scripts/check-cursor-age.mjs's ceiling with no way to
 * self-heal: raising MAX_UPDATES by hand was the ONLY exit.
 *
 * THE FIX IS TO FINISH THE DAY. A calendar day is the finest grain this
 * pipeline can honestly claim progress in (the list gives nothing finer), so:
 *   - The page loop keeps paging PAST MAX_UPDATES while every bill fetched so
 *     far still sits on one calendar day - stopping there would buy nothing.
 *     Bounded by MAX_DAY_COMPLETION so a pathological day cannot run forever.
 *   - The processing slice is extended to the END of that day for the same
 *     reason (planAscendingWindow). This is affordable because the extension is
 *     made of REFRESHES and GATE VERDICTS, which are free Congress.gov calls;
 *     the only thing that costs money is a new-bill decode, and that stays
 *     capped by MAX_NEW_DECODES exactly as before - bill 61 comes back
 *     'budget', is counted as queued for next run, and freezes the cursor on
 *     its own day just as it always has.
 *   - Once a day is provably FINISHED - the slice ended on a day boundary, or
 *     the loop processed past that day into the next one without freezing - the
 *     mark becomes the END of it (endOfDayCursor: midnight at the start of the
 *     next day) instead of its own midnight. That is the same claim the clean
 *     branch makes about `runStart`, scoped to a day, and it is what actually
 *     moves the cursor.
 * Nothing here weakens the freeze: a bill that still needs work stops the mark
 * at the last day that finished before it, and the monotonic clamp still
 * guards the result.
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
  mapStatus,
  readableAction,
  slugOf,
  toISODateTime,
  updateSlug,
} from './congress-fetch.mjs';
import { parseForceSlugs, passesGate } from './decode-gate.mjs';
import { setCounter } from './run-counters.mjs';

const MAX_UPDATES = Number(process.env.MAX_UPDATES ?? 500);
// The ceiling on the same-timestamp extension described in the header: how far
// past MAX_UPDATES this run is willing to go in order to FINISH the calendar
// day the cursor is sitting in. 3000 is deliberately several times the measured
// daily inflow (~337 tracked bills/day, 2026-08-08; the 2026-09-08 cohort that
// caused the freeze was ~700), so it clears any real day while still bounding a
// pathological one - a day that overflows even this is reported as a stall and
// left to the manual max_updates lever rather than allowed to run unbounded.
// The extension only ever adds FREE work: refreshes and gate verdicts. Decodes
// stay capped by MAX_NEW_DECODES below.
const MAX_DAY_COMPLETION = Number(process.env.MAX_DAY_COMPLETION ?? 3000);
// Read-only sizing mode: fetch the ascending window, report its shape, decode
// nothing, write nothing, exit 0. Added 2026-09-18 so "how much would a
// catch-up cost?" can be answered from the live API instead of estimated - the
// window scan is free Congress.gov traffic. Set SYNC_DRY_RUN_GATE_SAMPLE=N to
// additionally detail-fetch N of the window's new bills (still free) and report
// how many of them would clear the priority gate, i.e. actually spend a decode.
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.SYNC_DRY_RUN ?? '');
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
 * at all: one bad FORCE_DECODE_SLUGS entry (a typo; before 2026-08-11 also a
 * slug naming a Congress we don't track, which forceSlugTarget now skips
 * before any fetch) counted against a denominator it never contributed to, and
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
 * The calendar day a Congress.gov `updateDate` (or a persisted cursor) falls
 * on - 'YYYY-MM-DD', or null when there is nothing readable to take.
 *
 * A DAY is the unit the same-timestamp fix is expressed in, and not for
 * convenience: the bill-list `updateDate` IS a bare date, so a day is the
 * finest grain in which this pipeline can honestly say "the backlog scan has
 * finished everything up to here". See the header comment.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function updateDay(value) {
  const m = String(value ?? '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * The cursor value that means "every bill dated `day` has been processed":
 * midnight at the START of the day AFTER it.
 *
 * WHY IT IS NOT `day`'s OWN MIDNIGHT. That is what the high-water mark has
 * always been (`toISODateTime(u.updateDate)`), and it is a claim about having
 * got SOMEWHERE INSIDE the day. When the cursor already sits inside that same
 * day - which is exactly the state a truncated one-day window leaves it in -
 * that claim is strictly BEHIND where the run started, the monotonic clamp in
 * resolveNextSync holds it at `since`, and the night's work buys nothing. Once
 * the day is FINISHED the honest mark is the end of it, and the end of a day is
 * the start of the next one. Re-opening tomorrow's window at that instant skips
 * nothing: every bill of `day` was processed to get here.
 *
 * Date arithmetic rather than string arithmetic on purpose - month, year and
 * leap-day rollovers are precisely what a hand-rolled "+1" gets wrong. The
 * result goes through toISODateTime like every other branch, because
 * Date.toISOString()'s milliseconds 400 Congress.gov (the 2026-07-17/22
 * outage).
 *
 * @param {string|null} day 'YYYY-MM-DD'
 * @returns {string|null} seconds-precision ISO-8601, or null if unreadable
 */
export function endOfDayCursor(day) {
  const ms = Date.parse(`${String(day ?? '')}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return toISODateTime(new Date(ms + 86_400_000).toISOString());
}

/**
 * How much of the fetched ascending window this run will actually process, and
 * whether the slice ends on a calendar-day boundary - the decision that
 * un-freezes a cursor sitting inside an oversized day. Pure, so the arithmetic
 * that governs whether the backlog can EVER move is unit-testable without a
 * live sync.
 *
 * `days` is one bare date per FETCHED tracked bill, in the API's ascending
 * order (`updateDay(u.updateDate)` over `updated`).
 *
 * THE DEFAULT is unchanged from 2026-08-09: take the oldest `maxUpdates` and
 * defer the rest, which the caller turns into `truncated`.
 *
 * THE ONE EXCEPTION - the same-timestamp extension. If the whole capped slice
 * sits on ONE day AND that day continues past the cap, then stopping at the cap
 * produces a high-water mark of that day's own midnight, which is at or behind
 * the cursor: zero progress, forever, because tomorrow fetches the identical
 * window (the 2026-09-08 freeze, ten nights). So the slice is extended to the
 * END of that day. It is affordable because the extension is made of REFRESHES
 * and GATE VERDICTS - free Congress.gov detail calls; the only paid work, a
 * new-bill decode, stays capped by MAX_NEW_DECODES in the caller, and bill 61
 * comes back 'budget' and freezes the cursor exactly as it always has.
 *
 * The extension is deliberately NOT applied when the capped slice already spans
 * two days: there is a finished day in there to advance to, so the cap costs
 * nothing but a deferral, and widening the run's work for no cursor gain would
 * be pure runtime.
 *
 * `maxDayCompletion` bounds it. A day that overflows even that leaves
 * `dayComplete` false and `ceilingHit` true, and the caller reports a stall -
 * the same honest "we are behind" it reported before, now with a number.
 *
 * @param {{days: (string|null)[], maxUpdates?: number, maxDayCompletion?: number}} args
 * @returns {{count: number, extended: number, deferred: number, dayComplete: boolean,
 *            completedDay: string|null, ceilingHit: boolean}}
 */
export function planAscendingWindow({ days, maxUpdates = 500, maxDayCompletion = 3000 } = {}) {
  const list = Array.isArray(days) ? days : [];
  const n = list.length;
  if (n === 0) {
    return { count: 0, extended: 0, deferred: 0, dayComplete: false, completedDay: null, ceilingHit: false };
  }
  let count = Math.min(Math.max(0, Math.trunc(maxUpdates)), n);
  let extended = 0;
  let ceilingHit = false;
  const firstDay = list[0];
  const capLandsInsideOneDay =
    count > 0 && count < n && firstDay !== null && list[count - 1] === firstDay && list[count] === firstDay;
  if (capLandsInsideOneDay) {
    const ceiling = Math.max(count, Math.trunc(maxDayCompletion));
    let end = count;
    while (end < n && end < ceiling && list[end] === firstDay) end++;
    extended = end - count;
    // Stopped by the ceiling rather than by the day running out: the day is
    // still unfinished, so nothing below may claim otherwise.
    ceilingHit = end < n && list[end] === firstDay;
    count = end;
  }
  const last = count > 0 ? list[count - 1] : null;
  // The list is ascending, so a NEXT fetched bill on a LATER day proves every
  // bill of `last` is already inside the slice. That - and only that - is what
  // licenses the end-of-day mark.
  const dayComplete = count < n && last !== null && list[count] !== last;
  return {
    count,
    extended,
    deferred: n - count,
    dayComplete,
    completedDay: dayComplete ? last : null,
    ceilingHit,
  };
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
 * warns; scripts/check-cursor-age.mjs's CURSOR_MAX_AGE_DAYS reds the run once
 * the cursor passes its ceiling (post-commit since 2026-08-12 - the night's
 * data lands anyway). Since 2026-09-18 the same-timestamp case is handled
 * structurally rather than only reported: see "A DAY THAT CANNOT BE FINISHED"
 * in the header. What is left here is the residue - a day over
 * MAX_DAY_COMPLETION, or a decode budget frozen inside one.
 *
 * Deliberately NOT "advance a second past `since` to break the tie": that
 * would skip real bills, and nothing here knows the sub-day precision
 * Congress.gov compares `fromDateTime` against. Finishing the day and taking
 * its END (endOfDayCursor) is the version of that idea that is actually
 * honest, and it is the caller's job - by the time a mark reaches here, the
 * proof that the day was finished has already been made.
 *
 * THE MONOTONIC GUARD (2026-08-12), and the live incident that earned it. The
 * high-water mark is `toISODateTime(u.updateDate)`, and Congress.gov's
 * bill-list `updateDate` is a BARE DATE - so a run whose window is one
 * calendar day wide resolves to that day's MIDNIGHT, which can be EARLIER than
 * the cursor it started from. On 2026-08-11 it was: `since` was
 * 2026-08-10T08:55:10Z, the truncated window's mark normalized to
 * 2026-08-10T00:00:00Z, and the run persisted a cursor 8h55m BEHIND the one it
 * had been handed (origin/main:data/sync-state.json, commit bcec170). Nothing
 * caught it: the merge-time guard in tests/merge-sync-state.unit.spec.ts
 * covers the rebase-union path only, and the test in tests/sync-cursor.unit
 * .spec.ts that CLAIMED "the cursor never runs backwards" only ever passed
 * marks at or after `since`. A backwards cursor is not free: it re-fetches a
 * window this run already paid for, and it hands lib/freshness-state.ts a
 * staler `lastSync` than the truth. So the mark is clamped to `since` - never
 * past it, never behind it - and the caller warns. `stalled` is unaffected by
 * construction: a clamp lands exactly ON `since`, which is what `stalled`
 * already tests for.
 *
 * Every branch passes through toISODateTime because BOTH other shapes have
 * shipped an outage: a bare-date cursor 400s (2026-06-25/07-01) and so do
 * Date.toISOString() milliseconds, which `runStart` carries (07-17/07-22).
 *
 * @param {{since: string, highWater: string, runStart: string, frozen?: boolean, truncated?: boolean}} args
 * @returns {{lastSync: string, reason: 'clean'|'frozen'|'truncated'|'frozen+truncated', stalled: boolean, clamped: boolean}}
 */
export function resolveNextSync({ since, highWater, runStart, frozen = false, truncated = false }) {
  const clean = !frozen && !truncated;
  const mark = toISODateTime(clean ? runStart : highWater);
  const floor = toISODateTime(since);
  // Guarded against an unparseable `since` (a corpus that predates the cursor,
  // or a hand-edited state file): with no floor to measure against there is
  // nothing to clamp to, and the mark passes through exactly as before.
  const clamped = Number.isFinite(Date.parse(floor)) && Date.parse(mark) < Date.parse(floor);
  const lastSync = clamped ? floor : mark;
  const reason = clean ? 'clean' : frozen ? (truncated ? 'frozen+truncated' : 'frozen') : 'truncated';
  return {
    lastSync,
    reason,
    stalled: truncated && Date.parse(lastSync) <= Date.parse(floor),
    clamped,
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
  // Constructed only when this run can actually spend money: the SDK throws on
  // a missing ANTHROPIC_API_KEY at construction, and a sizing run has no
  // business needing that key at all.
  const anthropic = DRY_RUN ? null : new Anthropic({ maxRetries: 8 });
  if (DRY_RUN) {
    console.log(
      `SYNC_DRY_RUN: sizing only. The recent-first pass is skipped entirely (it is the pass that spends decodes), nothing is decoded, and nothing is written to data/. Congress.gov list/detail calls are free.`
    );
  }

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
  const recentBills = DRY_RUN ? [] : await fetchRecentlyUpdated(RECENT_FETCH_LIMIT);
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
  if (!DRY_RUN) writeCorpus();
  console.log(
    DRY_RUN
      ? `recent-first pass skipped and nothing written (SYNC_DRY_RUN); the cursor stays at ${since}`
      : `recent-first pass persisted to data/ (corpus only; the cursor stays at ${since} until the backlog pass finishes)`
  );

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
    // The cap ends the scan - UNLESS every bill fetched so far sits on ONE
    // calendar day, in which case stopping here is guaranteed to buy zero
    // cursor progress (the 2026-09-08 freeze; see the header). Then keep paging
    // until a later day appears or MAX_DAY_COMPLETION is reached: list pages are
    // free, and without one we can never prove the day is finished. The list is
    // sorted ascending, so first-vs-last is the whole test.
    const oneDayOnly =
      updated.length > 0 &&
      updateDay(updated[0]?.updateDate) !== null &&
      updateDay(updated[0]?.updateDate) === updateDay(updated[updated.length - 1]?.updateDate);
    const capReached = updated.length >= MAX_UPDATES;
    const completingTheDay = capReached && oneDayOnly && updated.length < MAX_DAY_COMPLETION;
    if (capReached && !completingTheDay) {
      unfetchedPagesRemain = morePages;
      break;
    }
    if (!morePages) break;
  }
  // Bills the API handed us that this run will not process. The slice takes the
  // oldest MAX_UPDATES and stops - except when that cap lands inside a single
  // day the cursor is already sitting in, where it runs on to the end of that
  // day (planAscendingWindow). Anything past the slice, plus any page we never
  // fetched, is the deferred tail the cursor must not step over.
  const plan = planAscendingWindow({
    days: updated.map((u) => updateDay(u.updateDate)),
    maxUpdates: MAX_UPDATES,
    maxDayCompletion: MAX_DAY_COMPLETION,
  });
  const deferredInWindow = plan.deferred;
  const windowTruncated = deferredInWindow > 0 || unfetchedPagesRemain;
  console.log(`${updated.length} updated bills (cap ${MAX_UPDATES}; processing ${plan.count})`);
  if (plan.extended) {
    console.log(
      `same-timestamp extension: ${plan.extended} bill(s) past the cap will be processed so ${updated[0] ? updateDay(updated[0].updateDate) : 'the cursor day'} finishes and the cursor can leave it. These are refreshes and gate verdicts - free Congress.gov calls; the paid work (new-bill decodes) is still capped at MAX_NEW_DECODES=${MAX_NEW_DECODES}.`
    );
  }

  // ---- SYNC_DRY_RUN: report the window, spend nothing, write nothing ----
  // Everything above this line is free Congress.gov list traffic, so a sizing
  // run stops here with the two numbers a catch-up decision actually needs:
  // how the backlog is distributed across days, and how many of its bills are
  // NEW (the only ones that can ever cost a decode). The optional gate sample
  // below turns the second number into a money estimate; it is still free.
  if (DRY_RUN) {
    const byDay = new Map();
    const newBills = [];
    let known = 0;
    for (const u of updated) {
      const day = updateDay(u.updateDate) ?? 'unreadable';
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
      if (bySlug.has(updateSlug(u))) known++;
      else newBills.push(u);
    }
    console.log(
      `DRY RUN window since ${since}: ${updated.length} tracked bill(s) fetched, ${known} already in the corpus (free refresh), ${newBills.length} not in it (decode CANDIDATES - most are turned away free by the priority gate).`
    );
    for (const [day, n] of [...byDay].sort()) console.log(`  ${day}: ${n} tracked bill(s)`);
    console.log(
      `DRY RUN plan at MAX_UPDATES=${MAX_UPDATES}: would process ${plan.count} (${plan.extended} added by the same-timestamp extension), defer ${plan.deferred}; cursor day finished: ${plan.dayComplete}${plan.completedDay ? ` (${plan.completedDay} -> cursor ${endOfDayCursor(plan.completedDay)})` : ''}${plan.ceilingHit ? '; MAX_DAY_COMPLETION ceiling hit' : ''}`
    );
    const sampleSize = Math.max(0, Math.trunc(Number(process.env.SYNC_DRY_RUN_GATE_SAMPLE ?? 0)));
    if (sampleSize > 0 && newBills.length > 0) {
      // One FREE Congress.gov detail fetch per sampled bill, evenly spread
      // across the window so a sample can't be all of one day. No Anthropic
      // call, no write - this only asks mapStatus/passesGate what the real run
      // would ask.
      const step = Math.max(1, Math.floor(newBills.length / sampleSize));
      let checked = 0, gatePassed = 0, unreadable = 0;
      // Per day as well as in total: a whole-window rate is the wrong number
      // for "what will TONIGHT cost", because the ascending pass works one day
      // at a time and the days are nothing like each other - a day of pure
      // introductions is free, a day of floor action is not.
      const perDay = new Map();
      for (let i = 0; i < newBills.length && checked < sampleSize; i += step) {
        const u = newBills[i];
        const d = updateDay(u.updateDate) ?? 'unreadable';
        const row = perDay.get(d) ?? { checked: 0, passed: 0, newTotal: 0 };
        try {
          const detail = (await cg(`/bill/${CONGRESS}/${String(u.type).toLowerCase()}/${u.number}`)).bill;
          const action = readableAction(detail);
          if (!action) unreadable++;
          else if (passesGate(mapStatus(action.text))) { gatePassed++; row.passed++; }
        } catch {
          unreadable++;
        }
        row.checked++;
        perDay.set(d, row);
        checked++;
      }
      for (const u of newBills) {
        const d = updateDay(u.updateDate) ?? 'unreadable';
        const row = perDay.get(d);
        if (row) row.newTotal++;
      }
      const rate = checked > 0 ? gatePassed / checked : 0;
      const projected = Math.round(rate * newBills.length);
      console.log(
        `DRY RUN gate sample: ${gatePassed}/${checked} sampled new bill(s) clear the priority decode gate (${unreadable} unreadable payload(s)). Extrapolated across ${newBills.length} new bill(s): ~${projected} decode(s) - MAX_NEW_DECODES=${MAX_NEW_DECODES} per run caps what any single run can actually spend.`
      );
      for (const [d, row] of [...perDay].sort()) {
        console.log(
          `  ${d}: ${row.passed}/${row.checked} sampled clear the gate, over ${row.newTotal} new bill(s) -> ~${Math.round((row.passed / Math.max(1, row.checked)) * row.newTotal)} decode(s)`
        );
      }
    }
    console.log('DRY RUN: nothing decoded, nothing written.');
    process.exit(0);
  }

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
  //
  // ADDED 2026-09-18: `lastFullDay` - the newest calendar day this run
  // processed CLEAN THROUGH, i.e. it went on to a bill of a later day without
  // having frozen. That is a strictly stronger fact than "we got somewhere
  // inside this day", and it is the one that lets the cursor leave a day it is
  // already sitting in (endOfDayCursor). It is tracked in the loop rather than
  // inferred afterwards because only the loop knows where the freeze fell.
  let cursor = since;
  let frozen = false;
  let lastFullDay = null;
  let currentDay = null;
  for (const u of updated.slice(0, plan.count)) {
    const day = updateDay(u.updateDate);
    // Crossing into a later day with nothing frozen behind us means every bill
    // of the day we just left is done.
    if (!frozen && currentDay !== null && day !== null && day !== currentDay) lastFullDay = currentDay;
    if (day !== null) currentDay = day;
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
  // runStart; a frozen one, or one whose window was truncated, advances only to
  // the high-water mark, so the deferred tail re-enters tomorrow's window
  // instead of falling out of every future one. The arithmetic (and why the two
  // causes share one decision) is in resolveNextSync near the top of this file.
  //
  // THE MARK ITSELF (2026-09-18). `cursor` is the MIDNIGHT of the last finished
  // bill's day - a claim about having got somewhere inside that day, which is
  // worth nothing when the run started inside the same day. Where a day
  // FINISHED, the honest mark is the end of it. `plan.dayComplete` proves it for
  // the slice's last day (the next fetched bill is on a later one);
  // `lastFullDay` proves it for any earlier day the loop walked clean through
  // before freezing. Take whichever is later, never earlier than `cursor`, and
  // let resolveNextSync's monotonic clamp have the last word.
  const finishedDay = (!frozen && plan.dayComplete) ? plan.completedDay : lastFullDay;
  const dayMark = endOfDayCursor(finishedDay);
  const highWater =
    dayMark && Date.parse(dayMark) > Date.parse(toISODateTime(cursor)) ? dayMark : cursor;
  const next = resolveNextSync({ since, highWater, runStart, frozen, truncated: windowTruncated });
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
      `::warning::backlog window truncated at MAX_UPDATES=${MAX_UPDATES}${plan.extended ? ` (+${plan.extended} processed past it to finish ${plan.completedDay ?? 'the cursor day'})` : ''}: ${why.join('; ')}. The cursor advances only to ${next.lastSync} (${finishedDay ? `the end of ${finishedDay}, the newest day this run finished outright` : 'the newest bill this run finished'}), so the deferred tail comes back tomorrow instead of being skipped forever. A cap hit on consecutive nights means the backlog is outrunning the cap - raise MAX_UPDATES for a catch-up run.`
    );
  }
  if (next.stalled) {
    console.log(
      `::warning::the window made NO forward progress: the cursor stays at ${next.lastSync}. Since 2026-09-18 a run finishes the cursor's own calendar day rather than stopping at MAX_UPDATES inside it, so the only two ways to land here are (a) ${plan.ceilingHit ? 'THIS RUN: ' : ''}a day carrying more than MAX_DAY_COMPLETION=${MAX_DAY_COMPLETION} tracked bills${plan.ceilingHit ? '' : ' (not this run)'}, or (b) ${frozen ? 'THIS RUN: ' : ''}a bill inside that day still needing a decode the budget could not pay for${frozen ? '' : ' (not this run)'}. Case (b) drains on its own - MAX_NEW_DECODES more bills clear every night. Case (a) needs a dispatch of sync-bills.yml with a raised max_updates (raise max_new_decodes with it, or the decode budget re-freezes the cursor). scripts/check-cursor-age.mjs reds the run once the cursor passes its age ceiling - after the commit, so the data still lands.`
    );
  }
  if (next.clamped) {
    // The bare-date high-water mark landed BEHIND the cursor we started from
    // (see resolveNextSync's MONOTONIC GUARD note). Held at `since` instead:
    // re-scanning a window we already paid for buys nothing, and a cursor that
    // walks backwards makes the site's own freshness math read staler than the
    // truth.
    console.log(
      `::warning::the high-water mark (${toISODateTime(cursor)}) resolved EARLIER than this run's starting cursor (${since}) - Congress.gov's bill-list updateDate is a bare date, so a one-day window normalizes to that day's midnight. The cursor is held at ${next.lastSync} rather than moved backwards.`
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
  // What the post-commit honesty alarm judges the night on
  // (scripts/check-run-honesty.mjs). Written here, after both passes and the
  // force-slug pass have resolved, so the numbers are the same ones the DONE
  // line reports - the alarm and the log can never disagree. `billsFailed` is
  // every pass's failures together, because "the decode path is dead" is a
  // claim about the run, not about one window. No-ops with RUN_COUNTERS_FILE
  // unset, which is every local run.
  setCounter('billsAdded', added);
  setCounter('billsFailed', failed + recentFailed + forceFailed);
  setCounter('billsRefreshed', refreshed);
  console.log(
    `DONE: ${refreshed} refreshed, ${added} added+decoded, ${gated} gated (no real legislative motion), ${queued} queued for next run, ${partialSkipped} skipped: partial payload (left untouched), ${noTextSkipped} skipped: no bill text published yet (not decoded), ${forceWrongCongress} skipped: force slug naming another Congress (never fetched), ${failed} failed in the ascending pass (${newFailed} new), ${recentFailed} in the recent-first pass, ${forceFailed} force-slug; cursor -> ${state.lastSync} (${next.reason}${finishedDay ? `, finished ${finishedDay}` : ''}); new bills seen this run: ${newSeen}; corpus ${bills.length}`
  );
  // Mostly-failed run: don't let CI commit garbage. Judged on the ascending
  // pass ALONE - its own failures against its own window - so neither the
  // recent-first pass (logged separately, different window) nor a bad
  // FORCE_DECODE_SLUGS entry (owner input, not a window at all) can end a
  // night whose backlog scan was healthy. The minimum-sample floor - and why
  // a single transient failure must not be allowed to end the night - is at
  // shouldAbortMostlyFailed near the top of this file.
  //
  // The denominator is the slice this run ATTEMPTED (plan.count), not
  // everything the window handed us. It used to be `updated.length`, which was
  // already a mismatch - failures can only come from bills we tried - and the
  // same-timestamp extension widens the gap in the other direction, since the
  // slice can now be LARGER than MAX_UPDATES. Judging failures against the
  // population they were drawn from is the same "one window" discipline the
  // force-slug split above already enforces.
  const verdict = mostlyFailedVerdict({ ascendingFailed: failed, forceFailed, windowSize: plan.count });
  if (verdict.abort) {
    console.error(
      `::error::mostly-failed run: ${failed} of the ${plan.count} bills this ascending pass processed failed. Nothing is committed tonight.`
    );
    process.exit(1);
  }
  if (verdict.underFloor) {
    console.log(
      `${failed} of ${plan.count} ascending-pass bills failed - over half, but under the ${MOSTLY_FAILED_FLOOR}-bill floor where "mostly failed" carries any signal, so this run continues to the gates.`
    );
  }
}
