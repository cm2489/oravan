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
 * - An existing bill whose TEXT has been replaced since it was decoded is
 *   re-read, at most REDECODE_MAX_PER_NIGHT (10) a night — the one paid thing
 *   a refresh can trigger, and the only answer to an amendment in committee,
 *   which changes the document without changing the title or the ladder. See
 *   the RE-DECODE ON NEW TEXT pass near the bottom of this file.
 * - NEW-BILL decodes go through the Message Batches API at half price
 *   (DECODE_BATCH, on by default; see the flag's comment and the drain near
 *   the bottom). The nightly has no reader waiting on it, which is what makes
 *   an asynchronous transport free to take. The RE-DECODE pass above is NOT
 *   batched and is not an oversight — the reasoning is at that pass, and it
 *   comes down to ~$0.33 a night of discount against two more rounds of
 *   holding the data-sync concurrency group the hourly newsdesk queues behind.
 *   The hourly newsdesk's own re-decode, which heals a live page, is
 *   synchronous for a different reason again (latency) and is untouched by
 *   this flag.
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
 * FORCE_REDECODE_SLUGS (same comma-separated shape) is its counterpart for
 * bills ALREADY in the corpus: each listed slug is re-read from its current
 * text whether or not the new-text detection would have nominated it. It
 * bypasses the detection, never the ceiling — forced slugs are simply first
 * in the queue, so no env var can raise a night's Anthropic bill above
 * REDECODE_MAX_PER_NIGHT. See planRedecodes in scripts/text-version.mjs.
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
 *
 * WITH BATCHING ON (2026-09-19) THAT WRITE MOVED ITS MEANING, and gained a
 * sibling. Pass 1 no longer decodes anything: it queues, so its mid-run write
 * persists FREE refreshes and there is no paid work there to lose. The spend
 * all happens in one drain after pass 2, so the drain does its own
 * writeCorpus() the moment it finishes - same guarantee ("never discard work
 * already paid for"), applied at the point where payment now happens, and
 * before the re-decode pass below it gets a chance to throw.
 *
 * WHERE THE CURSOR IS DECIDED (2026-09-19). Not in the loop any more. A
 * queued decode's outcome is unknown while the loop runs, so the loop records
 * one row per fetched bill and resolveCursorRows applies the freeze rule AND
 * #251's day-walk once the drain has resolved them. See that function, and
 * docs/solutions/pinned-sync-cursor.md's 2026-09-19 amendment.
 */
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync } from 'node:fs';
import {
  completeDecode,
  decodeBill,
  decodeStructureFrom,
  fetchTextVersions,
  loadJSON,
  redecodeBill,
  syncOneBill,
} from './bill-decode.mjs';
import { decodeBatched } from '../lib/decode-batch.mjs';
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
import { bumpCounter, recordApiError, setCounter } from './run-counters.mjs';
import { classifyApiError } from './api-billing.mjs';
import {
  DEFAULT_REDECODE_MAX_PER_NIGHT,
  DEFAULT_REDECODE_PROBE_LIMIT,
  countSaysNewText,
  dateSaysNewText,
  planRedecodes,
} from './text-version.mjs';

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
/*
 * BATCHED DECODES (2026-09-18, owner directive: cut pipeline spend).
 *
 * On by default, and on for THIS script only. The nightly is the one decode
 * path with no reader waiting on it, so its two model calls per new bill go
 * through the Message Batches API at 50% of the standard rate. The hourly
 * newsdesk re-decode — which heals a page that is live and wrong right now —
 * stays synchronous and is untouched by this flag.
 *
 * WHAT IT CHANGES ABOUT THE NIGHT: nothing that can be seen in the output.
 * The gates, the budget, the priority filter, the no-text refusal and the
 * publish shape check all run exactly where they always ran; only the
 * transport for the two calls moves, and any bill the batch cannot deliver is
 * decoded synchronously in the same run at full price (see the drain below).
 * The cost is wall-clock: two batch rounds, measured at 2-5 minutes each on
 * this repo's existing batch user, with a ceiling past which it gives up and
 * falls back.
 *
 * DECODE_BATCH=0 turns it off and restores the pre-2026-09-18 behaviour
 * exactly — the kill switch, if a batch ever misbehaves at 14:15 UTC.
 */
const DECODE_BATCH = (process.env.DECODE_BATCH ?? '1') !== '0';

/** Record which pass queued a decode, so the drain can put a failure in the
 *  same tally that pass's inline failure would have gone to. Matched by slug
 *  rather than by "the last thing pushed" — the passes are sequential today,
 *  and a future reader who makes one concurrent should not have to notice
 *  this to keep the failure counts honest. */
function tagPass(queue, slug, pass) {
  const job = queue.find((j) => j.slug === slug);
  if (job) job.pass = pass;
}

/**
 * THE WHOLE CURSOR DECISION FOR THE ASCENDING WINDOW, as one pure function:
 * the freeze rule AND the day-walk, over one row per fetched bill, in window
 * order. Exported so the arithmetic that governs whether a bill is EVER seen
 * again is unit-testable without a live sync.
 *
 * THE FREEZE RULE is unchanged and is the one docs/solutions/pinned-sync-
 * cursor.md exists to protect: advance the high-water mark over every bill
 * this run fully handled, and freeze it the instant one still needs work.
 * What changed on 2026-09-18 is only WHEN it can be evaluated. A queued
 * decode's outcome — added, or failed and therefore still needing work — is
 * not known while the loop is running, so the loop records its verdict per
 * bill and this function applies the same rule once the drain has resolved
 * the pending ones. Deciding inline would have meant guessing, and both
 * guesses are bad: assume success and a failed decode advances the cursor past
 * a bill that is not in the corpus, which is exactly the permanently-skipped-
 * bill failure the pinned-cursor doc is about; assume failure and one queued
 * bill freezes the night's whole backlog.
 *
 * THE DAY-WALK moved in here on 2026-09-19, when #251's cursor work met this
 * one. `lastFullDay` is the newest calendar day this run processed CLEAN
 * THROUGH — the walk crossed into a LATER day with nothing frozen behind it —
 * which is a strictly stronger fact than "we got somewhere inside this day"
 * and is what lets the cursor leave a day it is already sitting in
 * (endOfDayCursor). It has to be decided here and not in the loop for exactly
 * the same reason the freeze does: a day whose last bill is a queued decode is
 * not finished until the drain says it is, and the loop cannot know that yet.
 * Two rules over the same rows, one pass, one place to read.
 *
 * EVERY BILL OF THE WINDOW GETS A ROW — including the ones pass 1 already
 * resolved, which the loop's dedupe branch skips without deciding anything.
 * That is what makes "handledSlugs ⟹ resolved" an invariant of this function
 * rather than a property of whichever branch remembered to push: a row is
 * frozen only by its own `needsWork` or by its slug appearing in
 * `failedSlugs`, and a deduped row has neither.
 *
 * @param {{ updateDate?: string | null, day?: string | null, slug?: string | null,
 *           needsWork: boolean }[]} rows one per fetched bill, ascending
 * @param {string} since the cursor this run started from
 * @param {Set<string>} failedSlugs slugs whose queued decode did not produce a decode
 * @returns {{ cursor: string, frozen: boolean, lastFullDay: string|null }}
 */
export function resolveCursorRows(rows, since, failedSlugs = new Set()) {
  let cursor = since;
  let frozen = false;
  let lastFullDay = null;
  let currentDay = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const day = row.day ?? null;
    // Crossing into a later day with nothing frozen behind us means every bill
    // of the day we just left is done.
    if (!frozen && currentDay !== null && day !== null && day !== currentDay) lastFullDay = currentDay;
    if (day !== null) currentDay = day;
    const needsWork = Boolean(row.needsWork) || (row.slug ? failedSlugs.has(row.slug) : false);
    if (needsWork) frozen = true;
    else if (!frozen && row.updateDate) cursor = toISODateTime(row.updateDate);
  }
  return { cursor, frozen, lastFullDay };
}

// See the header comment above and decode-gate.mjs. Empty by default.
const forceSlugs = parseForceSlugs(process.env.FORCE_DECODE_SLUGS);
// RE-DECODE-ON-NEW-TEXT (2026-09-18). A separate, much smaller budget from
// MAX_NEW_DECODES above, and additive to it: the worst case a night can bill
// is MAX_NEW_DECODES first decodes PLUS REDECODE_MAX_PER_NIGHT re-reads. Ten
// is ~$0.65 at the measured per-decode cost. See the RE-DECODE pass near the
// bottom of this file and scripts/text-version.mjs's ceiling comment.
const REDECODE_MAX_PER_NIGHT = Number(
  process.env.REDECODE_MAX_PER_NIGHT ?? DEFAULT_REDECODE_MAX_PER_NIGHT
);
// Free /text probes per run — runner time, not money. See text-version.mjs.
const REDECODE_PROBE_LIMIT = Number(
  process.env.REDECODE_PROBE_LIMIT ?? DEFAULT_REDECODE_PROBE_LIMIT
);
// FORCE_REDECODE_SLUGS: the FORCE_DECODE_SLUGS of the re-decode path. It
// bypasses the DETECTION (a listed slug is re-read whether or not its text
// moved) but NOT the ceiling — forced slugs are simply first in the queue, so
// no env var can raise a night's bill. See planRedecodes.
const forceRedecodeSlugs = parseForceSlugs(process.env.FORCE_REDECODE_SLUGS);

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

  // The batch queue. Present (an array) when DECODE_BATCH is on, which makes
  // syncOneBill stop at the decode and hand the job back instead of spending
  // it — see its 'queued_decode' outcome. Null restores the synchronous path
  // byte for byte.
  const decodeQueue = DECODE_BATCH ? [] : null;
  const ctxBase = { bills, es, bySlug, anthropic, forceSlugs, decodeQueue };

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

  // What each refreshed bill told us on the way past, for the re-decode pass
  // near the bottom of this file. A refresh is free and already fetched the
  // bill-detail payload, so its text-version COUNT and its served TITLE cost
  // nothing extra here — and they are the only two things a refresh can say
  // about whether the DOCUMENT moved rather than the calendar entry. Keyed by
  // slug so a bill both passes touch is recorded once, with the later (pass 2)
  // reading winning, which is the newer one.
  const refreshedThisRun = new Map();
  const noteRefreshed = (r) => {
    if (!r?.slug) return;
    refreshedThisRun.set(r.slug, {
      servedCount: r.textVersionCount ?? null,
      fetchedTitle: r.fetchedTitle ?? null,
    });
  };

  const recentDecodeCap = Math.min(RECENT_DECODE_RESERVE, MAX_NEW_DECODES);
  console.log(`recent-first pass: fetching up to ${RECENT_FETCH_LIMIT} most-recently-updated bills (decode reserve ${recentDecodeCap})`);
  const recentBills = DRY_RUN ? [] : await fetchRecentlyUpdated(RECENT_FETCH_LIMIT);
  let recentRefreshed = 0, recentAdded = 0, recentGated = 0, recentDeferred = 0, recentPartial = 0, recentNoText = 0, recentFailed = 0;
  for (const u of recentBills) {
    const result = await syncOneBill(u, { ...ctxBase, allowDecode: added < recentDecodeCap });
    if (result.outcome === 'refreshed') {
      refreshed++; recentRefreshed++; handledSlugs.add(result.slug); noteRefreshed(result);
    } else if (result.outcome === 'added' || result.outcome === 'queued_decode') {
      // A queued decode charges the budget NOW, before it is spent. It has to:
      // `allowDecode` is what stops a night from decoding more bills than
      // MAX_NEW_DECODES allows, and a queue that didn't count against it would
      // let the whole window queue up and then bill for all of it at once. The
      // drain reconciles the count afterwards — a queued decode that fails
      // comes back out of `added` and into the failure tallies.
      added++; recentAdded++; handledSlugs.add(result.slug);
      if (result.outcome === 'queued_decode') tagPass(decodeQueue, result.slug, 'recent');
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
  console.log(`recent-first pass: ${recentRefreshed} refreshed, ${recentAdded} ${DECODE_BATCH ? 'queued for batch decode' : 'added+decoded'}, ${recentGated} gated (no real motion), ${recentDeferred} deferred (reserve exhausted), ${recentPartial} skipped (partial payload), ${recentNoText} skipped (no bill text published yet), ${recentFailed} failed`);

  // PERSIST WHAT PASS 1 ALREADY PAID FOR, before pass 2 gets the chance to
  // throw. Corpus only - the cursor belongs to pass 2 and pass 2 hasn't run.
  // See "WHAT IS ON DISK WHEN PASS 2 THROWS" in the header comment.
  // With DECODE_BATCH on, this write persists pass 1's FREE refreshes only:
  // its new bills are still sitting in `decodeQueue`, undecoded and unpushed,
  // and nothing has been paid for them yet. That is the same guarantee this
  // write was added for (2026-08-09) — never discard work already paid for —
  // reaching it from the other side: there is no paid work to lose here,
  // because the spend happens after pass 2, in one drain. The drain does its
  // OWN write the moment it finishes, for the original reason; see it below.
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
  // already sitting in (endOfDayCursor).
  //
  // RECORDED, NOT APPLIED (2026-09-19, merging the batch drain). Both rules —
  // the freeze and the day-walk — now live in resolveCursorRows near the top
  // of this file, and run once the drain has turned every queued decode into
  // added-or-failed. The loop cannot decide either one while it runs: a bill
  // whose decode is still sitting in a batch is neither handled nor failed
  // yet, and guessing is not available. Assume success and a failed decode
  // advances the cursor past a bill that is not in the corpus, which is the
  // permanently-skipped-bill failure docs/solutions/pinned-sync-cursor.md
  // exists for; assume failure and one queued bill freezes the night's whole
  // backlog. So the loop writes down what it saw — one row per bill of the
  // window, IN WINDOW ORDER, dedupes included — and the pure function decides.
  const cursorRows = [];
  for (const u of updated.slice(0, plan.count)) {
    const slug = updateSlug(u);
    let needsWork = false;
    if (handledSlugs.has(slug)) {
      // Already fully resolved by the recent-first pass this run - dedupe,
      // don't re-fetch/re-decide. Resolved is resolved, so the cursor may
      // still advance over it exactly as if pass 2 had handled it itself.
    } else {
      const result = await syncOneBill(u, { ...ctxBase, allowDecode: added < MAX_NEW_DECODES });
      if (result.outcome === 'refreshed') {
        refreshed++; handledSlugs.add(result.slug); noteRefreshed(result);
      } else if (result.outcome === 'added') {
        added++; handledSlugs.add(result.slug);
      } else if (result.outcome === 'queued_decode') {
        // Charged to the budget now, resolved at the drain — see the same
        // branch in pass 1. The cursor cannot judge this bill yet; its row
        // below carries the slug, and resolveCursorRows finishes the job
        // against the drain's failure set.
        added++; handledSlugs.add(result.slug);
        tagPass(decodeQueue, result.slug, 'ascending');
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
    // ONE ROW PER BILL OF THE WINDOW — dedupes included. That is what makes
    // "resolved ⟹ a row exists saying so" an invariant of the function rather
    // than a property of whichever branch happened to push: the pass-1 dedupe
    // branch above writes nothing and decides nothing, and a row carrying its
    // slug is how the drain's verdict still reaches it.
    cursorRows.push({
      updateDate: u.updateDate ?? null,
      day: updateDay(u.updateDate),
      slug,
      needsWork,
    });
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
    if (result.outcome === 'refreshed') { refreshed++; noteRefreshed(result); }
    else if (result.outcome === 'added') added++;
    else if (result.outcome === 'queued_decode') {
      added++;
      tagPass(decodeQueue, slug, 'force');
    } else if (result.outcome === 'skipped_partial') partialSkipped++;
    else if (result.outcome === 'skipped_no_text') noTextSkipped++;
    else if (result.outcome === 'failed') forceFailed++;
    handledSlugs.add(slug);
  }
  // ---- THE BATCH DRAIN ---------------------------------------------------
  // Every decode this run decided to spend, spent here, in two batch rounds
  // at half the standard rate (lib/decode-batch.mjs). It runs AFTER both
  // passes and the force list so one batch covers the whole night rather than
  // three, and BEFORE the cursor is resolved, because a decode that does not
  // land is a bill that still needs work.
  //
  // THE FALLBACK IS THE POINT. A batch that times out, errors a row, or comes
  // back with a reply that fails the publish shape check costs that bill
  // nothing except the wait: it is decoded synchronously, right here, at full
  // price, through the identical decodeBill/completeDecode pair the
  // pre-batch nightly used. The only way a bill ends the night undecoded is
  // the way it always could — both attempts failed — and that is counted and
  // freezes the cursor exactly as an inline decode failure always did.
  let batchDecoded = 0;
  let syncFallback = 0;
  // New bills whose queued decode produced nothing, outside the ascending
  // window: the recent-first pass's and the force list's. They are real new
  // bills this run SAW, so `newSeen` at the bottom has to count them, and
  // their pass's own failure tally is where the DONE line reports them. Kept
  // apart from `newFailed`, which stays the ascending pass's own number
  // because lib/pipeline-health.mjs parses it out of the DONE line as such.
  let newQueuedFailed = 0;
  const drainFailedSlugs = new Set();
  if (decodeQueue && decodeQueue.length) {
    console.log(`decode-batch: draining ${decodeQueue.length} queued decode(s) — Message Batches API at half the standard rate, synchronous fallback for anything it can't deliver`);
    const decoded = await decodeBatched(decodeQueue, { anthropic });
    for (const job of decodeQueue) {
      // #246's counter, moved to where the spend moved. `decodeAttempts` is
      // what scripts/check-run-honesty.mjs's rule 3 measures a dead decode
      // path against ("reached the model N times, landed none"), and with the
      // batch transport syncOneBill no longer reaches the model at all — it
      // hands the job here. One bump per job, exactly as syncOneBill bumps
      // once per bill: every job below issues at least one request, through
      // the batch or through the fallback.
      bumpCounter('decodeAttempts');
      const batched = decoded.get(job.slug);
      let dec = batched?.ok ? batched.dec : null;
      if (dec) {
        batchDecoded++;
      } else {
        try {
          // PAY FOR THE MISSING HALF, NOT THE WHOLE THING. When the batch
          // delivered round 1 and lost round 2, its summary comes back on the
          // failure (lib/decode-batch.mjs) and has already been billed at the
          // batch rate — re-running decodeBill here would buy that paragraph a
          // second time at full rate for nothing.
          dec = batched?.summary
            ? await decodeStructureFrom(anthropic, job.bill, batched.summary)
            : await decodeBill(anthropic, job.bill, job.text);
          syncFallback++;
          console.log(`decode-batch: ${job.slug} fell back to a synchronous ${batched?.summary ? 'call 2 only (the batch delivered its summary)' : 'decode'} (${batched?.reason ?? 'no batch result'})`);
        } catch (e) {
          console.error(`FAIL ${job.slug}: batch (${batched?.reason ?? 'no batch result'}) then sync decode (${e.message})`);
          // The other half of #246: a refusal the API never billed (a credit
          // balance 400 above all) has to be classified where it is caught, or
          // the post-commit alarm cannot tell an outage from a bad night.
          recordApiError(classifyApiError(e));
          drainFailedSlugs.add(job.slug);
          continue;
        }
      }
      try {
        await completeDecode({
          slug: job.slug, bill: job.bill, text: job.text,
          version: job.version ?? null, count: job.count ?? null,
          dec, bills, es, bySlug, anthropic,
        });
      } catch (e) {
        // completeDecode is the write, not the decode: a throw here means the
        // bill is not in the corpus, so it is a failure like any other.
        console.error(`FAIL ${job.slug}: storing the decode threw (${e.message})`);
        drainFailedSlugs.add(job.slug);
      }
    }
    // Reconcile the optimistic budget accounting the loops did (see their
    // 'queued_decode' branches): a queued decode that produced nothing is not
    // an `added` bill, and it must land in the same tally its pass's inline
    // failure would have.
    for (const job of decodeQueue) {
      if (!drainFailedSlugs.has(job.slug)) continue;
      added--;
      if (job.pass === 'recent') { recentFailed++; newQueuedFailed++; }
      else if (job.pass === 'force') { forceFailed++; newQueuedFailed++; }
      else { failed++; newFailed++; }
    }
    console.log(
      `decode-batch: ${batchDecoded} decoded via Batches (50% rate), ${syncFallback} via synchronous fallback (full rate), ${drainFailedSlugs.size} failed both`
    );
    // PERSIST THE MOMENT THE MONEY IS SPENT. This is the 2026-08-09 guarantee
    // ("never discard work already paid for") moved to where payment now
    // happens: before batching, pass 1's write was the only thing standing
    // between a paid decode and a pass-2 throw; with batching, every decode of
    // the night lands here, and the re-decode pass below it can still throw.
    // One extra writeFileSync of a file this run writes anyway, and it is the
    // simplest correct answer — draining pass 1 separately would double the
    // batch rounds and the wall-clock on a concurrency group the hourly
    // newsdesk is queued behind; a try/finally around the rest of the run
    // would put the write on the abort path too, which is exactly where the
    // mostly-failed rule says nothing should land.
    writeCorpus();
  }

  if (forceFailed) {
    console.log(
      `::warning::${forceFailed} FORCE_DECODE_SLUGS entr(ies) failed their direct fetch (reasons in the FAIL lines above; ${forceSlugs.size} slug(s) were listed, and any the two passes already resolved were never direct-fetched). Check the slugs. This does NOT count toward the mostly-failed abort and never freezes the cursor.`
    );
  }

  // ---- RE-DECODE ON NEW TEXT (2026-09-18) -------------------------------
  //
  // Everything above answers "has this bill MOVED". This answers "is the text
  // we explained still the text Congress publishes". They are not the same
  // question, and the gap between them shipped a wrong number to readers for
  // ten days: H.R. 5634 was reported out of committee WITH AN AMENDMENT on
  // 2026-09-08, which changed the dollar figure at the centre of its decode,
  // while the refresh path dutifully updated its status, its date and its
  // urgency and left the explanation describing the bill as introduced — in
  // both languages, on the bill page and in the homepage hero.
  //
  // WHY IT LIVES HERE AND NOT IN THE NEWSDESK. scripts/newsdesk.mjs already
  // re-decodes, on two triggers of its own: a vehicle swap (the title
  // Congress serves stopped matching ours) and a stale decode beside a newer
  // floor action, both scoped to bills at the front of the ladder. Neither
  // fires on an amendment in committee: the title does not change, and the
  // action that accompanies it ("Placed on the Union Calendar") is not a
  // floor signal. The nightly is the right place because the nightly is what
  // already holds every refreshed bill's detail payload.
  //
  // WHAT IT SPENDS, and the one knob that governs it: REDECODE_MAX_PER_NIGHT
  // (10 → ~$0.65 worst case), additive to MAX_NEW_DECODES. Forced slugs jump
  // the queue but do not raise the ceiling. The detection itself is free: the
  // count comparison rides on a payload already paid for, and confirming a
  // candidate costs one free Congress.gov /text request.
  //
  // WHERE IT SITS IN THE RUN, and why (order re-stated 2026-09-19, when the
  // batch drain landed between it and the passes):
  //   force loop -> BATCH DRAIN -> failVerdict -> THIS PASS -> the cursor
  //   decision -> the writes.
  //   - AFTER THE DRAIN, because `failVerdict` below is what stops this pass
  //     from spending on a night that is going to exit 1, and a queued
  //     decode's failure is not known until the drain resolves it. Computing
  //     the verdict before the drain would have let a night whose batch died
  //     wholesale pay for ten re-decodes on its way to throwing the night away.
  //   - BEFORE THE CURSOR DECISION and before writeCorpus, because it mutates
  //     the corpus in place — but it must NOT touch `frozen` or the high-water
  //     mark, because the cursor means "the backlog scan has fully processed
  //     through here" and a deferred re-decode says nothing about the backlog.
  //     A re-decode that fails leaves the old decode standing (see
  //     redecodeBill) and is retried on the bill's next refresh — there is
  //     nothing to freeze for.
  const redecodeProbeLimit = Number.isFinite(REDECODE_PROBE_LIMIT) && REDECODE_PROBE_LIMIT >= 0
    ? Math.floor(REDECODE_PROBE_LIMIT)
    : DEFAULT_REDECODE_PROBE_LIMIT;
  // A night that is going to abort as mostly-failed buys nothing by re-reading
  // ten bills: the abort at the bottom of this file exits 1, sync-bills.yml
  // never reaches its commit step, and every decode paid for after this point
  // dies with the runner. The verdict is computed once here and reused at the
  // bottom, so the two can't disagree about whether tonight is that night —
  // its inputs (the ascending pass's failures, the force loop's, the window)
  // are all final by now.
  //
  // "BY NOW" MOVED (2026-09-19). It used to mean "after the two passes and the
  // force loop"; with the batch drain a queued decode's failure is not known
  // until the drain has run, so this sits BELOW the drain. Getting that order
  // wrong would have been silent and expensive in exactly one direction: a
  // night whose batch died wholesale would have computed a clean verdict,
  // skipped nothing, and then paid for ten re-decodes on its way to exit 1.
  // `plan.count` - the slice this run ATTEMPTED - is the denominator, never
  // `updated.length`: failures can only come from bills we tried, and since the
  // same-timestamp extension (2026-09-18) the slice can be LARGER than
  // MAX_UPDATES as well as smaller than the window. Same number the bottom-of-
  // run check reports, because it is literally the same verdict object.
  const failVerdict = mostlyFailedVerdict({
    ascendingFailed: failed,
    forceFailed,
    windowSize: plan.count,
  });
  if (failVerdict.abort) {
    console.log(
      're-decode on new text: skipped — this run is already going to abort as mostly-failed, so nothing it paid for tonight would be committed.'
    );
  }
  // Probe order: bills whose published text-version COUNT grew since we last
  // looked first (the strongest free signal there is), then by urgency, so a
  // run that can confirm only `redecodeProbeLimit` bills confirms the ones a
  // reader is most likely to open. Probing more bills than we can re-decode is
  // the point: it is what makes the capped queue the RIGHT ten rather than the
  // first ten.
  const probeQueue = [...refreshedThisRun.entries()]
    .map(([slug, seen]) => ({ slug, seen, bill: bySlug.get(slug) }))
    .filter((c) => c.bill)
    .map((c) => ({
      ...c,
      hint: countSaysNewText({
        storedCount: c.bill.text_version_count ?? null,
        servedCount: c.seen.servedCount,
      }),
    }))
    .sort((a, b) => {
      if (a.hint.newer !== b.hint.newer) return a.hint.newer ? -1 : 1;
      return (b.bill.urgency_score ?? 0) - (a.bill.urgency_score ?? 0);
    });
  const countHinted = probeQueue.filter((c) => c.hint.newer).length;
  const toProbe = failVerdict.abort ? [] : probeQueue.slice(0, redecodeProbeLimit);

  const newTextCandidates = [];
  let probed = 0, probeFailed = 0, countStamped = 0;
  for (const c of toProbe) {
    let versions, count;
    try {
      ({ versions, count } = await fetchTextVersions(c.bill.bill_type, c.bill.bill_number));
      probed++;
    } catch (e) {
      // Free call, non-fatal, nothing written: the bill keeps whatever stamp
      // it had and comes back on its next refresh. A probe failure must never
      // cost the night anything, least of all the cursor.
      probeFailed++;
      console.error(`  re-decode probe failed for ${c.slug}: ${e.message}`);
      continue;
    }
    const verdict = dateSaysNewText({ storedDate: c.bill.text_version_date ?? null, versions });
    if (verdict.redecode) {
      newTextCandidates.push({
        slug: c.slug,
        reason: verdict.reason,
        from: verdict.from,
        to: verdict.to,
        fetchedTitle: c.seen.fetchedTitle,
        urgency: c.bill.urgency_score ?? 0,
      });
      continue;
    }
    // NOT a candidate, so record what we just saw — and ONLY the count, never
    // a date. The count is an honest statement about this probe ("this many
    // versions existed when we last looked") and it is what stops a
    // single-version bill from spending a probe every night for the life of
    // the corpus. A DATE would be a claim about which document the stored
    // decode came from, which nobody read and nothing here can know.
    // Deliberately not written for candidates: a candidate the cap defers
    // must stay a candidate.
    if (c.bill.text_version_count == null && Number.isFinite(count)) {
      c.bill.text_version_count = count;
      countStamped++;
    }
  }

  // planRedecodes owns the ORDER as well as the ceiling — a known change
  // outranks a suspected one, and urgency decides within each tier. See its
  // comment for why the backfill must never be able to crowd out a bill
  // amended this morning.
  const redecodePlan = planRedecodes({
    forced: failVerdict.abort ? [] : [...forceRedecodeSlugs],
    detected: newTextCandidates,
    cap: REDECODE_MAX_PER_NIGHT,
  });
  console.log(
    `re-decode on new text: ${refreshedThisRun.size} refreshed bill(s) seen, ${countHinted} with a grown text-version count, ${probed} probed (limit ${redecodeProbeLimit}${probeFailed ? `, ${probeFailed} probe failure(s)` : ''}), ${newTextCandidates.length} candidate(s) detected (${newTextCandidates.filter((c) => c.reason === 'new-text-version').length} newer than our stamp, ${newTextCandidates.filter((c) => c.reason === 'legacy-backfill').length} unstamped backfill), ${forceRedecodeSlugs.size} forced; ${redecodePlan.run.length} will be re-decoded (cap ${redecodePlan.cap}), ${redecodePlan.deferred.length} deferred to a later run, ${countStamped} record(s) stamped with a first text-version count`
  );
  if (!Number.isFinite(REDECODE_MAX_PER_NIGHT) || REDECODE_MAX_PER_NIGHT < 0) {
    console.log(
      `::warning::REDECODE_MAX_PER_NIGHT was not a usable number, so the built-in ceiling of ${redecodePlan.cap} was used instead. Check the workflow input.`
    );
  }

  // WHY THIS PASS STAYS SYNCHRONOUS while the new-bill decodes above went to
  // the Message Batches API (2026-09-19). Not an oversight, and not a small
  // change either way:
  //   - THE SAVING IS SMALL. The ceiling is 10 re-decodes a night at ~$0.065,
  //     so the batch discount is worth about $0.33 a night — against ~$2 for
  //     the new-bill path it is rounding error.
  //   - THE COST IS NOT. Batching this would add a THIRD and FOURTH round of
  //     waiting to a job that holds the `data-sync` concurrency group, which
  //     the hourly newsdesk queues behind. That is the exact starvation
  //     DECODE_BATCH_MAX_WAIT_MS was lowered to bound; spending it again for
  //     $0.33 is the wrong trade.
  //   - IT IS NOT MECHANICAL. redecodeBill fetches, fingerprints, VETOES,
  //     decodes and stores in one function shared with scripts/newsdesk.mjs.
  //     Batching it means splitting it into a "fetch + veto" phase and a
  //     "decode + store" phase and threading the version stamp between them —
  //     a refactor of the newsdesk's decode path, done for a night that saves
  //     a third of a dollar. If this ceiling is ever raised far enough to
  //     matter, that is the shape it should take.
  let redecoded = 0, redecodeFailed = 0, redecodeNoText = 0, redecodeUnchanged = 0, redecodeMissing = 0;
  for (const item of redecodePlan.run) {
    const bill = bySlug.get(item.slug);
    // The served title is written ONLY beside a new decode and ONLY when it
    // actually differs — refreshBillFields deliberately never touches `title`,
    // because a title that moves without its decode is a page whose headline
    // describes a different document. Here the decode IS moving, so the two
    // land together. Passing it unchanged would also re-run the search-input
    // call for nothing, which is the one avoidable cent on this path.
    const fetchedTitle = item.fetchedTitle ?? null;
    const title = bill && fetchedTitle && fetchedTitle !== bill.title ? fetchedTitle : null;
    // `forced` CARRIES THE OWNER'S ORDER THE REST OF THE WAY (2026-09-19).
    // planRedecodes marks a FORCE_REDECODE_SLUGS entry with reason 'forced';
    // dropping that here let the fingerprint veto answer a question the owner
    // had not asked, so a forced slug over unchanged text came back
    // 'text-unchanged' with zero model calls and the workflow input was inert
    // on exactly the bill someone typed it for. The ceiling is untouched:
    // forced slugs are already inside redecodePlan.run, which is capped.
    const result = await redecodeBill(item.slug, {
      anthropic, es, bySlug, title, forced: item.reason === 'forced',
    });
    if (result.outcome === 'redecoded') redecoded++;
    else if (result.outcome === 'text-unchanged') redecodeUnchanged++;
    else if (result.outcome === 'skipped_no_text') redecodeNoText++;
    else if (result.outcome === 'missing') redecodeMissing++;
    else redecodeFailed++;
    const span = item.from && item.to ? ` ${String(item.from).slice(0, 10)} -> ${String(item.to).slice(0, 10)}` : '';
    console.log(`  ${item.slug}: ${result.outcome} (${item.reason}${span}${title ? ', title updated' : ''})`);
  }
  if (redecodePlan.run.length) {
    console.log(
      `re-decode on new text: ${redecoded} re-decoded, ${redecodeUnchanged} vetoed by the fingerprint (prompt byte-identical — no model call, both provenance stamps refreshed), ${redecodeNoText} skipped (no published text), ${redecodeMissing} not in the corpus, ${redecodeFailed} failed (old decode left standing)`
    );
  }

  // ---- THE CURSOR DECISION, IN ONE PURE FUNCTION -------------------------
  // Everything that can change a bill's verdict has now happened: the drain
  // turned every queued decode into added-or-failed, and the re-decode pass
  // above deliberately touches neither `frozen` nor the mark (a deferred
  // re-decode says nothing about whether the BACKLOG SCAN got through here).
  // resolveCursorRows near the top of this file owns the freeze rule and the
  // day-walk together, so there is exactly one place to read - and to test -
  // for "could this run skip a bill forever".
  const { cursor, frozen, lastFullDay } = resolveCursorRows(cursorRows, since, drainFailedSlugs);

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
  // `lastFullDay` proves it for any earlier day the walk got clean through
  // before freezing (resolveCursorRows, which owns both rules now). Take
  // whichever is later, never earlier than `cursor`, and let resolveNextSync's
  // monotonic clamp have the last word. `plan.dayComplete` stays a property of
  // the FETCHED WINDOW — it says the next bill Congress.gov handed us is on a
  // later day — so the drain cannot change it; `frozen` is the post-drain one,
  // which is the whole reason this line reads them in this order.
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
  // this run touched resolves to exactly one of added/gated/queued/newFailed/
  // newQueuedFailed by the time we get here (a pass-1 'budget' deferral that
  // pass 2 later resolves is NOT double-counted - see recentDeferred's comment
  // above). `newQueuedFailed` was added 2026-09-19 with the batch drain: a
  // queued decode that fails outside the ascending window comes back out of
  // `added` and would otherwise vanish from this total, which would make a bad
  // batch night read as a quiet one.
  // The one exception is 'skipped_partial', counted in partialSkipped instead:
  // its payload was unreadable, so we can't honestly say we saw a bill at all.
  // 'skipped_no_text' IS counted: that bill's record read fine and the bill is
  // real - only its text is missing, so we saw it and declined to decode it.
  const newSeen = added + gated + queued + newFailed + newQueuedFailed + noTextSkipped;
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
  //
  // Computed once, above the re-decode pass, and reused here — so "is tonight
  // a mostly-failed night" is answered in exactly one place and the pass that
  // spends money can't disagree with the check that throws the night away.
  const verdict = failVerdict;
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
