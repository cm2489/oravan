/*
 * BIG QUESTION PRESS COUNTS — which AllSides-rated outlets covered each live
 * Big Question this week, found by one GDELT search per question per lean,
 * kept as checkable evidence (outlet, lean, the day GDELT saw it, the link).
 *
 * The pure half. The I/O half is scripts/gdelt-intake.mjs; the CI gate is
 * scripts/check-question-press.mjs; the nightly re-check is in
 * scripts/verify-sync.mjs. Nothing in here touches the network or the disk.
 *
 * ---- WHY THIS EXISTS -------------------------------------------------------
 * The news lamp (lib/conversation.mjs) matches HEADLINES to ONE BILL each, and
 * the 2026-09-25 recall audit measured what that loses on a live question: on
 * the 2026-09-24 Senate Iran war-powers vote at least 17 rated outlets
 * published within a day, and the question's vehicles held 2 of them — the
 * press writes "war powers", not "H.Con.Res. 89", and a question has up to ten
 * near-identical resolutions to scatter over. The owner's ruling (relayed
 * 2026-09-26): keep today's ONE generic Google News search, add NO more Google
 * News queries, and take per-question intake from GDELT — counts only.
 *
 * ---- WHAT THIS FILE IS NOT (the boundaries are the feature) ---------------
 *   - NOT an input to scripts/moment-candidates.mjs. Evidence gathered BECAUSE
 *     a question is live must never count toward whether a question should be
 *     live — a live question would inflate its own ranking. The candidate
 *     report reads data/conversation.json and nothing here;
 *     tests/question-press.unit.spec.ts fails if that ever changes.
 *   - NOT on the homepage. Whether a question-level card may enter the news
 *     band is an open owner decision, so no page, component, API route or
 *     lib/*.ts reads this file. Same test.
 *   - NOT tone, sentiment, or text. GDELT publishes tone scores; using them
 *     would put Oravan's voice on "what the coverage means", which the
 *     editorial law forbids. The request is ArtList mode only, and the parser
 *     keeps four fields (url, domain, seendate, title) — the title lives in
 *     memory for one run-log diagnostic and is never stored. News text never
 *     reaches a Big Question's prose or any model prompt from here: there is no
 *     model call anywhere on this path.
 *   - NOT unrated outlets. Only a domain data/media-bias.json rates (AllSides)
 *     is queried, stored or counted — the same B-3 gate the lamp uses
 *     (`leanOf`), imported rather than copied. `OUTLET_POLICY` names the rule.
 *     The owner's outlet floor (lib/press-outlets.mjs, owner ruling
 *     2026-09-26) is "rated, plus an optional approved allowlist", and this
 *     file deliberately takes only the rated half for now: an allowlisted
 *     outlet carries no lean, and every search and count here is per lean.
 *     If the owner trials an allowlist, it plugs in as a fourth, lean-less
 *     search group in `eligibleDomainsByLean`, with the gate in
 *     `verifyQuestionPress` widened in the same change;
 *     scripts/gdelt-intake.mjs says so in the run log the day one exists.
 *   - NOT a second definition of an article link. Links go through the lamp's
 *     B-5 gate (`normalizeArticleUrl`, lib/conversation.mjs), so this file and
 *     the news band agree byte for byte on what a checkable link is.
 *
 * ---- NONPARTISAN BY CONSTRUCTION ------------------------------------------
 * ONE QUERY PER LEAN. Each question is searched three times, once restricted to
 * the left-rated domains, once to center, once to right. GDELT returns at most
 * 250 articles per request, so a single mixed query on a big news day would
 * let whichever side published most crowd the others out of the window. Split
 * by lean, each side gets its own window, and no lean's volume can hide
 * another's coverage.
 *
 * ALL THREE OR NOTHING. A question's evidence moves only when all three lean
 * searches came back. If the right-lean search is rate-limited and the left
 * one succeeds, recording the left result would show a one-sided week that
 * never happened, so the whole question carries forward unchanged and is
 * retried on a later run.
 *
 * THE TERMS (plan §4, the alias rules), applied by `questionTerms`:
 *   1. Only multi-word phrases. A single word ("iran", "hormuz", "shutdown")
 *      OR'd with a congressional word pulls campaign and war-politics stories
 *      that are about the topic, not the question in front of Congress.
 *   2. Bill-number aliases are placeholders, not press vocabulary ("S. 3172":
 *      0 of 10 Iran headlines and 0 of 23 college-sports slugs carried a bill
 *      number in the audit), so they are dropped too.
 *   3. Every query ANDs a legislative context word (`LEGISLATIVE_CONTEXT_TERMS`,
 *      no party nouns, both chambers).
 *   4. Sponsors: every lead sponsor or none — and here it is none, for two
 *      reasons that do not depend on each other. The corpus stores ONE sponsor
 *      per bill and no co-leads, so the set is never known to be complete, and
 *      one senator's surname on a bipartisan bill skews recall toward coverage
 *      of that senator. And in a full-text search a surname can only ever be
 *      ANDed with a topic term that already matches, so it could narrow recall
 *      but never widen it. No sponsor name ever enters a query.
 *   The terms are the question's own `aliases.en` (data/moments.json) plus
 *   each vehicle's bill names (`press_names`, `short_title`). The
 *   AI-generated per-bill `news_query` phrases are deliberately NOT used:
 *   "fiscal 2027" and "troop levels" match every appropriations story. The
 *   exact terms used are stored beside the evidence, so anyone can re-run the
 *   search.
 *
 * LEAN PARITY IS MEASURED, NOT ASSUMED. Alias vocabulary can skew by lean (one
 * side says "Iran war", the other the operation's name). Every run logs, per
 * question, the rated outlets found per lean against the number of rated
 * domains searched per lean (`leanParity`), what the lamp holds for the same
 * vehicles (`lampLeanCounts`), and which term each outlet's title carried
 * (`termTitleHits`, counts only). The log is where a skewed alias shows up.
 *
 * ---- ATTRIBUTION (GDELT's terms) -------------------------------------------
 * gdeltproject.org/about: use is "unlimited and unrestricted … for any
 * academic, commercial, or governmental use", and "any use or redistribution
 * of the data must include a citation to the GDELT Project and a link to this
 * website (https://www.gdeltproject.org/)". This file is committed to a public
 * repository, which is redistribution, so the citation and link travel inside
 * it (`_meta.attribution`, checked by the gate). Any page that ever renders
 * these counts must carry the same citation and link in both languages — that
 * copy is owner scope and does not exist yet, which is one more reason nothing
 * renders this file today.
 */
import { RATED_LEANS, dayKey, daysBetween, leanOf, normalizeArticleUrl, normalizeDomain } from './conversation.mjs';

export const QUESTION_PRESS_PATH = 'data/question-press.json';
export const QUESTION_PRESS_SCHEMA = 'question-press/v1';

/** The rolling evidence window, in days — "this week", the same claim the lamp makes. */
export const QUESTION_PRESS_WINDOW_DAYS = 7;

/** At most this many links kept per outlet per question (newest first). The
 *  OUTLET count is what matters and is never capped; this only bounds the
 *  file on a week one outlet runs twenty stories. */
export const MAX_ARTICLES_PER_OUTLET = 5;

/** File-size tripwire: six questions × every rated outlet × five links is
 *  ~350 KB at the absolute ceiling; a real week is a few tens of KB. */
export const QUESTION_PRESS_MAX_BYTES = 512 * 1024;

/** Upper bound on search terms per question, so one question's alias list
 *  can never grow a query GDELT refuses. Aliases come first (the owner's
 *  vocabulary), then bill names, in file order. */
export const MAX_TERMS_PER_QUESTION = 12;

/** The outlet rule, named so the gate and the writer cite the same thing. */
export const OUTLET_POLICY = 'allsides-rated-only';

export const GDELT_HOME = 'https://www.gdeltproject.org/';
export const GDELT_DOC_ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';
export const GDELT_ATTRIBUTION =
  'Article discovery by the GDELT Project (https://www.gdeltproject.org/), used under its terms of use with citation and link. Outlet leans by AllSides (https://www.allsides.com/media-bias/ratings), CC BY-NC 4.0.';

/** GDELT's own ceiling for ArtList mode. */
export const GDELT_MAX_RECORDS = 250;

/** Words that make a match about CONGRESS rather than about the topic in
 *  general. Symmetric on purpose: both chambers, no party nouns. "house" on
 *  its own is left out because every "White House" story carries it; the two
 *  House phrases keep the chamber represented. */
export const LEGISLATIVE_CONTEXT_TERMS = Object.freeze([
  'congress',
  'congressional',
  'senate',
  'senators',
  'representatives',
  'lawmakers',
  'legislation',
  'house vote',
  'house floor',
]);

/** Every key an evidence document may carry, at every level. The gate
 *  rejects anything else — which is how "never tone, never text" is enforced
 *  on the file and not only promised in this comment. */
const META_KEYS = ['schema', 'source', 'attribution', 'window_days', 'outlet_policy', 'bias_table', 'stores'];
const ENTRY_KEYS = ['checkedOn', 'terms', 'counts', 'outlets'];
const OUTLET_KEYS = ['domain', 'lean', 'firstSeen', 'lastSeen', 'articles'];
const ARTICLE_KEYS = ['url', 'seen'];

// ---- terms -----------------------------------------------------------------

/** A bill citation used as an alias: "S. 3172", "H.R. 8800", "H.Con.Res. 89",
 *  "S.J.Res. 185", "hr-3633". */
const CITATION_RE = /^(h\.?\s*r|s|h\.?\s*res|s\.?\s*res|h\.?\s*j\.?\s*res|s\.?\s*j\.?\s*res|h\.?\s*con\.?\s*res|s\.?\s*con\.?\s*res|hr|hres|sres|hjres|sjres|hconres|sconres)\.?[\s-]*\d+(-\d+)?$/i;

/** Lowercase, collapse whitespace, strip the characters GDELT's query syntax
 *  owns (quotes and parentheses), so a term can never break out of its phrase.
 * @param {unknown} raw
 */
export function normalizeTerm(raw) {
  return String(raw ?? '')
    .replace(/["()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** "Protect College Sports Act of 2026" -> "Protect College Sports Act". */
function stripYearSuffix(name) {
  return String(name ?? '').replace(/\s+of\s+(19|20)\d{2}\s*$/i, '');
}

/**
 * The search terms for one question, by the alias rules in the header.
 *
 * @param {{ aliases?: { en?: string[] }, vehicles?: Array<{ slug: string }> }} moment
 * @param {Map<string, any> | Record<string, any>} billsBySlug data/bills.json records keyed by full_identifier
 * @returns {{ terms: string[], dropped: Array<{ term: string, source: 'alias' | 'name', reason: string }> }}
 */
export function questionTerms(moment, billsBySlug) {
  const lookup = (slug) => (billsBySlug instanceof Map ? billsBySlug.get(slug) : billsBySlug?.[slug]);
  /** @type {Array<{ raw: string, source: 'alias' | 'name' }>} */
  const candidates = [];
  for (const a of moment?.aliases?.en ?? []) candidates.push({ raw: a, source: 'alias' });
  for (const v of moment?.vehicles ?? []) {
    const bill = lookup(v?.slug);
    if (!bill) continue;
    for (const n of bill.press_names ?? []) candidates.push({ raw: stripYearSuffix(n), source: 'name' });
    if (bill.short_title) candidates.push({ raw: stripYearSuffix(bill.short_title), source: 'name' });
  }
  const terms = [];
  const dropped = [];
  const seen = new Set();
  for (const { raw, source } of candidates) {
    const term = normalizeTerm(raw);
    let reason = null;
    if (!term) reason = 'empty';
    else if (CITATION_RE.test(term)) reason = 'bill number (a placeholder, not press vocabulary)';
    else if (term.split(' ').length < 2) reason = 'single word';
    else if (seen.has(term)) reason = 'duplicate';
    else if (terms.length >= MAX_TERMS_PER_QUESTION) reason = `over the ${MAX_TERMS_PER_QUESTION}-term cap`;
    if (reason) {
      if (reason !== 'duplicate') dropped.push({ term: term || String(raw ?? ''), source, reason });
      continue;
    }
    seen.add(term);
    terms.push(term);
  }
  return { terms, dropped };
}

// ---- outlets ----------------------------------------------------------------

/**
 * The domains each lean's search is restricted to: every domain
 * data/media-bias.json rates, grouped by lean, sorted. THE OUTLET POLICY
 * SEAM: an owner allowlist, if one is ever trialled, is added here and in
 * `verifyQuestionPress` in the same change — nowhere else decides who counts.
 *
 * @param {Record<string, string>} bias data/media-bias.json's `outlets` map
 * @returns {Record<'left' | 'center' | 'right', string[]>}
 */
export function eligibleDomainsByLean(bias) {
  /** @type {Record<string, string[]>} */
  const out = { left: [], center: [], right: [] };
  for (const domain of Object.keys(bias ?? {})) {
    const lean = leanOf(domain, bias);
    const bare = normalizeDomain(domain);
    if (lean && bare === domain) out[lean].push(domain);
  }
  for (const lean of RATED_LEANS) out[lean].sort();
  return /** @type {Record<'left' | 'center' | 'right', string[]>} */ (out);
}

// ---- the request -------------------------------------------------------------

/** @param {string} t */
function quoteIfPhrase(t) {
  return t.includes(' ') ? `"${t}"` : t;
}

/** GDELT's OR syntax: parentheses around two or more, "OR" between. A single
 *  item goes bare — a one-item group is not a documented form.
 * @param {string[]} items */
function orBlock(items) {
  if (items.length === 1) return items[0];
  return `(${items.join(' OR ')})`;
}

/**
 * The GDELT query for one question and one lean's domains:
 *   (term OR term …) (congress OR senate …) (domainis:a OR domainis:b …)
 * Three OR groups side by side are ANDed; none is nested inside another,
 * which GDELT does not support.
 *
 * @param {{ terms: string[], domains: string[] }} input
 */
export function buildGdeltQuery({ terms, domains }) {
  if (!terms?.length) throw new Error('buildGdeltQuery: no terms');
  if (!domains?.length) throw new Error('buildGdeltQuery: no domains');
  return [
    orBlock(terms.map((t) => quoteIfPhrase(normalizeTerm(t)))),
    orBlock(LEGISLATIVE_CONTEXT_TERMS.map(quoteIfPhrase)),
    orBlock(domains.map((d) => `domainis:${d}`)),
  ].join(' ');
}

/**
 * The full request URL. ArtList mode and nothing else: the only fields this
 * pipeline can ever see are the article list's. Sorted newest first so a
 * window that overflows GDELT's 250-record ceiling keeps the latest coverage.
 *
 * @param {{ query: string, timespanDays: number, maxRecords?: number }} input
 */
export function gdeltUrl({ query, timespanDays, maxRecords = GDELT_MAX_RECORDS }) {
  const days = Math.max(1, Math.min(QUESTION_PRESS_WINDOW_DAYS, Math.round(timespanDays)));
  const u = new URL(GDELT_DOC_ENDPOINT);
  u.searchParams.set('query', query);
  u.searchParams.set('mode', 'ArtList');
  u.searchParams.set('format', 'json');
  u.searchParams.set('maxrecords', String(Math.min(GDELT_MAX_RECORDS, maxRecords)));
  u.searchParams.set('timespan', `${days}d`);
  u.searchParams.set('sort', 'DateDesc');
  return u.toString();
}

/**
 * How far back this run searches for one question: from the last day it was
 * checked (inclusive, so a late-evening story is never missed), clamped to
 * [2, window] days. A question never checked searches the whole window.
 *
 * @param {string | null | undefined} checkedOn
 * @param {string} today
 */
export function timespanFor(checkedOn, today) {
  const gap = daysBetween(checkedOn, today);
  if (!Number.isFinite(gap) || gap < 0) return QUESTION_PRESS_WINDOW_DAYS;
  return Math.max(2, Math.min(QUESTION_PRESS_WINDOW_DAYS, gap + 1));
}

// ---- the response --------------------------------------------------------------

/** "20260924T211500Z" -> "2026-09-24", or null. GDELT's seendate is when
 *  GDELT saw the article, which the stored field name (`seen`) says. */
export function seenDay(seendate) {
  const m = /^(\d{4})(\d{2})(\d{2})T\d{6}Z$/.exec(String(seendate ?? ''));
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isFinite(Date.parse(`${day}T00:00:00Z`)) ? day : null;
}

/** Does the URL's host belong to the outlet domain (itself or a subdomain)? */
export function urlBelongsTo(url, domain) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

/**
 * Parse one ArtList JSON body. GDELT answers a bad query with HTTP 200 and a
 * plain-text sentence, and a query with no matches with `{}` — so "not JSON"
 * is an error and "no articles key" is an empty result.
 *
 * Keeps url, domain, seendate and title ONLY. Tone, language, source country,
 * images: never read.
 *
 * @param {string} body
 * @returns {{ ok: true, articles: Array<{ url: string, domain: string, seendate: string, title: string }> } | { ok: false, error: string }}
 */
export function parseArtList(body) {
  const text = String(body ?? '');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // One retry with raw control characters blanked. A raw control character
    // is never valid inside a JSON string and is whitespace-equivalent
    // outside one, so blanking them cannot change what a valid document
    // means — it only rescues a body whose article titles carried one.
    // (GDELT's JSON is reported to do this now and then — UNVERIFIED here,
    // since every live request from this build's measurement machine was
    // rate-limited; the retry costs nothing if it never happens.)
    try {
      json = JSON.parse(text.replace(/[\u0000-\u001f]/g, ' '));
    } catch {
      return { ok: false, error: `not JSON: ${text.replace(/\s+/g, ' ').trim().slice(0, 160)}` };
    }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, error: 'not a JSON object' };
  if (json.articles === undefined) return { ok: true, articles: [] };
  if (!Array.isArray(json.articles)) return { ok: false, error: '`articles` is not an array' };
  return {
    ok: true,
    articles: json.articles.map((a) => ({
      url: String(a?.url ?? ''),
      domain: String(a?.domain ?? ''),
      seendate: String(a?.seendate ?? ''),
      title: String(a?.title ?? ''),
    })),
  };
}

/**
 * Turn one lean's parsed articles into admissible evidence. An article is
 * admitted only when ALL hold: its domain is rated, and rated as the lean the
 * search was restricted to (a defensive check — the query already restricts
 * it); its URL is http(s) on that domain; GDELT's seen-day parses and falls
 * inside the window ending today.
 *
 * @param {Array<{ url: string, domain: string, seendate: string, title?: string }>} articles
 * @param {{ lean: 'left' | 'center' | 'right', bias: Record<string, string>, today: string }} ctx
 * @returns {{ admitted: Array<{ url: string, domain: string, lean: string, seen: string, title: string }>, rejected: number }}
 */
export function admitArticles(articles, { lean, bias, today }) {
  const admitted = [];
  let rejected = 0;
  for (const a of articles ?? []) {
    const domain = normalizeDomain(a.domain);
    const url = normalizeArticleUrl(a.url);
    const seen = seenDay(a.seendate);
    const age = daysBetween(seen, today);
    if (
      !domain ||
      leanOf(domain, bias) !== lean ||
      !url ||
      !urlBelongsTo(url, domain) ||
      !seen ||
      age < 0 ||
      age >= QUESTION_PRESS_WINDOW_DAYS
    ) {
      rejected++;
      continue;
    }
    admitted.push({ url, domain, lean, seen, title: String(a.title ?? '') });
  }
  return { admitted, rejected };
}

// ---- the evidence document -------------------------------------------------------

/** Newest link first, then URL — deterministic, so two runs that saw the
 *  same links serialize identically and `shouldWrite` can compare them.
 * @param {Array<{ url: string, seen: string }>} list */
function sortOutletArticles(list) {
  return [...list].sort((a, b) => String(b.seen).localeCompare(String(a.seen)) || String(a.url).localeCompare(String(b.url)));
}

/**
 * Counts derived from the stored evidence and nothing else — so every number
 * in `counts` is a number of links a reader can open.
 * @param {Array<{ lean: string, articles: any[] }>} outlets
 */
export function countsFor(outlets) {
  const counts = {
    outlets: { left: 0, center: 0, right: 0 },
    articles: { left: 0, center: 0, right: 0 },
  };
  for (const o of outlets ?? []) {
    if (!RATED_LEANS.includes(o?.lean)) continue;
    counts.outlets[o.lean] += 1;
    counts.articles[o.lean] += Array.isArray(o.articles) ? o.articles.length : 0;
  }
  return counts;
}

/**
 * Fold one question's evidence: the previous entry's articles, pruned to the
 * window and re-judged against the CURRENT bias table (an outlet that lost its
 * rating leaves; an outlet re-rated moves lean), plus this run's admitted
 * articles. Dedupe by URL, newest links first, capped per outlet; each
 * outlet's first/last-seen days are read off its stored links, so every date
 * is checkable too.
 *
 * @param {any} prev previous entry (or undefined)
 * @param {{ admitted?: Array<{ url: string, domain: string, seen: string }>, bias: Record<string, string>, today: string }} input
 * @returns {Array<{ domain: string, lean: string, firstSeen: string, lastSeen: string, articles: Array<{ url: string, seen: string }> }>}
 */
export function foldOutlets(prev, { admitted, bias, today }) {
  /** @type {Map<string, Map<string, string>>} domain -> url -> seen */
  const byDomain = new Map();
  const add = (domain, url, seen) => {
    const age = daysBetween(seen, today);
    if (!(age >= 0 && age < QUESTION_PRESS_WINDOW_DAYS)) return;
    if (!byDomain.has(domain)) byDomain.set(domain, new Map());
    const urls = byDomain.get(domain);
    // The same link seen on two days keeps the EARLIER day: when an article
    // first appeared is a fact about the article, not about when we re-ran.
    const had = urls.get(url);
    if (!had || seen < had) urls.set(url, seen);
  };
  for (const o of prev?.outlets ?? []) {
    const domain = normalizeDomain(o?.domain);
    if (!domain) continue;
    for (const a of o?.articles ?? []) {
      const url = normalizeArticleUrl(a?.url);
      if (url && urlBelongsTo(url, domain) && seenDayShape(a?.seen)) add(domain, url, a.seen);
    }
  }
  for (const a of admitted ?? []) add(a.domain, a.url, a.seen);

  const outlets = [];
  for (const [domain, urls] of byDomain) {
    const lean = leanOf(domain, bias);
    if (!lean) continue; // rated-only: an outlet whose rating was withdrawn leaves the evidence
    const articles = sortOutletArticles([...urls].map(([url, seen]) => ({ url, seen }))).slice(0, MAX_ARTICLES_PER_OUTLET);
    if (articles.length === 0) continue;
    const days = articles.map((a) => a.seen).sort();
    outlets.push({ domain, lean, firstSeen: days[0], lastSeen: days[days.length - 1], articles });
  }
  return outlets.sort(
    (a, b) => RATED_LEANS.indexOf(a.lean) - RATED_LEANS.indexOf(b.lean) || a.domain.localeCompare(b.domain)
  );
}

function seenDayShape(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));
}

/** @param {Record<string, any>} obj */
function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Build the next document.
 *
 * `results` holds only the questions this run finished — ALL THREE lean
 * searches answered. Every other live question is carried forward (pruned and
 * re-judged, its `checkedOn` and `terms` untouched). A question that is no
 * longer live leaves the file. A question with no carried entry and no result
 * is simply absent: absence means "not checked", never "no coverage".
 *
 * @param {{
 *   previous?: any,
 *   liveIds: Iterable<string>,
 *   results?: Map<string, { terms: string[], admitted: Array<{ url: string, domain: string, seen: string }> }>,
 *   bias: Record<string, string>,
 *   today: string,
 * }} input
 */
export function buildQuestionPress({ previous, liveIds, results, bias, today }) {
  const prevQ = previous?.questions ?? {};
  /** @type {Record<string, any>} */
  const questions = {};
  for (const id of liveIds) {
    const done = results?.get(id);
    const prev = prevQ[id];
    if (!done && !prev) continue;
    const outlets = foldOutlets(prev, { admitted: done ? done.admitted : [], bias, today });
    questions[id] = {
      checkedOn: done ? today : prev.checkedOn,
      terms: done ? [...done.terms] : [...(prev.terms ?? [])],
      counts: countsFor(outlets),
      outlets,
    };
  }
  return {
    _meta: {
      schema: QUESTION_PRESS_SCHEMA,
      source: `GDELT DOC 2.0 API (${GDELT_DOC_ENDPOINT}), ArtList mode — one search per question per AllSides lean`,
      attribution: GDELT_ATTRIBUTION,
      window_days: QUESTION_PRESS_WINDOW_DAYS,
      outlet_policy: OUTLET_POLICY,
      bias_table: 'data/media-bias.json',
      stores:
        'Per question: the exact search terms, the day it was last checked, and for each AllSides-rated outlet GDELT found, its domain, lean, the days GDELT saw it and up to five article links. Never titles, article text, tone or sentiment.',
    },
    questions: sortKeys(questions),
  };
}

/** Every claim here is day-granular, so the whole document IS the material
 *  fingerprint: a re-run on the same day that found nothing new writes
 *  nothing. */
export function shouldWrite({ previous, next }) {
  if (!previous) return true;
  return JSON.stringify(previous) !== JSON.stringify(next);
}

// ---- lean parity (run log only) --------------------------------------------------

/**
 * Rated outlets found per lean, against how many rated domains that lean's
 * search covered — the denominator matters: the table rates 32 left, 20
 * center and 25 right domains, so raw counts alone would read a structural
 * difference in the table as a difference in coverage.
 *
 * @param {any} entry a question entry
 * @param {Record<string, string[]>} domainsByLean
 */
export function leanParity(entry, domainsByLean) {
  const counts = countsFor(entry?.outlets ?? []);
  return Object.fromEntries(
    RATED_LEANS.map((lean) => {
      const searched = domainsByLean?.[lean]?.length ?? 0;
      const outlets = counts.outlets[lean];
      return [lean, { outlets, articles: counts.articles[lean], searched, share: searched ? outlets / searched : 0 }];
    })
  );
}

/**
 * What the news lamp (data/conversation.json) holds for the same question —
 * rated outlets across all of its vehicles, within the lamp's own window.
 * Read for the run log's comparison ONLY; nothing here is written back.
 *
 * @param {any} conversation
 * @param {string[]} vehicleSlugs
 * @param {string} today
 * @returns {Record<'left' | 'center' | 'right', string[]>}
 */
export function lampLeanCounts(conversation, vehicleSlugs, today) {
  const window = conversation?._meta?.window_days ?? QUESTION_PRESS_WINDOW_DAYS;
  /** @type {Record<string, Set<string>>} */
  const sets = { left: new Set(), center: new Set(), right: new Set() };
  for (const slug of vehicleSlugs ?? []) {
    for (const o of conversation?.slugs?.[slug]?.outlets7d ?? []) {
      const age = daysBetween(o?.lastSeen, today);
      if (RATED_LEANS.includes(o?.lean) && age >= 0 && age <= window) sets[o.lean].add(o.domain);
    }
  }
  return /** @type {Record<'left' | 'center' | 'right', string[]>} */ (
    Object.fromEntries(RATED_LEANS.map((l) => [l, [...sets[l]].sort()]))
  );
}

/**
 * For each search term, how many admitted articles per lean carried it in
 * their TITLE. A diagnostic for the one skew the plan names — alias
 * vocabulary one side uses and the other doesn't. GDELT matches full text, so
 * this undercounts; it is printed as counts and the titles are never stored.
 *
 * @param {Array<{ lean: string, title?: string }>} admitted
 * @param {string[]} terms
 */
export function termTitleHits(admitted, terms) {
  return Object.fromEntries(
    (terms ?? []).map((t) => {
      const hits = { left: 0, center: 0, right: 0 };
      for (const a of admitted ?? []) {
        if (RATED_LEANS.includes(a.lean) && normalizeTerm(a.title).includes(t)) hits[a.lean] += 1;
      }
      return [t, hits];
    })
  );
}

// ---- the gate ------------------------------------------------------------------

/**
 * The CI gate and the nightly re-check share this judgement.
 *
 * FAILS on: an unknown schema or window; a missing GDELT citation or link;
 * any key the format does not define (this is where "never tone, never text"
 * is enforced); a question id data/moments.json does not know; a term that
 * breaks the alias rules; an outlet with no AllSides rating, or a lean that
 * disagrees with data/media-bias.json; a link that is not http(s) on its
 * outlet's own domain, or appears twice in one question; a day outside the
 * window or in the future; more links than the per-outlet cap; first/last-seen
 * days that are not the stored links' own; counts that are not the stored
 * evidence's own; a file past its size ceiling.
 *
 * WARNS on: a question that is no longer live (the next run drops it), and a
 * question not checked for more than two days (the search is failing).
 *
 * @param {{ data: any, fileBytes?: number, bias?: Record<string, string> | null, moments?: Record<string, any> | null, now?: number }} input
 */
export function verifyQuestionPress({ data, fileBytes = 0, bias = null, moments = null, now = Date.now() }) {
  const failures = [];
  const warnings = [];
  const notes = [];
  const today = dayKey(now);
  const fail = (m) => failures.push(m);

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    fail('question-press: not a JSON object');
    return { failures, warnings, notes };
  }
  if (fileBytes > QUESTION_PRESS_MAX_BYTES) fail(`question-press: ${fileBytes} bytes exceeds the ${QUESTION_PRESS_MAX_BYTES}-byte ceiling`);
  for (const k of Object.keys(data)) if (k !== '_meta' && k !== 'questions') fail(`question-press: unknown top-level key "${k}"`);
  const meta = data._meta ?? {};
  for (const k of Object.keys(meta)) if (!META_KEYS.includes(k)) fail(`question-press: unknown _meta key "${k}"`);
  if (meta.schema !== QUESTION_PRESS_SCHEMA) fail(`question-press: schema ${JSON.stringify(meta.schema)} is not ${QUESTION_PRESS_SCHEMA}`);
  if (meta.window_days !== QUESTION_PRESS_WINDOW_DAYS) fail(`question-press: window_days ${JSON.stringify(meta.window_days)} is not ${QUESTION_PRESS_WINDOW_DAYS}`);
  if (meta.outlet_policy !== OUTLET_POLICY) fail(`question-press: outlet_policy ${JSON.stringify(meta.outlet_policy)} is not ${OUTLET_POLICY}`);
  if (typeof meta.attribution !== 'string' || !meta.attribution.includes('GDELT Project') || !meta.attribution.includes(GDELT_HOME)) {
    fail(`question-press: _meta.attribution must cite the GDELT Project and link ${GDELT_HOME} (GDELT's terms of use)`);
  }
  const questions = data.questions;
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    fail('question-press: `questions` is not an object');
    return { failures, warnings, notes };
  }

  let outletTotal = 0;
  for (const [id, entry] of Object.entries(questions)) {
    const at = `question-press: ${id}`;
    if (moments) {
      if (!moments[id]) fail(`${at}: no such question in data/moments.json`);
      else if (moments[id].status !== 'live') warnings.push(`${at}: the question is no longer live — the next collection drops it`);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`${at}: entry is not an object`);
      continue;
    }
    for (const k of Object.keys(entry)) if (!ENTRY_KEYS.includes(k)) fail(`${at}: unknown key "${k}"`);
    if (!seenDayShape(entry.checkedOn)) fail(`${at}: checkedOn ${JSON.stringify(entry.checkedOn)} is not a YYYY-MM-DD day`);
    else if (daysBetween(entry.checkedOn, today) < 0) fail(`${at}: checkedOn ${entry.checkedOn} is in the future`);
    else if (daysBetween(entry.checkedOn, today) > 2) warnings.push(`${at}: last checked ${entry.checkedOn} — the GDELT search has not succeeded for ${daysBetween(entry.checkedOn, today)} days`);
    if (!Array.isArray(entry.terms) || entry.terms.length === 0) fail(`${at}: no search terms recorded`);
    else {
      for (const t of entry.terms) {
        if (typeof t !== 'string' || normalizeTerm(t) !== t) fail(`${at}: term ${JSON.stringify(t)} is not normalized`);
        else if (t.split(' ').length < 2) fail(`${at}: single-word term "${t}" (the alias rules allow phrases only)`);
        else if (CITATION_RE.test(t)) fail(`${at}: bill-number term "${t}"`);
      }
      if (entry.terms.length > MAX_TERMS_PER_QUESTION) fail(`${at}: ${entry.terms.length} terms exceeds the ${MAX_TERMS_PER_QUESTION}-term cap`);
    }
    if (!Array.isArray(entry.outlets)) {
      fail(`${at}: outlets is not an array`);
      continue;
    }
    const urls = new Set();
    for (const o of entry.outlets) {
      const oat = `${at}: outlet ${JSON.stringify(o?.domain)}`;
      if (!o || typeof o !== 'object') {
        fail(`${oat}: not an object`);
        continue;
      }
      for (const k of Object.keys(o)) if (!OUTLET_KEYS.includes(k)) fail(`${oat}: unknown key "${k}"`);
      const domain = normalizeDomain(o.domain);
      if (!domain || domain !== o.domain) fail(`${oat}: not a bare lowercase domain`);
      if (!RATED_LEANS.includes(o.lean)) fail(`${oat}: lean ${JSON.stringify(o.lean)} is not a rated lean`);
      if (bias) {
        const rated = leanOf(o.domain, bias);
        if (!rated) fail(`${oat}: data/media-bias.json carries no AllSides rating for it (${OUTLET_POLICY})`);
        else if (rated !== o.lean) fail(`${oat}: lean "${o.lean}" disagrees with data/media-bias.json ("${rated}")`);
      }
      const arts = Array.isArray(o.articles) ? o.articles : null;
      if (!arts || arts.length === 0) {
        fail(`${oat}: no article links — every counted outlet must carry evidence`);
        continue;
      }
      if (arts.length > MAX_ARTICLES_PER_OUTLET) fail(`${oat}: ${arts.length} links exceeds the ${MAX_ARTICLES_PER_OUTLET}-per-outlet cap`);
      const days = [];
      for (const a of arts) {
        for (const k of Object.keys(a ?? {})) if (!ARTICLE_KEYS.includes(k)) fail(`${oat}: article has unknown key "${k}"`);
        const url = typeof a?.url === 'string' ? a.url : '';
        if (!/^https?:\/\//.test(url) || normalizeArticleUrl(url) !== url) fail(`${oat}: link ${JSON.stringify(a?.url)} is not a normalized http(s) URL`);
        else if (!urlBelongsTo(url, o.domain)) fail(`${oat}: link ${url} is not on ${o.domain}`);
        if (urls.has(url)) fail(`${oat}: link ${url} appears twice in this question`);
        urls.add(url);
        if (!seenDayShape(a?.seen)) fail(`${oat}: seen ${JSON.stringify(a?.seen)} is not a YYYY-MM-DD day`);
        else {
          const age = daysBetween(a.seen, today);
          if (age < 0) fail(`${oat}: seen ${a.seen} is in the future`);
          else if (age >= QUESTION_PRESS_WINDOW_DAYS) fail(`${oat}: seen ${a.seen} is outside the ${QUESTION_PRESS_WINDOW_DAYS}-day window`);
          days.push(a.seen);
        }
      }
      days.sort();
      if (days.length && (o.firstSeen !== days[0] || o.lastSeen !== days[days.length - 1])) {
        fail(`${oat}: firstSeen/lastSeen (${o.firstSeen}/${o.lastSeen}) are not its links' own days (${days[0]}/${days[days.length - 1]})`);
      }
      outletTotal++;
    }
    const derived = countsFor(entry.outlets);
    if (JSON.stringify(entry.counts) !== JSON.stringify(derived)) {
      fail(`${at}: counts ${JSON.stringify(entry.counts)} are not the stored evidence's own ${JSON.stringify(derived)}`);
    }
  }
  notes.push(`question-press: ${Object.keys(questions).length} question(s), ${outletTotal} rated outlet record(s)`);
  return { failures, warnings, notes };
}
