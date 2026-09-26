/*
 * BIG QUESTION PRESS COUNTS — which AllSides-rated outlets covered each live
 * Big Question this week, found by short GDELT searches and filtered to rated
 * outlets HERE, kept as checkable evidence (outlet, lean, the day GDELT saw
 * it, the link).
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
 *     is stored or counted — the same B-3 gate the lamp uses (`leanOf`),
 *     imported rather than copied. `OUTLET_POLICY` names the rule. The owner's
 *     outlet floor (lib/press-outlets.mjs, owner ruling 2026-09-26) is "rated,
 *     plus an optional approved allowlist", and this file deliberately takes
 *     only the rated half for now: an allowlisted outlet carries no lean, and
 *     every count here is per lean. If the owner trials an allowlist, it plugs
 *     in at `ratedDomainFor` as a lean-less bucket, with the gate in
 *     `verifyQuestionPress` widened in the same change;
 *     scripts/gdelt-intake.mjs says so in the run log the day one exists.
 *   - NOT a second definition of an article link. Links go through the lamp's
 *     B-5 gate (`normalizeArticleUrl`, lib/conversation.mjs), so this file and
 *     the news band agree byte for byte on what a checkable link is.
 *
 * ---- THE QUERY: SHORT, AND THE SAME FOR EVERY LEAN ---------------------------
 * One request = ONE quoted multi-word phrase AND a small OR group of
 * legislative words, over a time window — and nothing else:
 *
 *     "war powers" (congress OR senate OR representatives OR lawmakers)
 *
 * (`QUERY_SHAPE`, `buildGdeltQuery`). No domain list. The first two builds of
 * this file put every rated domain of a lean into the query (`domainis:` ×
 * 8–32) and GDELT refused all of them — see `GDELT_MAX_QUERY_CHARS` for what
 * was measured. The rated-outlet filter now happens HERE, on the domains
 * GDELT returns (`ratedDomainFor`, `admitArticles`), so the query carries no
 * outlet at all.
 *
 * NONPARTISAN BY CONSTRUCTION. The query names no outlet and no lean, so it
 * is byte-identical for every lean: whatever GDELT returns, each lean is
 * judged by the same local rule against the same AllSides table. GDELT
 * returns at most 250 articles per request, newest first; a response that
 * fills all 250 is PAGED backwards in time (scripts/gdelt-intake.mjs), so the
 * cut, where one remains, is a cut in TIME — the same instant for every
 * outlet of every lean — never a cut by source. The run log prints any term
 * whose paging ran out, so a truncated week is never read as a quiet one.
 *
 * ALL OR NOTHING. A question's evidence moves only when every one of its
 * searches came back. If one term's request is rate-limited, recording the
 * others would show a narrower week than the one that happened, so the whole
 * question carries forward unchanged and is retried on a later run. The one
 * exception is a term GDELT REFUSES as a query ("too short or too long"): that
 * answer is deterministic — the same string is refused every time — so the
 * term is left out of this run's search with a ::warning:: carrying GDELT's
 * own sentence, and the stored `terms` are exactly the ones GDELT answered,
 * so anyone can re-run the search. Dropping a term drops it for every lean.
 *
 * THE TERMS (plan §4, the alias rules), applied by `questionTerms`:
 *   1. Only multi-word phrases. A single word ("iran", "hormuz", "shutdown")
 *      AND a congressional word pulls campaign and war-politics stories
 *      that are about the topic, not the question in front of Congress.
 *   2. Bill-number aliases are placeholders, not press vocabulary ("S. 3172":
 *      0 of 10 Iran headlines and 0 of 23 college-sports slugs carried a bill
 *      number in the audit), so they are dropped too.
 *   3. Every query ANDs a legislative context word (`LEGISLATIVE_CONTEXT_TERMS`:
 *      no party nouns, both chambers — "senate" beside "representatives", so
 *      neither chamber's coverage is favoured — and "congress"/"lawmakers"
 *      for coverage that names neither).
 *   4. Sponsors: every lead sponsor or none — and here it is none, for two
 *      reasons that do not depend on each other. The corpus stores ONE sponsor
 *      per bill and no co-leads, so the set is never known to be complete, and
 *      one senator's surname on a bipartisan bill skews recall toward coverage
 *      of that senator. And in a full-text search a surname can only ever be
 *      ANDed with a topic term that already matches, so it could narrow recall
 *      but never widen it. No sponsor name ever enters a query.
 *   5. A phrase whose query would exceed `GDELT_MAX_QUERY_CHARS` is dropped
 *      before it is ever sent, and the run log says so.
 *   The terms are the question's own `aliases.en` (data/moments.json) plus
 *   each vehicle's bill names (`press_names`, `short_title`). The
 *   AI-generated per-bill `news_query` phrases are deliberately NOT used:
 *   "fiscal 2027" and "troop levels" match every appropriations story. The
 *   exact terms searched and the query shape are stored beside the evidence.
 *
 * LEAN PARITY IS MEASURED, NOT ASSUMED. Alias vocabulary can skew by lean (one
 * side says "Iran war", the other the operation's name). Every run logs, per
 * question, the rated outlets found per lean against the number of rated
 * domains per lean (`leanParity`), what the lamp holds for the same vehicles
 * (`lampLeanCounts`), and which term each outlet's title carried
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

/** The rolling evidence window, in days — "this week", the same claim the lamp
 *  makes, measured the same way: a link is inside the window while it is 0 to
 *  7 whole days old (`inWindow`), exactly as lib/conversation.mjs's pruneList
 *  keeps an outlet and verifyConversation judges one. One definition, so the
 *  run log's lamp comparison compares like with like. */
export const QUESTION_PRESS_WINDOW_DAYS = 7;

/**
 * Is a day inside the window that ends on `asOf`? 0..QUESTION_PRESS_WINDOW_DAYS
 * whole days old, inclusive — never after `asOf`.
 * @param {string | null | undefined} day
 * @param {string} asOf
 */
export function inWindow(day, asOf) {
  const age = daysBetween(day, asOf);
  return age >= 0 && age <= QUESTION_PRESS_WINDOW_DAYS;
}

/** At most this many links kept per outlet per question (newest first). The
 *  OUTLET count is what matters and is never capped; this only bounds the
 *  file on a week one outlet runs twenty stories. */
export const MAX_ARTICLES_PER_OUTLET = 5;

/** File-size tripwire: seven questions × every rated outlet × five links is
 *  ~400 KB at the absolute ceiling; a real week is a few tens of KB. */
export const QUESTION_PRESS_MAX_BYTES = 512 * 1024;

/** Upper bound on search terms per question. Each term is its own request
 *  (plus pages on a heavy week), so this bounds one question's share of a
 *  run. Aliases come first (the owner's vocabulary), then bill names, in file
 *  order; eight is exactly the funding question's phrase count today. */
export const MAX_TERMS_PER_QUESTION = 8;

/** The outlet rule, named so the gate and the writer cite the same thing. */
export const OUTLET_POLICY = 'allsides-rated-only';

export const GDELT_HOME = 'https://www.gdeltproject.org/';
export const GDELT_DOC_ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';
export const GDELT_ATTRIBUTION =
  'Article discovery by the GDELT Project (https://www.gdeltproject.org/), used under its terms of use with citation and link. Outlet leans by AllSides (https://www.allsides.com/media-bias/ratings), CC BY-NC 4.0.';

/** GDELT's own ceiling for ArtList mode ("up to 250 results"). */
export const GDELT_MAX_RECORDS = 250;

/** The longest query this pipeline will ever SEND. GDELT's DOC 2.0 docs name
 *  no query-length limit; what is known was measured with this project's
 *  honest User-Agent:
 *
 *    REFUSED — HTTP 200 and the plain-text sentence "Your query was too short
 *    or too long." — on 2026-09-26 at 1,002, 976, 734, 583, 436 and 333
 *    characters: every query of the old shape (a phrase list, nine context
 *    words and 8–25 `domainis:` terms) that GDELT answered at all.
 *
 *    ANSWERED with an article list — see MEASURED_ACCEPTED below for the
 *    six requests of this pass, one per searchable live question, in the
 *    exact shape `buildGdeltQuery` + `gdeltUrl` produce.
 *
 *  The exact ceiling lies between the longest answered and the shortest
 *  refused and is NOT pinned further: finding it would cost requests that
 *  answer nothing about a live question. This cap is the longest length
 *  measured ANSWERED, rounded down — so no query is ever sent at a length
 *  GDELT has not already been seen to accept, and every query sits at under
 *  a third of the shortest length it refused. A phrase that would need more
 *  is dropped from the search with a logged reason (`questionTerms`), never
 *  sent to be refused.
 */
export const GDELT_MAX_QUERY_CHARS = 100;

/** Every query-length measurement behind `GDELT_MAX_QUERY_CHARS`, as data, so
 *  a test can hold the cap to it. `answered` = GDELT returned an article list
 *  (JSON); `refused` = GDELT returned "Your query was too short or too long."
 *  Requests that drew a 429 or no answer at all measure nothing about length
 *  and are not listed. */
export const GDELT_LENGTH_EVIDENCE = Object.freeze({
  answered: Object.freeze([
    { chars: 54, on: '2026-09-26', query: '"war powers" (congress OR senate) domainis:foxnews.com' },
  ]),
  refused: Object.freeze([
    { chars: 333, on: '2026-09-26', query: '"war powers" + 9 context words + 8 center domainis: terms' },
    { chars: 436, on: '2026-09-26', query: 'Iran terms + 9 context words + 8 center domainis: terms' },
    { chars: 583, on: '2026-09-26', query: 'Iran terms + 9 context words + 14 center domainis: terms' },
    { chars: 734, on: '2026-09-26', query: 'Iran terms + 9 context words + 20 center domainis: terms' },
    { chars: 976, on: '2026-09-26', query: 'funding terms (no two-letter words) + 25 right domainis: terms' },
    { chars: 1002, on: '2026-09-26', query: 'funding terms + 9 context words + 25 right domainis: terms' },
  ]),
});

/** Words that make a match about CONGRESS rather than about the topic in
 *  general. Symmetric on purpose: both chambers ("senate" and
 *  "representatives", as in "House of Representatives"), no party nouns.
 *  "house" alone is left out because every "White House" story carries it.
 *  Four words, not the nine the domain-list build carried: the group is part
 *  of every query, so it is kept to what the query needs. */
export const LEGISLATIVE_CONTEXT_TERMS = Object.freeze(['congress', 'senate', 'representatives', 'lawmakers']);

/** The one query shape, stored in the file so every count can be re-run. */
export const QUERY_SHAPE = `"<term>" (${LEGISLATIVE_CONTEXT_TERMS.join(' OR ')})`;

/** What a count means, stated in the file itself so no reader (or later
 *  renderer) mistakes it for more. GDELT searches an article's FULL TEXT, so
 *  a topical alias ("strait of hormuz") plus "congress" anywhere in the body
 *  matches coverage of the topic that mentions Congress, not only coverage of
 *  the vote. The run log's title-level reading (`titleTermShare`) is the
 *  precision measurement; this sentence is the claim's honest ceiling. */
export const MATCH_RULE =
  'An article counts when GDELT finds one of the question’s search terms AND one congressional word anywhere in its text — coverage of the topic that mentions Congress, not only coverage of the vote itself.';

/** Every key an evidence document may carry, at every level. The gate
 *  rejects anything else — which is how "never tone, never text" is enforced
 *  on the file and not only promised in this comment. `as_of` is the UTC day
 *  the window was last pruned against: every day in the file is judged
 *  against IT, never against the wall clock at check time (see the gate). */
const META_KEYS = ['schema', 'source', 'attribution', 'window_days', 'as_of', 'outlet_policy', 'bias_table', 'query_shape', 'matches', 'stores'];
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
 * @param {{ maxQueryChars?: number }} [opts]
 * @returns {{ terms: string[], dropped: Array<{ term: string, source: 'alias' | 'name', reason: string }> }}
 */
export function questionTerms(moment, billsBySlug, { maxQueryChars = GDELT_MAX_QUERY_CHARS } = {}) {
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
    else if (buildGdeltQuery(term).length > maxQueryChars) reason = `its query would be over the ${maxQueryChars}-character limit`;
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
 * How many domains data/media-bias.json rates per lean — the denominator of
 * the lean-parity line (the table rates 32 left, 20 center and 25 right, so a
 * raw count alone would read a difference in the table as a difference in
 * coverage). THE OUTLET POLICY SEAM: an owner allowlist, if one is ever
 * trialled, is added here, in `ratedDomainFor` and in `verifyQuestionPress`
 * in the same change — nowhere else decides who counts.
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

/**
 * The rated outlet an article belongs to, or null. THE LOCAL FILTER that
 * replaced the `domainis:` lists: GDELT's own `domain` field is tried first,
 * then the link's host and each parent of it ("edition.cnn.com" → "cnn.com",
 * "abcnews.go.com" stays itself because it is the rated key) — and whichever
 * rated domain matches, the LINK must be on it, so a page elsewhere that
 * merely names an outlet can never be counted as that outlet.
 *
 * @param {{ url: string, domain?: string }} article
 * @param {Record<string, string>} bias
 * @returns {{ domain: string, lean: 'left' | 'center' | 'right', url: string } | null}
 */
export function ratedDomainFor(article, bias) {
  const url = normalizeArticleUrl(article?.url);
  if (!url) return null;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  const candidates = [];
  const given = normalizeDomain(article?.domain);
  if (given) candidates.push(given);
  const labels = host.split('.');
  for (let i = 0; i <= labels.length - 2; i++) candidates.push(labels.slice(i).join('.'));
  for (const domain of candidates) {
    const lean = leanOf(domain, bias);
    if (lean && urlBelongsTo(url, domain)) return { domain, lean, url };
  }
  return null;
}

// ---- the request -------------------------------------------------------------

/**
 * The GDELT query for one term: `"<term>" (congress OR senate OR …)`. One
 * quoted phrase, one OR group, side by side (ANDed); no nesting, which GDELT
 * does not support; no outlet, no lean.
 *
 * @param {string} term
 */
export function buildGdeltQuery(term) {
  const t = normalizeTerm(term);
  if (!t) throw new Error('buildGdeltQuery: no term');
  return QUERY_SHAPE.replace('<term>', t);
}

/** Epoch ms -> GDELT's YYYYMMDDHHMMSS (UTC). @param {number} ms */
export function gdeltDateTime(ms) {
  return new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/**
 * The first day this run searches for one question: the day it was last
 * checked (inclusive — so a late-evening story is never missed, and a day the
 * collector did not run is searched on the next one), never earlier than the
 * start of the window, and the whole window for a question never checked.
 *
 * @param {string | null | undefined} checkedOn
 * @param {string} today
 * @returns {string} YYYY-MM-DD
 */
export function windowStartDay(checkedOn, today) {
  const earliest = dayKey(Date.parse(`${today}T00:00:00Z`) - QUESTION_PRESS_WINDOW_DAYS * 86_400_000);
  const gap = daysBetween(checkedOn, today);
  if (!Number.isFinite(gap) || gap < 0 || gap > QUESTION_PRESS_WINDOW_DAYS) return earliest;
  return /** @type {string} */ (checkedOn);
}

/**
 * The full request URL. ArtList mode and nothing else: the only fields this
 * pipeline can ever see are the article list's. Newest first, over an exact
 * window (GDELT's STARTDATETIME/ENDDATETIME, YYYYMMDDHHMMSS, "within the last 3
 * months"), so a response that fills all 250 records can be paged backwards
 * by moving `end` to the oldest article it returned.
 *
 * @param {{ query: string, startDay: string, end: number | string, maxRecords?: number }} input
 *   `end` is epoch ms or an already-formatted YYYYMMDDHHMMSS stamp.
 */
export function gdeltUrl({ query, startDay, end, maxRecords = GDELT_MAX_RECORDS }) {
  const u = new URL(GDELT_DOC_ENDPOINT);
  u.searchParams.set('query', query);
  u.searchParams.set('mode', 'ArtList');
  u.searchParams.set('format', 'json');
  u.searchParams.set('maxrecords', String(Math.min(GDELT_MAX_RECORDS, maxRecords)));
  u.searchParams.set('sort', 'DateDesc');
  u.searchParams.set('startdatetime', `${String(startDay).replace(/-/g, '')}000000`);
  u.searchParams.set('enddatetime', typeof end === 'number' ? gdeltDateTime(end) : String(end));
  return u.toString();
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

/** "20260924T211500Z" -> "20260924211500" (a GDELT ENDDATETIME), or null. */
export function seenStamp(seendate) {
  const m = /^(\d{8})T(\d{6})Z$/.exec(String(seendate ?? ''));
  return m ? `${m[1]}${m[2]}` : null;
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

/** GDELT's plain-text answer to a query it will not run. The first sentence
 *  is measured (2026-09-26); "is too short" is GDELT's documented-by-example
 *  answer to a too-short phrase and is UNVERIFIED here. Either is a verdict on
 *  the query string itself, so it is the same answer every time. */
export const QUERY_REFUSAL = /too short or too long|is too short/i;

/**
 * Parse one ArtList body, and say exactly what kind of answer it was:
 *   ok        — JSON with an `articles` list, or `{}` (GDELT's "no matches").
 *   refused   — GDELT's plain-text refusal of the query (QUERY_REFUSAL).
 *   empty     — a body with nothing in it. Never read as "no matches":
 *               absence is only ever recorded from an answer that says so.
 *   malformed — anything else (an HTML error page, a truncated body, JSON of
 *               the wrong shape).
 *
 * Keeps url, domain, seendate and title ONLY. Tone, language, source country,
 * images: never read.
 *
 * @param {string} body
 * @returns {{ ok: true, articles: Array<{ url: string, domain: string, seendate: string, title: string }> } | { ok: false, kind: 'refused' | 'empty' | 'malformed', error: string }}
 */
export function parseArtList(body) {
  const text = String(body ?? '');
  const head = text.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (text.trim() === '') return { ok: false, kind: 'empty', error: 'an empty body' };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // One retry with raw control characters blanked. A raw control character
    // is never valid inside a JSON string and is whitespace-equivalent
    // outside one, so blanking them cannot change what a valid document
    // means — it only rescues a body whose article titles carried one.
    // (UNVERIFIED that GDELT ever does this; the retry costs nothing if it
    // never happens.)
    try {
      json = JSON.parse(text.replace(/[\u0000-\u001f]/g, ' '));
    } catch {
      if (QUERY_REFUSAL.test(text)) return { ok: false, kind: 'refused', error: `GDELT refused the query: ${head}` };
      return { ok: false, kind: 'malformed', error: `not JSON: ${head}` };
    }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, kind: 'malformed', error: 'not a JSON object' };
  if (json.articles === undefined) return { ok: true, articles: [] };
  if (!Array.isArray(json.articles)) return { ok: false, kind: 'malformed', error: '`articles` is not an array' };
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
 * Turn parsed articles into admissible evidence. An article is admitted only
 * when ALL hold: it belongs to a domain data/media-bias.json rates
 * (`ratedDomainFor` — the link on that domain); GDELT's seen-day parses and
 * falls inside the window ending today (`inWindow`, the lamp's 0–7 days).
 *
 * The three non-admitted buckets are kept apart for the run log, because they
 * mean different things: `unrated` is the normal case (GDELT searches every
 * outlet it monitors, and most are not rated); `outOfWindow` is paging
 * overlap; `unreadable` — no usable link or seen-date — is what a changed
 * response shape looks like, and is the one that warns.
 *
 * @param {Array<{ url: string, domain: string, seendate: string, title?: string }>} articles
 * @param {{ bias: Record<string, string>, today: string }} ctx
 */
export function admitArticles(articles, { bias, today }) {
  /** @type {Array<{ url: string, domain: string, lean: 'left' | 'center' | 'right', seen: string, title: string }>} */
  const admitted = [];
  let unrated = 0;
  let outOfWindow = 0;
  let unreadable = 0;
  for (const a of articles ?? []) {
    const seen = seenDay(a?.seendate);
    if (!seen || !normalizeArticleUrl(a?.url)) {
      unreadable++;
      continue;
    }
    const rated = ratedDomainFor(a, bias);
    if (!rated) {
      unrated++;
      continue;
    }
    if (!inWindow(seen, today)) {
      outOfWindow++;
      continue;
    }
    admitted.push({ url: rated.url, domain: rated.domain, lean: rated.lean, seen, title: String(a.title ?? '') });
  }
  return { admitted, unrated, outOfWindow, unreadable };
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
    if (!inWindow(seen, today)) return;
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
 * `results` holds only the questions this run finished — EVERY search of the
 * question answered (a term GDELT refused as a query is not one of its
 * searches, and is not in its `terms`). Every other live question is carried forward (pruned and
 * re-judged, its `checkedOn` and `terms` untouched) — unless its last check is
 * itself older than the window: such an entry has no link left to stand on,
 * and its zero counts would read as "no coverage this week" when the truth is
 * "not checked this week", so it leaves the file. A question that is no
 * longer live leaves the file. A question with no carried entry and no result
 * is simply absent: absence means "not checked", never "no coverage".
 *
 * `_meta.as_of` is `today`: the day every link was just pruned against. The
 * gate judges the file's days against it, so a file written on day D stays
 * valid at D+1 00:30 UTC before any collector run has pruned it again.
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
    const prev = !done && prevQ[id] && !inWindow(prevQ[id].checkedOn, today) ? undefined : prevQ[id];
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
      source: `GDELT DOC 2.0 API (${GDELT_DOC_ENDPOINT}), ArtList mode — one search per term in the query shape below, over the days since the question was last checked; the rated outlets are picked out of GDELT’s results using the AllSides table, never named in the query`,
      attribution: GDELT_ATTRIBUTION,
      window_days: QUESTION_PRESS_WINDOW_DAYS,
      as_of: today,
      outlet_policy: OUTLET_POLICY,
      bias_table: 'data/media-bias.json',
      query_shape: QUERY_SHAPE,
      matches: MATCH_RULE,
      stores:
        'Per question: the exact search terms, the day it was last checked, and for each AllSides-rated outlet GDELT found, its domain, lean, the days GDELT saw it and up to five article links. Never titles, article text, tone or sentiment.',
    },
    questions: sortKeys(questions),
  };
}

/** The counts of every question, and which questions there are — the part
 *  of the file a count reader sees. @param {any} doc */
function countsKey(doc) {
  const q = doc?.questions ?? {};
  return JSON.stringify(Object.keys(q).sort().map((id) => [id, q[id]?.counts ?? null]));
}

/**
 * Write at most ONCE A DAY, unless the counts actually change.
 *
 *   - No file yet: write only if there is something to record (an empty
 *     first file would be a commit and a deploy that records no evidence).
 *   - A count moved (an outlet appeared or aged out, a link was added, a
 *     question entered or left the file): write — that is news.
 *   - Same UTC day as the file, counts unchanged: do not write. A second run
 *     that re-found the same outlets, or only moved a check-day, is not
 *     worth a commit.
 *   - A new UTC day, counts unchanged: write once if anything beyond the
 *     `as_of` stamp itself differs (a question was checked today, a link
 *     moved) — after that write the file carries today's `as_of`, so the rule
 *     above keeps the rest of the day quiet. A day on which NOTHING was
 *     checked (GDELT refusing all day) leaves the file alone: it stays honest
 *     as of its own day, the gate judges it against that day, and its
 *     lateness shows up as a warning — never as a restamp claiming a check
 *     that did not happen.
 *
 * @param {{ previous: any, next: any }} input
 */
export function shouldWrite({ previous, next }) {
  if (!previous) return Object.keys(next?.questions ?? {}).length > 0;
  if (countsKey(previous) !== countsKey(next)) return true;
  if (previous?._meta?.as_of === next?._meta?.as_of) return false;
  const unstamped = (d) => JSON.stringify({ ...d, _meta: { ...(d?._meta ?? {}), as_of: null } });
  return unstamped(previous) !== unstamped(next);
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

/**
 * The PRECISION reading, per lean: of the articles admitted this run, how many
 * carry one of the question's terms in their TITLE. A full-text match (a
 * topical alias plus "congress" anywhere in the body) is the count's ceiling;
 * a title that names the question is the floor. A low share on one lean and a
 * high one on another is alias skew, which is the thing plan §4 says must be
 * measured by lean before a count is ever shown. Titles are read in memory
 * and never stored; only the two numbers are logged.
 *
 * @param {Array<{ lean: string, title?: string }>} admitted
 * @param {string[]} terms
 * @returns {Record<'left' | 'center' | 'right', { admitted: number, titled: number }>}
 */
export function titleTermShare(admitted, terms) {
  const out = { left: { admitted: 0, titled: 0 }, center: { admitted: 0, titled: 0 }, right: { admitted: 0, titled: 0 } };
  for (const a of admitted ?? []) {
    if (!RATED_LEANS.includes(a?.lean)) continue;
    out[a.lean].admitted += 1;
    const title = normalizeTerm(a.title);
    if ((terms ?? []).some((t) => title.includes(t))) out[a.lean].titled += 1;
  }
  return /** @type {Record<'left' | 'center' | 'right', { admitted: number, titled: number }>} */ (out);
}

// ---- the gate ------------------------------------------------------------------

/**
 * The CI gate and the nightly re-check share this judgement.
 *
 * FAILS on: an unknown schema or window; a missing GDELT citation or link;
 * no recorded query shape or statement of what a count means;
 * any key the format does not define (this is where "never tone, never text"
 * is enforced); a question id data/moments.json does not know; a term that
 * breaks the alias rules; an outlet with no AllSides rating, or a lean that
 * disagrees with data/media-bias.json; a link that is not http(s) on its
 * outlet's own domain, or appears twice in one question; a day outside the
 * window the FILE claims; more links than the per-outlet cap; first/last-seen
 * days that are not the stored links' own; counts that are not the stored
 * evidence's own; a file past its size ceiling.
 *
 * AGED AGAINST THE FILE'S OWN DAY, NEVER THE WALL CLOCK. Every day in the file
 * is judged against `_meta.as_of` — the day the writer pruned the window —
 * the way verifyConversation judges the lamp against `_meta.fetched_at`. A
 * file is either damaged or it is not; the wall clock moving past midnight
 * cannot damage it. Judging it against the clock would fail CI and the
 * nightly's pre-commit verify-sync every day from 00:00 UTC until the first
 * collector run of the day rewrote it, and a news-layer outage would then fail
 * the bill sync. That would be exactly the "we are behind" check the owner's
 * N8-A2 ruling moved OUT of the pre-commit gate (CLAUDE.md), so lateness here
 * is a WARNING only. The only wall-clock FAILURE is an `as_of` more than a day
 * in the future, which no honest writer produces.
 *
 * WARNS on: a question that is no longer live (the next run drops it); a
 * question not checked for more than two days by the wall clock (the search is
 * failing); a file not rewritten for more than two days by the wall clock (the
 * collector is not running). All three are lateness, never damage.
 *
 * @param {{ data: any, fileBytes?: number, bias?: Record<string, string> | null, moments?: Record<string, any> | null, now?: number }} input
 */
export function verifyQuestionPress({ data, fileBytes = 0, bias = null, moments = null, now = Date.now() }) {
  const failures = [];
  const warnings = [];
  const notes = [];
  const today = dayKey(now);
  const fail = (m) => failures.push(m);
  const LATE_DAYS = 2;

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
  if (typeof meta.query_shape !== 'string' || !meta.query_shape.includes('<term>')) {
    fail('question-press: _meta.query_shape must record the query every term was searched with ("<term>" marks the phrase), so every count can be re-run');
  }
  if (typeof meta.matches !== 'string' || meta.matches.trim() === '') {
    fail('question-press: _meta.matches must say what a count means (an alias AND a congressional word anywhere in the text)');
  }
  // The day every other day in the file is judged against. Unusable → the
  // day checks below have nothing honest to stand on, so they are skipped
  // and this one failure says why.
  /** @type {string | null} */
  let asOf = null;
  if (!seenDayShape(meta.as_of)) fail(`question-press: _meta.as_of ${JSON.stringify(meta.as_of)} is not a YYYY-MM-DD day`);
  else if (daysBetween(meta.as_of, today) < -1) fail(`question-press: _meta.as_of ${meta.as_of} is in the future`);
  else {
    asOf = meta.as_of;
    const late = daysBetween(asOf, today);
    if (late > LATE_DAYS) {
      warnings.push(
        `question-press: the file was last pruned on ${asOf}, ${late} days ago — the collector has not written since; its evidence is honest as of that day, and the next write prunes it to the current week`
      );
    }
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
    else if (asOf) {
      if (daysBetween(entry.checkedOn, asOf) < 0) fail(`${at}: checkedOn ${entry.checkedOn} is after the day the file was written (${asOf})`);
      else if (!inWindow(entry.checkedOn, asOf)) {
        fail(`${at}: last checked ${entry.checkedOn}, outside the ${QUESTION_PRESS_WINDOW_DAYS}-day window ending ${asOf} — its counts would read as "no coverage this week" when the truth is "not checked"; the writer drops such an entry`);
      } else if (daysBetween(entry.checkedOn, today) > LATE_DAYS) {
        warnings.push(`${at}: last checked ${entry.checkedOn} — the GDELT search has not succeeded for ${daysBetween(entry.checkedOn, today)} days`);
      }
    }
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
          if (asOf && daysBetween(a.seen, asOf) < 0) fail(`${oat}: seen ${a.seen} is after the day the file was written (${asOf})`);
          else if (asOf && !inWindow(a.seen, asOf)) {
            fail(`${oat}: seen ${a.seen} is outside the ${QUESTION_PRESS_WINDOW_DAYS}-day window ending ${asOf}, the day the file was written`);
          }
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
