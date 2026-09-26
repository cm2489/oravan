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
 * @param {string} log
 * @returns {{refreshed:number, added:number, gated:number, queued:number,
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
  return {
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
 *   `pregen: done — 60 cached, 0 failed, batch msgbatch_...`
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
 *   toGenerate:number|null, cached:number|null, failed:number|null,
 *   costLow:number|null, costHigh:number|null, abortReason:string|null}}
 */
export function parsePregen(log) {
  const lines = logLines(log);
  const plan = lastMatch(
    lines,
    /^pregen: (\d+) top bill\(s\), (\d+) combo\(s\) total, (\d+) already cached, (\d+) to generate/
  );
  const done = lastMatch(lines, /^pregen: done [—-] (\d+) cached, (\d+) failed/);
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
    cached: done ? int(done[1]) : null,
    failed: done ? int(done[2]) : null,
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

/** `upstash cache: request failed (status 0); failing open to in-memory (error #N ...)` */
export function countUpstashCacheFailures(log) {
  return logLines(log).filter((l) => /^upstash cache: request failed/.test(l)).length;
}

/** `mirror-portraits: B001323 source fetch failed (status 404) - skipped` */
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
 * @param {{lastSync?: string, lastRun?: string}} state
 * @param {{now?: number, previousSync?: string|null}} [opts]
 */
export function cursorHealth(state, { now = Date.now(), previousSync = null } = {}) {
  const sync = Date.parse(state?.lastSync ?? '');
  const run = Date.parse(state?.lastRun ?? '');
  const previous = Date.parse(previousSync ?? '');
  const lastSyncAgeDays = Number.isFinite(sync) ? (now - sync) / 86_400_000 : null;
  const lastRunAgeHours = Number.isFinite(run) ? (now - run) / 3_600_000 : null;
  /** true = advanced, false = stood still (or went backwards), null = no baseline to compare against. */
  const moved = Number.isFinite(sync) && Number.isFinite(previous) ? sync > previous : null;
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
    lastSyncAgeDays,
    lastRunAgeHours,
    moved,
    behind,
    // Behind AND demonstrably standing still. A cursor that is behind but
    // advancing is catching up, which is the opposite of the thing this word
    // sends the owner to go fix.
    frozen: behind && moved === false,
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
 * @param {object} signals
 * @param {{now?: number, staleHours?: number, alarmHours?: number}} opts
 */
export function floorSignalFreshness(
  signals,
  { now = Date.now(), staleHours = undefined, alarmHours = FLOOR_SIGNAL_ALARM_HOURS } = {}
) {
  const raw = signals?.fetched_at ?? signals?._meta?.fetched_at ?? null;
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

/** Newsdesk is `cron: '7 * * * *'` — 24 scheduled firings in a UTC day. */
export const NEWSDESK_EXPECTED_SLOTS = 24;

/* ------------------------------------------------------------------ *
 * 6 · Spend estimate
 * ------------------------------------------------------------------ */

/**
 * Per-million-token list prices, verified against Anthropic's published
 * pricing table on 2026-09-18. They live here rather than being imported
 * because lib/pregen.ts is TypeScript with extensionless relative imports
 * (plain `node` cannot load it — the same constraint scripts/daily-metrics.mjs
 * documents at length), and this script must run under plain `node`.
 *
 * READ THIS BEFORE TRUSTING A DOLLAR FIGURE DOWNSTREAM. lib/pregen.ts's cost
 * comment records Sonnet 5 "standard pricing" as $3/$15 per MTok from
 * 2026-09-01. The published table on 2026-09-18 lists Claude Sonnet 5 at
 * $2/$10. This file does not resolve that disagreement and must not: it
 * reports the SCRIPT'S OWN printed estimate as the primary pregen number (so
 * the digest never contradicts the log it is summarising) and marks every
 * figure it derives itself as an estimate.
 */
export const MODEL_PRICE_PER_MTOK = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/**
 * A DELIBERATELY COARSE day estimate. It exists to answer "did tonight cost
 * pennies or dollars", not to reconcile a bill — the authoritative number is
 * the Anthropic console, and the digest says so in as many words.
 *
 * Inputs it TRUSTS: pregen's own printed range, which the script computes from
 * its real generation count and already carries the Batches API's half price.
 * Inputs it ESTIMATES: the decode calls and the newsdesk t3 call.
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
 * @param {{decodes?:number, t3Batched?:number, t3Runs?:number,
 *   pregen?:{costLow:number|null, costHigh:number|null}|null}} input
 */
export function estimateDaySpend({ decodes = 0, t3Batched = 0, t3Runs = 0, pregen = null } = {}) {
  const sonnet = MODEL_PRICE_PER_MTOK['claude-sonnet-5'];
  const haiku = MODEL_PRICE_PER_MTOK['claude-haiku-4-5'];
  // Assumed shapes. Named, not buried: every one of these is a guess about
  // average size, and the only honest thing to do with a guess is print it.
  const assumptions = {
    decodeInputTokens: 12_000,
    decodeOutputTokens: 2_000,
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
    decodeModel: 'claude-sonnet-5',
    t3Model: 'claude-haiku-4-5',
  };
  const decodeUsd =
    (decodes * (assumptions.decodeInputTokens * sonnet.input + assumptions.decodeOutputTokens * sonnet.output)) /
    1_000_000;
  const t3InputTokens = t3Runs * assumptions.t3PromptOverheadTokens + t3Batched * assumptions.t3TokensPerHeadline;
  // The reply is capped per run, so the ceiling is runs × max_tokens.
  const t3OutputTokens = t3Runs * assumptions.t3MaxOutputTokensPerRun;
  const t3Usd = (t3InputTokens * haiku.input + t3OutputTokens * haiku.output) / 1_000_000;
  const pregenLow = pregen?.costLow ?? null;
  const pregenHigh = pregen?.costHigh ?? null;
  const round = (n) => Math.round(n * 1000) / 1000;
  return {
    decodeUsd: round(decodeUsd),
    t3Usd: round(t3Usd),
    pregenUsd: pregenLow === null ? null : { low: pregenLow, high: pregenHigh ?? pregenLow },
    totalLow: round(decodeUsd + t3Usd + (pregenLow ?? 0)),
    totalHigh: round(decodeUsd + t3Usd + (pregenHigh ?? pregenLow ?? 0)),
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
      text: `data/floor-signals.json was last stamped ${Math.round(report.floorSignals.ageHours)}h ago, past the ${report.floorSignals.alarmHours}h alarm`,
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
  return out;
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

function formatOtherWorkflows(workflows) {
  const entries = Object.entries(workflows ?? {});
  if (!entries.length) return 'none in 24h';
  return entries.map(([name, w]) => `${name} ${w?.conclusion ?? 'unknown'}`).join(' · ');
}

/**
 * The one word the cursor row is allowed to end on. A cursor that is behind
 * but advancing gets BEHIND (advancing) rather than FROZEN, because the two
 * send the owner to do opposite things: wait, or go unstick a scan. Nothing
 * at all when the cursor is keeping up.
 */
function cursorWord(cursor) {
  if (!cursor?.behind) return '';
  if (cursor.frozen) return ' · FROZEN';
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
  return `${range} today (decodes $${spend.decodeUsd.toFixed(3)}, t3 $${spend.t3Usd.toFixed(3)}, pregen ${
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
        ? `${sync.refreshed} refreshed · ${sync.added} added+decoded · ${sync.gated} gated · ${
            sync.ascendingFailed + sync.recentFailed
          } failed`
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
    row('portraits', `${n(report?.portrait404s)} source 404(s)`),
    row('conversation', `${n(report?.conversation?.dangling?.length)} dangling slug(s)`),
    row('press feeds', formatPressFeeds(report?.pressFeeds)),
    row('moment candidates', formatCandidates(report?.momentCandidates)),
    row('spend (estimate)', formatSpend(report?.spend)),
  ];
  // Only when it bit: a truncated read must SAY it was truncated, so a number
  // built from 16 of 30 runs is never mistaken for a number built from all 30.
  if (report?.logsSkipped) {
    lines.push(row('logs', `${report.logsRead} read, ${report.logsSkipped} SKIPPED (per-run cap) — counters below are partial`));
  }
  lines.push('```');
  if (list.length) lines.push('', ...list.map((x) => `⛔ ${x.text}`));
  else lines.push('', '✅ No ⛔ conditions.');
  lines.push(
    '',
    '_Spend is an ESTIMATE assembled from call counts and list prices, not a bill — ' +
      'the Anthropic console is the only authoritative figure. Every reading above comes ' +
      'from run logs, the committed data files and the Actions API; "not found" means the ' +
      'line was absent, never that the number was zero._'
  );
  return lines.join('\n');
}

export const HEALTH_ISSUE_TITLE = '🩺 Pipeline health';
export const HEALTH_ISSUE_LABEL = 'pipeline-health';

/**
 * The standing issue's body — rewritten every day, never appended to. Same
 * shape rule the traffic-decline issue follows: a STATE gets one issue whose
 * body is current, not a pile of dated issues nobody reads.
 */
export function formatHealthIssueBody(report) {
  return [
    `_Rewritten every run. Last update: ${report?.generatedAt ?? 'unknown'} (trailing 24h)._`,
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
    '**A dated comment appears below only when a ⛔ condition holds** — the nightly did ' +
      'not succeed, an Anthropic call was refused for credit, newsdesk t3 resolved none of ' +
      'what it batched, CI on main has been red over 24h, the cursor stopped moving while ' +
      'the pipeline kept running, the floor-signals stamp passed its alarm, a newsdesk ' +
      'press feed (or every feed of one lean) went dark, the coverage ' +
      "sync's 30-day pass shifted its outlet-lean mix against the whole-life pass, a " +
      'coverage night kept nothing at all, TheNewsAPI answered none of a night\'s requests, ' +
      "or a night's relevance gate dropped half or more of the stored articles it re-judged. " +
      'A quiet day rewrites this body and says nothing else.',
  ].join('\n');
}

/** The dated comment, posted only on an alarm day. */
export function formatHealthAlarmComment({ date, alarms: list, runUrl }) {
  return [
    `<!-- pipeline-health:${date} -->`,
    `⛔ **Pipeline health — ${date}**`,
    '',
    ...(list ?? []).map((a) => `- ${a.text}`),
    '',
    runUrl
      ? `Full report: this issue's body (rewritten this run). Digest run: ${runUrl}`
      : "Full report: this issue's body (rewritten this run).",
  ].join('\n');
}
