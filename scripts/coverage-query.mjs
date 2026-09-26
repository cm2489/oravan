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
 * @param {any} b @param {number} [now]
 */
export function isCoverageEligible(b, now = Date.now()) {
  if (!b?.ai_headline) return false;
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
 * NOT A FEEDBACK LOOP INTO BIG QUESTION SELECTION: this decides only which
 * bills are ASKED about earlier and more often. data/coverage.json still takes
 * only what the relevance gate keeps, and scripts/moment-candidates.mjs never
 * proposes a bill that is already a vehicle, so a live question cannot use
 * this to inflate its own ranking.
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
 * PRIORITY_REQUESTS_PER_BILL each; what is left is split between the ladder
 * head and the least-recently-checked tail exactly as before (TAIL_SHARE), with
 * the overflow absorbing any remainder the tail cannot use. Returns the bills
 * in processing order and the request count, which never exceeds `topN`.
 *
 * @param {{ ranked: {b: any, eff: number}[], prioritySlugs?: string[], topN: number, tailShare: number, checkedAt?: Record<string,string> }} args
 */
export function planCoverageRun({ ranked, prioritySlugs = [], topN, tailShare, checkedAt = {} }) {
  const budget = Math.max(0, Math.floor(topN));
  const bySlug = new Map(ranked.map((e) => [coverageSlug(e.b), e]));
  const maxPriority = Math.floor(budget / PRIORITY_REQUESTS_PER_BILL);
  const priority = [];
  const skipped = [];
  for (const slug of prioritySlugs) {
    const e = bySlug.get(slug);
    if (!e) {
      skipped.push(slug);
      continue;
    }
    if (priority.length >= maxPriority) break;
    if (!priority.includes(e)) priority.push(e);
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
    /** Priority slugs that are not in tonight's eligible set (terminal past grace, undecoded, unknown). */
    skipped,
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
