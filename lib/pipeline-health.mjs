/**
 * PIPELINE HEALTH — the pure half.
 *
 * One deterministic read of "is the machine running clean", assembled from
 * things that already exist: the Actions run list, the run logs the scripts
 * already print, the committed data files, and the open-issue list. No new
 * database, no new secret, no new paid call. `scripts/pipeline-health.mjs`
 * does the I/O (gh + fs + git) and hands the results here; everything in this
 * file is a pure function of its arguments so tests/pipeline-health.unit.spec.ts
 * can drive it from fixture log excerpts saved off real runs.
 *
 * Same split as lib/traffic-metrics.mjs / scripts/daily-metrics.mjs, and for
 * the same reason: a parser that is only exercised through a network call is a
 * parser nobody can test, and a log parser that has quietly stopped matching
 * finds nothing and reports a healthy zero. Every SHAPE parser here returns
 * `null` (not 0) when its anchor line is absent, and the formatters render
 * `null` as "not found" rather than as a number — a missing reading and a
 * healthy reading must never look the same. The COUNTING parsers are the
 * deliberate exception: "no credit-error line in the log" really is zero
 * credit errors, and each one is pinned by a test that proves it still counts.
 *
 * WHAT THIS IS NOT. It is not a gate: nothing here fails a build, blocks a
 * commit or closes an issue. It reports. The gates stay where they are
 * (scripts/verify-sync.mjs pre-commit, scripts/check-cursor-age.mjs
 * post-commit, the gate list in .github/workflows/ci.yml).
 */

// Pure, I/O-free: the same day arithmetic and the same dark-feed reading the
// conversation gate uses, so the digest and the gate cannot disagree about how
// long a press feed has been dark.
import { committedDarkFeeds, daysBetween, FEED_DARK_ALARM_DAYS } from './conversation.mjs';
// The short-titles step's summary line and its four checks, defined where the line is printed.
import { shortTitlesAlarms } from './short-titles-summary.mjs';
export { parseShortTitlesSummary, shortTitlesSummaryExpected } from './short-titles-summary.mjs';
// The Big Question press collector's alarm window, named where its signal is
// defined (questionPressActivity) so the digest and the collector agree.
import { QUESTION_PRESS_SILENT_DAYS } from './question-press.mjs';
import { floorSignalsHealthy } from './docket.mjs';
// The summary refusal alarm's threshold, named where the collector counts
// (scripts/moment-updates.mjs writeSummaries), so the two cannot disagree.
import { SUMMARY_REFUSAL_ALARM_RUNS } from './moment-updates-gate.mjs';
// The record re-check's held rows, read off the committed file the same way
// the collector reads them (lib/moment-updates-recheck.mjs heldRows).
import {
  RECHECK_UNCHECKED_ALARM_NIGHTS,
  RECHECK_ZERO_CHECKED_ALARM_NIGHTS,
  RECHECK_SENTENCES_PER_LINE,
  heldRows,
  quoteWords,
  recheckReportProblems,
  renderRecord,
} from './moment-updates-recheck.mjs';
// The nightly identical-bills step's alarms, defined beside the step's own
// lines and file (lib/related-bills.mjs; owner, 2026-11-13, twin coverage).
import { relatedAlarms } from './related-bills.mjs';
import { MODEL_PRICE_PER_MTOK } from './decode-spend.mjs';

/* ------------------------------------------------------------------ *
 * 0 · Log-line normalisation
 * ------------------------------------------------------------------ */

/**
 * `gh run view --log` prints `<job>\t<step>\t<ISO timestamp> <message>`, with
 * ANSI colour left in. Strip all three so a parser can match the message the
 * script actually wrote. Written defensively: a line with no prefix (a raw
 * script capture, a fixture trimmed by hand) passes through unchanged.
 * @param {string} line
 * @returns {string}
 */
export function stripLogPrefix(line) {
  let out = String(line ?? '').replace(/\[[0-9;]*m/g, '');
  // Two leading tab-separated fields, only when both are present.
  const tabbed = out.match(/^[^\t\n]*\t[^\t\n]*\t(.*)$/);
  if (tabbed) out = tabbed[1];
  out = out.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '');
  return out.trim();
}

/** @param {string} log @returns {string[]} */
export function logLines(log) {
  return String(log ?? '')
    .split('\n')
    .map(stripLogPrefix)
    .filter(Boolean);
}

/** The LAST line matching `re`, as a match array, or null. */
function lastMatch(lines, re) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = lines[i].match(re);
    if (m) return m;
  }
  return null;
}

const int = (v) => (v === undefined ? null : Number.parseInt(v, 10));

/* ------------------------------------------------------------------ *
 * 1 · The nightly sync's own DONE line
 * ------------------------------------------------------------------ */

/**
 * scripts/sync-bills.mjs's summary. Anchored on "gated (no real legislative
 * motion)" specifically, because scripts/newsdesk.mjs's hot-bill refresh
 * prints a SHORTER line that also starts `DONE: N refreshed, N added+decoded`
 * — matching that one as if it were the nightly would report a night that
 * never ran.
 *
 * `waitingOnBatch` and `revisitFailed` come from the parked-batch segment the
 * line has carried since 2026-09-25 (the part the lazy `.*?` skips). They are
 * read separately so an older line still parses, and they read null there,
 * not 0: an older line said nothing about parked batches.
 *
 * @param {string} log
 * @returns {{refreshed:number, added:number, gated:number, queued:number,
 *   waitingOnBatch:number|null, revisitFailed:number|null,
 *   ascendingFailed:number, newFailed:number, recentFailed:number,
 *   forceFailed:number, cursor:string, cursorReason:string, newSeen:number,
 *   corpus:number} | null}
 */
export function parseSyncDone(log) {
  const m = lastMatch(
    logLines(log),
    /^DONE: (\d+) refreshed, (\d+) added\+decoded, (\d+) gated \(no real legislative motion\), (\d+) queued for next run,.*?(\d+) failed in the ascending pass \((\d+) new\), (\d+) in the recent-first pass, (\d+) force-slug; cursor -> (\S+) \(([^)]*)\); new bills seen this run: (\d+); corpus (\d+)/
  );
  if (!m) return null;
  const waiting = m.input.match(/ queued for next run, (\d+) waiting on a slow batch /);
  const revisit = m.input.match(/ parked bill\(s\) re-fetched directly \((\d+) with an error\)/);
  return {
    waitingOnBatch: waiting ? int(waiting[1]) : null,
    revisitFailed: revisit ? int(revisit[1]) : null,
    refreshed: int(m[1]),
    added: int(m[2]),
    gated: int(m[3]),
    queued: int(m[4]),
    ascendingFailed: int(m[5]),
    newFailed: int(m[6]),
    recentFailed: int(m[7]),
    forceFailed: int(m[8]),
    cursor: m[9],
    cursorReason: m[10],
    newSeen: int(m[11]),
    corpus: int(m[12]),
  };
}

/**
 * scripts/sync-bills.mjs's RE-DECODE summary — the second paid decode path of
 * the night, and the one the day's spend estimate used to leave out entirely.
 * Verbatim (2026-09-26 nightly):
 *
 *   `re-decode on new text: 10 re-decoded, 0 vetoed by the fingerprint (prompt
 *    byte-identical — no model call, both provenance stamps refreshed), 0
 *    skipped (no published text), 0 not in the corpus, 0 failed (old decode
 *    left standing)`
 *
 * The same run prints an EARLIER line with the same prefix — the plan
 * ("… 192 refreshed bill(s) seen, 40 probed (limit 40), 10 will be
 * re-decoded") — so the pattern requires `N re-decoded,` immediately after the
 * prefix and can only match the outcome line. `lastMatch` then takes the
 * newest of them, as everywhere else in this file.
 *
 * The `.*?` after "fingerprint" is not laziness: the parenthetical the line
 * carries there holds its own comma ("… no model call, both provenance stamps
 * refreshed"), so a comma-excluding class cannot reach the next field.
 *
 * `vetoed` is deliberately NOT a cost: the log says why in its own words, and
 * the fingerprint veto is the one branch here that makes no model call.
 *
 * WHY NOT `decodeAttempts`. The run counters the same night prints
 * (`run counters (nightly): {"decodeAttempts":11,…}`) already tally every
 * decode request the run issued, which looks like the better source and is
 * not: that counter is shaped for scripts/check-run-honesty.mjs's rule 3
 * ("reached the model N times, landed none"), so a PARKED batch job is
 * deliberately not bumped tonight even though tonight submitted it — see the
 * bump's own comment in lib/decode-batch.mjs. Verdict-timing semantics are the
 * right ones for that alarm and the wrong ones for a bill. This line counts
 * decodes that LANDED, which is what `added` counts too, so the two add up.
 *
 * @param {string} log
 * @returns {{redecoded:number, vetoed:number, skipped:number,
 *   notInCorpus:number, failed:number} | null}
 */
export function parseRedecodeDone(log) {
  const m = lastMatch(
    logLines(log),
    /^re-decode on new text: (\d+) re-decoded, (\d+) vetoed by the fingerprint.*?, (\d+) skipped \(no published text\), (\d+) not in the corpus, (\d+) failed/
  );
  if (!m) return null;
  return {
    redecoded: int(m[1]),
    vetoed: int(m[2]),
    skipped: int(m[3]),
    notInCorpus: int(m[4]),
    failed: int(m[5]),
  };
}

/**
 * scripts/sync-bills.mjs's SPEND LEDGER line (2026-11-28, PR #581;
 * lib/decode-spend.mjs formatSpendLedgerLine writes it). Verbatim shape:
 *
 *   `decode spend ledger: $1.234 estimated at list price against the $3.00
 *    nightly ceiling; 12 decode(s) charged (2 long, 1 split into chunks); 0
 *    left for the next night by the ceiling; 0 parked after repeated failures;
 *    0 over the single-decode limit; $0.000 on a one-off approved decode`
 *
 * The last two fields (2026-11-28, check 2 of #581) are optional in the
 * pattern, so a log from before them still parses (and reads 0 for both).
 *
 * The dollar figure is the run's OWN list-price, worst-case estimate of every
 * decode it paid for (new and re-decodes, every reply at its cap, no Batches
 * discount), so it is an upper bound on the night's decode bill — the real
 * invoice for a batched night is about half of it. A one-off decode the owner
 * approved is counted apart from it (`oneOffUsd`). Null on a log from before
 * the ledger existed.
 *
 * @param {string} log
 * @returns {{usd:number, ceilingUsd:number, charged:number, long:number, chunked:number,
 *   deferred:number, failureParked:number, overLimit:number, oneOffUsd:number} | null}
 */
export function parseDecodeLedger(log) {
  const m = lastMatch(
    logLines(log),
    /^decode spend ledger: \$(\d+(?:\.\d+)?) estimated at list price against the \$(\d+(?:\.\d+)?) nightly ceiling; (\d+) decode\(s\) charged \((\d+) long, (\d+) split into chunks\); (\d+) left for the next night by the ceiling; (\d+) parked after repeated failures(?:; (\d+) over the single-decode limit; \$(\d+(?:\.\d+)?) on a one-off approved decode)?/
  );
  if (!m) return null;
  return {
    usd: Number(m[1]),
    ceilingUsd: Number(m[2]),
    charged: int(m[3]),
    long: int(m[4]),
    chunked: int(m[5]),
    deferred: int(m[6]),
    failureParked: int(m[7]),
    overLimit: m[8] === undefined ? 0 : int(m[8]),
    oneOffUsd: m[9] === undefined ? 0 : Number(m[9]),
  };
}

/**
 * scripts/sync-coverage.mjs's summary:
 *   `DONE: 90/600 bills with coverage, 194 articles total (+310 unprocessed bills carried forward)`
 * and, since the 2026-09-26 merge made those counts include articles carried
 * over from earlier nights, a tail saying what TONIGHT found:
 *   `…; kept tonight: 41 article(s) on 23 bill(s); 3 of 40 re-judged stored
 *    article(s) dropped on tonight's gate verdict; 0 gate reply(ies) not
 *    complete and well-formed (no stored article dropped on them)`
 * The tail is optional in the pattern so an older log still parses — and its
 * fields read null there, not 0: an old line did not say "kept nothing".
 *
 * `checked` is the Y of "X/Y": the bills the night PLANNED to check. A quota
 * stop or per-bill failures can leave some of them unreached, so it is an
 * upper bound on what was actually looked at, not a count of it.
 * `rejudged` is how many stored articles tonight's gate was shown again with
 * a complete, well-formed reply; `droppedOnVerdict` can never exceed it.
 *
 * @returns {{withCoverage:number, checked:number, articles:number, carriedForward:number,
 *   keptTonight:number|null, billsKeptTonight:number|null, droppedOnVerdict:number|null,
 *   rejudged:number|null, unansweredGates:number|null} | null}
 */
export function parseCoverageDone(log) {
  const m = lastMatch(
    logLines(log),
    /^DONE: (\d+)\/(\d+) bills with coverage, (\d+) articles total(?: \(\+(\d+) unprocessed bills carried forward\))?(?:; kept tonight: (\d+) article\(s\) on (\d+) bill\(s\)(?:; (\d+) of (\d+) re-judged stored article\(s\) dropped on tonight's gate verdict)?(?:; (\d+) gate reply\(ies\) not complete and well-formed)?)?/
  );
  if (!m) return null;
  return {
    withCoverage: int(m[1]),
    checked: int(m[2]),
    articles: int(m[3]),
    carriedForward: m[4] === undefined ? 0 : int(m[4]),
    keptTonight: int(m[5]),
    billsKeptTonight: int(m[6]),
    droppedOnVerdict: int(m[7]),
    rejudged: int(m[8]),
    unansweredGates: int(m[9]),
  };
}

/**
 * scripts/sync-coverage.mjs's hard-outage line, printed INSTEAD of the DONE
 * line when TheNewsAPI answered none of the night's requests:
 *   `COVERAGE OUTAGE: 0 of 600 planned bill(s) got a TheNewsAPI response tonight
 *    (600 failed) — data/coverage.json left unchanged, no bill checked`
 * with `; the daily quota stopped the run` inside the parentheses when the
 * quota, not a failure, ended it. Null when the line is absent.
 *
 * @returns {{planned:number, failed:number, quotaStopped:boolean} | null}
 */
export function parseCoverageOutage(log) {
  const m = lastMatch(
    logLines(log),
    /^COVERAGE OUTAGE: 0 of (\d+) planned bill\(s\) got a TheNewsAPI response tonight \((\d+) failed(; the daily quota stopped the run)?\)/
  );
  if (!m) return null;
  return { planned: int(m[1]), failed: int(m[2]), quotaStopped: m[3] !== undefined };
}

/**
 * The nightly short-titles step's trouble line (scripts/sync-short-titles.mjs,
 * 2026-11-15), printed once when it stopped early:
 *   `SHORT TITLES TROUBLE: the source has changed: 30 of 40 answers tonight were refused for the same reason ("…"); stopped, …; 10 bill(s) read before it are kept`
 *   `SHORT TITLES TROUBLE: stopped early: 10 requests in a row got no usable answer from Congress.gov (no answer, an error page or a broken connection); 0 bill(s) read before it are kept`
 * `sourceChanged` is true for the first kind, which needs a person (the API
 * changed shape); the others heal by themselves on a later night but are
 * still worth a line. Null when the line is absent.
 *
 * @returns {{text:string, reasons:string[], sourceChanged:boolean} | null}
 */
export function parseShortTitlesTrouble(log) {
  // EVERY trouble line of the night, not only the last (2026-11-17): from the
  // second night of a reshaped source, "bills piling up" used to overwrite
  // "the source has changed" and the alarm lost its "needs a person" code.
  const reasons = [];
  for (const line of logLines(log)) {
    const m = line.match(/^SHORT TITLES TROUBLE: (.+)$/);
    if (m && !reasons.includes(m[1])) reasons.push(m[1]);
  }
  if (reasons.length === 0) return null;
  const shown = reasons.slice(0, SHORT_TITLES_TROUBLE_SHOWN);
  const more = reasons.length - shown.length;
  return {
    text: shown.join(' | ') + (more > 0 ? ` | and ${more} more` : ''),
    reasons,
    sourceChanged: reasons.some((r) => /^the source has changed/.test(r)),
  };
}

/**
 * Decode locks gone stale (scripts/decode-locks.mjs, 2026-11-25). A locked
 * bill is a hand-corrected decode the pipeline must never rewrite; when
 * Congress publishes newer text for one, every run that sees it skips the bill
 * anyway and prints
 *   `::warning::DECODE LOCK STALE: hr-2347-119 has newer text than its hand-corrected decode (PR #562, locked 2026-11-25): …`
 * (GitHub's log shows the `::warning::` prefix as `##[warning]`; neither is
 * anchored here). One entry per bill across every log passed in, first line
 * kept. Empty when there is none.
 *
 * @param {string | string[]} logs one log or several
 * @returns {{slug:string, text:string}[]}
 */
export function parseDecodeLockStale(logs) {
  const out = [];
  const seen = new Set();
  for (const log of Array.isArray(logs) ? logs : [logs]) {
    for (const line of logLines(log)) {
      const m = line.match(/DECODE LOCK STALE: ([a-z]+-\d+-\d+) (.+)$/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({ slug: m[1], text: `${m[1]} ${m[2]}` });
    }
  }
  return out;
}

/** Where a person reads what to do about a short-titles alarm. */
const SHORT_TITLES_RUNBOOK = 'What to do: docs/runbooks/new-congress-switch.md';

/** At most this many distinct trouble reasons go into the alarm text. */
export const SHORT_TITLES_TROUBLE_SHOWN = 4;

/**
 * The nightly coverage sync's lean measurement — the 30-day date-sorted pass
 * against the whole-life pass on the same priority bills (see LEAN_DRIFT in
 * scripts/coverage-query.mjs, where the thresholds live; this file only reads
 * the verdict the script printed, so there is one definition of "shifted").
 *
 *   `LEAN MIX (kept tonight, AllSides): priority bills — 30-day pass L2/C2/R1/unrated 1, whole-life pass L0/C2/R0/unrated 0; all other bills L0/C2/R0/unrated 0`
 *   `LEAN DRIFT: ok — rated share: … · left/right split: …`
 *
 * `verdict` is 'ok' | 'drift' | 'thin' (the script's "too few to judge"), or
 * null when the MIX line is there but the DRIFT line is not (a log from before
 * the drift check shipped). Null overall when there is no MIX line at all.
 *
 * @returns {{windowDays:number, recent:object, wholeLife:object, rest:object,
 *   verdict:'ok'|'drift'|'thin'|null, detail:string|null} | null}
 */
export function parseCoverageLean(log) {
  const lines = logLines(log);
  const mix = lastMatch(
    lines,
    /^LEAN MIX \(kept tonight, AllSides\): priority bills — (\d+)-day pass L(\d+)\/C(\d+)\/R(\d+)\/unrated (\d+), whole-life pass L(\d+)\/C(\d+)\/R(\d+)\/unrated (\d+); all other bills L(\d+)\/C(\d+)\/R(\d+)\/unrated (\d+)/
  );
  if (!mix) return null;
  const bucket = (i) => ({ left: int(mix[i]), center: int(mix[i + 1]), right: int(mix[i + 2]), unrated: int(mix[i + 3]) });
  const drift = lastMatch(lines, /^LEAN DRIFT: (ok|DRIFT|too few to judge) — (.*)$/);
  const VERDICT = { ok: 'ok', DRIFT: 'drift', 'too few to judge': 'thin' };
  return {
    windowDays: int(mix[1]),
    recent: bucket(2),
    wholeLife: bucket(6),
    rest: bucket(10),
    verdict: drift ? VERDICT[drift[1]] : null,
    detail: drift ? drift[2] : null,
  };
}

/**
 * A coverage night set out to check this many bills and kept NOTHING before
 * it is a ⛔. The gate historically keeps 7.5–11% of candidates, and a normal
 * night keeps articles on dozens of bills. Zero across a sweep of 100+ planned
 * bills means an API that answers with no articles, a dead gate (every gate
 * call failing), or a quota stop in the first batches. It is not a quiet news
 * day. An API that answers NOTHING never prints the DONE line this reads, so
 * that case is the separate coverage-outage ⛔ (parseCoverageOutage).
 */
export const COVERAGE_KEPT_ZERO_MIN_CHECKED = 100;

/**
 * When a coverage night dropped enough stored articles on its gate's verdict
 * to need a person to look. It fires when BOTH hold:
 *   - at least `minDropped` stored articles were dropped, and
 *   - they are at least `minShare` of the stored articles the gate was shown
 *     again with a complete, well-formed reply (the DONE line's "D of J
 *     re-judged").
 * Every one of those articles was KEPT by an earlier gate. A healthy gate
 * mostly agrees with itself on a second look. Rejecting half or more of them
 * in one night points to a broken prompt, a model change, or a query that
 * started returning a different kind of article, and not to editorial
 * churn. Share, not a raw count, because the number re-judged changes with
 * how much of the stored file tonight's sweep reaches.
 *
 * THESE ARE A FIRST SETTING, NOT A MEASURED ONE. No night has run with
 * drop-on-verdict yet, so the normal re-rejection rate is unknown. The first
 * night after it ships may run high for a real reason: #302 changed the gate
 * prompt (it now sees dates), and most stored articles were kept under the
 * old one. Tune here after a week of DONE lines.
 */
export const COVERAGE_MASS_DROP = Object.freeze({ minDropped: 20, minShare: 0.5 });

/* ------------------------------------------------------------------ *
 * 2 · Pregen (the one paid path that prices itself in the log)
 * ------------------------------------------------------------------ */

/**
 * Three lines, each optional independently — a night where pregen is disabled
 * prints none of them, and that is a null, not a zero.
 *
 *   `pregen: 10 top bill(s), 60 combo(s) total, 0 already cached, 60 to generate`
 *   `pregen: estimated cost — batch ~$0.084-$0.126/night (~$2.52-$3.78/month); sync-fallback ...`
 *   `pregen: done — 60 generated, 60 stored durably, 0 not stored, 0 failed, batch msgbatch_...`
 *
 * THE DONE LINE HAS TWO SPELLINGS AND BOTH ARE READ. Until #288 (2026-09-24)
 * it was `pregen: done — 60 cached, 0 failed, …`; that PR split the single
 * "cached" number into what was GENERATED and what was then STORED DURABLY,
 * and nothing here followed. The anchor stopped matching and `cached`/`failed`
 * rendered "not found" every night from 2026-09-24 on — a present line read as
 * an absent one, which is precisely the failure the file's own contract
 * forbids. The old spelling is kept because run logs older than that PR are
 * still fed to this parser.
 *
 * `cached` is the number the report prints as "written", so it reads STORED
 * DURABLY, not generated: a script that was generated and then failed its
 * cache write did not get written. The gap between the two is the `not stored`
 * count, captured as `notStored` (null on the old spelling, which had no such
 * number to give).
 *
 * The anchor is `^pregen: done` and not `^pregen:` because the run that
 * collects a batch an earlier night parked prints a SECOND, near-identical
 * line first — `pregen: collected parked batch msgbatch_… — 18 generated, 18
 * stored durably, 0 not stored, 0 failed` — and the night's outcome is the
 * `done` line, never that one.
 *
 * The batch id is deliberately NOT captured: it is an operational handle with
 * no diagnostic value in a digest, and the less that leaves a log for an issue
 * body the better.
 *
 * There is a FOURTH line, and it is the reason this parser is not just the
 * three above. When pregen refuses (`PregenCacheUnavailableError` — a dead
 * cache database before the batch, or every cache write failing after it) or
 * crashes, scripts/pregen-scripts.mjs prints `::error::pregen failed: <reason>`
 * and exits 1, having printed NONE of the three. In a downloaded run log that
 * arrives as `##[error]pregen failed: …`, so the `^pregen:` anchors above
 * cannot match it and every field lands null — rendering a night where pregen
 * REFUSED exactly like a night where pregen was never armed. That is the one
 * thing this file exists to prevent, so the refusal gets read too.
 *
 * @returns {{topBills:number|null, combos:number|null, alreadyCached:number|null,
 *   toGenerate:number|null, generated:number|null, cached:number|null,
 *   notStored:number|null, failed:number|null,
 *   costLow:number|null, costHigh:number|null, abortReason:string|null}}
 */
export function parsePregen(log) {
  const lines = logLines(log);
  const plan = lastMatch(
    lines,
    /^pregen: (\d+) top bill\(s\), (\d+) combo\(s\) total, (\d+) already cached, (\d+) to generate/
  );
  const done = lastMatch(
    lines,
    /^pregen: done [—-] (\d+) generated, (\d+) stored durably, (\d+) not stored, (\d+) failed/
  );
  const legacyDone = done ? null : lastMatch(lines, /^pregen: done [—-] (\d+) cached, (\d+) failed/);
  // The em dash and the hyphen between the two dollar figures are both the
  // script's own characters; keep them literal rather than guessing.
  const cost = lastMatch(lines, /^pregen: estimated cost [—-] batch ~\$([\d.]+)-\$([\d.]+)\/night/);
  // Both marker spellings: `##[error]` is what a downloaded log carries,
  // `::error::` what the raw stream carries, and a hand-trimmed excerpt may
  // have neither.
  const abort = lastMatch(lines, /^(?:##\[error\]|::error::)?pregen failed: (.+)$/);
  return {
    topBills: plan ? int(plan[1]) : null,
    combos: plan ? int(plan[2]) : null,
    alreadyCached: plan ? int(plan[3]) : null,
    toGenerate: plan ? int(plan[4]) : null,
    generated: done ? int(done[1]) : null,
    cached: done ? int(done[2]) : legacyDone ? int(legacyDone[1]) : null,
    notStored: done ? int(done[3]) : null,
    failed: done ? int(done[4]) : legacyDone ? int(legacyDone[2]) : null,
    costLow: cost ? Number.parseFloat(cost[1]) : null,
    costHigh: cost ? Number.parseFloat(cost[2]) : null,
    abortReason: abort ? abort[1].trim() : null,
  };
}

/* ------------------------------------------------------------------ *
 * 3 · Counting parsers (absence is 0 here, and that is correct)
 * ------------------------------------------------------------------ */

/**
 * Anthropic billing/validation failures. Split deliberately: a
 * "credit balance is too low" IS an invalid_request_error, so counting the
 * two together would double-count the exact outage this exists to catch
 * (2026-09-09/10, every decode in the night failing on one billing state).
 * `creditBalance` is the money alarm; `invalidRequestOther` is everything
 * else the API rejected as malformed, which is a code bug, not a bill.
 *
 * @returns {{creditBalance:number, invalidRequestOther:number, total:number}}
 */
export function countAnthropicErrors(log) {
  let creditBalance = 0;
  let invalidRequestOther = 0;
  for (const line of logLines(log)) {
    if (/credit balance is too low/i.test(line)) creditBalance += 1;
    else if (/invalid_request_error/.test(line)) invalidRequestOther += 1;
  }
  return { creditBalance, invalidRequestOther, total: creditBalance + invalidRequestOther };
}

/**
 * The nightly record re-check's trouble, from the collector's own lines
 * (scripts/moment-updates.mjs, 2026-11-14). Matched anywhere in a line, so
 * the `::error::` prefix and the `##[error]` form GitHub's log shows both
 * count. A COUNTING parser: no such line is no trouble, never "not found".
 *   - `refused`: "moment-updates record re-check refused: <why>. Nothing was
 *     changed; …" — a guard stopped the night; the reason, or null.
 *   - `failed`: "moment-updates record re-check failed and changed nothing" —
 *     the re-check threw.
 *   - `acceptMalformed`: "moment-updates record re-check: data/record-recheck-accept.json …"
 *   - `zeroChecked`: "moment-updates record re-check checked 0 of N re-checkable row(s)"
 *   - `reported`: how many "moment-updates record re-check REPORT:" lines
 * @param {string} log
 *   - `wouldRefuse`: "record re-check: the source looks wrong for <bill> tonight; …: <why>"
 * @returns {{ refused: string|null, wouldRefuse: string|null, failed: boolean, acceptMalformed: boolean, zeroChecked: boolean, reported: number }}
 */
export function parseRecheckTrouble(log) {
  let refused = null;
  let wouldRefuse = null;
  let failed = false;
  let acceptMalformed = false;
  let zeroChecked = false;
  let reported = 0;
  for (const line of logLines(log)) {
    const m = line.match(/moment-updates record re-check refused: (.*?)\. Nothing was changed/);
    if (m) refused = m[1];
    const w = line.match(/moment-updates record re-check: the source looks wrong for (\S+) tonight; its lines are unconfirmed, not reported as differences: (.*)$/);
    if (w) wouldRefuse = `${w[1]}: ${w[2]}`;
    if (/moment-updates record re-check (follow-up )?failed and changed nothing/.test(line)) failed = true;
    if (/moment-updates record re-check: data\/record-recheck-accept\.json/.test(line)) acceptMalformed = true;
    if (/moment-updates record re-check checked 0 of \d+ re-checkable row/.test(line)) zeroChecked = true;
    if (/moment-updates record re-check REPORT: /.test(line)) reported += 1;
  }
  return { refused, wouldRefuse, failed, acceptMalformed, zeroChecked, reported };
}

/**
 * What the nightly comparison still has unresolved, read from the committed
 * data/record-recheck-report.json (scripts/moment-updates.mjs writes it; see
 * lib/moment-updates-recheck.mjs nextRecheckReport), and what of it is DUE a
 * comment this morning.
 *
 * WHEN A COMMENT IS DUE. Each finding has a day it first becomes worth a
 * comment (E) and, while it lasts, every 7 days after (E+7, E+14 …). A comment
 * is due when such a day falls after the previous report that actually ran
 * (`lastReportDay`, read from the standing issue's own "Last update" stamp)
 * and on or before today. So a report that is skipped, or runs late, never
 * loses a finding: the next one that runs catches it up, once.
 *   - a line found to differ or left: E = the morning after the night that
 *     first found it (named once); then only the issue BODY counts it, with
 *     one weekly reminder comment for all open lines (E+7 …);
 *   - a bill not checked, a line newer than its list (3+ nights), nothing
 *     checked at all (2+ nights), a night a guard would refuse (1 night):
 *     E = the morning after the night the streak reached its threshold; then
 *     the BODY counts it, with a weekly reminder.
 * The report runs at 13:00 UTC, before that day's nightly at 14:15 UTC.
 * `lastReportDay` unknown: the day before today (the report runs daily).
 *
 * Returns null when the file is absent (`unreadable` unset): nothing to say.
 * A file that cannot be parsed (`unreadable`, the parse error) or that fails
 * its shape is returned as { malformed: [why …] } with nothing else in it.
 * @param {Record<string, any>|null} file
 * @param {{ now?: number, lastReportDay?: string|null, unreadable?: string|null }} [opts]
 */
export function recheckFindings(file, { now = Date.now(), lastReportDay = undefined, unreadable = null } = {}) {
  const empty = { newRows: [], openRows: [], oldestOpen: null, weeklyReminder: false, unchecked: [], newer: [], zeroCheckedNights: 0, zeroCheckedDue: false, suspect: [] };
  if (unreadable) return { ...empty, malformed: [`data/record-recheck-report.json is not valid JSON (${unreadable})`] };
  if (!file) return null;
  const problems = recheckReportProblems(file);
  if (problems.length) return { ...empty, malformed: problems };
  const today = etDayOf(now);
  // Named through which day: the standing issue BODY's marker. Not passed
  // (a caller that runs daily, or the issue could not be read): yesterday.
  // Read and NOT FOUND (null), or dated after today (no report can have named
  // a day not yet come: treated as unreadable): fall back to naming
  // everything still open, once, which the 60-day window bounds.
  const prev =
    lastReportDay === undefined
      ? shiftEtDay(today, -1)
      : lastReportDay && lastReportDay < today
        ? lastReportDay
        : lastReportDay === today
          ? today // already named today: the same-day duplicate guard
          : shiftEtDay(today, -(RETENTION_WINDOW_DAYS + 1));
  const due = (e) => prev < e && e <= today;
  const dueWeekly = (e) => {
    if (today < e) return false;
    const k = Math.floor(daysBetween(e, today) / 7);
    return shiftEtDay(e, 7 * k) > prev;
  };
  const nights = (since, last) => daysBetween(since, last) + 1;
  const crossing = (since, threshold) => shiftEtDay(since, threshold); // the morning after the threshold-th night
  const rows = Object.entries(file.rows ?? {}).map(([key, r]) => ({ key, ...r }));
  const newRows = rows.filter((r) => due(shiftEtDay(r.first_seen, 1)));
  const openRows = rows.filter((r) => shiftEtDay(r.first_seen, 1) <= prev);
  const oldest = openRows.map((r) => r.first_seen).sort()[0] ?? null;
  const streak = (entries, threshold) =>
    entries
      .map(([key, u]) => ({ key, ...u, nights: nights(u.since, u.last) }))
      .filter((u) => u.nights >= threshold)
      .map((u) => ({ ...u, due: dueWeekly(crossing(u.since, threshold)) }));
  const unchecked = streak(Object.entries(file.unchecked ?? {}), RECHECK_UNCHECKED_ALARM_NIGHTS).map((u) => ({ ...u, slug: u.key }));
  const newer = streak(Object.entries(file.newer ?? {}), RECHECK_UNCHECKED_ALARM_NIGHTS);
  const zc = file.zero_checked ? nights(file.zero_checked.since, file.zero_checked.last) : 0;
  // A bill whose source looked wrong on the latest night: due the first
  // morning, weekly after, and on any morning its unconfirmed set gained a line.
  const suspect = Object.entries(file.suspect ?? {})
    .filter(([, b]) => b.last >= shiftEtDay(today, -1))
    .map(([slug, b]) => {
      const lines = Object.entries(b.rows ?? {}).map(([key, r]) => ({ key, ...r }));
      const gained = lines.filter((r) => due(shiftEtDay(r.first_seen, 1)));
      return { slug, ...b, lines, gained, nights: nights(b.since, b.last), due: dueWeekly(crossing(b.since, 1)) || gained.length > 0 };
    });
  return {
    malformed: /** @type {string[]|undefined} */ (undefined),
    newRows,
    openRows,
    oldestOpen: oldest,
    weeklyReminder: openRows.length > 0 && dueWeekly(shiftEtDay(oldest, 8)),
    unchecked,
    newer,
    zeroCheckedNights: zc,
    zeroCheckedDue: zc >= RECHECK_ZERO_CHECKED_ALARM_NIGHTS && dueWeekly(crossing(file.zero_checked.since, RECHECK_ZERO_CHECKED_ALARM_NIGHTS)),
    suspect,
  };
}

/** The window the collector keeps (lib/moment-updates-gate.mjs RETENTION_DAYS): a fallback never names past it. */
const RETENTION_WINDOW_DAYS = 60;

/**
 * The ET day through which the comparison's findings were NAMED in a comment
 * (or nothing was due), from the standing issue BODY's marker
 * `<!-- recheck-named-through: YYYY-MM-DD -->`, which daily-metrics advances
 * only after the morning's comment is posted (or when no comment was due).
 * Null when the marker is missing or unreadable (recheckFindings then falls
 * back to naming everything still open).
 * @param {string|null|undefined} body
 */
export function namedThroughFromBody(body) {
  const m = String(body ?? '').match(/<!-- recheck-named-through: (\d{4}-\d{2}-\d{2}) -->/);
  return m && Number.isFinite(Date.parse(`${m[1]}T00:00:00Z`)) ? m[1] : null;
}

/**
 * The re-check's markers as scripts/pipeline-health.mjs reads them: from the
 * standing issue's BODY only (only the workflow, the issue's author and the
 * repository's collaborators can edit it; never a comment, which anyone can
 * write on a public repository). `issues` is the `gh issue list` answer, or
 * null when that read failed.
 *   - read failed: `lastReportDay` undefined (recheckFindings takes the last
 *     report as yesterday), so a flaky lookup never re-names every line; and
 *     `unread`, so daily-metrics writes NO named-through date into the body
 *     that morning (a marker it could not read is never moved: the next
 *     report that reads the body finds none and names every open line, once);
 *   - read, but no issue, no marker, or a marker dated after today: null
 *     (name everything still open, once);
 *   - otherwise the marker's day.
 * `namedThrough` is what daily-metrics carries forward into the body.
 * @param {unknown} issues
 * @param {number} now
 * @returns {{ lastReportDay: string|null|undefined, namedThrough: string|null, leftOutSince: string|null, unread: boolean }}
 */
export function recheckMarkersFrom(issues, now) {
  const today = etDayOf(now);
  if (!Array.isArray(issues)) return { lastReportDay: undefined, namedThrough: null, leftOutSince: null, unread: true };
  const issue = issues.find((i) => i?.title === HEALTH_ISSUE_TITLE);
  const marked = issue ? namedThroughFromBody(issue.body) : null;
  const left = issue ? leftOutSinceFromBody(issue.body) : null;
  const lastReportDay = marked && marked <= today ? marked : null;
  return { lastReportDay, namedThrough: lastReportDay, leftOutSince: left && left <= today ? left : null, unread: false };
}

/** The marker formatHealthIssueBody writes. */
export function namedThroughMarker(day) {
  return day ? `<!-- recheck-named-through: ${day} -->` : '';
}

/** The US Eastern day of an instant, the day the comparison's dates are in. */
export function healthDayOf(ms) {
  return etDayOf(ms);
}

function etDayOf(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function shiftEtDay(day, delta) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Rows the record re-check is HOLDING (hidden: the record's new words fail the
 * update lint and no decode has passed yet), read from the committed
 * data/moment-updates.json. null when the file was not read.
 * @param {Record<string, any> | null} updatesFile
 */
export function recheckHeldRows(updatesFile) {
  if (!updatesFile || typeof updatesFile !== 'object' || Array.isArray(updatesFile)) return null;
  return heldRows(updatesFile);
}

/** `upstash cache: request failed (status 0); failing open to in-memory (error #N ...)` */
export function countUpstashCacheFailures(log) {
  return logLines(log).filter((l) => /^upstash cache: request failed/.test(l)).length;
}

/**
 * `mirror-portraits: B001323 source fetch failed (status 404) - skipped`
 *
 * Since #402 (2026-09-29) this is NOT the number of members without a photo:
 * a member whose photo answered 404 is written to data/portrait-missing.json
 * and not asked again for 30 days, so a normal night prints no 404 at all.
 * The count of members with no photo upstream is portraitsMissingUpstream.
 */
export function countPortrait404s(log) {
  return logLines(log).filter((l) => /^mirror-portraits: \S+ source fetch failed \(status 404\)/.test(l)).length;
}

/**
 * `t3: 25 headline(s) batched, 8 resolved` — summed across every occurrence in
 * the supplied log(s), because the collector concatenates a day of newsdesk
 * runs. `runs` counts how many t3 lines were seen at all, so a day with no
 * newsdesk run reads as 0-of-0 rather than as a silent failure.
 * @returns {{batched:number, resolved:number, runs:number}}
 */
export function parseT3(log) {
  let batched = 0;
  let resolved = 0;
  let runs = 0;
  for (const line of logLines(log)) {
    const m = line.match(/^t3: (\d+) headline\(s\) batched.*?, (\d+) resolved/);
    if (!m) continue;
    batched += int(m[1]);
    resolved += int(m[2]);
    runs += 1;
  }
  return { batched, resolved, runs };
}

/**
 * Playwright's github reporter writes both
 *   `::error file=tests/freshness.spec.ts,title=[webkit-mobile] > tests/freshness.spec.ts:175:7 > ...`
 * and
 *   `##[error]  1) [webkit-mobile] > tests/freshness.spec.ts:175:7 > ...`
 * so matching the spec:line:col token on any error-annotated line catches both
 * and dedupes the pair. A CI run that died in a non-Playwright gate step (the
 * naming / parity / claim-truth gates) has no such token — that returns [],
 * and the collector reports the failing STEP name instead, which is the honest
 * answer for those.
 * @returns {string[]} e.g. ['tests/freshness.spec.ts:175:7']
 */
export function parseFailingTests(log) {
  const seen = new Set();
  for (const line of logLines(log)) {
    if (!/(::error|##\[error\])/.test(line)) continue;
    for (const m of line.matchAll(/(tests\/[A-Za-z0-9._/-]+\.spec\.ts):(\d+):(\d+)/g)) {
      seen.add(`${m[1]}:${m[2]}:${m[3]}`);
    }
  }
  return [...seen];
}

/* ------------------------------------------------------------------ *
 * 4 · File-derived readings
 * ------------------------------------------------------------------ */

/** Keys data/coverage.json carries that are metadata, not bills. */
const COVERAGE_META_KEYS = new Set(['_checkedAt', '_note']);

export const COVERAGE_STALE_DAYS = 30;

/**
 * How much of the coverage corpus is old news — the exact measurement
 * CLAUDE.md's 2026-08-05 note records going unflagged once (88.5% of entries
 * older than 30 days behind a page that reads as nightly-fresh). Reported
 * every day so it can never quietly drift again.
 *
 * `newest article` is the max publishedAt across a slug's articles; a slug
 * whose articles carry no parseable date counts as UNDATED rather than as
 * stale — an unparseable date is a different problem from an old one.
 *
 * @param {Record<string, unknown>} coverage
 * @param {{now?: number, staleDays?: number}} [opts]
 * @returns {{bills:number, stale:number, undated:number, sharePct:number|null}}
 */
export function coverageStaleness(coverage, { now = Date.now(), staleDays = COVERAGE_STALE_DAYS } = {}) {
  let bills = 0;
  let stale = 0;
  let undated = 0;
  const cutoff = now - staleDays * 86_400_000;
  for (const [key, articles] of Object.entries(coverage ?? {})) {
    if (COVERAGE_META_KEYS.has(key)) continue;
    if (!Array.isArray(articles)) continue;
    bills += 1;
    let newest = Number.NEGATIVE_INFINITY;
    for (const a of articles) {
      const t = Date.parse(a?.publishedAt ?? '');
      if (Number.isFinite(t) && t > newest) newest = t;
    }
    if (!Number.isFinite(newest)) undated += 1;
    else if (newest < cutoff) stale += 1;
  }
  return {
    bills,
    stale,
    undated,
    sharePct: bills ? Math.round((stale / bills) * 1000) / 10 : null,
  };
}

/** Bills present in data/coverage.json (metadata keys excluded). */
export function coverageBillCount(coverage) {
  return Object.keys(coverage ?? {}).filter((k) => !COVERAGE_META_KEYS.has(k)).length;
}

/**
 * Members with no photo upstream, as data/portrait-missing.json records them
 * (scripts/mirror-portraits.mjs writes it on a 404 and drops a member the
 * moment a photo is found). This, not the night's 404 count, is the number of
 * members a reader sees the initials box for: after #402 a known-missing
 * member is re-asked only every 30 days, so the log's 404 count reads 0 on a
 * normal night while the members are still missing.
 *
 * `notServing` counts records whose member is no longer in
 * data/legislators.json (the mirror only walks current members, so it never
 * clears them). Null when the legislators file could not be read.
 *
 * @param {Record<string, unknown> | null} missing data/portrait-missing.json
 * @param {{bioguide?: string}[] | null} [legislators] data/legislators.json
 * @returns {{members: number, notServing: number | null} | null}
 */
export function portraitsMissingUpstream(missing, legislators = null) {
  if (!missing || typeof missing !== 'object' || Array.isArray(missing)) return null;
  const ids = Object.keys(missing);
  if (!Array.isArray(legislators)) return { members: ids.length, notServing: null };
  const serving = new Set(legislators.map((l) => l?.bioguide).filter(Boolean));
  return { members: ids.length, notServing: ids.filter((id) => !serving.has(id)).length };
}

/**
 * Distinct bills waiting on a slow decode batch, as data/decode-batch-parked.json
 * records them (lib/decode-batch.mjs writes it in the same nightly commit as
 * data/sync-state.json, so it describes the same run). Null when the file is
 * absent or not the shape this reads.
 *
 * @param {{schema?: string, batches?: {jobs?: {slug?: string}[]}[]} | null} parked
 * @returns {number | null}
 */
export function parkedDecodeCount(parked) {
  if (!parked || typeof parked !== 'object' || !Array.isArray(parked.batches)) return null;
  const slugs = new Set();
  for (const batch of parked.batches) {
    for (const job of Array.isArray(batch?.jobs) ? batch.jobs : []) if (job?.slug) slugs.add(job.slug);
  }
  return slugs.size;
}

/** How many days a cursor is allowed to sit still before FROZEN is the word for it. */
export const CURSOR_FROZEN_DAYS = 2;

/**
 * The cursor's two clocks. FROZEN is the interesting one and it is a
 * CONJUNCTION, not an age: the pipeline ran and the cursor did not move.
 * lastSync alone being old on a pipeline that has also stopped running is a
 * different failure (nothing is running at all) and must not wear the same
 * word.
 *
 * Corrected 2026-09-22. This function asserted that conjunction in its own
 * comment and in the alarm text ("has not moved in Nd … the backlog scan is
 * not making progress") while measuring only lastSync's AGE, which cannot see
 * movement at all. Age is a sound proxy for "did not move" only while the
 * cursor tracks real time; it is exactly wrong while the cursor is WALKING A
 * BACKLOG FORWARD, which is this pipeline's normal state. The cursor advanced
 * 2026-09-09 → 09-16 → 09-18 on consecutive nights and the report called it
 * FROZEN and "not making progress" on every one of them. Movement is now
 * measured against the previous committed cursor instead of inferred.
 *
 * `moved` is deliberately three-valued. With no baseline (a checkout too
 * shallow to reach the previous commit that touched data/sync-state.json) the
 * honest answer is "not measured", never "moved" — a dead-man's-switch that
 * goes quiet for want of an input is the failure it exists to catch. An
 * unmeasurable baseline on an old cursor still raises an alarm; it just says
 * what it actually knows (see `alarms`).
 *
 * HELD, NOT FROZEN (2026-10-06). The 2026-09-30 digest raised "did not move
 * … the backlog scan is not making progress" at 18:18Z. The last sync was a
 * 17:20Z dispatch (three forced re-decodes) whose backlog pass parked 10 new
 * decodes in a slow batch. A bill waiting on its batch freezes the cursor BY
 * DESIGN (scripts/sync-bills.mjs, "A DEFERRED BILL FREEZES THE CURSOR", since
 * 2026-09-25), so tomorrow's window reopens on it and lands it; the forced
 * re-decodes themselves touch neither `frozen` nor the mark. The nightly at
 * 19:17Z collected the batch and moved the cursor 09-28 → 09-30. The cursor
 * had moved on the sync before, 22h earlier.
 *
 * So one sync that stood still is HELD, not FROZEN, when all of these hold:
 *   - the committed data/decode-batch-parked.json (same commit as the cursor)
 *     names at least one bill waiting on a batch (`parkedDecodes`);
 *   - the cursor moved on the sync before that (`earlierSync` → `previousSync`),
 *     so this is one sync standing still, not two;
 *   - the DONE line of the run that wrote this cursor (`lastDone`, matched on
 *     its printed cursor) shows no other cause that can freeze the cursor:
 *     nothing queued past the decode budget, no failed decode in any pass, no
 *     truncated window, and a non-zero "waiting on a slow batch".
 * There is ONE exception to the last test: while the run that wrote the
 * cursor is still going (`producerRunning`, see runThatWroteCursor and
 * producerStillRunning) its log cannot be downloaded yet, so the committed
 * files alone decide, and the row says the other causes went unchecked. That
 * is the 09-30 case: the digest read at 18:17:58Z, the dispatch that wrote the
 * cursor at 17:20Z was still running until 18:22Z. The collector passes
 * producerRunning true only when NO completed nightly could have written the
 * stamp and exactly one nightly is in progress (a queued or pending run never
 * counts), so a second nightly that waits or runs after the producer cannot
 * stand in for it. In EVERY other case where the DONE line is missing (the
 * run finished but its log could not be read, the run list was stale, no
 * producing run was found, the line names another cursor) the sync is FROZEN,
 * as before: the 09-27 nightly was held AND truncated, the next sync moved the
 * cursor, and HELD on the files alone would have let that stall pass unseen.
 * A second sync in a row that stands still is FROZEN whatever the reason, and
 * so is a held sync with no baseline for the sync before, and a cursor that
 * went backwards. The lateness gate (scripts/check-cursor-age.mjs, 10 days)
 * does not read any of this.
 *
 * @param {{lastSync?: string, lastRun?: string}} state
 * @param {{now?: number, previousSync?: string|null, earlierSync?: string|null,
 *   parkedDecodes?: number|null, lastDone?: ReturnType<typeof parseSyncDone>,
 *   producerRunning?: boolean}} [opts]
 */
export function cursorHealth(
  state,
  {
    now = Date.now(),
    previousSync = null,
    earlierSync = null,
    parkedDecodes = null,
    lastDone = null,
    producerRunning = false,
  } = {}
) {
  const sync = Date.parse(state?.lastSync ?? '');
  const run = Date.parse(state?.lastRun ?? '');
  const previous = Date.parse(previousSync ?? '');
  const earlier = Date.parse(earlierSync ?? '');
  const lastSyncAgeDays = Number.isFinite(sync) ? (now - sync) / 86_400_000 : null;
  const lastRunAgeHours = Number.isFinite(run) ? (now - run) / 3_600_000 : null;
  /** true = advanced, false = stood still (or went backwards), null = no baseline to compare against. */
  const moved = Number.isFinite(sync) && Number.isFinite(previous) ? sync > previous : null;
  /** The same test one sync further back: did the sync BEFORE the last one move it? */
  const movedBefore = Number.isFinite(previous) && Number.isFinite(earlier) ? previous > earlier : null;
  // The log only counts when it describes THIS cursor. A DONE line from some
  // other run (an older nightly, one whose commit never landed) says nothing
  // about why this one stood still.
  const done = lastDone && Number.isFinite(sync) && Date.parse(lastDone.cursor ?? '') === sync ? lastDone : null;
  // Checked against the log, or excused from that check only because the run
  // that wrote the cursor is still going. Anything else that leaves the DONE
  // line missing is not evidence the sync was held, so it stays FROZEN.
  const otherCause = done
    ? done.queued > 0 ||
      done.ascendingFailed > 0 ||
      done.newFailed > 0 ||
      done.recentFailed > 0 ||
      done.forceFailed > 0 ||
      done.revisitFailed !== 0 ||
      !(done.waitingOnBatch > 0) ||
      /truncated/.test(done.cursorReason ?? '')
    : producerRunning !== true;
  // Stood still exactly: a cursor that went BACKWARDS is not a hold for a
  // parked batch (the batch keeps the mark where it was), so it stays FROZEN.
  const stoodStill = moved === false && sync === previous;
  const heldForBatch =
    stoodStill && movedBefore === true && typeof parkedDecodes === 'number' && parkedDecodes > 0 && !otherCause;
  // "The pipeline ran recently and the cursor is behind." On its own this is
  // lateness, not damage — scripts/check-cursor-age.mjs owns the ceiling that
  // actually reds a run (10 days). It is the precondition for both words
  // below, never a verdict by itself.
  const behind =
    lastSyncAgeDays !== null &&
    lastRunAgeHours !== null &&
    lastSyncAgeDays > CURSOR_FROZEN_DAYS &&
    lastRunAgeHours < 48;
  return {
    lastSync: state?.lastSync ?? null,
    lastRun: state?.lastRun ?? null,
    previousSync: previousSync ?? null,
    earlierSync: earlierSync ?? null,
    lastSyncAgeDays,
    lastRunAgeHours,
    moved,
    movedBefore,
    parkedDecodes: typeof parkedDecodes === 'number' ? parkedDecodes : null,
    behind,
    // Behind AND demonstrably standing still. A cursor that is behind but
    // advancing is catching up, which is the opposite of the thing this word
    // sends the owner to go fix. One sync held for a parked batch is the
    // pipeline's own design, not a stall (see HELD above).
    frozen: behind && moved === false && !heldForBatch,
    // Behind, stood still on the last sync only, and only for bills waiting
    // on a parked decode batch. Reported on the cursor row; not a ⛔.
    held: behind && heldForBatch,
    // Whether HELD was also checked against the DONE line of the run that
    // wrote the cursor. HELD is only ever unchecked while that run is still
    // going (its log cannot be downloaded yet), and the row says so.
    heldCheckedAgainstLog: done !== null,
    // Behind, and whether it moved could not be established. Loud, but it
    // says "could not verify" rather than asserting a stall.
    movementUnknown: behind && moved === null,
  };
}

/**
 * ALARM_HOURS is deliberately TIGHTER than lib/docket.mjs's SIGNAL_STALE_HOURS
 * (the site's own "stop trusting this signal" ceiling, 48h). The digest's job
 * is to shout BEFORE the site starts hiding a signal, not after.
 */
export const FLOOR_SIGNAL_ALARM_HOURS = 36;

/**
 * Floor-signals freshness. The stamp lives at the top level of
 * data/floor-signals.json as `fetched_at`; `_meta.fetched_at` is accepted too
 * so a future schema move does not silently read as "no stamp".
 *
 * `checked` is data/floor-signals-checked.json, the reconfirmation heartbeat.
 * floor-signals.json is rewritten only when its content changes, so a quiet
 * recess weekend leaves its stamp days old while the newsdesk keeps checking.
 * The site reads whichever stamp is newer (lib/docket.mjs's
 * floorSignalsHealthy), and so does this alarm, or it shouts about a signal
 * the site is still honestly trusting (the 2026-10-04 digest: "53h ago" with
 * a heartbeat 4h old).
 *
 * @param {object} signals
 * @param {{now?: number, staleHours?: number, alarmHours?: number, checked?: object|null}} opts
 */
export function floorSignalFreshness(
  signals,
  { now = Date.now(), staleHours = undefined, alarmHours = FLOOR_SIGNAL_ALARM_HOURS, checked = null } = {}
) {
  const own = signals?.fetched_at ?? signals?._meta?.fetched_at ?? null;
  const raw = floorSignalsHealthy({ fetched_at: own }, checked).fetched_at;
  const stamp = Date.parse(raw ?? '');
  const ageHours = Number.isFinite(stamp) ? (now - stamp) / 3_600_000 : null;
  return {
    fetchedAt: raw,
    ageHours,
    staleHours: staleHours ?? null,
    alarmHours,
    pastSiteCeiling: ageHours !== null && staleHours !== undefined && ageHours > staleHours,
    pastAlarm: ageHours !== null && ageHours > alarmHours,
  };
}

/**
 * Slugs data/conversation.json talks about that the corpus no longer has — a
 * dangling caption renders a count for a bill with no page behind it.
 * @param {{slugs?: Record<string, unknown>}} conversation
 * @param {Set<string>|string[]} billIds
 * @returns {string[]}
 */
export function danglingConversationSlugs(conversation, billIds) {
  const known = billIds instanceof Set ? billIds : new Set(billIds ?? []);
  return Object.keys(conversation?.slugs ?? {}).filter((slug) => !known.has(slug));
}

/**
 * The press basket's own health, as data/conversation.json's
 * `source_status` records it: which named feeds, and which rated leans, the
 * newsdesk has marked dark. The day counts are recomputed against `now`
 * rather than read from the stored `dark_days`, which only moves when the file
 * is written.
 *
 * `tracked: null` when the file carries no `feeds` block at all (written by a
 * build older than the per-feed alarm) — that is "not measured", and must not
 * render as "every feed is fine".
 *
 * @param {any} conversation
 * @param {{ now?: number }} [opts]
 * @returns {{ tracked: number | null, darkFeeds: { name: string, domain: string | null, lean: string | null, darkDays: number | null, since: string | null, lastError: string | null }[], darkLeans: { lean: string, darkDays: number | null, lastLive: string | null }[] } | null}
 */
export function pressFeedHealth(conversation, { now = Date.now() } = {}) {
  const status = conversation?._meta?.source_status;
  if (!status || typeof status !== 'object') return null;
  const today = new Date(now).toISOString().slice(0, 10);
  const feeds = status.feeds && typeof status.feeds === 'object' ? status.feeds : null;
  const darkLeans = Object.entries(status.leans ?? {})
    .filter(([, s]) => s?.status === 'dark')
    .map(([lean, s]) => {
      const days = s?.last_live ? daysBetween(s.last_live, today) : Number.isFinite(s?.dark_days) ? s.dark_days : null;
      return { lean, darkDays: Number.isFinite(days) ? days : null, lastLive: s?.last_live ?? null };
    });
  return {
    tracked: feeds ? Object.keys(feeds).length : null,
    darkFeeds: feeds ? committedDarkFeeds(status, { today }) : [],
    darkLeans,
  };
}

/* ------------------------------------------------------------------ *
 * 5 · Actions-run judgements
 * ------------------------------------------------------------------ */

/**
 * Consecutive failures at the head of a newest-first run list. `cancelled` is
 * NOT counted as red and does not break the streak either — this repo's own
 * standing rule reads a zero-step `cancelled` job as a lost runner rather than
 * a real result, so it is skipped over in both directions.
 *
 * @param {{conclusion?: string, status?: string, createdAt?: string}[]} runs newest first
 * @returns {{count:number, latest:string|null, since:string|null}}
 */
export function ciRedStreak(runs) {
  const completed = (runs ?? []).filter((r) => r.status === 'completed' || r.status === undefined);
  let count = 0;
  let since = null;
  let latest = null;
  for (const run of completed) {
    if (run.conclusion === 'cancelled') continue;
    if (latest === null) latest = run.conclusion ?? null;
    if (run.conclusion === 'failure') {
      count += 1;
      since = run.createdAt ?? run.startedAt ?? since;
    } else break;
  }
  return { count, latest, since };
}

/** Minutes between two ISO stamps, rounded to 0.1, or null. */
export function durationMinutes(startedAt, updatedAt) {
  const a = Date.parse(startedAt ?? '');
  const b = Date.parse(updatedAt ?? '');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round(((b - a) / 60_000) * 10) / 10;
}

/** sync-bills.yml's `name:` — the scheduled nightly and every dispatch of it. */
export const NIGHTLY_WORKFLOW = 'Nightly bill sync';

/** @param {{workflowName?: string}} r */
export const isNightly = (r) => r?.workflowName === NIGHTLY_WORKFLOW;

/**
 * The order the collector downloads logs in: nightlies first, so a day that
 * hits the per-run log cap never drops the one log carrying the sync
 * counters, and the NEWEST nightly first among them, because the collector
 * takes the night's counters from the first nightly log it reads. Until
 * 2026-10-06 the order among nightlies was left to the run list and the
 * collector kept the LAST log it read, so a day with two nightly runs in the
 * window (a dispatch beside the scheduled run) printed the older run's
 * counters. Returns a new array; other runs keep their relative order.
 *
 * @template {{workflowName?: string, createdAt?: string}} R
 * @param {R[]} runs
 * @returns {R[]}
 */
export function orderLogTargets(runs) {
  return [...(runs ?? [])].sort(
    (a, b) =>
      Number(isNightly(b)) - Number(isNightly(a)) ||
      (isNightly(a) && isNightly(b) ? Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '') : 0)
  );
}

/**
 * The nightly run that wrote the committed cursor, from the run list and
 * data/sync-state.json's `lastRun` (the script stamps it when it starts).
 *
 * The run list cannot say when a run's JOB started: `startedAt` in
 * `gh run list` equals `createdAt` on every nightly read (100 of 100, from
 * 2026-07-18 to 2026-10-05, checked 2026-10-06), so it is the time the run was CREATED, and the gap to the stamp
 * includes the time the run waited in the data-sync queue. Since #447
 * (2026-10-06) that group uses `queue: max`, so two nightlies can wait at
 * once, and "the newest nightly created by lastRun" can be a second nightly
 * that was created while the producer waited and is still queued or running
 * after it. Taking that one for the producer would excuse the producer's
 * unread DONE line (producerStillRunning) and let a held-and-truncated stall
 * read HELD. So:
 *   1. A COMPLETED nightly that was alive at the stamp (created at or before
 *      it, last updated at or after it) wins over any run that is not
 *      completed. Only one job in the group runs at a time, so a completed
 *      run alive at the stamp was either the producer or a run waiting behind
 *      it (cancelled, or run later). The group takes waiting runs first in,
 *      first out (sync-bills.yml; GitHub adds that ordering is not
 *      guaranteed), so the OLDEST such run is taken. Choosing a completed run
 *      never excuses a missing log: HELD then needs that run's own DONE line,
 *      naming this cursor and showing no other cause, or the row stays FROZEN.
 *   2. Otherwise, the one nightly in progress that was created by the stamp.
 *      A queued, pending or waiting run has not started its job, so it cannot
 *      have written the stamp and is never taken. Two in progress at once is
 *      not a state the group allows; it reads as no producer (FROZEN).
 * Null when nothing matches.
 *
 * @template {{workflowName?: string, status?: string, startedAt?: string,
 *   createdAt?: string, updatedAt?: string}} R
 * @param {R[]} runs
 * @param {string | null | undefined} lastRun
 * @returns {R | null}
 */
export function runThatWroteCursor(runs, lastRun) {
  const stamp = Date.parse(lastRun ?? '');
  if (!Number.isFinite(stamp)) return null;
  const created = (r) => Date.parse(r.startedAt ?? r.createdAt ?? '');
  const byStamp = (runs ?? []).filter((r) => isNightly(r) && created(r) <= stamp);
  const aliveAtStamp = byStamp
    .filter((r) => r.status === 'completed' && Date.parse(r.updatedAt ?? '') >= stamp)
    .sort((a, b) => created(a) - created(b));
  if (aliveAtStamp.length) return aliveAtStamp[0];
  const running = byStamp.filter((r) => r.status === 'in_progress');
  return running.length === 1 ? running[0] : null;
}

/**
 * How long after a nightly is CREATED it may stamp `lastRun` and still be
 * taken for a producer that is still going. The run list's `startedAt` is the
 * creation time (see runThatWroteCursor), so this gap is queue wait plus job
 * setup: 22s to 375s across the 35 nightlies that wrote data/sync-state.json
 * from 2026-09-01 to 2026-10-04 (measured 2026-10-06), while sync-bills.yml notes a run can wait in the data-sync
 * queue for most of an hour. A producer that waited longer than this reads
 * as not running, so its row says FROZEN while it runs: that errs toward the
 * alarm, on purpose, and a wider window would widen the room for a wrong run
 * to excuse a stall.
 */
export const PRODUCER_START_SLACK_MS = 30 * 60_000;

/**
 * Whether the run that wrote the committed cursor is still going, which is
 * the one case where cursorHealth may call a cursor HELD without reading that
 * run's DONE line. True only for a run that was found, is in progress (not
 * completed, and not queued, pending or waiting: a run that has not started
 * its job cannot have written the stamp), and was created within
 * PRODUCER_START_SLACK_MS before `lastRun`: an in-progress run created long
 * before the stamp is a stale run list, not the producer, and false sends the
 * cursor row back to FROZEN.
 *
 * @param {{status?: string, startedAt?: string, createdAt?: string} | null} producer runThatWroteCursor's answer
 * @param {string | null | undefined} lastRun
 */
export function producerStillRunning(producer, lastRun) {
  if (!producer || producer.status !== 'in_progress') return false;
  const stamp = Date.parse(lastRun ?? '');
  const started = Date.parse(producer.startedAt ?? producer.createdAt ?? '');
  if (!Number.isFinite(stamp) || !Number.isFinite(started)) return false;
  return stamp - started >= 0 && stamp - started <= PRODUCER_START_SLACK_MS;
}

/**
 * Which nightly log the night's counters come from, given the nightly logs
 * in the order they were read (newest first, see orderLogTargets): the newest
 * one that carries a DONE line, so a newer run cancelled before its summary
 * does not blank the counters of an older run that finished. When none has a
 * DONE line, the newest log read (its other lines may still parse). Null when
 * no nightly log was read.
 *
 * @template {{done: unknown}} E
 * @param {E[]} reads
 * @returns {E | null}
 */
export function pickNightlyLog(reads) {
  return (reads ?? []).find((e) => e.done !== null && e.done !== undefined) ?? reads?.[0] ?? null;
}

/** Newsdesk is `cron: '7 * * * *'` — 24 scheduled firings in a UTC day. */
export const NEWSDESK_EXPECTED_SLOTS = 24;

/* ------------------------------------------------------------------ *
 * 6 · Spend estimate
 * ------------------------------------------------------------------ */

/**
 * Per-million-token list prices. The Sonnet row was verified against
 * Anthropic's published pricing page on 2026-09-28, when the pipeline moved
 * to Claude Sonnet 5.5 ($2 in / $10 out, the same as Sonnet 5); the Haiku row
 * was last verified on 2026-09-18. They live here rather than being imported
 * because lib/pregen.ts is TypeScript with extensionless relative imports
 * (plain `node` cannot load it — the same constraint scripts/daily-metrics.mjs
 * documents at length), and this script must run under plain `node`.
 *
 * READ THIS BEFORE TRUSTING A DOLLAR FIGURE DOWNSTREAM. lib/pregen.ts's cost
 * comment still carries a $3/$15 "standard pricing" figure from the strategy
 * doc; Anthropic's pricing page says that scheduled rise "will not occur", so
 * pregen's printed range tops out at 1.5x the list price. This file still
 * reports the SCRIPT'S OWN printed estimate as the primary pregen number (so
 * the digest never contradicts the log it is summarising) and marks every
 * figure it derives itself as an estimate.
 */
// The one copy lives in lib/decode-spend.mjs (2026-11-28), where the nightly
// spend ceiling reads it too; re-exported here for the digest and its specs.
export { MODEL_PRICE_PER_MTOK };

/**
 * A DELIBERATELY COARSE day estimate. It exists to answer "did tonight cost
 * pennies or dollars", not to reconcile a bill — the authoritative number is
 * the Anthropic console, and the digest says so in as many words.
 *
 * Inputs it TRUSTS: pregen's own printed range, which the script computes from
 * its real generation count and already carries the Batches API's half price.
 * Inputs it ESTIMATES: the decode calls, the RE-decode calls and the newsdesk
 * t3 call.
 *
 * WHAT IT STILL LEAVES OUT, and why the digest now says so in as many words
 * (2026-09-27): the coverage sync's relevance classifications and the Moments
 * live layer's summary calls. Neither is omitted because it is free — each is
 * bounded by its own nightly cap — but neither prints a call count this
 * function could read without guessing, and an invented number is worse here
 * than a named gap. Until they print one, the total below is a FLOOR on the
 * day, not the day.
 *
 * RE-DECODES were the largest of those gaps and are now counted. They had
 * been missing since the path shipped, and they are not a rounding error: the
 * 2026-09-26 nightly re-decoded 10 bills against 3 added+decoded, so the
 * number the standing issue printed as the day's decode spend was under a
 * third of the decode calls the night actually made. They are priced with the
 * SAME per-decode assumption as a new-bill decode, which is the consistent
 * choice, not a measured one: sync-bills.yml's own `redecode_max_per_night`
 * comment carries a higher figure (~$0.065 against the ~$0.044 this function
 * derives), and that discrepancy is named here rather than resolved silently,
 * exactly as MODEL_PRICE_PER_MTOK's comment does for the pregen price.
 *
 * t3 is priced PER RUN, not per headline: scripts/newsdesk.mjs's
 * resolveWithHaiku sends ONE ordinary `messages.create` (not the Batches API,
 * so no discount) carrying every ambiguous headline in one prompt, capped at
 * `max_tokens: 1024` for the whole reply. Pricing it per headline would
 * multiply one prompt's overhead by its own contents and overstate the day.
 *
 * `assumptions` carries every guessed token shape into the output so a reader
 * can re-derive the number instead of trusting it.
 *
 * LONG BILLS AND THE NIGHTLY LEDGER (2026-11-28, PR #581). `longDecodes` is
 * the night's count of decodes of bills over 60,000 characters, read from the
 * nightly's own ledger line (parseDecodeLedger), priced with the long-decode
 * shape below. When the ledger itself is passed (`ledger`), its list-price
 * total — the run's own estimate of EVERY decode it paid for, new and
 * re-decodes, long and split ones included — replaces the three
 * assumption-based decode figures in the totals: it is computed from the
 * prompts actually sent, which beats any average.
 *
 * @param {{decodes?:number, redecodes?:number, longDecodes?:number, t3Batched?:number, t3Runs?:number,
 *   pregen?:{costLow:number|null, costHigh:number|null}|null,
 *   ledger?:{usd:number, ceilingUsd:number, charged:number, long:number, chunked:number, deferred:number, failureParked:number, overLimit?:number, oneOffUsd?:number}|null}} input
 */
export function estimateDaySpend({
  decodes = 0,
  redecodes = 0,
  longDecodes = 0,
  t3Batched = 0,
  t3Runs = 0,
  pregen = null,
  ledger = null,
} = {}) {
  const sonnet = MODEL_PRICE_PER_MTOK['claude-sonnet-5-5'];
  const haiku = MODEL_PRICE_PER_MTOK['claude-haiku-4-5'];
  // Assumed shapes. Named, not buried: every one of these is a guess about
  // average size, and the only honest thing to do with a guess is print it.
  const assumptions = {
    decodeInputTokens: 12_000,
    decodeOutputTokens: 2_000,
    // Long / multi-division bills (60k–400k cleaned chars): up to ~6.7x input
    // size and up to 1,800 output tokens in round 1 + round 2 synthesis.
    longDecodeInputTokens: 60_000,
    longDecodeOutputTokens: 3_500,
    // Re-measured 2026-09-26 after the t3 prompt started carrying each
    // candidate's latest action, status and floor-record note (#303): an
    // offline run's prompts held ~1,170 characters of fixed instruction and
    // 720-1,300 characters per headline (two 40-headline batches). Converted
    // at an ASSUMED ~3.5 characters per token (not tokenized): ~330 fixed,
    // and ~205 and ~370 per headline for the two batches. The per-headline
    // figure below sits between them; the old 200/150 read low by about half.
    t3PromptOverheadTokens: 350,
    t3TokensPerHeadline: 300,
    t3MaxOutputTokensPerRun: 1024,
    decodeModel: 'claude-sonnet-5-5',
    t3Model: 'claude-haiku-4-5',
  };
  const usdPerDecode =
    (assumptions.decodeInputTokens * sonnet.input + assumptions.decodeOutputTokens * sonnet.output) / 1_000_000;
  const usdPerLongDecode =
    (assumptions.longDecodeInputTokens * sonnet.input + assumptions.longDecodeOutputTokens * sonnet.output) / 1_000_000;
  const decodeUsd = decodes * usdPerDecode;
  const redecodeUsd = redecodes * usdPerDecode;
  const longDecodeUsd = longDecodes * usdPerLongDecode;
  const t3InputTokens = t3Runs * assumptions.t3PromptOverheadTokens + t3Batched * assumptions.t3TokensPerHeadline;
  // The reply is capped per run, so the ceiling is runs × max_tokens.
  const t3OutputTokens = t3Runs * assumptions.t3MaxOutputTokensPerRun;
  const t3Usd = (t3InputTokens * haiku.input + t3OutputTokens * haiku.output) / 1_000_000;
  const pregenLow = pregen?.costLow ?? null;
  const pregenHigh = pregen?.costHigh ?? null;
  const round = (n) => Math.round(n * 1000) / 1000;
  const ledgerUsd = ledger && Number.isFinite(ledger.usd) ? ledger.usd : null;
  // A one-off decode the owner approved is charged apart from the ceiling, but
  // it is still the night's spend.
  const oneOffUsd = ledger && Number.isFinite(ledger.oneOffUsd) ? ledger.oneOffUsd : 0;
  const nightlyDecodeUsd = (ledgerUsd ?? decodeUsd + redecodeUsd + longDecodeUsd) + oneOffUsd;
  return {
    decodeUsd: round(decodeUsd),
    redecodeUsd: round(redecodeUsd),
    longDecodeUsd: round(longDecodeUsd),
    ledger: ledgerUsd === null ? null : { ...ledger, usd: round(ledgerUsd) },
    t3Usd: round(t3Usd),
    pregenUsd: pregenLow === null ? null : { low: pregenLow, high: pregenHigh ?? pregenLow },
    totalLow: round(nightlyDecodeUsd + t3Usd + (pregenLow ?? 0)),
    totalHigh: round(nightlyDecodeUsd + t3Usd + (pregenHigh ?? pregenLow ?? 0)),
    // Named in the shape, not only in the prose above, so a reader of the JSON
    // sees the gap without reading this file.
    excludes: [
      'coverage relevance classifications',
      'Moments live-layer summary calls',
      // The newsdesk's decodes were never in this estimate; since PR #581 it
      // may not decode a bill over 60,000 characters (lib/decode-spend.mjs
      // NEWSDESK_MAX_BILL_TEXT_CHARS), so 30 a day stay near $3 at list price.
      'newsdesk decodes and re-decodes',
    ],
    assumptions,
    labelled: 'estimate',
  };
}

/* ------------------------------------------------------------------ *
 * 7 · Alarms
 * ------------------------------------------------------------------ */

/**
 * The ⛔ set. These, and only these, earn a dated comment on the standing
 * issue — everything else is a body rewrite the owner reads when he chooses
 * to. The line between them is whether a human has to DO something today.
 *
 * Deliberately NOT alarms: portrait 404s (upstream photos that have never
 * existed), upstash cache failures (the cache fails open by design), coverage
 * staleness (a known, owner-acknowledged state, tracked as a number).
 *
 * @param {object} report
 * @returns {{code:string, text:string}[]}
 */
export function alarms(report) {
  const out = [];
  const nightly = report?.nightly;
  if (!nightly) {
    out.push({ code: 'nightly-missing', text: 'no recent nightly bill sync run — nothing has synced the corpus' });
  } else if (nightly.running) {
    // A run still in flight has no verdict. Alarming on it would fire every
    // time the report and the nightly overlapped, which is a scheduling
    // coincidence rather than a fault.
  } else if (nightly.conclusion && nightly.conclusion !== 'success') {
    out.push({
      code: 'nightly-not-success',
      text: `the nightly bill sync ended \`${nightly.conclusion}\`${nightly.url ? ` — ${nightly.url}` : ''}`,
    });
  }
  // A bill parked after repeated billed decode failures (lib/decode-failures.mjs)
  // has no decode and will get none until its text changes: a person decides.
  const parkedFailures = report?.spend?.ledger?.failureParked ?? 0;
  if (parkedFailures > 0) {
    out.push({
      code: 'decode-failure-parked',
      text: `${parkedFailures} bill(s) parked after repeated billed decode failures — not retried until Congress publishes new text or the slug is forced; the nightly log names them (DECODE PARKED AFTER REPEATED FAILURES)`,
    });
  }
  // A bill whose ONE decode is estimated over the single-decode limit
  // (lib/decode-spend.mjs MAX_SINGLE_DECODE_USD) is never run by the nightly:
  // it waits for a one-off dispatch at an amount the owner approves.
  const overLimit = report?.spend?.ledger?.overLimit ?? 0;
  if (overLimit > 0) {
    out.push({
      code: 'decode-over-limit',
      text: `${overLimit} bill(s) whose one decode is estimated over the nightly single-decode limit — not decoded until the owner approves a one-off amount (sync-bills.yml one_off_decode_slug and one_off_decode_max_usd); the nightly log names them (DECODE OVER THE WHOLE NIGHTLY CEILING)`,
    });
  }
  const credit = report?.anthropic?.creditBalance ?? 0;
  if (credit > 0) {
    out.push({
      code: 'anthropic-credit',
      text: `${credit} call(s) rejected for a low credit balance — the paid paths are dark until the console is topped up`,
    });
  }
  const t3 = report?.newsdesk?.t3;
  if (t3 && t3.batched > 0 && t3.resolved === 0) {
    out.push({
      code: 't3-zero',
      text: `newsdesk t3 resolved 0 of ${t3.batched} batched headlines — the outlet matcher returned nothing all day`,
    });
  }
  const ci = report?.ci;
  if (ci && typeof ci.redForHours === 'number' && ci.redForHours > 24) {
    out.push({
      code: 'ci-red-24h',
      text: `CI on main has been red for ${Math.round(ci.redForHours)}h (${ci.consecutiveRed} consecutive run(s))`,
    });
  }
  if (report?.cursor?.frozen) {
    out.push({
      code: 'cursor-frozen',
      text: `the corpus cursor did not move on the last sync and is ${Math.round(
        report.cursor.lastSyncAgeDays
      )}d behind while the pipeline kept running — the backlog scan is not making progress`,
    });
  } else if (report?.cursor?.movementUnknown) {
    out.push({
      code: 'cursor-movement-unknown',
      text: `the corpus cursor is ${Math.round(
        report.cursor.lastSyncAgeDays
      )}d behind and whether it moved could not be checked (no previous data/sync-state.json in this checkout) — treat as unverified, not as progress`,
    });
  }
  if (report?.floorSignals?.pastAlarm) {
    out.push({
      code: 'floor-signals-stale',
      text: `data/floor-signals.json was last stamped or reconfirmed ${Math.round(report.floorSignals.ageHours)}h ago, past the ${report.floorSignals.alarmHours}h alarm`,
    });
  }
  // Nonpartisan by construction: the coverage sync's 30-day date-sorted pass
  // was shipped unmeasured (measuring it needed a keyed call), so its lean is
  // measured every night and a shift is a human's call, today.
  if (report?.coverageLean?.verdict === 'drift') {
    out.push({
      code: 'coverage-lean-drift',
      text: `the nightly coverage sync's ${report.coverageLean.windowDays}-day date-sorted pass kept a different outlet mix than the whole-life pass on the same bills (${report.coverageLean.detail}) — review before keeping the date sort`,
    });
  }
  const run = report?.coverageRun;
  if (run && typeof run.keptTonight === 'number' && run.keptTonight === 0 && run.checked >= COVERAGE_KEPT_ZERO_MIN_CHECKED) {
    const dropped = run.droppedOnVerdict ? `, minus ${run.droppedOnVerdict} article(s) dropped on the gate's verdict` : '';
    out.push({
      code: 'coverage-kept-zero',
      text: `the nightly coverage sync set out to check ${run.checked} bills and kept no article on any of them — the news source or the relevance gate is not working (stored coverage was carried over${dropped})`,
    });
  }
  // A night whose gate re-judged stored articles and threw out half or more of
  // them. Each was kept by an earlier gate, and a drop is not undone unless a
  // later search happens to return the article again. So a mass drop needs a
  // person to look before a second night repeats it. Thresholds:
  // COVERAGE_MASS_DROP.
  if (
    run &&
    typeof run.droppedOnVerdict === 'number' &&
    typeof run.rejudged === 'number' &&
    run.rejudged > 0 &&
    run.droppedOnVerdict >= COVERAGE_MASS_DROP.minDropped &&
    run.droppedOnVerdict / run.rejudged >= COVERAGE_MASS_DROP.minShare
  ) {
    out.push({
      code: 'coverage-mass-drop',
      text: `the nightly coverage sync dropped ${run.droppedOnVerdict} of the ${run.rejudged} stored articles its relevance gate re-judged (${Math.round(
        (100 * run.droppedOnVerdict) / run.rejudged
      )}%), each one kept by an earlier gate — check the gate's prompt and replies before another night drops more (the previous data/coverage.json in git history has them)`,
    });
  }
  // TheNewsAPI answered nothing: the script kept the file as it was and exited
  // before its DONE line, which is why coverage-kept-zero cannot see this case.
  const outage = report?.coverageOutage;
  if (outage) {
    out.push({
      code: 'coverage-outage',
      text: `the nightly coverage sync got no TheNewsAPI response for any of its ${outage.planned} planned bills (${outage.failed} failed${
        outage.quotaStopped ? '; the daily quota stopped the run' : ''
      }) — no bill was checked and data/coverage.json was left as it was; the FAIL lines in the nightly log say why`,
    });
  }
  // The short-titles summary line's four checks (lib/short-titles-summary.mjs):
  // a missing line, titled bills falling over a week, bills losing every title
  // tonight, no read for more than 3 days. Only when a finished nightly's log was read;
  // "summary missing" only when that log shows the step started or its history already
  // holds a night (round 6: never on a nightly that ran before the step existed).
  if (report?.shortTitlesSummaryChecked) {
    out.push(
      ...shortTitlesAlarms(report.shortTitlesSummary ?? null, {
        checked: true,
        expected: report.shortTitlesSummaryExpected === true,
      }),
    );
  }
  // The short-titles step's TROUBLE lines (the name addresses' nightly read).
  const shortTitles = report?.shortTitlesTrouble;
  if (shortTitles) {
    out.push({
      code: shortTitles.sourceChanged ? 'short-titles-source-changed' : 'short-titles-stopped',
      text: shortTitles.sourceChanged
        ? `the short-titles read refused most of Congress.gov's answers for one reason, so the source has likely changed shape and needs a person: ${shortTitles.text}. ${SHORT_TITLES_RUNBOOK}, section "Short titles: when the nightly read reports trouble"`
        : `the short-titles read reported trouble (a stop, a refused file or bills piling up in its retry file): ${shortTitles.text}. ${SHORT_TITLES_RUNBOOK}, section "Short titles: when the nightly read reports trouble"`,
    });
  }
  // A dead press feed needs a human to find a replacement (and check its
  // robots.txt and terms) — it will not heal on its own, which is what makes it
  // a ⛔ rather than a number. The Washington Times feed returned 403 to every
  // runner for six weeks with no alarm anywhere; this is the line that would
  // have said so.
  const press = report?.pressFeeds;
  if (press?.darkFeeds?.length) {
    out.push({
      code: 'press-feed-dark',
      text: `${press.darkFeeds.length} newsdesk press feed(s) dark past the ${FEED_DARK_ALARM_DAYS}-day alarm: ${formatDarkFeeds(
        press.darkFeeds
      )} — the basket is narrower than its construction claims; fix or replace in scripts/newsdesk.mjs's SOURCES`,
    });
  }
  if (press?.darkLeans?.length) {
    out.push({
      code: 'press-lean-dark',
      text: `no newsdesk feed of the ${press.darkLeans.map((l) => `${l.lean}-rated (${n(l.darkDays, 'd')})`).join(', ')} lean has produced an item past the lean alarm — cross-spectrum corroboration is skewed until it is fixed`,
    });
  }
  // The Big Question press collector (GDELT, question-press.yml) exits 0 on
  // every GDELT outcome by design, so its green conclusion in the side-workflow
  // row says nothing about whether it recorded anything. This reads the
  // committed file's newest check instead (lib/question-press.mjs
  // questionPressActivity) — trustworthy because only a recorded check ever
  // moves a `checkedOn` (a run that records nothing writes nothing, except a
  // repair write after a moments/bias change, which moves none). It will not
  // heal while GDELT keeps refusing, and a
  // refusal's reason is only in the runs' ::warning:: lines, which is what
  // makes it a ⛔ rather than a number.
  const qp = report?.questionPress;
  if (qp?.silent) {
    const why =
      'its runs stay green on every GDELT outcome, so the reason is in their ::warning:: lines (429s, refused searches, an open circuit)';
    out.push({
      code: 'question-press-silent',
      text: qp.lastChecked
        ? `the Big Question press collector (GDELT) has recorded no check since ${qp.lastChecked} — ${qp.silentDays}d, past the ${qp.alarmDays}-day alarm; ${why}`
        : `the Big Question press collector (GDELT) has been running for ${Math.floor(
            qp.runningDays
          )}d and has never recorded a check (no data/question-press.json yet), past the ${qp.alarmDays}-day alarm; ${why}`,
    });
  }
  // A "Where it stands" summary refused run after run stays stale, and
  // nothing retries it on purpose (each refusal already spent a model call).
  // The collector prints a ::warning:: on each such run; this is the line a
  // person reads the next morning. Threshold: SUMMARY_REFUSAL_ALARM_RUNS.
  // The nightly record re-check (2026-11-14). Its step is continue-on-error,
  // so the nightly run shows green and a refusal or a throw would otherwise
  // be one annotation nobody opens. A refusal repeats every night until a
  // person accepts the rows or they age out; a held row stays hidden until a
  // decode passes. Each says where to look.
  const rc = report?.recheck;
  if (rc?.refused) {
    out.push({
      code: 'record-recheck-refused',
      text: `the nightly record re-check refused to change stored timeline lines and changed nothing: ${rc.refused}. The held-back rows are named in the nightly's "Collect Moment updates" step summary; docs/runbooks/record-recheck.md says how to accept them for one night`,
    });
  }
  if (rc?.failed) {
    out.push({
      code: 'record-recheck-failed',
      text: 'the nightly record re-check threw and changed nothing (the rest of the night was written); the stack is in the nightly\'s "Collect Moment updates" step log',
    });
  }
  if (rc?.acceptMalformed) {
    out.push({
      code: 'record-recheck-accept-malformed',
      text: 'data/record-recheck-accept.json is malformed, so the record re-check accepted nothing tonight; CI\'s check-moment-updates names what is wrong',
    });
  }
  // One night with nothing checked is an error line in the collector's log;
  // the alarm waits for a second night running (a flaky Congress.gov night
  // pages nobody, a dead comparison is raised by the second morning).
  const f = rc?.findings;
  // Only the record's words, and the stored row's own words, are ever put
  // inside quotation marks here (rule 6; these comments are public).
  // Each quoted text is escaped for GitHub (quoteWords), and a line quotes at
  // most RECHECK_SENTENCES_PER_LINE of the record's sentences, the nearest to
  // the stored words; the report file keeps them all.
  const q = (t) => quoteWords(t, { md: true });
  const lineOf = (r) =>
    `${r.key} on /questions/${r.key.split('/')[0]} (${r.day}): stored ${q(r.stored)}; ${renderRecord(r.note, r.record, { md: true, max: RECHECK_SENTENCES_PER_LINE, near: r.stored })}`;
  if (f?.malformed) {
    out.push({
      code: 'record-recheck-report-malformed',
      text: `data/record-recheck-report.json is malformed, so the record re-check's findings cannot be read (${f.malformed.slice(0, 3).join('; ')}); verify-sync refuses such a file before a commit, so look at how it was written`,
    });
  }
  if (f?.zeroCheckedDue) {
    out.push({
      code: 'record-recheck-silent',
      text: `the nightly record re-check has checked no stored line for ${f.zeroCheckedNights} nights running although there are lines to check: every Congress.gov list it asked for failed or was rejected, so stored lines are not being compared with the record at all. The reasons are in data/record-recheck-report.json under unchecked, and in the nightly's Collect Moment updates step log (this repeats weekly while it lasts; the issue body counts it daily)`,
    });
  }
  const uncheckedDue = (f?.unchecked ?? []).filter((u) => u.due);
  if (uncheckedDue.length > 0) {
    out.push({
      code: 'record-recheck-unchecked',
      head: `Bills not checked against the record for ${RECHECK_UNCHECKED_ALARM_NIGHTS}+ nights running (${uncheckedDue.length}): `,
      lines: uncheckedDue.map((u) => `${u.slug} (since ${u.since}, ${u.nights} nights: ${u.why}; ${u.rows?.length ?? 0} stored line(s) unchecked${u.rows?.length ? `: ${u.rows.join(', ')}` : ''})`),
      sep: '; ',
      tail: ' (repeats weekly while it lasts; the issue body counts it daily)',
    });
  }
  // Newly found lines, one heading per kind, each named once.
  const HEADINGS = {
    'would-correct': ['record-recheck-differs', 'Stored lines the official record now words differently; the page still shows the stored words, and the re-check (report only) would correct them'],
    'would-withdraw': ['record-recheck-gone', 'Stored lines the official record no longer holds; the page still shows them, and the re-check (report only) would withdraw them'],
    'would-hold': ['record-recheck-would-hold', "Stored lines whose new record words the update lint refuses; the re-check (report only) would hide them until a plain line passes"],
    'would-reinstate': ['record-recheck-back', 'Withdrawn lines the official record holds again'],
    left: ['record-recheck-left', 'Stored lines that could not be confirmed against the record, left for a person (each with the reason)'],
  };
  for (const [verdict, [code, heading]] of Object.entries(HEADINGS)) {
    const these = (f?.newRows ?? []).filter((r) => r.verdict === verdict);
    if (!these.length) continue;
    out.push({
      code,
      head: `${heading} (${these.length}): `,
      lines: these.map((r) => `${lineOf(r)}${verdict === 'left' ? `; reason: ${r.why}` : ''}`),
      tail: '. docs/runbooks/record-recheck.md says how to correct one by hand',
    });
  }
  if (f?.weeklyReminder) {
    out.push({
      code: 'record-recheck-open',
      text: `Weekly reminder: ${f.openRows.length} stored timeline line(s) still differ from the official record or are left for a person (the oldest first found ${f.oldestOpen}); each was named once the morning after it was found, and all are listed in data/record-recheck-report.json. docs/runbooks/record-recheck.md says how to correct one by hand`,
    });
  }
  const newerDue = (f?.newer ?? []).filter((u) => u.due);
  if (newerDue.length > 0) {
    out.push({
      code: 'record-recheck-newer',
      head: `Stored lines dated after the newest action on their bill's Congress.gov list, ${RECHECK_UNCHECKED_ALARM_NIGHTS}+ nights running, so the record may have deleted them (${newerDue.length}): `,
      lines: newerDue.map((u) => `${u.key} on /questions/${u.key.split('/')[0]} (${u.day}; the list's newest action is dated ${u.newest}): stored ${q(u.stored)}`),
      tail: ' (repeats weekly while it lasts)',
    });
  }
  const suspectDue = (f?.suspect ?? []).filter((b) => b.due);
  if (suspectDue.length > 0 && !rc?.refused) {
    out.push({
      code: 'record-recheck-source-suspect',
      head: `A source that looked wrong (${suspectDue.length} bill(s)); none of its lines is reported as differing, and every other bill's findings stand: `,
      // One entry per unconfirmed line; a bill's first entry also carries
      // the bill and why its source looked wrong.
      lines: suspectDue.flatMap((b) => {
        const intro = `${b.slug}${b.nights > 1 ? ` (${b.nights} nights running)` : ''}: ${b.why}.${b.gained.length && b.nights > 1 ? ` ${b.gained.length} line(s) newly unconfirmed.` : ''} Unconfirmed lines, because the source looked wrong (a person may still look): `;
        const these = b.lines.map((r) => `${lineOf(r)} (${r.verdict})`);
        return these.length ? [intro + these[0], ...these.slice(1)] : [intro.trimEnd()];
      }),
      tail: ' (repeats weekly while it lasts, and whenever a line is added; the issue body counts it daily)',
    });
  }
  if (Array.isArray(rc?.held) && rc.held.length > 0) {
    out.push({
      code: 'record-recheck-held',
      head: `${rc.held.length} timeline line(s) are HELD by the record re-check (hidden: the record's new words fail the update lint and no decode has passed yet): `,
      lines: rc.held.map((h) => `${h.momentId}/${h.id} since ${h.since} (${q(h.words)})`),
      sep: '; ',
      tail: ' — docs/runbooks/record-recheck.md, section Held rows',
      where: 'data/moment-updates.json',
    });
  }

  const refused = report?.summaryRefusals;
  if (Array.isArray(refused) && refused.length > 0) {
    out.push({
      code: 'summary-refused',
      text: `${refused.length} Big Question "Where it stands" summar${refused.length === 1 ? 'y was' : 'ies were'} refused on ${SUMMARY_REFUSAL_ALARM_RUNS} or more runs in a row, so the previous one stands: ${refused
        .map((r) => `${r.id} (${r.count} in a row, newest ${r.day} ET: ${r.reason})`)
        .join('; ')} — data/moment-updates.json summary_refusals`,
    });
  }
  // A hand-corrected decode whose bill now has newer text. The pipeline kept
  // the correction and did not re-decode; only a person can say whether it
  // still holds (scripts/decode-locks.mjs).
  const staleLocks = report?.decodeLockStale ?? [];
  if (staleLocks.length) {
    out.push({
      code: 'decode-lock-stale',
      text: `${staleLocks.length} hand-corrected decode(s) now sit beside newer bill text and were NOT re-decoded: ${staleLocks
        .map((l) => l.slug)
        .join(', ')}. Re-read the new text against the corrected decode, then delete the lock (the next nightly re-decodes) or update its version fields in data/decode-locks.json`,
    });
  }
  // The nightly identical-bills step: a STOPPED line or a crash in the night's
  // log, and its file not filled for more than 3 days (lib/related-bills.mjs).
  out.push(...relatedAlarms(report?.related));
  return boundRecheckLines(out);
}

/**
 * GitHub refuses a comment (or an issue body) over 65,536 characters, and the
 * same alarm texts go into the dated comment, the issue body and the daily
 * digest. HEALTH_COMMENT_MAX_BYTES caps the dated comment; it counts UTF-8
 * bytes, which are never fewer than characters however GitHub counts them,
 * and leaves 15,536 of headroom. The record re-check's alarms, the only ones
 * that grow with the data, share RECHECK_SECTION_MAX_BYTES, so the rest of
 * the day's alarms always have 20,000 bytes beside them.
 */
export const HEALTH_COMMENT_MAX_BYTES = 50_000;
export const RECHECK_SECTION_MAX_BYTES = 30_000;
const utf8 = new TextEncoder();
const byteLength = (s) => utf8.encode(String(s ?? '')).length;

/**
 * Turn each listed alarm ({ head, lines, tail }) into its text within the
 * re-check's shared byte budget: whole lines in order while they fit, then,
 * outside any quotation, how many more lines there are and where every one
 * is. A line is never cut, so no quotation is ever cut.
 * @param {Array<Record<string, any>>} list
 */
function boundRecheckLines(list) {
  let budget = RECHECK_SECTION_MAX_BYTES;
  return list.map((a) => {
    if (!Array.isArray(a.lines)) return a;
    const { head, lines, sep = ' · ', tail = '', where = 'data/record-recheck-report.json', ...rest } = a;
    const moreNote = (n) => `and ${n} more line(s) not listed here, to keep this comment within GitHub's size limit; every one is in ${where}`;
    let used = byteLength(head) + byteLength(tail) + byteLength(moreNote(lines.length)) + byteLength(sep);
    const shown = [];
    for (const l of lines) {
      const b = byteLength(l) + byteLength(sep);
      if (used + b > budget) continue; // a long line is left out; shorter ones after it may still fit
      shown.push(l);
      used += b;
    }
    const more = lines.length - shown.length;
    const text = `${head}${[...shown, ...(more ? [moreNote(more)] : [])].join(sep)}${tail}`;
    budget = Math.max(0, budget - byteLength(text));
    // The issue body and the daily digest carry only the heading and the
    // count, with where every line is: the listing belongs in the comment.
    const short = `${head.replace(/:\s*$/, '')}; every one is listed in ${where}`;
    return { ...rest, text, short, listed: shown.length, unlisted: more };
  });
}

/**
 * Big Questions whose "Where it stands" summary was refused on
 * SUMMARY_REFUSAL_ALARM_RUNS or more model replies in a row, read from the
 * committed data/moment-updates.json (`summary_refusals`, which
 * scripts/moment-updates.mjs writes and clears; see
 * lib/moment-updates-gate.mjs). Only the ids in `liveIds` when it is given, so
 * a retired question's last counter does not alarm forever. Newest count
 * first. null when the file was not read — never an invented empty list.
 * @param {Record<string, any> | null} updatesFile
 * @param {{ liveIds?: Iterable<string> | null }} [opts]
 * @returns {{ id: string, count: number, day: string, reason: string }[] | null}
 */
export function refusedSummaries(updatesFile, { liveIds = null } = {}) {
  if (!updatesFile || typeof updatesFile !== 'object' || Array.isArray(updatesFile)) return null;
  const live = liveIds ? new Set(liveIds) : null;
  const out = [];
  for (const [id, entry] of Object.entries(updatesFile)) {
    if (id === '_meta' || (live && !live.has(id))) continue;
    const f = entry?.summary_refusals;
    if (!f || !Number.isInteger(f.count) || f.count < SUMMARY_REFUSAL_ALARM_RUNS) continue;
    out.push({ id, count: f.count, day: String(f.day ?? ''), reason: String(f.reason ?? '') });
  }
  return out.sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The `question press` table row: when the collector last recorded a check,
 *  how many searchable live questions the file holds, and how many of them
 *  have not been checked inside the alarm window. */
function formatQuestionPress(qp) {
  if (!qp) return 'not read';
  if (qp.nothingToSearch) return 'no live question has search terms — nothing to record';
  const total = qp.searchable ?? '?';
  const lagging = qp.lagging?.length ? ` · ${qp.lagging.length} not checked in ${qp.alarmDays}d+` : '';
  if (!qp.lastChecked) {
    return `no check recorded yet${
      typeof qp.runningDays === 'number' ? ` (collector runs seen for ${Math.floor(qp.runningDays)}d)` : ''
    } · 0/${total} questions on record`;
  }
  return `last check ${qp.lastChecked} (${n(qp.silentDays, 'd')} ago) · ${qp.onRecord}/${total} questions on record${lagging}`;
}

/** `name (domain, lean) Nd` per dark feed, capped so the ⛔ line and the table
 *  row stay one readable line. */
function formatDarkFeeds(list) {
  const shown = list
    .slice(0, 4)
    .map((f) => `${f.name} (${[f.domain ?? 'aggregator', f.lean].filter(Boolean).join(', ')}) ${n(f.darkDays, 'd')}`);
  return `${shown.join('; ')}${list.length > 4 ? `; +${list.length - 4} more` : ''}`;
}

/** The `press feeds` table row. Three honest states: no status block at all
 *  ("not found"), a file written before the per-feed alarm existed ("not
 *  tracked yet"), or the count. */
function formatPressFeeds(press) {
  if (!press) return 'not found';
  if (press.tracked === null) return 'not tracked yet (data/conversation.json predates the per-feed alarm)';
  const dark = press.darkFeeds?.length ?? 0;
  const head = `${press.tracked - dark}/${press.tracked} live`;
  const feeds = dark ? ` · DARK: ${formatDarkFeeds(press.darkFeeds)}` : '';
  const leans = press.darkLeans?.length ? ` · lean DARK: ${press.darkLeans.map((l) => l.lean).join(', ')}` : '';
  return `${head}${feeds}${leans}`;
}

/* ------------------------------------------------------------------ *
 * 8 · Rendering
 * ------------------------------------------------------------------ */

const n = (v, suffix = '') => (v === null || v === undefined ? 'not found' : `${v}${suffix}`);
const signed = (v) => (v === null || v === undefined ? 'not found' : v > 0 ? `+${v}` : `${v}`);
const fixed = (v, d, suffix = '') => (typeof v === 'number' ? `${v.toFixed(d)}${suffix}` : 'not found');

/** One aligned `label  value` line inside the fenced block. */
function row(label, value) {
  return `${label.padEnd(20)}${value}`;
}

/**
 * A REFUSAL IS NOT A BLANK. When pregen aborted it printed none of its three
 * counter lines, so rendering them would be four "not found"s — indistinguishable
 * from the disabled night this row reads identically on. The reason it gave is
 * then the entire reading, and it takes the row.
 *
 * Capped because the reason is a sentence written for a run log, not a table
 * cell, and a row that wraps costs the fenced block its alignment.
 */
function formatPregen(pregen, cacheWriteFailures) {
  const reason = pregen?.abortReason;
  if (reason) return `FAILED — ${reason.length > 150 ? `${reason.slice(0, 149)}…` : reason}`;
  return `${n(pregen?.alreadyCached)} already cached · ${n(pregen?.cached)} written · ${n(
    pregen?.failed
  )} failed · ${n(cacheWriteFailures)} cache-write failures`;
}

/**
 * The members still without a photo come first, read from the committed
 * file; the night's 404 lines come second, because since #402 they count only
 * the members re-asked that night, and "0 source 404(s)" alone read as "every
 * member has a portrait" while 15 did not.
 */
function formatPortraits(missing, log404s) {
  const head = missing
    ? `${missing.members} member(s) with no photo upstream${
        missing.notServing ? ` (${missing.notServing} no longer serving)` : ''
      } (data/portrait-missing.json${missing.recheckDays ? `; re-asked every ${missing.recheckDays}d` : ''})`
    : 'members with no photo upstream: not found';
  return `${head} · ${n(log404s)} source 404(s) in the nightly log`;
}

function formatOtherWorkflows(workflows) {
  const entries = Object.entries(workflows ?? {});
  if (!entries.length) return 'none in 24h';
  return entries.map(([name, w]) => `${name} ${w?.conclusion ?? 'unknown'}`).join(' · ');
}

/**
 * The one word the cursor row is allowed to end on. A cursor that is behind
 * but advancing gets BEHIND (advancing) rather than FROZEN, because the two
 * send the owner to do opposite things: wait, or go unstick a scan. A cursor
 * HELD for one sync by a parked decode batch (cursorHealth) says so, and says
 * when the run's own log could not be checked. Nothing at all when the
 * cursor is keeping up.
 */
function cursorWord(cursor) {
  if (!cursor?.behind) return '';
  if (cursor.frozen) return ' · FROZEN';
  if (cursor.held) {
    return ` · BEHIND (held for ${cursor.parkedDecodes} parked decode(s); moved on the sync before${
      cursor.heldCheckedAgainstLog ? '' : '; its run is still going, other causes unchecked'
    })`;
  }
  if (cursor.movementUnknown) return ' · BEHIND (movement unverified)';
  return ' · BEHIND (advancing)';
}

/**
 * Zero errors is one word. Any errors at all get the per-workflow breakdown
 * inline, because "which job is burning the key" is the first question the
 * number raises and it should not need a second lookup to answer.
 */
function formatAnthropicErrors(anthropic) {
  const credit = anthropic?.creditBalance ?? 0;
  const other = anthropic?.invalidRequestOther ?? 0;
  const head = `${credit} credit · ${other} other invalid_request`;
  const by = Object.entries(anthropic?.byWorkflow ?? {});
  if (!by.length) return head;
  return `${head} — ${by
    .map(([name, v]) => `${name}: ${v.creditBalance}c/${v.invalidRequestOther}o`)
    .join(' · ')}`;
}

/** What the coverage run found TONIGHT, apart from what it carried over. */
function formatCoverageRun(run, outage) {
  if (!run && outage) {
    return `OUTAGE — 0 of ${outage.planned} planned bills got a TheNewsAPI response (${outage.failed} failed${
      outage.quotaStopped ? '; quota stop' : ''
    }) · data/coverage.json unchanged`;
  }
  if (!run) return 'not found in the log';
  const tonight =
    typeof run.keptTonight === 'number'
      ? `kept tonight ${run.keptTonight} on ${run.billsKeptTonight} bill(s) · ${n(run.droppedOnVerdict)} of ${n(
          run.rejudged
        )} re-judged stored dropped on the gate's verdict · ${n(run.unansweredGates)} gate replies not complete and well-formed`
      : 'kept tonight not in this log (older format)';
  return `${run.checked} planned · ${tonight} · ${run.withCoverage} with coverage after the merge`;
}

/** The date pass's lean, judged against the whole-life pass on the same bills. */
function formatCoverageLean(lean) {
  if (!lean) return 'not found in the log';
  const mix = (m) => `L${m.left}/C${m.center}/R${m.right}/unrated ${m.unrated}`;
  const word = { ok: 'ok', drift: 'DRIFT', thin: 'too few to judge' }[lean.verdict] ?? 'verdict not in this log';
  return `${lean.windowDays}d pass ${mix(lean.recent)} vs whole-life ${mix(lean.wholeLife)} · ${word}`;
}

function formatCandidates(candidates) {
  if (!candidates) return 'not read';
  if (!candidates.length) return 'none open';
  return candidates.map((c) => `#${c.number} (${c.ageDays}d)`).join(', ');
}

function formatSpend(spend) {
  if (!spend) return 'not computed';
  const range =
    spend.totalLow === spend.totalHigh
      ? `~$${spend.totalLow.toFixed(3)}`
      : `~$${spend.totalLow.toFixed(3)}-$${spend.totalHigh.toFixed(3)}`;
  const l = spend.ledger;
  const decodePart = l
    ? `nightly decodes $${l.usd.toFixed(3)} by the run's own list-price ledger, of a $${l.ceilingUsd.toFixed(2)} ceiling: ${l.charged} charged, ${l.long} long (over 60,000 characters), ${l.chunked} split into chunks${l.deferred ? `, ${l.deferred} LEFT FOR THE NEXT NIGHT by the ceiling` : ''}${l.failureParked ? `, ${l.failureParked} PARKED after repeated failures` : ''}${l.overLimit ? `, ${l.overLimit} OVER THE SINGLE-DECODE LIMIT (waiting for a one-off approval)` : ''}${l.oneOffUsd ? `, plus $${Number(l.oneOffUsd).toFixed(3)} on a one-off approved decode` : ''}`
    : `decodes $${spend.decodeUsd.toFixed(3)}, re-decodes $${(spend.redecodeUsd ?? 0).toFixed(3)}${spend.longDecodeUsd ? `, long $${spend.longDecodeUsd.toFixed(3)}` : ''}`;
  return `${range} today (${decodePart}, t3 $${spend.t3Usd.toFixed(3)}, pregen ${
    spend.pregenUsd ? `$${spend.pregenUsd.low}-$${spend.pregenUsd.high}` : 'n/a'
  })`;
}

/**
 * The digest section. Rendered as a fenced block for the same reason
 * lib/traffic-metrics.mjs does: a monospace column survives GitHub's comment
 * rendering, and nothing in here is a link the reader needs to click except
 * the run URLs, which sit outside the fence.
 */
export function formatHealthSection(report) {
  const list = report?.alarms ?? [];
  const nightly = report?.nightly;
  const sync = report?.sync;
  const lines = [
    '🩺 **Pipeline health**',
    '',
    '```',
    row(
      'nightly',
      nightly
        ? `${nightly.conclusion} in ${n(nightly.durationMin, 'm')}${
            typeof nightly.ageHours === 'number' ? ` (${nightly.ageHours.toFixed(1)}h ago)` : ''
          }`
        : 'no recent run'
    ),
    row(
      'sync counters',
      sync
        ? `${sync.refreshed} refreshed · ${sync.added} added+decoded${
            report?.redecode ? ` · ${report.redecode.redecoded} re-decoded` : ''
          } · ${sync.gated} gated · ${sync.ascendingFailed + sync.recentFailed} failed`
        : 'not found in the log'
    ),
    row('corpus', `${n(report?.corpus?.bills)} bills (${signed(report?.corpus?.delta)} since the previous commit)`),
    row(
      'cursor',
      `lastSync ${fixed(report?.cursor?.lastSyncAgeDays, 1, 'd')} · lastRun ${fixed(
        report?.cursor?.lastRunAgeHours,
        1,
        'h'
      )}${cursorWord(report?.cursor)}`
    ),
    row(
      'coverage',
      `${n(report?.coverage?.bills)} bills (${signed(report?.coverage?.delta)}) · ${n(
        report?.coverage?.sharePct,
        '%'
      )} older than ${COVERAGE_STALE_DAYS}d`
    ),
    row('coverage run', formatCoverageRun(report?.coverageRun, report?.coverageOutage)),
    row('coverage lean', formatCoverageLean(report?.coverageLean)),
    row('anthropic errors', formatAnthropicErrors(report?.anthropic)),
    row(
      'newsdesk',
      `${n(report?.newsdesk?.scheduledRuns)}/${NEWSDESK_EXPECTED_SLOTS} scheduled slots · t3 ${n(
        report?.newsdesk?.t3?.batched
      )} batched, ${n(report?.newsdesk?.t3?.resolved)} resolved`
    ),
    row(
      'floor signals',
      `stamped ${fixed(report?.floorSignals?.ageHours, 1, 'h')} ago (alarm ${n(
        report?.floorSignals?.alarmHours,
        'h'
      )}, site ceiling ${n(report?.floorSignals?.staleHours, 'h')})`
    ),
    row('other workflows', formatOtherWorkflows(report?.workflows)),
    row(
      'CI on main',
      `${n(report?.ci?.latest)}${report?.ci?.consecutiveRed ? ` · ${report.ci.consecutiveRed} consecutive red` : ''}${
        report?.ci?.failing?.length ? ` · ${report.ci.failing.join(', ')}` : ''
      }`
    ),
    row('pregen', formatPregen(report?.pregen, report?.upstashCacheFailures)),
    row('portraits', formatPortraits(report?.portraitsMissing, report?.portrait404s)),
    row('conversation', `${n(report?.conversation?.dangling?.length)} dangling slug(s)`),
    row('press feeds', formatPressFeeds(report?.pressFeeds)),
    row('question press', formatQuestionPress(report?.questionPress)),
    row('moment candidates', formatCandidates(report?.momentCandidates)),
    row('record re-check', formatRecheck(report?.recheck)),
    row('spend (estimate)', formatSpend(report?.spend)),
  ];
  // Only when it bit: a truncated read must SAY it was truncated, so a number
  // built from 16 of 30 runs is never mistaken for a number built from all 30.
  if (report?.logsSkipped) {
    lines.push(row('logs', `${report.logsRead} read, ${report.logsSkipped} SKIPPED (per-run cap) — counters below are partial`));
  }
  lines.push('```');
  if (list.length) lines.push('', ...list.map((x) => `⛔ ${x.short ?? x.text}`));
  else lines.push('', '✅ No ⛔ conditions.');
  lines.push(
    '',
    '_Spend is an ESTIMATE assembled from call counts and list prices, not a bill — ' +
      'the Anthropic console is the only authoritative figure. It counts the decode, ' +
      're-decode, newsdesk t3 and pre-generation calls, and it does NOT count the coverage ' +
      "sync's relevance classifications or the Moments live layer's summary calls, neither " +
      'of which prints a call count this report can read: treat the number as a floor on ' +
      'the day, not the day. Every reading above comes from run logs, the committed data ' +
      'files and the Actions API; "not found" means the line was absent, never that the ' +
      'number was zero._'
  );
  return lines.join('\n');
}

/** The `record re-check` body row: what is open, every day (the comment carries it once, then weekly). */
function formatRecheck(rc) {
  const f = rc?.findings;
  if (f === null || f === undefined) return 'no report file yet (the nightly comparison has not written one)';
  if (f.malformed) return `report file MALFORMED: ${f.malformed[0]}`;
  const parts = [`${f.newRows.length + f.openRows.length} line(s) open${f.oldestOpen ? ` (oldest first found ${f.oldestOpen})` : ''}`];
  if (f.newer.length) parts.push(`${f.newer.length} newer than their list 3+ nights`);
  if (f.unchecked.length) parts.push(`${f.unchecked.length} bill(s) not checked 3+ nights`);
  if (f.zeroCheckedNights) parts.push(`nothing checked ${f.zeroCheckedNights} night(s)`);
  if (f.suspect.length) parts.push(`${f.suspect.length} bill(s) whose source looked wrong (${f.suspect.reduce((n, b) => n + b.lines.length, 0)} line(s) unconfirmed)`);
  return parts.join(' · ');
}

export const HEALTH_ISSUE_TITLE = '🩺 Pipeline health';
export const HEALTH_ISSUE_LABEL = 'pipeline-health';

/**
 * The standing issue's body — rewritten every day, never appended to. Same
 * shape rule the traffic-decline issue follows: a STATE gets one issue whose
 * body is current, not a pile of dated issues nobody reads.
 *
 * `namedThrough`: the record re-check's marker (namedThroughFromBody), which
 * daily-metrics writes forward and advances only after the comment posts.
 * `leftOutSince`: the first day the re-check's section was left out of the
 * comment and is still being left out (leftOutSinceFromBody).
 * The body is the ONLY place these markers are read from: only the workflow,
 * the issue's author and the repository's collaborators can edit it. Never a
 * comment, which anyone can write on a public repository.
 * @param {Record<string, any>} report
 * @param {{ namedThrough?: string|null, leftOutSince?: string|null }} [opts]
 */
export function formatHealthIssueBody(report, { namedThrough = null, leftOutSince = null } = {}) {
  return [
    `_Rewritten every run. Last update: ${report?.generatedAt ?? 'unknown'} (trailing 24h)._`,
    ...(namedThrough ? [namedThroughMarker(namedThrough)] : []),
    ...(leftOutSince ? [`<!-- recheck-left-out-since: ${leftOutSince} -->`] : []),
    '',
    formatHealthSection(report),
    '',
    '---',
    '',
    '**What this is.** A read-only report. Nothing here gates a build, blocks a commit ' +
      'or closes an issue — the gates live in `scripts/verify-sync.mjs` (pre-commit), ' +
      '`scripts/check-cursor-age.mjs` (post-commit) and `.github/workflows/ci.yml`. ' +
      'Built by `scripts/pipeline-health.mjs`, posted by the daily metrics job.',
    '',
    '**A dated comment appears below only when a ⛔ condition holds** — the Big Question ' +
      `press collector (GDELT) recorded no check for ${QUESTION_PRESS_SILENT_DAYS} days, the nightly did ` +
      'not succeed, an Anthropic call was refused for credit, newsdesk t3 resolved none of ' +
      'what it batched, CI on main has been red over 24h, the cursor stopped moving while ' +
      'the pipeline kept running (one sync held only by decodes parked in a slow batch, ' +
      'after a sync that moved it, does not count), the floor-signals stamp passed its alarm, a newsdesk ' +
      'press feed (or every feed of one lean) went dark, the coverage ' +
      "sync's 30-day pass shifted its outlet-lean mix against the whole-life pass, a " +
      'coverage night kept nothing at all, TheNewsAPI answered none of a night\'s requests, ' +
      "or a night's relevance gate dropped half or more of the stored articles it re-judged. " +
      'A quiet day rewrites this body and says nothing else.',
  ].join('\n');
}

/** The dated comment, posted only on an alarm day. */
export function formatHealthAlarmComment({ date, alarms: list, runUrl }) {
  return buildHealthAlarmComment({ date, alarms: list, runUrl }).body;
}

const isRecheckAlarm = (a) => String(a?.code ?? '').startsWith('record-recheck');
/** The first words of the note a comment carries when the re-check's section was left out of it. */
export const RECHECK_LEFT_OUT_NOTE = "The record re-check's section was left out of this comment";

/**
 * The dated comment, and whether it carries the record re-check's section.
 * The re-check's section is left out when `leaveOutRecheck` gives a reason
 * (a post that failed) or when the comment would pass
 * HEALTH_COMMENT_MAX_BYTES with it; `sayLeftOut` (default true) adds the note
 * saying so and why. Every other alarm is always in it: the re-check never
 * holds the rest of the day's alarms back.
 * @param {{ date: string, alarms?: Array<{ code: string, text: string }>, runUrl?: string|null, leaveOutRecheck?: string|null, sayLeftOut?: boolean }} opts
 * @returns {{ body: string, recheckIncluded: boolean, leftOutWhy: string|null, others: number }}
 */
export function buildHealthAlarmComment({ date, alarms: list = [], runUrl = null, leaveOutRecheck = null, sayLeftOut = true }) {
  const hasRecheck = list.some(isRecheckAlarm);
  const others = list.filter((a) => !isRecheckAlarm(a));
  const render = (alarmsShown, note) =>
    [
      `<!-- pipeline-health:${date} -->`,
      `⛔ **Pipeline health — ${date}**`,
      '',
      ...alarmsShown.map((a) => `- ${a.text}`),
      ...(note ? [`- ${note}`] : []),
      '',
      runUrl ? `Full report: this issue's body (rewritten this run). Digest run: ${runUrl}` : "Full report: this issue's body (rewritten this run).",
    ].join('\n');
  if (!leaveOutRecheck) {
    const full = render(list, null);
    if (byteLength(full) <= HEALTH_COMMENT_MAX_BYTES) return { body: full, recheckIncluded: true, leftOutWhy: null, others: others.length };
    leaveOutRecheck = `with it this comment came to ${byteLength(full).toLocaleString('en-US')} bytes, over this report's cap of ${HEALTH_COMMENT_MAX_BYTES.toLocaleString('en-US')} (GitHub refuses a comment over 65,536 characters)`;
  }
  const note =
    hasRecheck && sayLeftOut
      ? `${RECHECK_LEFT_OUT_NOTE}: ${leaveOutRecheck}. Its lines stay due and are named on the next report that can post them; every one is in data/record-recheck-report.json. (While this lasts, this note repeats weekly.)`
      : null;
  return { body: render(others, note), recheckIncluded: !hasRecheck, leftOutWhy: hasRecheck ? leaveOutRecheck : null, others: others.length };
}

/** The day the re-check's section was first left out, from the issue body's `<!-- recheck-left-out-since: DAY -->`. */
export function leftOutSinceFromBody(body) {
  const m = String(body ?? '').match(/<!-- recheck-left-out-since: (\d{4}-\d{2}-\d{2}) -->/);
  return m && Number.isFinite(Date.parse(`${m[1]}T00:00:00Z`)) ? m[1] : null;
}

/**
 * The account the daily-metrics workflow posts as: it runs `gh` with the
 * workflow's GITHUB_TOKEN, whose comments `gh issue view --json comments`
 * reports with author login `github-actions` (REST: `github-actions[bot]`,
 * type Bot, id 41898282). Read 2026-11-14: all 45 dated ⛔ comments on the
 * standing issue #242 are by that account, and no user account has that
 * login (GET /users/github-actions answers 404). A comment by anyone else is
 * ignored: the repository is public, and anyone can comment.
 * WORKFLOW_COMMENT_LOGINS: that spelling, and exactly two others the same
 * account goes by, so a change in how `gh` spells it cannot make a same-day
 * re-run post twice: `app/github-actions` (how `gh` already spells it for
 * issue and pull-request authors) and `github-actions[bot]` (the REST login).
 * No other login counts.
 */
export const WORKFLOW_COMMENT_LOGIN = 'github-actions';
export const WORKFLOW_COMMENT_LOGINS = Object.freeze([WORKFLOW_COMMENT_LOGIN, 'app/github-actions', 'github-actions[bot]']);
/** @param {{ author?: { login?: string } } | null | undefined} c */
export const byWorkflow = (c) => WORKFLOW_COMMENT_LOGINS.includes(String(c?.author?.login ?? ''));
/**
 * The workflow's own comment carrying `marker`, or null (comments by anyone else are ignored).
 * @param {Array<{ body?: string, author?: { login?: string } }> | null | undefined} comments
 * @param {string} marker
 */
export function workflowCommentWith(comments, marker) {
  return (comments ?? []).find((c) => byWorkflow(c) && typeof c?.body === 'string' && c.body.includes(marker)) ?? null;
}
/**
 * The workflow's own last comment, or null (what `gh issue comment --edit-last` edits when run as that account).
 * @param {Array<{ body?: string, author?: { login?: string } }> | null | undefined} comments
 */
export function lastWorkflowComment(comments) {
  return (comments ?? []).filter(byWorkflow).at(-1) ?? null;
}

/**
 * The ONE standing health issue (scripts/daily-metrics.mjs calls this; `gh`
 * and `writeTempFile` are passed in so the sequence can be tested): rewrite
 * the body every run; post one dated comment only on an alarm day.
 *
 * One day convention, the US Eastern day (healthDayOf): the comment's date,
 * its "already posted today" marker and the re-check's named-through marker
 * are all that day, because the re-check's own days (first_seen, the nights)
 * are Eastern days. At the scheduled 13:00 UTC run the two calendars agree;
 * a manual run in the Eastern evening (after midnight UTC) belongs to that
 * Eastern day, so it can never take the next morning's place.
 *
 * The named-through marker (in the issue BODY only) moves only once a comment
 * carrying the re-check's section is posted, or when nothing is due. A post
 * that fails with the section is retried once without it, saying so, so the
 * rest of the day's alarms are never held back by it; before any second post
 * today's comments are read again, so a post GitHub saved despite an error is
 * never doubled. A comment already posted for the day, by the workflow's own
 * account, is never posted again. When the section keeps being left out, the
 * note saying so repeats weekly (the body's recheck-left-out-since marker).
 * @param {Record<string, any>} report
 * @param {{ gh: (args: string[]) => string, repo: string, writeTempFile: (text: string) => string, runUrl?: string|null, log?: (line: string) => void }} io
 * @returns {string|null} the issue's URL, or null when it could not be maintained
 */
export function maintainHealthIssue(report, { gh, repo, writeTempFile, runUrl = null, log = (l) => console.log(l) }) {
  try {
    const raw = gh(['issue', 'list', '--repo', repo, '--state', 'open', '--search', `in:title "${HEALTH_ISSUE_TITLE}"`, '--json', 'number,title,url']).trim();
    const matches = raw ? JSON.parse(raw) : [];
    const existing = matches.find((m) => m.title === HEALTH_ISSUE_TITLE) ?? null;
    const today = healthDayOf(Date.parse(report.generatedAt ?? new Date().toISOString()));
    const carried = report.recheck?.namedThrough ?? null;
    const carriedLeftOut = report.recheck?.leftOutSince ?? null;
    // The body's marker could not be read this morning (recheckMarkersFrom):
    // write no named-through date at all, rather than move a marker unseen.
    const stamp = report.recheck?.unread === true ? null : today;
    const list = report.alarms ?? [];
    const body = (opts) => writeTempFile(formatHealthIssueBody(report, opts));
    const bodyFile = body(list.length ? { namedThrough: carried, leftOutSince: carriedLeftOut } : { namedThrough: stamp });

    let issueNumber;
    let issueUrl;
    if (existing) {
      gh(['issue', 'edit', String(existing.number), '--repo', repo, '--body-file', bodyFile]);
      issueNumber = existing.number;
      issueUrl = existing.url;
      log(`pipeline health: standing issue #${issueNumber} body rewritten`);
    } else {
      issueUrl = gh(['issue', 'create', '--repo', repo, '--title', HEALTH_ISSUE_TITLE, '--label', HEALTH_ISSUE_LABEL, '--body-file', bodyFile]).trim();
      issueNumber = Number.parseInt(issueUrl.split('/').pop() ?? '', 10);
      log(`pipeline health: opened the standing issue ${issueUrl}`);
      // Pinning is best-effort: GitHub allows at most three pinned issues per
      // repo, so a full board must not turn a healthy run red.
      try {
        gh(['issue', 'pin', '--repo', repo, String(issueNumber)]);
      } catch (e) {
        log(`::warning::pipeline health: could not pin the standing issue (${e.message}) — body is still current.`);
      }
    }

    if (!list.length) {
      log('pipeline health: no ⛔ conditions — body refreshed, no comment posted');
      return issueUrl;
    }
    const editBody = (opts, what) => {
      try {
        gh(['issue', 'edit', String(issueNumber), '--repo', repo, '--body-file', body(opts)]);
      } catch (e) {
        log(`::warning::pipeline health: the issue body could not be updated (${e.message}); ${what}`);
      }
    };
    // The re-check's section went out: its lines are named through today.
    const advance = () => editBody({ namedThrough: stamp }, "the named-through marker stays where it was, so the next report names today's lines again");
    // Today's dated comment, by the workflow's own account only (byWorkflow).
    const marker = `<!-- pipeline-health:${today} -->`;
    const todays = () => {
      const viewed = Number.isFinite(issueNumber) ? gh(['issue', 'view', String(issueNumber), '--repo', repo, '--json', 'comments']).trim() : '';
      return workflowCommentWith(viewed ? JSON.parse(viewed).comments : null, marker);
    };
    // A comment for today is already there: never a second one. The marker
    // moves only if that comment carried the re-check's section: it did when
    // nothing of the re-check was due, or when it was not left out (no note
    // in it, and no left-out day carried in the body).
    const settle = (c, why, carriedSection) => {
      log(`pipeline health: today's (${today}, ET) ⛔ comment is ${why} — not posted again`);
      if (carriedSection) advance();
      else log("pipeline health: that comment did not carry the record re-check's section; its lines stay due");
      return issueUrl;
    };
    const already = todays();
    if (already) return settle(already, 'already posted', !list.some(isRecheckAlarm) || (!carriedLeftOut && !String(already.body).includes(RECHECK_LEFT_OUT_NOTE)));

    // Left out on an earlier day and still left out: the note repeats weekly.
    const noteDay = !carriedLeftOut || daysBetween(carriedLeftOut, today) % 7 === 0;
    const leftOut = (why) => buildHealthAlarmComment({ date: today, alarms: list, runUrl, leaveOutRecheck: why, sayLeftOut: noteDay });
    const post = (b) => {
      if (b.recheckIncluded || b.others > 0 || noteDay) gh(['issue', 'comment', String(issueNumber), '--repo', repo, '--body-file', writeTempFile(b.body)]);
    };
    let built = buildHealthAlarmComment({ date: today, alarms: list, runUrl });
    if (!built.recheckIncluded) built = leftOut(built.leftOutWhy);
    try {
      post(built);
    } catch (e) {
      // GitHub may have saved it although the call failed: look before posting again.
      const saved = todays();
      if (saved) return settle(saved, 'there after all (the post reported an error)', built.recheckIncluded);
      if (!list.some(isRecheckAlarm) || !built.recheckIncluded) throw e;
      log(`::warning::pipeline health: the ⛔ comment with the record re-check's section could not be posted (${e.message}); posting the rest of the day's alarms without it`);
      built = leftOut(`posting it failed (${String(e.message ?? e).replace(/\s+/g, ' ').slice(0, 300)})`);
      post(built);
    }
    if (built.recheckIncluded) {
      log(`pipeline health: ${list.length} ⛔ condition(s) — dated comment appended to ${issueUrl}`);
      advance();
    } else {
      log(`::warning::pipeline health: the record re-check's section was left out of today's comment (${built.leftOutWhy}); the named-through marker is not advanced, so its lines are named on the next report that can post them${noteDay ? '' : `. The note saying so repeats weekly, not today${built.others ? '' : '; nothing else was due, so nothing was posted'}`}`);
      if (!carriedLeftOut) editBody({ namedThrough: carried, leftOutSince: today }, 'the left-out note may repeat tomorrow');
    }
    return issueUrl;
  } catch (e) {
    log(`::warning::pipeline health: the standing issue could not be maintained (${e.message}) — the digest comment still carries the section.`);
    return null;
  }
}
