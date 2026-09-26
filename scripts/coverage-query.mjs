/**
 * The pure, testable half of the nightly coverage sync — the same
 * script/pure-sibling split scripts/newsdesk.mjs uses with
 * newsdesk-match.mjs, and for the same reason: scripts/sync-coverage.mjs runs
 * its work at module top level (and process.exit(0)s without NEWS_API_KEY),
 * so nothing in it can be imported by a test. Anything here is I/O-free.
 * Shared with the eval harness (scripts/eval-coverage-queries.mjs) and pinned
 * by tests/coverage-query.unit.spec.ts.
 *
 * Contents: the search-query builder (below), the TheNewsAPI rate-limit
 * header reader, and the recency pass's pure half (bottom): who is eligible,
 * who is always queried, how the nightly request budget is split, how a
 * night's articles merge into what is stored, and the relevance-gate prompt.
 *
 * ---- The search-query builder ----
 *
 * Design (each rule is backed by live TheNewsAPI experiments, 2026-07-02):
 * - Citations must be press-style: "H.R. 8463" matched a real article that
 *   the clerk-style "HR 8463" missed. Journalists write periods.
 * - Senate citations NEVER stand alone: "S 180" and "S. 180" both matched 25
 *   junk articles (any text containing "180"), flooding the candidate window
 *   and burning a relevance-gate call. They only appear ANDed with context
 *   terms: "S. 180" + (senate | congress). ("bill" was tried as a third
 *   context term and rejected — too common, it re-admitted junk.)
 * - Bills the press covers by name need the names the press actually prints
 *   (b.press_names, generated at decode time), not the official long title.
 * - Unnamed bills (CRA joint resolutions especially) are covered by SUBJECT,
 *   never by citation: "SJRES 188" matched nothing in any punctuation
 *   variant while EPA "power plant" found 50 articles. b.news_query holds a
 *   2-4 term subject query generated at decode time.
 */

import { TERMINAL_STATUSES } from '../lib/urgency.mjs';
import { conversationPool } from '../lib/conversation.mjs';
import { signalIsLive } from '../lib/docket.mjs';
import { momentVehicles } from './moment-updates-map.mjs';

const CITATION_STYLE = {
  hr: 'H.R.',
  s: 'S.',
  hjres: 'H.J. Res.',
  sjres: 'S.J. Res.',
  hconres: 'H. Con. Res.',
  sconres: 'S. Con. Res.',
  hres: 'H. Res.',
  sres: 'S. Res.',
};

/** Press-style citation, e.g. "H.R. 8463" / "S.J. Res. 188". */
export function pressCitation(b) {
  const prefix = CITATION_STYLE[b.bill_type] ?? b.bill_type.toUpperCase();
  return `${prefix} ${b.bill_number}`;
}

/* Senate-side short citations ("S. 180") tokenize into junk matches, so they
   are only usable ANDed with congressional context. House citations are
   distinctive enough to stand alone. */
function citationClause(b) {
  const cite = pressCitation(b);
  const senateSide = b.bill_type.startsWith('s');
  return senateSide ? `("${cite}" + (senate | congress))` : `"${cite}"`;
}

/**
 * Build the TheNewsAPI search query for a bill.
 * Precedence: press names (what journalists print) > subject query (how
 * unnamed bills are covered) > the bill's own usable title (so a bill whose
 * search inputs don't exist yet is never queried WORSE than the pre-#22
 * builder did — dropping the title arm from the fallback cost 57 bills their
 * coverage on the first partial-backfill night, 2026-07-03) > press-style
 * citation.
 */
/* A bare citation is not a press name — the builder handles citations itself,
   in press style. Defense against the generator echoing "HR 7086" as a name. */
const CITATION_SHAPED = /^(h\.?\s?r\.?|s\.?|[hs]\.?\s?j\.?\s?res\.?|[hs]\.?\s?con\.?\s?res\.?|[hs]\.?\s?res\.?)\s*\.?\s*\d+$/i;

/* Phrase match is apostrophe-EXACT and news CMSes emit typographic quotes:
   "Kayleigh's Law" (straight) missed the real article titled "Kayleigh’s
   Law" (curly). Emit both variants for any phrase containing either. */
const apostropheVariants = (n) => (/['’]/.test(n)
  ? [n.replace(/['’]/g, '’'), n.replace(/['’]/g, "'")]
  : [n]);

export function queryFor(b) {
  const names = (b.press_names ?? [])
    .map((n) => (n ?? '').trim())
    .filter((n) => n && n.length <= 60 && !CITATION_SHAPED.test(n))
    .flatMap(apostropheVariants)
    .filter((n, i, arr) => arr.indexOf(n) === i)
    .slice(0, 4);
  const clauses = names.map((n) => `"${n}"`);

  if (clauses.length === 0 && b.news_query) {
    // Subject query: raw terms, may embed its own quoted phrase.
    clauses.push(`(${b.news_query.trim()})`);
  }

  if (clauses.length === 0) {
    // No generated inputs (backfill hasn't reached this bill, or decode-time
    // generation failed): fall back to the bill's own title when usable —
    // the pre-#22 heuristic. Many titles ARE the press name ("SCAM Act").
    const title = (b.short_title ?? b.title ?? '').trim();
    if (title && title.length <= 80 && !/^an act|^a bill|^to |^a joint resolution/i.test(title)) {
      clauses.push(...apostropheVariants(title).map((t) => `"${t}"`));
    }
  }

  clauses.push(citationClause(b));
  return clauses.join(' | ');
}

// ---- TheNewsAPI rate-limit header ---------------------------------------
/**
 * Read `x-ratelimit-remaining` off a response, and say honestly when it isn't
 * there. (2026-08-09)
 *
 * THE BUG: sync-coverage.mjs read the header as
 * `Number(res.headers.get('x-ratelimit-remaining'))`. A MISSING header makes
 * that `Number(null)` — which is 0, and `Number.isFinite(0)` is true, so the
 * absent header latched the throttle to "this window's budget is spent". From
 * then on every single batch in the run took the proactive-throttle branch
 * and slept 60 seconds before firing, forever, because the response that
 * would reset the counter is itself only reached after the sleep. A CDN-cached
 * 200, a provider revision that drops or renames the header, or a proxy that
 * strips it is enough: the nightly coverage run doesn't fail, it just crawls,
 * and then runs out of night.
 *
 * `null` means "the header told us nothing" — the caller must leave its
 * existing budget estimate alone rather than assume zero. An empty string and
 * a non-numeric value are treated the same way, because `Number('')` is also
 * 0 and would latch identically.
 *
 * @param {Headers|{get: (name: string) => string|null}|null|undefined} headers
 * @returns {number|null} the remaining count, or null when unreadable
 */
export function readRateLimitRemaining(headers) {
  const raw = headers?.get?.('x-ratelimit-remaining');
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// ---- The recency pass (2026-09-26) ---------------------------------------
/*
 * WHAT WAS WRONG. Every bill got ONE request: `sort=relevance_score` over the
 * bill's whole life (published_after = introduced date), and the first 5 the
 * relevance gate kept, in relevance order, replaced whatever was stored. A
 * vote wave had to out-rank sixteen months of history to be seen at all, so
 * old articles won structurally: on the 2026-09-25 corpus all 443 covered
 * bills had been checked within 8 days, yet 86.2% had a newest article older
 * than 30 days (median 116). S. 4668 and H.R. 3633 were fetched every night
 * and still missed their September floor weeks. And because the night's result
 * REPLACED the stored list even when it was empty, ~8 bills a night lost good
 * older coverage to an unstable gate.
 *
 * WHAT CHANGED:
 *   1. A PRIORITY SET is queried every night, first: every vehicle of a live
 *      Big Question, every bill in the "In the news" pool (C1/C2), and every
 *      bill with a live tier-0 floor signal. Each gets a SECOND request — a
 *      date-sorted pass over the last RECENT_WINDOW_DAYS — beside the usual
 *      whole-life relevance pass.
 *   2. The budget does not grow: each priority bill costs two requests, and
 *      the head/tail rotation shrinks by exactly that much (planCoverageRun),
 *      so a night still spends at most COVERAGE_TOP_N requests.
 *   3. MERGE, don't replace: tonight's kept articles are merged with the
 *      stored ones by URL (and syndicated title), newest first, capped at
 *      PER_BILL (mergeArticles). A bad night can add; it cannot erase.
 *   4. The relevance gate sees each article's date and the bill's own dates.
 *   5. A bill that just became law stays in the sweep for ENACTED_GRACE_DAYS
 *      after its last action — the week its coverage peaks is exactly the week
 *      the old terminal-status filter stopped looking.
 *
 * FOLLOW-UPS (2026-09-26, after the first review of the above):
 *   6. The priority set is queried WHATEVER its terminal status (the plan's
 *      words: "always query vehicles, C1/C2 and tier-0 slugs"). The grace
 *      window alone left H.R. 6500 — a live Big Question vehicle, enacted 23
 *      days earlier — and the band's H.R. 1 and H.R. 4405 unchecked, and aged
 *      their stored coverage out of the file. isCoverageEligible's `priority`
 *      option.
 *   7. The priority set has its own ceiling, PRIORITY_MAX_SHARE of the night,
 *      so a busy news week cannot eat the least-recently-checked tail (the
 *      2026-08-05 starvation the 50/50 split exists to prevent). Eligible
 *      priority bills over the ceiling are reported, and still compete for an
 *      ordinary head/tail slot.
 *   8. Merging must not make the gate's NO permanent: a stored article that
 *      tonight's gate was shown and rejected is dropped (withoutRejected) — but
 *      only when the reply is a COMPLETE, WELL-FORMED answer (gateAnswered:
 *      the API says the model finished, and the text is exactly "none" or a
 *      comma-separated list of in-range indexes). A truncated, off-script or
 *      empty reply erases nothing.
 *   9. The date-sorted pass is measured by lean against the whole-life pass on
 *      the same bills every night, and a shift past LEAN_DRIFT raises a
 *      ::warning:: that lib/pipeline-health.mjs turns into a ⛔ (leanDrift).
 */

/** When the 119th Congress convened; no coverage can predate a bill in it. */
export const CONGRESS_START = '2025-01-03';

/** The sort the whole-life pass has always used. */
export const RELEVANCE_SORT = 'relevance_score';

/**
 * THE DATE SORT VALUE — ONE CONSTANT, AND NOT YET PROVEN AGAINST THE LIVE API.
 *
 * TheNewsAPI's own docs disagree with themselves: the `sort` row reads "Sort by
 * published_on or relevance_score … Default is published_at unless search is
 * used and sorting by published_at is not included, in which case
 * relevance_score is used" (docs fetched 2026-09-25). `published_on` is also
 * the name of a separate date-FILTER parameter, and the default-behaviour
 * sentence names `published_at` twice, so this ships the documented default,
 * `published_at`. No keyed request was made to confirm it.
 *
 * The first nightly after merge is the verification, and it cannot fail
 * silently: scripts/sync-coverage.mjs logs a ::warning:: naming the API's own
 * error if the value is rejected (and then carries on with the 30-day window
 * in the API's default order, which is still recency-bounded), and a
 * `DATE PASS:` summary line saying how many date-sorted responses actually
 * came back newest-first — the tell for a value that is accepted but ignored.
 * If it has to change, change it HERE; nothing else spells it.
 */
export const DATE_SORT = 'published_at';

/** How far back the date-sorted pass looks. */
export const RECENT_WINDOW_DAYS = 30;

/** How long a newly enacted bill stays in the nightly sweep. */
export const ENACTED_GRACE_DAYS = 14;

/** Requests a priority bill costs: the date-sorted pass + the relevance pass. */
export const PRIORITY_REQUESTS_PER_BILL = 2;

/**
 * The most of one night's requests the priority set may take (both passes
 * counted). 20% of the nightly 600 is 120 requests — 60 priority bills —
 * against 31 eligible on the 2026-09-26 corpus (28 before the terminal-status
 * bypass added H.R. 6500, H.R. 1 and H.R. 4405), so today it never binds; it
 * exists for the week it would. Without it the only ceiling was half the
 * budget, and with 30 priority slugs a 20-request run spent all 20 on 10
 * priority bills and checked nothing else at all.
 */
export const PRIORITY_MAX_SHARE = 0.2;

const DAY_MS = 86_400_000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** The coverage file's key for a bill. */
export function coverageSlug(b) {
  return `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();
}

/**
 * Is this bill in tonight's sweep at all? Decoded, and either still moving or
 * enacted within the last ENACTED_GRACE_DAYS (dated by its last action, which
 * for a signed bill is the signing or the public-law number). A vetoed bill is
 * not "newly enacted" and stays out, as before.
 *
 * `priority: true` (the bill is in coveragePriority's set tonight) skips the
 * terminal-status test entirely: a live Big Question vehicle, a bill the news
 * band is showing, or a bill on tonight's floor is asked about whatever its
 * status. The motivating case is H.R. 6500, the stopgap that became law on
 * 2026-09-02 and is still the funding question's vehicle — 23 days later it
 * was past the grace window, so it was never checked and its stored coverage
 * aged out of the file. Being decoded is still required: the Read section only
 * exists on a decoded bill. It stays eligible exactly as long as it stays in
 * the priority set; the night it leaves, the ordinary rule applies again and
 * its coverage ages out as before.
 *
 * @param {any} b @param {number} [now] @param {{ priority?: boolean }} [opts]
 */
export function isCoverageEligible(b, now = Date.now(), { priority = false } = {}) {
  if (!b?.ai_headline) return false;
  if (priority) return true;
  if (!TERMINAL_STATUSES.has(b.status)) return true;
  if (b.status !== 'signed' || !isDay(b.last_action_date)) return false;
  // Whole calendar days (UTC), so "14 days" means the same thing at 01:00 and 23:00.
  const age = (Date.parse(`${dayOf(now)}T00:00:00Z`) - Date.parse(`${b.last_action_date}T00:00:00Z`)) / DAY_MS;
  return age >= 0 && age <= ENACTED_GRACE_DAYS;
}

/** The whole-life pass's floor: the bill's introduction (or the Congress's start). */
export function wholeLifeStart(b) {
  return isDay(b?.introduced_date) ? b.introduced_date : CONGRESS_START;
}

/** The date-sorted pass's floor: RECENT_WINDOW_DAYS ago, never before the bill existed. */
export function recentWindowStart(b, now = Date.now()) {
  const windowStart = dayOf(now - RECENT_WINDOW_DAYS * DAY_MS);
  const born = wholeLifeStart(b);
  return born > windowStart ? born : windowStart;
}

/**
 * The bills queried every night, first, with the extra date-sorted pass —
 * in a fixed order (Big Question vehicles, then the news pool, then live
 * tier-0 floor signals), each slug once.
 *
 * Every input is read tolerantly: this orders a nightly sweep, and a missing
 * or malformed file must shrink the priority set, never fail the run.
 *
 * WHAT THIS FEEDS, STATED PLAINLY. This decides only which bills are ASKED
 * about earlier and more often; data/coverage.json still takes only what the
 * relevance gate keeps. But asking twice as often finds more, so it is a
 * feedback loop for every signal that reads stored coverage, and the honest
 * accounting is per group:
 *   - Big Question vehicles: no loop into question selection.
 *     scripts/moment-candidates.mjs never proposes a bill that is already a
 *     vehicle, so a live question cannot inflate its own ranking.
 *   - News-band (C1/C2) and tier-0 bills: YES, a loop. They get two requests
 *     a night where every other bill gets one every few days, and stored
 *     coverage feeds (a) the fallback news band (lib/coverage.ts rankNews,
 *     used only when data/conversation.json is not live) and (b) the
 *     candidate paths — scripts/moment-candidates.mjs ranks on stored coverage
 *     tier and outlet count, and scripts/moment-watch.mjs admits "neutral"
 *     coverage at 3 outlets. The live band itself reads newsdesk evidence
 *     (data/conversation.json), not this file, so the loop does not reach it.
 *     Accepted because the loop runs on real, gate-kept articles; it can make
 *     an already-covered bill look more covered, never invent coverage.
 *   - Terminal bills, now queried while they are priority (isCoverageEligible):
 *     neither candidate path admits a terminal status, so the loop stops at
 *     the fallback band, where "enacted, but in the news" is the owner's rule.
 *   OPEN, for the owner: both candidate paths count UNRATED outlets toward
 *   "neutral" coverage (coverageTier treats 2+ outlets with no partisan lean as
 *   neutral, and moment-watch's minOutletsForNeutral: 3 can be met by three
 *   unrated outlets). With Big Questions becoming automatic, that is the next
 *   place the rated-only outlet floor (lib/press-outlets.mjs) would apply. Not
 *   changed here.
 *
 * @param {{ moments?: any, conversation?: any, floorSignals?: any, now?: number }} inputs
 * @returns {{ slugs: string[], vehicles: string[], band: string[], tier0: string[] }}
 */
export function coveragePriority({ moments, conversation, floorSignals, now = Date.now() } = {}) {
  let vehicles = [];
  try {
    vehicles = momentVehicles(moments ?? {}).map((v) => v.slug);
  } catch {
    vehicles = [];
  }
  let band = [];
  try {
    band = conversationPool(conversation ?? {}, { now }).map((p) => p.slug);
  } catch {
    band = [];
  }
  const tier0 = [];
  const signals = floorSignals?.signals;
  if (signals && typeof signals === 'object') {
    const fetchedAt = floorSignals?._meta?.fetched_at ?? null;
    for (const [slug, signal] of Object.entries(signals)) {
      if (signalIsLive(signal, { fetchedAt, now })) tier0.push(slug);
    }
    tier0.sort();
  }
  const slugs = [...new Set([...vehicles, ...band, ...tier0].map((s) => String(s).toLowerCase()))];
  return { slugs, vehicles, band, tier0 };
}

/**
 * Split one night's request budget.
 *
 * `ranked` is the eligible set already in docket-ladder order (lib/docket.mjs),
 * each `{ b, eff }`. Priority bills that are eligible go first and cost
 * PRIORITY_REQUESTS_PER_BILL each, up to `priorityShare` of the budget
 * (PRIORITY_MAX_SHARE by default); what is left is split between the ladder
 * head and the least-recently-checked tail exactly as before (TAIL_SHARE), with
 * the overflow absorbing any remainder the tail cannot use. Returns the bills
 * in processing order and the request count, which never exceeds `topN`.
 *
 * A priority bill over the ceiling is `deferred`, not dropped: it gets no
 * 30-day pass tonight, but it is still in `ranked`, so it competes for an
 * ordinary head or tail slot like any other bill.
 *
 * @param {{ ranked: {b: any, eff: number}[], prioritySlugs?: string[], topN: number, tailShare: number, priorityShare?: number, checkedAt?: Record<string,string> }} args
 */
export function planCoverageRun({ ranked, prioritySlugs = [], topN, tailShare, priorityShare = PRIORITY_MAX_SHARE, checkedAt = {} }) {
  const budget = Math.max(0, Math.floor(topN));
  const bySlug = new Map(ranked.map((e) => [coverageSlug(e.b), e]));
  const share = Number.isFinite(priorityShare) ? Math.min(1, Math.max(0, priorityShare)) : PRIORITY_MAX_SHARE;
  const maxPriority = Math.floor((budget * share) / PRIORITY_REQUESTS_PER_BILL);
  const priority = [];
  const skipped = [];
  const deferred = [];
  for (const slug of prioritySlugs) {
    const e = bySlug.get(slug);
    if (!e) {
      skipped.push(slug);
      continue;
    }
    if (priority.includes(e)) continue;
    if (priority.length >= maxPriority) {
      deferred.push(slug);
      continue;
    }
    priority.push(e);
  }
  const claimed = new Set(priority.map((e) => coverageSlug(e.b)));
  const remaining = budget - priority.length * PRIORITY_REQUESTS_PER_BILL;

  const headSize = Math.max(0, Math.min(remaining, Math.round(remaining * (1 - tailShare))));
  const head = ranked.filter((e) => !claimed.has(coverageSlug(e.b))).slice(0, headSize);
  for (const e of head) claimed.add(coverageSlug(e.b));
  const tail = ranked
    .filter((e) => !claimed.has(coverageSlug(e.b)))
    .map((e) => ({ e, seen: checkedAt[coverageSlug(e.b)] ?? '' }))
    .sort((x, y) => x.seen.localeCompare(y.seen) || y.e.eff - x.e.eff)
    .slice(0, remaining - head.length)
    .map((x) => x.e);
  for (const e of tail) claimed.add(coverageSlug(e.b));
  const overflow = ranked
    .filter((e) => !claimed.has(coverageSlug(e.b)))
    .slice(0, remaining - head.length - tail.length);

  const requests = priority.length * PRIORITY_REQUESTS_PER_BILL + head.length + tail.length + overflow.length;
  return {
    priority: priority.map((e) => e.b),
    head: head.map((e) => e.b),
    tail: tail.map((e) => e.b),
    overflow: overflow.map((e) => e.b),
    /** Priority slugs that are not in tonight's eligible set (undecoded, or not in the corpus). */
    skipped,
    /** Eligible priority slugs over the priorityShare ceiling: no 30-day pass tonight. */
    deferred,
    maxPriority,
    requests,
  };
}

const titleKey = (a) => String(a?.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const urlKey = (a) => (typeof a?.url === 'string' ? a.url.trim() : '');
const articleDay = (a) => {
  const d = String(a?.publishedAt ?? '').slice(0, 10);
  return isDay(d) ? d : '';
};

/**
 * Merge tonight's kept articles into what is stored — by URL, then by
 * syndicated title — newest first, capped. Tonight's copy of an article wins
 * over the stored one. Undated articles sort after every dated one (never read
 * "no date" as new). Stable, pure, never mutates its inputs.
 *
 * @template {{url?: string, title?: string, publishedAt?: string|null}} A
 * @param {A[]} fresh tonight's kept articles
 * @param {A[]} stored the bill's stored articles
 * @param {number} cap PER_BILL
 * @returns {A[]}
 */
export function mergeArticles(fresh, stored, cap) {
  const seenUrl = new Set();
  const seenTitle = new Set();
  const pool = [];
  for (const a of [...(fresh ?? []), ...(stored ?? [])]) {
    if (!a || typeof a !== 'object') continue;
    const u = urlKey(a);
    const t = titleKey(a);
    if ((u && seenUrl.has(u)) || (t && seenTitle.has(t))) continue;
    if (u) seenUrl.add(u);
    if (t) seenTitle.add(t);
    pool.push(a);
  }
  return pool
    .map((a, i) => ({ a, i }))
    .sort((x, y) => articleDay(y.a).localeCompare(articleDay(x.a)) || x.i - y.i)
    .slice(0, Math.max(0, cap))
    .map((x) => x.a);
}

/**
 * A predicate: is this article one of `list` — the same URL, or the same
 * syndicated title? The identity mergeArticles and the pre-gate dedupe use, so
 * "the same article" means one thing everywhere in the sync.
 *
 * @param {{url?: string, title?: string}[]} list
 * @returns {(a: {url?: string, title?: string}) => boolean}
 */
export function articleMatcher(list) {
  const urls = new Set();
  const titles = new Set();
  for (const a of list ?? []) {
    const u = urlKey(a);
    const t = titleKey(a);
    if (u) urls.add(u);
    if (t) titles.add(t);
  }
  return (a) => {
    const u = urlKey(a);
    const t = titleKey(a);
    return Boolean((u && urls.has(u)) || (t && titles.has(t)));
  };
}

/**
 * The stored articles, minus every one tonight's gate was SHOWN and REJECTED.
 *
 * Why this exists: mergeArticles made a bad night unable to erase anything,
 * which is right for an article tonight's search simply did not return — and
 * wrong for one the gate looked at again and said no to. Without this, an
 * article an earlier gate kept by mistake could only ever leave by being
 * pushed out by PER_BILL newer ones, whatever every later gate said about it.
 * The most recent verdict on an article the gate has actually seen is the one
 * that stands; an article it has not seen tonight keeps its old verdict.
 *
 * Callers must pass `rejected` ONLY when gateAnswered says the reply was a
 * complete, well-formed answer. Any doubt about the reply rejects nothing.
 *
 * @template {{url?: string, title?: string}} A
 * @param {A[]} stored @param {{url?: string, title?: string}[]} rejected
 * @returns {A[]}
 */
export function withoutRejected(stored, rejected) {
  if (!Array.isArray(stored)) return [];
  if (!rejected?.length) return stored.slice();
  const wasRejected = articleMatcher(rejected);
  return stored.filter((a) => !wasRejected(a));
}

/**
 * Is this gate reply a COMPLETE, WELL-FORMED answer? Only such a reply may
 * DELETE stored coverage (withoutRejected).
 *
 * This is deliberately stricter than parseKeptIndexes. That parser reads any
 * in-range number out of any reply, and it still decides what tonight KEEPS,
 * unchanged, so what a night adds is exactly what it added before. Dropping a
 * stored article is different: nothing on a later night brings it back unless
 * a later search happens to return it again. So a drop needs the exact reply
 * relevancePrompt asks for, and nothing else:
 *   - `stopReason` must be "end_turn", meaning the model finished. A reply cut
 *     off at max_tokens is not an answer ("0, 3, 1" may have been going to be
 *     "0, 3, 12"), and neither is a refusal. A missing stop reason is
 *     unknown, and unknown counts as no.
 *   - The trimmed text must be exactly `none`, or exactly a comma-separated
 *     list of indexes, each one in range and none repeated. One pair of
 *     wrapping quotes or backticks and one trailing period are tolerated.
 *     These all fail: "0, 3 — the rest are about other bills",
 *     "Articles 2 and 4", "none of 0-24", "7, 9" when 5 were shown, "0, 3,",
 *     and "none" followed by an explanation.
 * Any other reply keeps every stored article. The DONE line counts it as a
 * reply that was not complete and well-formed.
 *
 * @param {string|null|undefined} text
 * @param {number} n candidates shown
 * @param {{ stopReason?: string|null }} [meta] the API response's stop_reason
 */
export function gateAnswered(text, n, { stopReason } = {}) {
  if (stopReason !== 'end_turn') return false;
  if (typeof text !== 'string' || !Number.isInteger(n) || n <= 0) return false;
  let body = text.trim();
  const wrapped = body.match(/^(["'`])([\s\S]*)\1$/);
  if (wrapped) body = wrapped[2].trim();
  body = body.replace(/\.$/, '').trim();
  if (/^none$/i.test(body)) return true;
  if (!/^\d+(?:[ \t]*,[ \t]*\d+)*$/.test(body)) return false;
  const tokens = body.split(',').map((x) => x.trim());
  // "03" is not how the prompt numbers an article.
  if (tokens.some((x) => x.length > 1 && x.startsWith('0'))) return false;
  const nums = tokens.map(Number);
  if (nums.some((i) => !Number.isSafeInteger(i) || i >= n)) return false;
  return new Set(nums).size === nums.length;
}

/**
 * Did a response come back newest-first? Only meaningful with 2+ dated
 * articles (returns null otherwise). The first nightly's check that
 * DATE_SORT is honoured, not merely accepted.
 *
 * @param {{publishedAt?: string|null}[]} articles
 * @returns {boolean|null}
 */
export function isNewestFirst(articles) {
  const days = (articles ?? []).map(articleDay).filter(Boolean);
  if (days.length < 2) return null;
  for (let i = 1; i < days.length; i++) if (days[i] > days[i - 1]) return false;
  return true;
}

/**
 * The relevance gate's prompt. It authors nothing — it returns indexes — and
 * since 2026-09-26 it sees DATES: each article's publication day, and the
 * bill's introduction and latest action, so "is this about THIS bill" can
 * weigh when as well as what.
 *
 * @param {any} b the bill
 * @param {{title?: string, snippet?: string|null, source?: string, publishedAt?: string|null}[]} candidates
 */
export function relevancePrompt(b, candidates) {
  const list = candidates
    .map((a, i) => `${i}. [${articleDay(a) || 'undated'}] ${a.title}${a.snippet ? ` — ${a.snippet}` : ''} (${a.source})`)
    .join('\n');
  const action = String(b.last_action_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `A US congressional bill:
${b.bill_type.toUpperCase()} ${b.bill_number} — ${b.ai_headline ?? b.title}
What it does: ${b.ai_sections?.tldr ?? b.ai_summary ?? b.title}
Introduced: ${isDay(b.introduced_date) ? b.introduced_date : 'unknown'}. Latest action (${isDay(b.last_action_date) ? b.last_action_date : 'undated'}): ${action || 'none recorded'}

Below are news articles, each with its publication date in brackets. Return ONLY the numbers of articles specifically about THIS bill (its provisions, votes, debate, or signing) — not merely the general topic, and not a different bill. Reply with a comma-separated list of numbers, or "none".

${list}`;
}

/** The article indexes a gate reply keeps — in range, deduped. */
export function parseKeptIndexes(text, n) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^0-9]+/)
      .filter(Boolean)
      .map(Number)
      .filter((i) => i >= 0 && i < n),
  );
}

// ---- The lean measurement (nonpartisan by construction) -----------------
/**
 * WHEN THE DATE PASS'S OUTLET MIX HAS MOVED FAR ENOUGH TO LOOK AT.
 *
 * The 30-day pass asks TheNewsAPI a different question than the whole-life
 * pass (newest, not most relevant), and the rule is that a change to how the
 * source is asked is measured by lean, not assumed neutral. It could not be
 * measured before merge without a keyed call, so it is measured every night,
 * on the same priority bills, with the whole-life pass as the control — and
 * this decides when the difference is big enough to raise a ::warning:: that
 * lib/pipeline-health.mjs turns into a ⛔.
 *
 * Two questions, each a two-proportion z-test on what the gate KEPT:
 *   1. rated share — rated / all kept. Does the date pass bring in more
 *      outlets AllSides does not rate?
 *   2. left/right split — right / (left + right) among partisan-rated kept
 *      articles. Symmetric: a shift either way is the same size of finding.
 * A question fires only when BOTH the shift is at least `minShift` (15
 * points) AND |z| is at least `z` (2.58, about 1 in 100 by chance) — so a
 * big-looking swing on a handful of articles does not fire, and neither does
 * a tiny, statistically solid one. Below `minArticles` / `minPartisan` kept in
 * EITHER pass the question is "too few to judge", never "ok".
 *
 * THESE THRESHOLDS ARE A FIRST SETTING, NOT A MEASURED ONE. No night has run
 * with the date pass yet, so the typical noise is unknown; articles also
 * cluster by bill (one busy vote week can dominate a night), which makes the
 * z-test read more certain than it is. Expect to tune them after a week of
 * LEAN DRIFT lines. Tune HERE — nothing else spells them.
 */
export const LEAN_DRIFT = Object.freeze({ minArticles: 10, minPartisan: 8, minShift: 0.15, z: 2.58 });

/** @typedef {{left: number, center: number, right: number, unrated: number}} LeanMix */

function twoProportion(k1, n1, k2, n2) {
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const pooled = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  return { p1, p2, z: se > 0 ? (p1 - p2) / se : 0 };
}

/**
 * @param {LeanMix} recent what the gate kept from the 30-day pass
 * @param {LeanMix} control what the gate kept from the whole-life pass, same bills
 * @param {typeof LEAN_DRIFT} [t]
 * @returns {{ verdict: 'ok'|'drift'|'thin', checks: {metric: 'rated'|'split', state: 'ok'|'drift'|'thin', p1: number|null, p2: number|null, n1: number, n2: number, z: number|null, need: number}[] }}
 */
export function leanDrift(recent, control, t = LEAN_DRIFT) {
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const mix = (m) => ({ left: num(m?.left), center: num(m?.center), right: num(m?.right), unrated: num(m?.unrated) });
  const r = mix(recent);
  const c = mix(control);
  const rated = (m) => m.left + m.center + m.right;
  const one = (metric, k1, n1, k2, n2, need) => {
    if (n1 < need || n2 < need) return { metric, state: 'thin', p1: null, p2: null, n1, n2, z: null, need };
    const { p1, p2, z } = twoProportion(k1, n1, k2, n2);
    const fired = Math.abs(p1 - p2) >= t.minShift && Math.abs(z) >= t.z;
    return { metric, state: fired ? 'drift' : 'ok', p1, p2, n1, n2, z, need };
  };
  const checks = [
    one('rated', rated(r), rated(r) + r.unrated, rated(c), rated(c) + c.unrated, t.minArticles),
    one('split', r.right, r.left + r.right, c.right, c.left + c.right, t.minPartisan),
  ];
  const verdict = checks.some((x) => x.state === 'drift') ? 'drift' : checks.some((x) => x.state === 'thin') ? 'thin' : 'ok';
  return { verdict, checks };
}

/** The verdict word the LEAN DRIFT line starts with — what pipeline-health parses. */
export const LEAN_DRIFT_WORD = Object.freeze({ ok: 'ok', drift: 'DRIFT', thin: 'too few to judge' });

/**
 * The LEAN DRIFT log line, after its `LEAN DRIFT: ` prefix. Wording is part of
 * a contract: lib/pipeline-health.mjs parseCoverageLean reads the leading
 * verdict word, and tests/sync-coverage-runner.unit.spec.ts feeds this
 * script's real output to that parser.
 *
 * @param {ReturnType<typeof leanDrift>} drift @param {number} windowDays
 */
export function formatLeanDrift(drift, windowDays) {
  const pct = (p) => `${Math.round(p * 100)}%`;
  const parts = drift.checks.map((x) => {
    if (x.metric === 'rated') {
      return x.state === 'thin'
        ? `rated share: too few to judge (${windowDays}-day ${x.n1}, whole-life ${x.n2} kept; need ${x.need} each)`
        : `rated share: ${windowDays}-day ${pct(x.p1)} of ${x.n1} vs whole-life ${pct(x.p2)} of ${x.n2} (z=${x.z.toFixed(2)})${x.state === 'drift' ? ' SHIFTED' : ''}`;
    }
    return x.state === 'thin'
      ? `left/right split: too few to judge (${windowDays}-day ${x.n1}, whole-life ${x.n2} partisan-rated; need ${x.need} each)`
      : `left/right split: ${windowDays}-day L${pct(1 - x.p1)}/R${pct(x.p1)} of ${x.n1} vs whole-life L${pct(1 - x.p2)}/R${pct(x.p2)} of ${x.n2} (z=${x.z.toFixed(2)})${x.state === 'drift' ? ' SHIFTED' : ''}`;
  });
  return `${LEAN_DRIFT_WORD[drift.verdict]} — ${parts.join(' · ')}`;
}

/**
 * TheNewsAPI's error body, reduced to something safe to log: its own code and
 * message, trimmed. Never the request URL — that carries the API token.
 * @param {any} body
 */
export function apiErrorDetail(body) {
  const err = body?.error ?? body;
  const code = typeof err?.code === 'string' ? err.code : typeof err === 'string' ? err : '';
  const message = typeof err?.message === 'string' ? err.message : '';
  return [code, message].filter(Boolean).join(': ').replace(/\s+/g, ' ').slice(0, 200) || 'no error detail in the body';
}
