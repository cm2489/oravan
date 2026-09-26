/**
 * Pure headline<->bill matching logic for scripts/newsdesk.mjs (Part 2 of
 * the 2026-07-16 spend-reduction pair). Deliberately has ZERO imports of
 * congress-fetch.mjs (which throws at import time without CONGRESS_API_KEY
 * set) or '@anthropic-ai/sdk' — every function here is a plain string/data
 * transform, so tests/newsdesk-match.unit.spec.ts can exercise the whole
 * matching design (citation regex, local token overlap, the ≥2-outlet
 * corroboration rule, feed parsing, the no-change-no-commit guard) with
 * zero mocking and zero live network/API calls.
 *
 * ---- Tier-0 (government signal) + three press tiers, cheapest first ----
 * t0 (extractFloorFeedSlugs / extractMostViewedSlugs /
 *    extractBillsThisWeekSlugs): pure parsers for Congress.gov's own RSS
 *    (House/Senate floor today, weekly most-viewed) and docs.house.gov's
 *    weekly floorschedule XML. These carry explicit bill numbers natively
 *    (the floor feeds' item TITLE is the bill number), so every extracted
 *    slug is citation-grade. They are the government's own record, not
 *    press interpretation — zero lean — so scripts/newsdesk.mjs lets them
 *    fire WITHOUT the ≥2-outlet guardrail (loudly logged; see decideFires'
 *    tier0 parameter). Feed shapes verified live 2026-07-23.
 * t1 (findCitations): regex over explicit bill-number citations
 *    ("H.R. 1234", "S. 567", "H.J.Res. 45"). Free, resolves directly to a
 *    slug for any of our four tracked types (hr, s, hjres, sjres; the
 *    119th Congress). Fires on ANY single outlet — an explicit citation is
 *    unambiguous, so no corroboration is required.
 * t2 (matchLocal): free normalized-token overlap against the corpus's own
 *    bill titles + press_names + news_query (data/bills.json fields — there
 *    is no separate data/search-inputs.json; press_names/news_query live
 *    directly on each bill object). A confident single match skips the LLM
 *    entirely; an ambiguous shortlist (multiple plausible candidates, or a
 *    weak-but-present signal on a legislative-looking headline) is handed
 *    to t3. RARE tokens (document frequency ≤ RARE_TOKEN_MAX_DF across the
 *    index) count double, so a single-distinctive-token nickname like "the
 *    CHIPS Act" clears the candidate floor instead of being unmatchable.
 * t3 (resolved by scripts/newsdesk.mjs's one batched Haiku call): ONLY
 *    headlines t2 left ambiguous. This module supplies the batch
 *    membership test (looksLegislative), the prompt itself (buildT3Prompt:
 *    each candidate with its latest action date, status and floor-record
 *    note), the floor-record family offer (offerFloorFamily — see "the floor
 *    record" below), and newsdesk.mjs validates the LLM's output against the
 *    offered candidates (a hallucinated slug is never trusted — see
 *    resolveWithHaiku). Every tier reads headlineForMatching's view of the
 *    title: an aggregator item without its " - Outlet" suffix.
 * nickname bridge (extractNicknameTokens + buildListIndex + matchNickname):
 *    for a legislative-looking headline t1/t2/t3 ALL missed — the
 *    "brand-new big bill covered only by name" gap. newsdesk.mjs resolves
 *    the headline's distinctive capitalized/quoted act-name tokens against
 *    ONE per-run Congress.gov recently-updated bill list (reused across
 *    headlines, so cost stays bounded). A bridge match is still
 *    press-derived, so it goes through the ≥2-outlet rule like any t2/t3
 *    match.
 *
 * ---- The ≥2-outlet corroboration rule (decideFires) ----
 * A bill fires only if (a) an explicit citation matched it from ANY
 * outlet, or (b) t2/t3 matched it from at least 2 DISTINCT outlets. (a)
 * needs no corroboration because a citation is unambiguous. (b) does,
 * because a free-text/LLM match to a bill's title is inherently softer,
 * and — the nonpartisan guardrail this exists for — letting a single
 * outlet's coverage alone decide which bills get fast-tracked ahead of
 * others would make whichever outlet happens to publish first a de facto
 * prioritization channel. data/media-bias.json's AllSides lean data
 * already normalizes DISPLAY of an outlet's lean; it does nothing to stop
 * a single-source story from silently jumping a bill to the front of the
 * decode/refresh queue. Requiring 2 distinct outlets before a soft match
 * can trigger anything makes that channel much harder to game with one
 * placement, without blocking a bill that's genuinely breaking (which
 * will show up in the citation tier, or in >1 outlet's feed within the
 * same rolling window, almost immediately).
 */
import { createHash } from 'node:crypto';

// Duplicated from congress-fetch.mjs's CONGRESS constant (not imported) so
// this module stays import-clean for unit tests — see the header comment.
// The 119th Congress; bump alongside congress-fetch.mjs's own CONGRESS if
// the tracked Congress ever changes.
const CONGRESS = 119;
export const TRACKED_TYPES = new Set(['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres']);

// ---- t1: explicit bill-number citations ------------------------------
// Each alternative requires the number to be IMMEDIATELY adjacent (through
// only an optional period and a single optional space) to the type token,
// which is what correctly rejects "H. Res. 12" (a simple House resolution
// — NOT one of our 4 tracked types; "Res" inserts non-dot/space characters
// between "H"/"R" and the digits, so no alternative can complete a match)
// and "US 567" (the leading \b can't fire inside "US" — no word boundary
// between "U" and "S"). HJRES/SJRES are tried before the shorter HR/S
// alternatives at each scan position so "H.J.Res. 45" resolves as hjres,
// not as a stray "H." partial.
//
// The (?<!['’]) guard is what stops an English possessive from being read as
// a Senate bill. An apostrophe is a non-word character, so \b fires happily
// between it and the trailing "s" of "Trump's" — leaving the bare `S\.?`
// alternative to eat that "s", `\s?` to eat the space, and the next number in
// the headline to become a bill number ("Trump's 2026 budget request" ->
// s-2026-119, "Speaker's 4 must-pass bills" -> s-4-119). That is a t1
// citation, which short-circuits corroboration in decideFires AND rides
// forceSlugs past the decode gate, so a headline-shaped possessive could
// force a refresh/decode of an arbitrary slug. The lookbehind sits before the
// whole alternation, so it protects every type token, not just S. Straight
// (U+0027, what &apos; decodes to) and curly (U+2019, &#8217;) apostrophes
// only — a LEFT quote is deliberately not listed, because "‘S. 2026’ passes"
// is a real citation we still want.
const CITATION_RE =
  /(?<!['’])\b(H\.?\s?Con\.?\s?Res\.?|S\.?\s?Con\.?\s?Res\.?|H\.?\s?J\.?\s?Res\.?|S\.?\s?J\.?\s?Res\.?|H\.?\s?R\.?|S\.?)\s?(\d{1,5})\b/gi;

function normalizeType(raw) {
  return raw.replace(/[^a-zA-Z]/g, '').toLowerCase();
}

// hconres/sconres tracked as of 2026-07-23 (War Powers + budget resolutions
// — mirrors congress-fetch.mjs BILL_TYPES). "H. Res."/"S. Res." simple
// resolutions still normalize to hres/sres -> absent here -> dropped.
const TYPE_ALIASES = {
  h: null,
  hr: 'hr',
  s: 's',
  hjres: 'hjres',
  sjres: 'sjres',
  hconres: 'hconres',
  sconres: 'sconres',
};

/** Find every explicit, trackable bill-number citation in `text`. Returns
 *  `[{type, number, slug}]` — type is one of hr/s/hjres/sjres, slug is
 *  `${type}-${number}-119`. Citations to untracked types (e.g. "H. Res.
 *  12", a simple resolution) are silently excluded, not returned as a
 *  partial/wrong match. */
export function findCitations(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(CITATION_RE)) {
    const type = TYPE_ALIASES[normalizeType(m[1])];
    if (!type) continue;
    const number = String(Number(m[2])); // normalize away leading zeros, if any
    const slug = `${type}-${number}-${CONGRESS}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ type, number, slug });
  }
  return out;
}

// ---- t2: free local token-overlap match -------------------------------
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'at', 'by',
  'with', 'from', 'into', 'act', 'acts', 'bill', 'bills', 'amendment',
  'amendments', 'congress', 'congressional', 'united', 'states', 'american',
  'establish', 'establishing', 'establishment', 'require', 'requiring',
  'provide', 'providing', 'relating', 'related', 'this', 'that', 'their',
  'national', 'federal', 'government', 'law', 'laws', 'program', 'programs',
]);

/**
 * Words shorter than 4 characters that are still kept. The length floor exists
 * to drop scraps ("gop", "new", "say"), and it also dropped the one short word
 * the corpus's war-powers resolutions are NAMED by: "War Powers Resolution"
 * tokenized to "powers resolution", so "Senate rejects Iran war powers vote"
 * shared nothing with them that it did not also share with a dozen other
 * resolutions. Measured 2026-09-26 over the 2026-09-24 Iran pull, with the
 * floor record: keeping "war" takes H.Con.Res. 89 from offered on 68 of 75
 * vote headlines to all 75 (left-rated outlets' headlines: 4 of 8 to 8 of 8).
 * Across ~6,900 unique replayed headlines it changes 38 t3-bound shortlists
 * with the floor record applied (left 7, center 7, right 6, unrated 18), or
 * 90 t2 results counted over every headline with no record (left 37, center
 * 19, right 21, unrated 13) - two counting methods, both roughly in
 * proportion to each lean's share of the corpus. When a headline says "war
 * powers", the two words score as ONE token (PHRASE_UNITS), so keeping "war"
 * adds nothing on those headlines; it matters for "the Iran war".
 * df("war") is 19, so it is an ordinary, un-doubled token.
 * The acronyms reviewed with it were NOT added: SEC, CR and NIL changed no
 * Iran routing and moved 21 unrelated shortlists, and lower-cased "sec" is as
 * often "Sec." (Secretary) as the Commission. Extending this list is a
 * measurement, not a guess — rerun the replay first.
 */
export const SHORT_TOKENS_KEPT = new Set(['war']);

/** Lower-case, strip punctuation/accents, drop short + stop words. Returns
 *  a de-duplicated token array. */
export function tokenize(s) {
  const raw = String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics after NFKD (e.g. é -> e)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => (t.length >= 4 || SHORT_TOKENS_KEPT.has(t)) && !STOPWORDS.has(t));
  return Array.from(new Set(raw));
}

const slugOfBill = (b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();

/** Attach a document-frequency map (token -> how many index entries carry
 *  it) to an index array as a non-serialized `.df` property. Rare tokens
 *  (df ≤ RARE_TOKEN_MAX_DF) are the distinctive ones — "chips" appears in
 *  1-2 bills, "veterans" in dozens — and scoreCandidates weights them
 *  double. Callers that hand-build an index without df just fall back to
 *  weight-1 everywhere (identical to the pre-df behavior). */
export function attachDf(index) {
  const df = new Map();
  for (const e of index) for (const t of e.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  index.df = df;
  return index;
}

/**
 * @typedef {{ slug: string, title: string, tokens: Set<string>, titleTokens: Set<string>, lastActionDate: string | null, status: string | null }} IndexEntry
 * @typedef {IndexEntry[] & { df?: Map<string, number>, bySlug?: Map<string, IndexEntry> }} BillIndex
 * @typedef {{ kind: 'floor' | 'scheduled' | 'announced', chamber: 'senate' | 'house' | null, date: string | null, source: string, certainty?: string | null }} FloorEntry
 * @typedef {Record<string, { source: string, last_seen: string }>} FloorMemory
 */

/** Build the free-match index once per run: slug -> token set drawn from
 *  the bill's title + press_names + news_query (data/bills.json fields;
 *  there is no separate search-inputs.json). news_query is the corpus's
 *  own press-search phrasing (~2,255 bills carry one) — exactly the
 *  vocabulary headlines use, so it belongs in the t2 index alongside the
 *  formal title. Bills with no usable tokens are skipped.
 *
 *  Each entry also carries what t3 needs to tell near-identical measures
 *  apart (2026-09-26): the bill's own latest action date and status, and the
 *  token set of its formal TITLE alone (titleTokens), which is what the
 *  floor-record family test compares — press_names/news_query are search
 *  phrasing, not what the measure is. `bySlug` is a non-serialized lookup,
 *  like `df`.
 *  @param {any[]} bills
 *  @returns {BillIndex} */
export function buildBillIndex(bills) {
  const index = [];
  for (const b of bills) {
    const text = [b.title, ...((b.press_names ?? [])), b.news_query].filter(Boolean).join(' ');
    const tokens = new Set(tokenize(text));
    if (tokens.size === 0) continue;
    index.push({
      slug: slugOfBill(b),
      title: b.title,
      tokens,
      titleTokens: new Set(tokenize(b.title)),
      lastActionDate: typeof b.last_action_date === 'string' ? b.last_action_date : null,
      status: typeof b.status === 'string' ? b.status : null,
    });
  }
  const built = /** @type {BillIndex} */ (attachDf(index));
  built.bySlug = new Map(index.map((e) => [e.slug, e]));
  return built;
}

const T2_CONFIDENT_MIN_SHARED = 3; // weighted (rare tokens count double)
const T2_CONFIDENT_MIN_RATIO = 0.6;
const T2_CANDIDATE_MIN_SHARED = 2; // weighted: 2 common tokens OR 1 rare token
/** A token appearing in at most this many index entries is "rare" and
 *  counts double in scoreCandidates. This is what makes a
 *  single-distinctive-token nickname ("the CHIPS Act" shares only "chips"
 *  with its bill) reach the candidate floor of 2 instead of being
 *  structurally unmatchable; a lone COMMON shared token still can't. */
export const RARE_TOKEN_MAX_DF = 3;

/**
 * Multi-word names that are ONE piece of evidence, not several. "War Powers"
 * is the name of one law (the War Powers Resolution). Once "war" was kept
 * (see SHORT_TOKENS_KEPT), every H.Con.Res. that cites it by name scored two
 * points on a headline's "war powers". That tied them with the one rare token
 * that names a different country's resolution: "Senate rejects Venezuela war
 * powers resolution" listed five other war-powers resolutions and dropped
 * S.J.Res. 98, the Venezuela one, off the shortlist. When a headline carries
 * the whole name, it is scored as one token: an entry gets one point for it,
 * and only if the entry carries the whole name too. Its words do not also
 * count one by one, so a bill that merely has "war" in its title (the Iran
 * War Oil Crisis Windfall Profits Tax Act) or "powers" (emergency-powers
 * bills) gets nothing from "war powers". A headline that says "war" without
 * "powers" ("the Iran war") still matches "war" as before.
 */
export const PHRASE_UNITS = Object.freeze([Object.freeze(['war', 'powers'])]);

/** One index entry scored against a headline's tokens. Returns the scored
 *  shape whatever the weight — the caller applies the candidate floor. A
 *  PHRASE_UNITS name the headline carries whole counts as one token, in
 *  `shared`, `weight` and the ratio's denominator alike. */
function scoreEntry(entry, hTokens, df) {
  let shared = 0;
  let weight = 0;
  const matched = [];
  const w = (t) => ((df.get(t) ?? Infinity) <= RARE_TOKEN_MAX_DF ? 2 : 1);
  const whole = PHRASE_UNITS.filter((u) => u.every((x) => hTokens.includes(x)));
  const inWhole = new Set(whole.flat());
  for (const t of hTokens) {
    if (inWhole.has(t) || !entry.tokens.has(t)) continue;
    shared++;
    matched.push(t);
    weight += w(t);
  }
  let units = hTokens.length;
  for (const u of whole) {
    units -= u.length - 1;
    if (!u.every((x) => entry.tokens.has(x))) continue;
    shared++;
    matched.push(...u);
    weight += Math.min(...u.map(w));
  }
  return {
    slug: entry.slug,
    title: entry.title,
    shared,
    weight,
    ratio: shared / units,
    matched,
    lastActionDate: entry.lastActionDate ?? null,
    status: entry.status ?? null,
  };
}

/** Score every indexed bill against a headline's tokens. `shared` is the
 *  raw shared-token count; `weight` is rarity-weighted (rare tokens count
 *  double — see RARE_TOKEN_MAX_DF); `ratio` stays raw-count-based so it
 *  keeps meaning "what fraction of the headline's own tokens matched".
 *  Sorted best-first by weight, then ratio. Each candidate also carries
 *  `matched` (the headline tokens it shared) and the bill's own
 *  `lastActionDate`/`status`, which t3's prompt prints. */
export function scoreCandidates(headline, billIndex) {
  const hTokens = tokenize(headline);
  if (hTokens.length === 0) return [];
  const df = billIndex.df ?? new Map();
  const scored = [];
  for (const entry of billIndex) {
    // Cheap weight pass first: most of the ~3,200 entries share nothing, and
    // only a candidate is worth building the full scored shape for. This
    // raw weight is an upper bound (a PHRASE_UNITS pair counts once in
    // scoreEntry), so the floor is applied again to the real score.
    let weight = 0;
    for (const t of hTokens) if (entry.tokens.has(t)) weight += (df.get(t) ?? Infinity) <= RARE_TOKEN_MAX_DF ? 2 : 1;
    if (weight < T2_CANDIDATE_MIN_SHARED) continue;
    const s = scoreEntry(entry, hTokens, df);
    if (s.weight >= T2_CANDIDATE_MIN_SHARED) scored.push(s);
  }
  scored.sort((a, b) => b.weight - a.weight || b.ratio - a.ratio);
  return scored;
}

/** How many candidates t2 hands t3 for one ambiguous headline, before any
 *  floor-record family member is added (see offerFloorFamily). */
export const T3_CANDIDATES_MAX = 5;

/** t2 verdict for one headline against the index:
 *   { tier: 't2', slug }        - one candidate is clearly the best match
 *   { tier: 'ambiguous', candidates } - 1+ plausible candidates, none
 *                                  clearly separated - t3's job
 *   null                        - no local signal at all
 *  Confidence thresholds run on the rarity-WEIGHTED count, so one rare +
 *  one common token (weight 3) can be confident where two common tokens
 *  (weight 2) cannot; a lone rare token (weight 2) is a candidate but
 *  never confident — it goes to t3 for disambiguation, not straight to a
 *  fire.
 *
 *  `opts.floorRecord` (Map<slug, FloorEntry>, see buildFloorRecord) changes
 *  ONLY the ambiguous branch: which candidates t3 is offered and in what
 *  order (offerFloorFamily). It never makes a headline confident, never
 *  turns a null into a match, and never touches the t2 verdict — the
 *  confident path is byte-for-byte what it was. */
export function matchLocal(headline, billIndex, opts = {}) {
  const candidates = scoreCandidates(headline, billIndex);
  if (candidates.length === 0) return null;
  const [top, runnerUp] = candidates;
  const confident =
    top.weight >= T2_CONFIDENT_MIN_SHARED &&
    top.ratio >= T2_CONFIDENT_MIN_RATIO &&
    (!runnerUp || top.weight >= runnerUp.weight * 1.5);
  if (confident) return { tier: 't2', slug: top.slug };
  const shown = candidates.slice(0, T3_CANDIDATES_MAX);
  const floorRecord = opts.floorRecord;
  if (!floorRecord || floorRecord.size === 0) return { tier: 'ambiguous', candidates: shown };
  return { tier: 'ambiguous', candidates: offerFloorFamily(headline, shown, billIndex, floorRecord) };
}

// ---- the floor record: which near-identical measure was actually voted on ----
/*
 * WHY (2026-09-26). On 2026-09-24 the Senate voted 49-50 on H.Con.Res. 89, the
 * House-passed Iran war-powers resolution. Tier-0 knew: the run log says
 * `TIER0 FIRE: hconres-89-119 <- senate-floor-today`. The press matcher did
 * not. The corpus holds TWELVE Iran war-powers resolutions whose titles are
 * the same sentence in two wordings (six S.J.Res. "to direct the removal of
 * United States Armed Forces from hostilities within or against the Islamic
 * Republic of Iran…", six H.Con.Res. "Directing the President, pursuant to
 * section 5(c) of the War Powers Resolution, to remove…"), so a headline like
 * "Senate rejects war powers resolution" scores them all the same. The
 * shortlist is cut at five by corpus order, t3 was shown titles only, and the
 * week's vote coverage landed on S.J.Res. 185 — a resolution last acted on in
 * June — while the measure actually on the floor got nothing. Replayed over
 * the 99-item Google News Iran pull of 2026-09-24: 79 headlines reached t3,
 * 62 of them listed S.J.Res. 185 first, 0 listed H.Con.Res. 89 first, and 15
 * did not offer it at all.
 *
 * WHAT CHANGES. Two things, both record-based and lean-free (the chamber's own
 * floor feed and schedule carry no outlet):
 *   1. offerFloorFamily: a measure on the floor record in the last 48 hours is
 *      ADDED to an ambiguous headline's shortlist when the headline cannot
 *      tell it apart from a near-identical candidate already on it
 *      (titleFamily + headlineCannotSeparate below), and it takes that
 *      sibling's place in the order. A sibling whose own title names what the
 *      headline says and the floor measure lacks (a Venezuela headline, an
 *      Iran resolution on the floor) is never passed, and the floor measure
 *      never lands ahead of a candidate the headline supports better unless
 *      that candidate is such an indistinguishable sibling or ranks below one.
 *   2. buildT3Prompt: every candidate reaches t3 with its latest action date,
 *      its status and, when it has one, its floor-record note — so t3 can see
 *      that one of twelve identical-looking resolutions was on the Senate floor
 *      yesterday and the others were last touched in June.
 * t3 still makes the call, and it can still only return a slug it was
 * offered. Nothing here fires anything or moves a bill up the docket.
 */

/** A floor-record entry stays eligible this long after it was last seen on a
 *  chamber floor feed. The feeds roll over to the next legislative day, while
 *  the coverage of a vote keeps arriving for a day or two after it. */
export const FLOOR_RECORD_HOURS = 48;

/** Tier-0 sources that ARE the floor record. Most-viewed is not: a bill being
 *  read on congress.gov says nothing about which measure a chamber acted on. */
export const FLOOR_RECORD_SOURCES = Object.freeze({
  'senate-floor-today': { kind: 'floor', chamber: 'senate' },
  'house-floor-today': { kind: 'floor', chamber: 'house' },
  'house-bills-this-week': { kind: 'scheduled', chamber: 'house' },
});

/** A token shared by this many index entries or fewer is DISTINCTIVE for the
 *  family test ("iran" 21, "hostilities" 16, "armed" 19, "forces" 22 in the
 *  2026-09-25 corpus; "resolution" 80, "security" 86, "health" 112 are not). */
export const FAMILY_TOKEN_MAX_DF = 25;
/** Two titles are one family when they share at least this many distinctive
 *  tokens. The S.J.Res. and H.Con.Res. Iran wordings share four (hostilities,
 *  armed, forces, iran) while their raw-token Jaccard is only 0.24 — a plain
 *  title-similarity threshold would have split exactly the pair that matters. */
export const FAMILY_MIN_SHARED = 3;
/** At most this many floor-record family members are ADDED to one headline's
 *  shortlist (it can then hold T3_CANDIDATES_MAX + this many). */
export const FLOOR_RESCUE_MAX = 2;

/** Are these two index entries near-identical measures? Counted on the formal
 *  titles only, over distinctive tokens only (see FAMILY_TOKEN_MAX_DF).
 *
 *  A family is a TEMPLATE, not a subject: every war-powers resolution in the
 *  corpus is one family whatever the country (the Venezuela, Cuba and Western
 *  Hemisphere resolutions share "armed", "forces" and "hostilities" with the
 *  Iran ones), and the Internal Revenue Code amendments form families of up to
 *  16. 499 of 3,219 bills have at least one sibling. So a family is never
 *  enough on its own to put one member in another's place; the headline has to
 *  be unable to tell the two apart (headlineCannotSeparate). */
export function titleFamily(a, b, df) {
  if (!a?.titleTokens || !b?.titleTokens || a.slug === b.slug) return false;
  let shared = 0;
  for (const t of a.titleTokens) {
    if (b.titleTokens.has(t) && (df?.get(t) ?? Infinity) <= FAMILY_TOKEN_MAX_DF) {
      shared++;
      if (shared >= FAMILY_MIN_SHARED) return true;
    }
  }
  return false;
}

/** Each entry's title family across the whole index, computed on first use.
 *  Keyed on the index object, so offerFloorFamily stays observably pure. */
const FAMILY_MEMO = new WeakMap();
function familyOf(entry, billIndex, df) {
  let memo = FAMILY_MEMO.get(billIndex);
  if (!memo) {
    memo = new Map();
    FAMILY_MEMO.set(billIndex, memo);
  }
  let fam = memo.get(entry.slug);
  if (!fam) {
    fam = billIndex.filter((x) => titleFamily(entry, x, df));
    memo.set(entry.slug, fam);
  }
  return fam;
}

/**
 * Can this headline tell the floor-record measure F apart from its sibling S?
 * offerFloorFamily lets F stand in for S (be added because S was shortlisted,
 * or be listed ahead of S) ONLY when it cannot. `sMatched` is the headline
 * tokens S matched (scoreCandidates' `matched`). Every test below counts
 * distinctive tokens only (df <= FAMILY_TOKEN_MAX_DF): "resolution" (df 80)
 * is in every one of these titles and says nothing about which one a story is
 * on.
 *   1. F and S are one title family (titleFamily).
 *   2. The headline matched F on a distinctive token S also carries. Sharing
 *      only "resolution" is not enough.
 *   3. Nothing the headline matched on S's formal title names something F
 *      lacks. A distinctive title token S has and F does not ("venezuela",
 *      "cuba", "hemisphere" against an Iran resolution; "iran" against the
 *      Venezuela one) says the headline is about S, not F, and F stays where
 *      the headline put it.
 *      The one exception is the family's template wording. The S.J.Res. form
 *      says "hostilities within or AGAINST" for every country, so a headline
 *      saying senators "voted against" the Iran resolution matches every
 *      S.J.Res. on "against", and H.Con.Res. 89 ("hostilities WITH Iran") does
 *      not. Such a token is wording, not a subject, when some OTHER sibling
 *      carries it together with everything that sets F's title apart from S
 *      (F's distinctive title tokens that S lacks). H.Con.Res. 75 is worded
 *      like H.Con.Res. 89 and says "hostilities AGAINST … Iran", so "against"
 *      does not separate 89 from an S.J.Res. No sibling carries "venezuela"
 *      beside "iran", so "venezuela" separates 89 from S.J.Res. 98, and
 *      "iran" separates 98 from every Iran resolution.
 * An unknown case falls to the conservative side: F keeps the place the
 * headline gave it, and its FLOOR RECORD note still reaches t3.
 * `sMatched` may be omitted; it is then scored here.
 */
export function headlineCannotSeparate(hTokens, f, s, sMatched, billIndex, df = billIndex?.df ?? new Map()) {
  if (!f || !s || !titleFamily(f, s, df)) return false;
  const distinct = (t) => (df.get(t) ?? Infinity) <= FAMILY_TOKEN_MAX_DF;
  const onS = sMatched ?? scoreEntry(s, hTokens, df).matched;
  const onF = new Set(scoreEntry(f, hTokens, df).matched);
  if (!onS.some((t) => distinct(t) && onF.has(t))) return false;
  let fOnly = null;
  for (const t of onS) {
    // Only S's formal TITLE can name its subject: press_names and news_query
    // are search phrasing (S.J.Res. 200's news_query adds "military action").
    if (f.tokens.has(t) || !distinct(t) || !s.titleTokens.has(t)) continue;
    fOnly ??= [...f.titleTokens].filter((x) => distinct(x) && !s.tokens.has(x));
    const wording = familyOf(f, billIndex, df).some(
      (g) => g.slug !== s.slug && g.tokens.has(t) && fOnly.every((x) => g.tokens.has(x))
    );
    if (!wording) return false;
  }
  return true;
}

/**
 * Offer the floor-record member of a near-identical family, and let it lead
 * the siblings the headline cannot tell it apart from. `shown` is t2's own
 * shortlist (already cut to T3_CANDIDATES_MAX). A bill F on the floor record
 * that is NOT on it is added when the headline cannot tell F apart from some
 * shown candidate S (headlineCannotSeparate). Added candidates are marked
 * `rescued: true` and join the list at their own headline weight. Then each
 * floor-record candidate F moves up, and only up:
 *   - ahead of equal-weight candidates (the record breaks a tie the headline
 *     leaves), but never past a title sibling the headline tells apart from F;
 *   - then into the place of the best-placed sibling the headline cannot tell
 *     apart from F; that sibling and everything after it move down one.
 * So F only ever lands ahead of a candidate the headline supports better when
 * that candidate is such a sibling or ranks below one. The list is otherwise
 * t2's own order. Every candidate on the floor record carries its entry as
 * `floor`. Pure; never mutates `shown`.
 */
export function offerFloorFamily(headline, shown, billIndex, floorRecord) {
  const df = billIndex.df ?? new Map();
  const bySlug = billIndex.bySlug ?? new Map(billIndex.map((e) => [e.slug, e]));
  const hTokens = tokenize(headline);
  const shownSlugs = new Set(shown.map((c) => c.slug));
  const cannotSeparate = (f, c) => headlineCannotSeparate(hTokens, f, bySlug.get(c.slug), c.matched, billIndex, df);
  const eligible = [];
  for (const [slug, entry] of floorRecord) {
    if (shownSlugs.has(slug)) continue;
    const f = bySlug.get(slug);
    if (!f) continue; // not in the corpus - t2/t3 can only ever offer corpus bills
    const scored = scoreEntry(f, hTokens, df);
    if (scored.shared === 0) continue;
    if (shown.some((s) => cannotSeparate(f, s))) eligible.push({ ...scored, rescued: true, floor: entry });
  }
  // More eligible than slots (rare: it takes several members of ONE family on
  // the floor inside 48 hours): on-the-floor before announced, then the
  // headline's own weight, then slug order so the pick is deterministic.
  const kindRank = (e) => (e.floor.kind === 'floor' ? 0 : e.floor.kind === 'scheduled' ? 1 : 2);
  const rescued = eligible
    .sort((a, b) => kindRank(a) - kindRank(b) || b.weight - a.weight || (a.slug < b.slug ? -1 : 1))
    .slice(0, FLOOR_RESCUE_MAX);
  const ordered = [
    ...shown.map((c) => (floorRecord.has(c.slug) ? { ...c, floor: floorRecord.get(c.slug) } : c)),
    ...rescued,
  ]
    // Array.prototype.sort is stable, so t2's own order (weight, then ratio)
    // survives every tie.
    .sort((a, b) => b.weight - a.weight);
  // A sibling whose own title names something the headline says and F lacks
  // (the Cuba resolution, on a headline that says "Cuba") is never passed.
  const separated = (fEntry, c) => titleFamily(fEntry, bySlug.get(c.slug), df) && !cannotSeparate(fEntry, c);
  for (const f of ordered.filter((c) => c.floor)) {
    const fEntry = bySlug.get(f.slug);
    const at = ordered.indexOf(f);
    let to = at;
    // 1. When the headline supports two measures equally, the one on the floor
    //    record goes first. It does not pass a candidate the headline supports
    //    even one point better, another floor-record candidate, or a separated
    //    sibling.
    while (to > 0) {
      const prev = ordered[to - 1];
      if (prev.weight !== f.weight || prev.floor || separated(fEntry, prev)) break;
      to--;
    }
    // 2. Then it takes the place of the best-placed sibling the headline
    //    cannot tell it apart from (headlineCannotSeparate). Between such
    //    siblings the weight gap is lexical noise, not evidence. A headline
    //    saying senators "voted against" the resolution scores the S.J.Res.
    //    wording ("hostilities within or AGAINST … Iran") one point above the
    //    H.Con.Res. wording ("hostilities WITH Iran") for no reason that has
    //    anything to do with which one was voted on, and in the 2026-09-24
    //    pull that noise sat almost entirely in right-rated outlets' headlines.
    const lead = ordered.findIndex((c, i) => i < to && !c.floor && cannotSeparate(fEntry, c));
    if (lead !== -1) to = lead;
    if (to === at) continue;
    ordered.splice(at, 1);
    ordered.splice(to, 0, f);
  }
  return ordered;
}

/**
 * The floor record t3 reads, as Map<slug, {kind, chamber, date, source,
 * certainty?}>. Two inputs, both the government's own record:
 *   - `persisted`: the newsdesk cache's rolling 48-hour memory of what the
 *     chamber floor feeds listed (rollFloorRecord) — kind 'floor' for the
 *     congress.gov floor-today feeds, 'scheduled' for the House's weekly
 *     schedule. `date` is the UTC day the feed last listed it.
 *   - `signals`: data/floor-signals.json's tier-0 announcements (the Senate
 *     Daily Digest program, the House weekly schedule), kind 'announced',
 *     `date` = the day it was announced FOR. Stale entries (a source that went
 *     quiet, carried forward) are skipped: carried-forward is not current.
 * A slug in both keeps the 'floor' entry — having been on the floor is the
 * stronger fact than having been announced.
 */
/**
 * @param {{ persisted?: unknown, signals?: Record<string, any> | null, nowMs?: number }} [input]
 * @returns {Map<string, FloorEntry>}
 */
export function buildFloorRecord({ persisted = null, signals = null, nowMs = Date.now() } = {}) {
  /** @type {Map<string, FloorEntry>} */
  const out = new Map();
  const fresh = rollFloorRecord(persisted, [], nowMs);
  for (const [slug, e] of Object.entries(fresh)) {
    const meta = FLOOR_RECORD_SOURCES[e.source];
    if (!meta) continue;
    out.set(slug, { kind: /** @type {FloorEntry['kind']} */ (meta.kind), chamber: /** @type {FloorEntry['chamber']} */ (meta.chamber), date: e.last_seen.slice(0, 10), source: e.source });
  }
  for (const [slug, s] of Object.entries(signals ?? {})) {
    if (!s || s.stale === true || !s.tier0 || out.has(slug)) continue;
    const chamber = s.tier0.chamber === 'senate' || s.tier0.chamber === 'house' ? s.tier0.chamber : null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(s.tier0.covers ?? '')) ? s.tier0.covers : null;
    out.set(slug, {
      kind: 'announced',
      chamber,
      date,
      source: typeof s.tier0.source === 'string' ? s.tier0.source : 'floor-signals',
      certainty: typeof s.tier0.certainty === 'string' ? s.tier0.certainty : null,
    });
  }
  return out;
}

/**
 * Roll the persisted floor-feed memory forward: merge this run's
 * observations ([{slug, source}], stamped `nowMs`) and drop anything last seen
 * more than FLOOR_RECORD_HOURS ago, or stamped in the future, or from a source
 * that is not a floor-record source. Returns a fresh plain object (JSON-safe,
 * `{[slug]: {source, last_seen}}`) and never mutates its input. A lost or
 * corrupt cache is `{}`, which costs the floor record its memory of earlier
 * runs and nothing else — this run's own floor feeds still count.
 *
 * A floor-today listing outranks a weekly-schedule listing: the first says the
 * measure WAS on the floor, the second that it may be. So a schedule sighting
 * never overwrites a floor sighting still inside the window (the floor fact
 * simply ages out on its own clock), while a floor sighting always replaces a
 * schedule one, and a same-kind sighting refreshes the clock.
 */
/**
 * @param {unknown} prev
 * @param {{ slug: string, source: string }[]} [observations]
 * @param {number} [nowMs]
 * @returns {FloorMemory}
 */
export function rollFloorRecord(prev, observations = [], nowMs = Date.now()) {
  /** @type {FloorMemory} */
  const out = {};
  const cutoff = nowMs - FLOOR_RECORD_HOURS * 3_600_000;
  const src = /** @type {Record<string, any>} */ (prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {});
  for (const [slug, e] of Object.entries(src)) {
    const t = Date.parse(e?.last_seen ?? '');
    if (!Number.isFinite(t) || t < cutoff || t > nowMs + 3_600_000) continue;
    if (!FLOOR_RECORD_SOURCES[e?.source]) continue;
    out[slug] = { source: e.source, last_seen: new Date(t).toISOString() };
  }
  const nowIso = new Date(nowMs).toISOString();
  const isFloor = (source) => FLOOR_RECORD_SOURCES[source]?.kind === 'floor';
  for (const o of observations ?? []) {
    if (!o?.slug || !FLOOR_RECORD_SOURCES[o.source]) continue;
    const prior = out[o.slug];
    if (prior && isFloor(prior.source) && !isFloor(o.source)) continue;
    out[o.slug] = { source: o.source, last_seen: nowIso };
  }
  return out;
}

// ---- the t3 prompt (pure, so the tests can read exactly what Haiku reads) ----
const STATUS_WORDS = {
  committee: 'in committee',
  markup: 'committee markup',
  floor_vote: 'floor action on record',
  passed_chamber: 'passed one chamber',
  signed: 'signed into law',
};

const CHAMBER_WORDS = { senate: 'Senate', house: 'House' };

/** The floor-record note for one candidate, or null. Plain record facts only —
 *  which chamber, which day, which government source — never an outlet. */
export function floorNote(floor) {
  if (!floor) return null;
  const chamber = CHAMBER_WORDS[floor.chamber] ?? 'chamber';
  if (floor.kind === 'floor') {
    return `listed on the ${chamber} floor by congress.gov's floor-today feed, last listed ${floor.date}`;
  }
  if (floor.kind === 'scheduled') {
    return `on the ${chamber}'s published weekly floor schedule, seen ${floor.date}`;
  }
  const when = floor.date ? ` for ${floor.date}` : '';
  const how = floor.certainty ? ` (${String(floor.certainty).replace(/_/g, ' ')})` : '';
  return `announced for ${chamber} floor action${when} in the chamber's own schedule${how}`;
}

/** One candidate as t3 sees it: slug, formal title, latest action date,
 *  status, and the floor-record note when there is one. */
export function formatT3Candidate(c) {
  const facts = [
    `latest action ${c.lastActionDate ?? 'unknown'}`,
    `status: ${STATUS_WORDS[c.status] ?? c.status ?? 'unknown'}`,
  ];
  const note = floorNote(c.floor);
  if (note) facts.push(`FLOOR RECORD: ${note}`);
  return `${c.slug} = ${c.title} [${facts.join('; ')}]`;
}

/**
 * The whole t3 user message for one batch ([{title, candidates}]). `today` is
 * the run's UTC date, printed so "last listed 2026-09-24" has a reference
 * point. The instruction is written to stay neutral: the floor record is
 * offered as a way to tell near-identical measures apart when a headline
 * reports a recent floor event, and explicitly NOT as evidence on its own.
 */
export function buildT3Prompt(batch, { today } = {}) {
  const lines = batch
    .map((b, i) => `${i}. HEADLINE: ${b.title}\n   CANDIDATES: ${b.candidates.map(formatT3Candidate).join(' | ')}`)
    .join('\n');
  return `${today ? `Today is ${today} (UTC). ` : ''}For each numbered headline below, decide which ONE candidate bill (if any) it is actually reporting on. Only pick a candidate if the headline is clearly about that specific bill's provisions, vote, or status — not just a similar general topic. If none fit, use null.

Each candidate shows its latest recorded action date and status. Some also carry a FLOOR RECORD note: the chamber's own record listed that measure for floor action within the last two days. Candidates can be near-identical measures with almost the same title (for example a joint resolution and a concurrent resolution on the same subject). When a headline reports a recent floor event — a vote, passage, rejection or debate — and more than one candidate fits its wording, pick the one whose floor record matches that chamber and timing, not an older measure with the same wording. A floor record is not evidence by itself: if the headline is not about a recent floor event, or the measure does not fit the headline, ignore the note.

${lines}

Output STRICT JSON only, an array like [{"i":0,"slug":"hr-1234-119"},{"i":1,"slug":null}] — no prose, no markdown fences, no other text.`;
}

// ---- t3 gating: only headlines that look legislative -------------------
// The budget-process vocabulary alternatives (megabill, package, stopgap,
// "continuing resolution", "budget blueprint", reconciliation) were added
// 2026-07-23 from real logged misses: "Revised GOP crypto package" and
// "Trump signs the megabill" both failed the original regex, so the week's
// biggest legislation never even reached t3. "package" is the loosest of
// them (trade packages, aid packages) — acceptable, because this gate only
// admits a headline to the cheap Haiku disambiguation batch (capped at
// T3_MAX_HEADLINES) or the nickname bridge; it never fires anything by
// itself.
//
// 2026-09-26 precision/recall pass (measured over the 2026-09-24 Google News
// pulls and ~6,300 publisher-sitemap headlines; numbers in the PR):
//   - "White House" is not a chamber. It used to satisfy the `house`
//     alternative, so every White House story - a press-credential fight, a
//     state dinner, a ballroom lawsuit - reached t3 with S. 4430 (the White
//     House Safety and Security Act, "White House" in its title) on the
//     shortlist: 142 replayed headlines did, 14 still do, each because it also
//     says bill/Senate/vote or the like. The phrase is blanked before the
//     test; a White House story that also says one of those still passes.
//   - Added the budget and defense shorthand headlines actually use: NDAA,
//     shutdown, and CR (matched CASE-SENSITIVELY, as the acronym only).
//     Measured: in a Google News pull that searched for "NDAA", the word
//     admitted 7 defense-bill headlines the gate had dropped and 6 that use
//     the letters for something else (a school's initials, "NDAA-compliant"
//     products); "shutdown" admitted 2 funding stories and 3 that are not
//     (an airport, a refinery, a regional strike). The politics basket rarely
//     carries the off-topic kind, and t3 answers null to them.
//   - NIL was reviewed and NOT added. Every NIL headline about the college
//     sports bill already says bill/act/Senate; the only headlines NIL alone
//     admitted were two sports-business stories (an endorsement deal, a
//     celebrity's opinion), both from one lean, and both would have been
//     offered the Protect College Sports Act as a candidate.
//   - No party nouns: widening the gate to "GOP"/"Democrats" is an open owner
//     decision (campaign coverage would flood t3), and a one-sided list would
//     not be neutral.
const LEGISLATIVE_SIGNAL_RE = /\b(bill|act|legislation|resolution|congress|senate|house|vote|voted|passed|introduced|amendment|committee|markup|filibuster|cloture|veto|vetoed|lawmakers?|representatives?|senators?|megabill|package|stopgap|continuing resolution|budget blueprint|reconciliation|ndaa|shutdowns?)\b/i;
const LEGISLATIVE_ACRONYM_RE = /\bCR\b/;
const NOT_A_CHAMBER_RE = /\bwhite\s+house\b/gi;

/** Cheap pre-filter: does this headline look like it MIGHT be about a
 *  specific bill, before spending an LLM call disambiguating it? */
export function looksLegislative(headline) {
  const h = String(headline ?? '').replace(NOT_A_CHAMBER_RE, ' ');
  return LEGISLATIVE_SIGNAL_RE.test(h) || LEGISLATIVE_ACRONYM_RE.test(h);
}

// ---- the aggregator's outlet suffix -------------------------------------
/** Hosts whose item titles carry the outlet's name as a trailing " - Outlet"
 *  segment. Google News is the only aggregator in the basket. */
export const AGGREGATOR_TITLE_HOSTS = new Set(['news.google.com']);

/**
 * The headline as the matcher should read it. Google News appends the outlet
 * to every title ("Senate rejects Iran war powers resolution - Washington
 * Examiner"), and until 2026-09-26 that suffix was tokenized with the
 * headline: "washington", "examiner", "review" (National Review), "post",
 * "york", "times", "hill" all became evidence about which BILL the story was
 * on. That is not only noise, it is lean-dependent noise — which bills a
 * story's candidates drift toward depended on the name of the outlet that ran
 * it. Only an aggregator item (its link on an AGGREGATOR_TITLE_HOSTS host) is
 * cut, and only at the LAST " - ", which is where Google News puts the
 * outlet; a direct feed's title is returned untouched, hyphens and all.
 *
 * The raw title is still what the seen-cache hashes (hashHeadline), so this
 * changes no dedupe key and re-surfaces no already-seen headline.
 */
export function headlineForMatching(title, link) {
  const t = String(title ?? '').trim();
  let host = null;
  try {
    host = new URL(String(link ?? '')).hostname.toLowerCase();
  } catch {
    host = null;
  }
  if (!host || !AGGREGATOR_TITLE_HOSTS.has(host)) return t;
  const cut = t.lastIndexOf(' - ');
  if (cut <= 0) return t;
  const head = t.slice(0, cut).trim();
  return head || t;
}

// ---- the ≥2-outlet rule -------------------------------------------------
/**
 * The sentinel newsdesk.mjs files an article under when its outlet cannot be
 * resolved to a real domain. Exactly one feed in the basket carries no domain
 * of its own — the Google News aggregator, where attribution lives in a
 * per-article `<source url="…">` tag — so a missing or unparseable tag there
 * leaves the article with no outlet at all.
 */
export const UNRESOLVED_OUTLET = 'unknown';

/**
 * How many REAL, DISTINCT outlets have matched this slug.
 *
 * The unresolved sentinel is NOT an outlet; it is the absence of one, and
 * counting it as a second distinct source is the hole this closes
 * (2026-08-09). One newsroom's story arriving twice — once from that
 * outlet's own feed, once as an unattributable Google News item — used to
 * present as {'cbsnews.com', 'unknown'}, size 2, and satisfied a guardrail
 * written to require TWO independent newsrooms. That is precisely the
 * single-outlet prioritization channel decideFires exists to prevent, so an
 * unresolved item may still contribute its headline (dedupe, the pending-hold
 * log, a future run's evidence) but never corroboration.
 *
 * Filtering at COUNT time rather than at write time is deliberate: it also
 * disarms the 'unknown' entries already persisted in the live
 * .newsdesk-cache/seen.json `pendingOutlets` by earlier runs, which a
 * stop-writing-it fix would have left armed until their 7-day TTL ran out.
 */
export function countDistinctOutlets(outlets) {
  if (!outlets) return 0;
  const real = new Set();
  for (const o of outlets) {
    const name = String(o ?? '').trim().toLowerCase();
    if (name && name !== UNRESOLVED_OUTLET) real.add(name);
  }
  return real.size;
}

/**
 * Decide which bills fire this run.
 *   citationSlugs: Set<slug> matched by an explicit citation (t1) this run
 *     - fires on any single outlet, no corroboration needed.
 *   outletsBySlug: Map<slug, Set<outlet>> - outlets that matched this slug
 *     via t2/t3, ACCUMULATED across runs (the caller persists this in the
 *     seen-headlines cache) so corroboration can build up over multiple
 *     hourly polls, not just within one run's fetch window. Only REAL
 *     outlets count toward the ≥2 (countDistinctOutlets); the
 *     UNRESOLVED_OUTLET sentinel is skipped.
 *   tier0Slugs: Map<slug, sourceLabel> - slugs extracted from the
 *     government's own signal feeds (Congress.gov floor/most-viewed RSS,
 *     docs.house.gov floorschedule). These BYPASS the ≥2-outlet guardrail
 *     by design: the guardrail exists to stop any single press outlet's
 *     editorial choices from becoming a prioritization channel, and a
 *     government record carries no outlet lean to guard against. They are
 *     listed FIRST in the fired set (highest precision) and their reason is
 *     'tier0:<label>' so the caller can log them loudly and draw from the
 *     tier-0 decode budget.
 * Returns { fired: Set<slug>,
 *           reason: Map<slug, 'tier0:<label>'|'citation'|'corroborated'> }.
 */
export function decideFires(citationSlugs, outletsBySlug, tier0Slugs = new Map()) {
  const fired = new Set();
  const reason = new Map();
  for (const [slug, label] of tier0Slugs) {
    fired.add(slug);
    reason.set(slug, `tier0:${label}`);
  }
  for (const slug of citationSlugs) {
    if (fired.has(slug)) continue;
    fired.add(slug);
    reason.set(slug, 'citation');
  }
  for (const [slug, outlets] of outletsBySlug) {
    if (fired.has(slug)) continue;
    // countDistinctOutlets, not outlets.size: an unresolved-outlet item is
    // not a second newsroom (see its comment above).
    if (countDistinctOutlets(outlets) >= 2) {
      fired.add(slug);
      reason.set(slug, 'corroborated');
    }
  }
  return { fired, reason };
}

// ---- dedupe cache keys ---------------------------------------------------
export function normalizeHeadlineKey(title, outlet) {
  return `${String(title ?? '').toLowerCase().replace(/\s+/g, ' ').trim()}::${String(outlet ?? '').toLowerCase()}`;
}

/** Stable hash of a (title, outlet) pair for the seen-headlines cache. */
export function hashHeadline(title, outlet) {
  return createHash('sha1').update(normalizeHeadlineKey(title, outlet)).digest('hex');
}

// ---- tier-0 refresh windows (the floor-publication buckets) -------------
/*
 * WHY THREE WINDOWS INSTEAD OF ONE PER DAY (2026-08-08).
 *
 * Congress.gov publishes day D's floor actions on D+1, between 13:35 and
 * 14:00 UTC. Measured over 6/6 consecutive legislative days from
 * senate.gov's per-day floor XML `Last-Modified` headers: 13:35:27 through
 * 13:55:29, no day outside that band. This repo's own corpus history says
 * the same thing independently: commits made at 08:30-10:10 UTC carry no
 * trace of the previous day's floor actions, commits at 12:15-17:42 do.
 *
 * The tier-0 dedupe key used to be (slug, UTC day), i.e. ONE refresh per
 * bill per day. That is a freshness cap, not just a cost control: any run
 * before ~14:00 UTC — and the hourly newsdesk schedule has several — spends
 * the bill's only slot on the PRE-publication record, so the floor action
 * that lands at 13:47 waits until tomorrow to be picked up.
 *
 * So the day is split into three windows, each of which gets its own slot:
 *   pre     00:00-13:59  catches an early API flip (seen as early as 12:15 UTC)
 *   record  14:00-18:59  the guaranteed window — opens after the latest
 *                        observed publication (13:55) plus margin
 *   session 19:00-23:59  evening updates during late sessions
 *
 * Cost note: this buys more FREE congress.gov refreshes and cannot raise
 * Anthropic spend. The decode budgets (TIER0_DECODE_CAP per run,
 * TIER0_DAILY_DECODE_CAP per UTC day) are accounted entirely separately
 * from this key — see rollDailyDecodes below, and the wiring half of
 * tests/newsdesk-match.unit.spec.ts.
 */
export function floorBucket(d = new Date()) {
  const h = d.getUTCHours();
  return h < 14 ? 'pre' : h < 19 ? 'record' : 'session';
}

/** Dedupe key for one tier-0 (government-feed) bill refresh: (slug, UTC
 *  day, floor window). Only the HASH enters the cache — never feed content
 *  (the never-republish rule). The window is passed in rather than read
 *  from the clock so a run that straddles a boundary spends and marks the
 *  SAME slot it opened with. */
export function tier0SeenKey(slug, dayUTC, bucket = floorBucket()) {
  return hashHeadline(`tier0:${slug}`, `${dayUTC}#${bucket}`);
}

// ---- the decode budget's daily rollover ---------------------------------
/** Roll the persisted tier-0/press decode counters forward for `todayUTC`.
 *
 *  Keyed by UTC DATE ALONE. It deliberately takes no floor-window argument:
 *  the seen-key above is per (day, window), but the SPEND ceiling is per
 *  day, so tripling the key's granularity buys extra free congress.gov
 *  refreshes and cannot buy a single extra Anthropic decode. A bucket
 *  transition must never reset these counts — that is the whole cost
 *  invariant, and tests/newsdesk-match.unit.spec.ts pins it.
 *
 *  Returns a fresh object (never mutates the argument). A cache written
 *  before the tier-0 budget existed has no tier0Count; it defaults to 0
 *  rather than resetting the day. */
export function rollDailyDecodes(dailyDecodes, todayUTC) {
  if (!dailyDecodes || dailyDecodes.date !== todayUTC) {
    return { date: todayUTC, count: 0, tier0Count: 0 };
  }
  return {
    ...dailyDecodes,
    count: dailyDecodes.count ?? 0,
    tier0Count: dailyDecodes.tier0Count ?? 0,
  };
}

// ---- what the decode budget is actually charged for ---------------------
/**
 * Did this syncOneBill result SPEND on the model? (2026-08-09)
 *
 * The budget used to be charged on outcome === 'added' alone, i.e. on
 * SUCCESS. A decode that reached the model and then threw — the shape check
 * in bill-decode.mjs rejecting a reply with a missing tag, which for a given
 * verbose bill is deterministic, not transient — came back 'failed' and cost
 * the caps nothing, while having already paid for the decode call (and, past
 * it, the search-inputs call). The bill then re-fired every hour, all day:
 * unbounded paid retries of a failure that could not succeed. The cap has to
 * price the attempt, because the attempt is what the invoice prices.
 *
 * syncOneBill therefore reports `decodeAttempted`, set immediately before the
 * first Anthropic call, and this charges on it. The three free outcomes are
 * never charged and never can be, because none of them reaches that line:
 *   'refreshed' — an existing bill's fields, Congress.gov only
 *   'gated'     — a new bill with no legislative motion, dropped before decode
 *   'budget'    — the caps already said no this call
 * and 'failed' splits: a failure BEFORE the first model call (a Congress.gov
 * 500, a timeout) is free and stays free, so a transient upstream blip still
 * retries next hour at no cost.
 *
 * THE SECOND FREE CASE (2026-09-18, after the Sep 9-10 credit outage). The
 * attempt is the right thing to price only while the attempt is what the
 * invoice prices. A request the API REFUSES before generating anything is
 * never invoiced: the credit-balance 400, any other invalid_request_error, a
 * 401/403/404/413/422/429, a 5xx. During the outage every decode threw one of
 * those, `decodeAttempted` was true for all of them, and the caps counted all
 * of them — two hours of a failure nobody was billed for ate the whole day's
 * NEWSDESK_DAILY_DECODE_CAP and TIER0_DAILY_DECODE_CAP, so the decodes were
 * still not running an hour after the credits were topped up.
 *
 * syncOneBill/redecodeBill therefore also report `unbilledApiError` (classified
 * in scripts/api-billing.mjs), and this exempts it. Note what that ALSO fixes:
 * the failedDecodeKey day-lock is set inside the caller's `chargeableDecode`
 * branch, so an outage no longer locks a slug out of retrying for the rest of
 * the day either. The shape-check failure this function was built for is
 * unaffected — a bad decode shape carries no HTTP status, so it stays billed
 * and stays charged, which is the whole point of the original fix.
 */
export function chargeableDecode(result) {
  return result?.decodeAttempted === true && result?.unbilledApiError !== true;
}

/** Dedupe key for "this slug already burned a decode and failed, today".
 *
 *  Keyed by UTC DAY, not by floor window: a deterministic decode failure
 *  (the missing-tag case above) fails identically on every retry, so the two
 *  extra tries a per-window key would allow are pure spend with no chance of
 *  a different answer. The day boundary still grants one retry per day, which
 *  is what covers the cases that AREN'T deterministic — a model-side change,
 *  a bill whose text was truncated upstream and has since been republished.
 *
 *  Reuses the seen-set mechanics (hashHeadline over a namespaced pair) so it
 *  rides the same actions/cache entry and the same 7-day GitHub eviction as
 *  every other key in there, with no new persistence to keep. Distinct
 *  namespace, so it can never collide with a headline or tier-0 key. */
export function failedDecodeKey(slug, dayUTC) {
  return hashHeadline(`faildecode:${slug}`, `${dayUTC}`);
}

// ---- the darkness tripwire ----------------------------------------------
/**
 * Fraction of the press basket that must come back empty before the run says
 * so out loud. Half: individual feeds break constantly and alone (AP's RSS
 * 404s, the Washington Post feed serves a 200 with a stub body — both found
 * dead during the 2026-07-16 verification), and an hourly job that shouts at
 * every one of those teaches its owner to ignore it. Half the basket at once
 * is not a feed problem; it is a network, a DNS, or a runner problem.
 */
export const PRESS_SILENT_WARN_RATIO = 0.5;

/**
 * Consecutive fully-dark runs before the warning becomes a red build. Six:
 * the schedule is hourly, so six is six hours of the newsdesk receiving
 * literally nothing — past any upstream blip, any Cloudflare challenge wave,
 * any Actions network incident, and into "this has been broken since before
 * you went to bed". Below that a single ::warning:: is the honest signal;
 * a job that reds on hour one trains its owner to click through, and a job
 * that never reds hides a week-long outage behind a green check.
 */
export const FEED_DARK_ESCALATE_RUNS = 6;

/**
 * Classify one run's feed intake. Pure — the caller counts, this judges.
 *
 * `pressSilent` counts a press feed that threw OR returned zero items: the
 * 200-with-a-stub-body case is invisible to Promise.allSettled and reads
 * exactly like a quiet news hour, which is the half of this failure mode that
 * has no error message at all. Tier-0 counts hard failures only — a floor
 * feed with no items is a recess day, and the docs.house.gov look-ahead 404s
 * legitimately on a no-session week (fetchTier0 returns [] there by design).
 *
 * `dark` is deliberately the strictest reading: EVERY tier-0 feed failed AND
 * EVERY press feed came back silent, i.e. the run received nothing from
 * anyone. That is the only state worth escalating on, because it is the only
 * one that cannot be a coincidence of upstreams.
 */
export function assessFeeds({ tier0Total, tier0Failed, pressTotal, pressSilent }) {
  const tier0Dark = tier0Total > 0 && tier0Failed >= tier0Total;
  const pressDark = pressTotal > 0 && pressSilent >= pressTotal;
  const pressDegraded =
    pressTotal > 0 && pressSilent >= Math.ceil(pressTotal * PRESS_SILENT_WARN_RATIO);
  return { tier0Dark, pressDark, pressDegraded, dark: tier0Dark && pressDark };
}

/** Advance the persisted consecutive-darkness counter. Returns a fresh
 *  object (never mutates the argument), and `escalate` once the streak
 *  reaches `escalateAfter` — staying true for every further dark run, so the
 *  build stays red until someone fixes it rather than going quiet again on
 *  hour seven. Any non-dark run resets the streak to 0: recovery is the
 *  all-clear. A lost cache resets it too, which fails toward silence — the
 *  counter is an escalation aid, never the only signal (the per-run
 *  ::warning:: is emitted independently). */
export function rollFeedDarkness(prev, dark, escalateAfter = FEED_DARK_ESCALATE_RUNS) {
  const previous = Number(prev?.consecutiveDark);
  const consecutiveDark = dark ? (Number.isFinite(previous) && previous > 0 ? previous : 0) + 1 : 0;
  return { consecutiveDark, escalate: consecutiveDark >= escalateAfter };
}

// ---- the no-change-no-commit guard --------------------------------------
/** Given the syncOneBill outcome strings from this run's ON-FIRE actions,
 *  did anything actually mutate bills/es? Only 'refreshed', 'added' and
 *  'redecoded' (the re-decode trigger's outcome — a new decode + its ES twin
 *  written over an existing record, scripts/bill-decode.mjs's redecodeBill)
 *  and 'text-unchanged' (that same trigger finding the document byte-identical
 *  to the one the decode was written from, so it wrote no decode but DID
 *  stamp `decode_text_verified_at` — the stamp has to be committed or the
 *  short-circuit resets every run and saves nothing)
 *  touch the in-memory corpus; 'budget' (decode cap hit), 'failed',
 *  'skipped_partial' (an unreadable Congress.gov payload: no refresh
 *  applied, no new bill created — see readableAction) and 'skipped_no_text'
 *  (a real bill Congress.gov publishes no text for yet, refused rather than
 *  decoded from its title — see syncOneBill) don't.
 *  A tier-0 fire that comes back 'skipped_no_text' therefore spends no
 *  corroboration and is never marked seen, so the next hourly run retries it
 *  — which is the wanted behavior here, not a leak: the retry is two free
 *  Congress.gov calls, and it is what decodes the bill within the hour its
 *  text is finally published.
 *  newsdesk.mjs only calls writeFileSync when this is true, so an
 *  hourly run with nothing to do never produces a diff for the workflow's
 *  own `git diff --cached --quiet` step to (redundantly, but harmlessly)
 *  confirm. */
export function anyDataChanged(outcomes) {
  return outcomes.some(
    (o) => o === 'refreshed' || o === 'added' || o === 'redecoded' || o === 'text-unchanged'
  );
}

// ---- RSS/Atom feed parsing (pure — takes already-fetched XML text) ------
function decodeEntities(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .trim();
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? decodeEntities(m[1]) : null;
}

function extractLink(block) {
  // Atom: <link href="..." /> ; RSS: <link>https://...</link>
  const atom = block.match(/<link\b[^>]*\bhref=["']([^"']+)["']/i);
  if (atom) return atom[1];
  return extractTag(block, 'link');
}

/** Google News RSS (and some aggregator feeds) carry a per-article
 *  <source url="https://outlet.example">Outlet Name</source> tag — use its
 *  domain when present so a single aggregator feed still yields correct
 *  per-article outlet attribution for the ≥2-outlet rule. */
function extractSource(block) {
  const m = block.match(/<source\b[^>]*\burl=["']([^"']+)["'][^>]*>/i);
  if (!m) return null;
  try {
    return new URL(m[1]).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Parse RSS 2.0 <item> or Atom <entry> blocks out of raw feed XML into
 *  `{title, link, pubDate, source}[]`. Best-effort/regex-based (no XML
 *  dependency) — tolerant of the handful of real-world shapes the verified
 *  feed list actually returns (see newsdesk.mjs's SOURCES header comment).
 *  Entries missing a title or link are dropped. */
export function parseFeed(xml) {
  const blocks = [...String(xml ?? '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>|<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)];
  const out = [];
  for (const m of blocks) {
    const body = m[1] ?? m[2] ?? '';
    const title = extractTag(body, 'title');
    const link = extractLink(body);
    if (!title || !link) continue;
    const pubDate = extractTag(body, 'pubDate') || extractTag(body, 'published') || extractTag(body, 'updated');
    out.push({ title, link, pubDate, source: extractSource(body) });
  }
  return out;
}

// ---- Tier-0: government signal feed parsers (pure; shapes verified live
// ---- 2026-07-23 against all four sources) -------------------------------

/** Congress.gov house-floor-today.xml / senate-floor-today.xml: each item's
 *  TITLE is a bare bill number ("H.R.8884", "S.4784", "H.Con.Res.89").
 *  findCitations over the titles resolves the tracked types — which include
 *  H.Con.Res./S.Con.Res. since 2026-07-23 (TRACKED_TYPES), so "H.Con.Res.89"
 *  becomes hconres-89-119 and fires tier-0 like any bill — and silently drops
 *  the untracked ones (H.Res/S.Res simple resolutions, treaties, nominations),
 *  with no partial matches, by the same regex discipline t1 already pins.
 *  (Until 2026-09-25 this comment listed H.Con.Res among the dropped types;
 *  the 2026-09-24 Senate vote on H.Con.Res. 89 fired as
 *  `TIER0 FIRE: hconres-89-119 <- senate-floor-today`.)
 *  Returns deduped slugs. */
export function extractFloorFeedSlugs(xml) {
  const slugs = new Set();
  for (const item of parseFeed(xml)) {
    for (const c of findCitations(item.title)) slugs.add(c.slug);
  }
  return [...slugs];
}

// most-viewed-bills.xml is ONE weekly item whose <description> is an HTML
// <ol> of the top-10 with explicit numbers AND congress tags:
//   <a href='…'>H.R.4818</a> [118th] - Treat and Reduce Obesity Act…
// The congress bracket is load-bearing: the list routinely mixes 118th-
// congress bills in, and firing one of those would resync a bill outside
// the tracked Congress. Same type alternatives as CITATION_RE, plus the
// optional intervening </a> and the [Nth] capture.
const MOST_VIEWED_RE = /\b(H\.?\s?J\.?\s?Res\.?|S\.?\s?J\.?\s?Res\.?|H\.?\s?R\.?|S\.?)\s?(\d{1,5})(?:<\/a>)?\s*\[\s*(\d{1,3})\s*(?:st|nd|rd|th)?\s*\]/gi;

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** The feed's OWN printed week, as a date. congress.gov titles the single
 *  weekly item "Most-Viewed Bills - Week of August 9, 2026" and repeats the
 *  same date in the item's guid; the channel `pubDate` says it a third way.
 *  Nothing is synthesized here — with no printed label this returns null, and
 *  the caller's weeks-on-list accounting simply does not advance (an
 *  unlabelled observation must never manufacture a second week).
 *  @param {string} xml @returns {{ week: string | null, weekLabel: string | null }} */
export function extractMostViewedWeek(xml) {
  const src = String(xml ?? '');
  const item = /<item\b[^>]*>([\s\S]*?)<\/item>/i.exec(src)?.[1] ?? src;
  const title = extractTag(item, 'title');
  const label = /Week of\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i.exec(`${title ?? ''} ${extractTag(item, 'guid') ?? ''}`);
  if (label) {
    const month = MONTH_NAMES.indexOf(label[1].toLowerCase());
    const day = Number(label[2]);
    const year = Number(label[3]);
    if (month >= 0 && Number.isFinite(day) && Number.isFinite(year)) {
      return { week: new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10), weekLabel: title ?? null };
    }
  }
  const pub = Date.parse(extractTag(item, 'pubDate') ?? extractTag(src, 'pubDate') ?? '');
  if (Number.isFinite(pub)) return { week: new Date(pub).toISOString().slice(0, 10), weekLabel: title ?? null };
  return { week: null, weekLabel: title ?? null };
}

/** Extract only CURRENT-Congress (119th) tracked-type slugs from the
 *  most-viewed-bills feed XML, WITH the rank congress.gov gave each one.
 *
 *  Rank is the position in the feed's own <ol>, counted across EVERY list
 *  item — including the ones dropped here (a 118th-Congress bill, a simple
 *  resolution). Renumbering after the drops would invent a rank the source
 *  never published, and the rank is a quoted fact on the page.
 *
 *  Entries from any other congress are excluded, not remapped; a duplicate
 *  slug keeps its first (best) rank.
 *  @param {string} xml @param {number} [congress]
 *  @returns {{ week: string | null, weekLabel: string | null, entries: { slug: string, rank: number }[] }} */
export function extractMostViewedRanked(xml, congress = CONGRESS) {
  const src = String(xml ?? '');
  const seen = new Set();
  const entries = [];
  const push = (block, rank) => {
    for (const m of String(block).matchAll(MOST_VIEWED_RE)) {
      const type = TYPE_ALIASES[normalizeType(m[1])];
      if (!type) continue;
      if (Number(m[3]) !== congress) continue;
      const slug = `${type}-${String(Number(m[2]))}-${congress}`;
      if (seen.has(slug)) continue;
      seen.add(slug);
      entries.push({ slug, rank });
      return; // one measure per list item
    }
  };
  const items = [...src.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)];
  if (items.length > 0) {
    items.forEach((m, i) => push(m[1], i + 1));
  } else {
    // The <ol> shape is what congress.gov has served since this parser was
    // verified live (2026-07-23), but a feed that drops the list markup must
    // still yield slugs — rank then falls back to document order.
    [...src.matchAll(MOST_VIEWED_RE)].forEach((m, i) => push(m[0], i + 1));
  }
  return { ...extractMostViewedWeek(src), entries };
}

/** Extract only CURRENT-Congress (119th) tracked-type slugs from the
 *  most-viewed-bills feed XML, in the list's own order. Entries from any
 *  other congress are excluded, not remapped. */
export function extractMostViewedSlugs(xml, congress = CONGRESS) {
  return extractMostViewedRanked(xml, congress).entries.map((e) => e.slug);
}

/** docs.house.gov/billsthisweek floorschedule XML — the LOOK-AHEAD signal
 *  (bills scheduled days before the vote). Bill numbers live in
 *  <legis-num> elements ("H.R. 2715 ", "H. Con. Res. 113"); ONLY those
 *  elements are scanned — the surrounding <floor-text> prose cites other
 *  bills in passing and must not trigger anything. findCitations again
 *  drops untracked types. Returns deduped slugs. */
export function extractBillsThisWeekSlugs(xml) {
  const slugs = new Set();
  for (const m of String(xml ?? '').matchAll(/<legis-num>([\s\S]*?)<\/legis-num>/gi)) {
    for (const c of findCitations(m[1])) slugs.add(c.slug);
  }
  return [...slugs];
}

/** 'YYYYMMDD' of the Monday of the current week in US/Eastern — the path
 *  segment docs.house.gov keys its billsthisweek XML by. Computed from the
 *  ET calendar date (NOT the UTC date: early-UTC Monday is still Sunday
 *  ET, which belongs to the PREVIOUS week's schedule); Sunday counts as
 *  6 days after its week's Monday. */
export function mondayOfWeekET(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const daysSinceMonday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'));
  const d = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day'))));
  d.setUTCDate(d.getUTCDate() - Math.max(0, daysSinceMonday));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// ---- pendingOutlets hygiene ---------------------------------------------
/** How long a single-outlet soft match may wait for its second outlet
 *  before the pending entry expires. Mirrors GitHub's own 7-day cache
 *  eviction (the outer bound the workflow already relies on), but enforced
 *  in-code so a cache that stays warm through daily runs can't accumulate
 *  stale holds forever. */
export const PENDING_OUTLETS_TTL_DAYS = 7;

/** Split a persisted pendingOutlets object ({slug: {outlets, updated}})
 *  into entries still inside the TTL and expired slugs. An entry with a
 *  missing/unparseable `updated` is treated as expired (fail-closed: it
 *  re-accumulates from fresh headlines rather than living forever). */
export function prunePendingOutlets(pending, nowMs = Date.now()) {
  const kept = {};
  const expired = [];
  const ttlMs = PENDING_OUTLETS_TTL_DAYS * 86_400_000;
  for (const [slug, entry] of Object.entries(pending ?? {})) {
    const updated = Date.parse(entry?.updated ?? '');
    if (Number.isFinite(updated) && nowMs - updated <= ttlMs) kept[slug] = entry;
    else expired.push(slug);
  }
  return { kept, expired };
}

/** One-line, log-friendly summary of the guardrail's current holds — the
 *  soft matches waiting on a second distinct outlet. Only slugs (never
 *  headline text) appear, per the never-republish-feed-content rule.
 *
 *  A "hold" is counted the same way decideFires counts a fire: by REAL
 *  outlets. An entry sitting at {'cbsnews.com', 'unknown'} is one newsroom
 *  waiting for a second, and the log has to say so — reading it as a
 *  two-outlet entry that simply hasn't fired would make this line disagree
 *  with the rule it reports on. */
export function summarizePendingOutlets(pending, nowMs = Date.now()) {
  const holds = Object.entries(pending ?? {})
    .filter(([, e]) => countDistinctOutlets(e?.outlets) === 1)
    .map(([slug, e]) => {
      const ageDays = Math.max(0, Math.floor((nowMs - Date.parse(e.updated ?? '')) / 86_400_000));
      const only = e.outlets.find((o) => String(o ?? '').trim().toLowerCase() !== UNRESOLVED_OUTLET);
      return `${slug}<-${only} (${Number.isFinite(ageDays) ? ageDays : '?'}d)`;
    });
  return holds.length
    ? `pending single-outlet holds (need a 2nd distinct outlet to fire): ${holds.join(', ')}`
    : 'pending single-outlet holds: none';
}

// ---- nickname bridge (non-corpus bills covered by name only) ------------
/** Pull the DISTINCTIVE tokens out of a headline: quoted names, capitalized
 *  runs ending in "Act" ("SAVE America Act"), and ALL-CAPS acronyms (SAVE,
 *  CHIPS, NDAA). Everything else in the headline is deliberately ignored —
 *  the bridge should match on what a bill is CALLED, not on topic words.
 *  Output goes through tokenize(), so stopwords and <4-char scraps (GOP,
 *  CR) drop out. */
export function extractNicknameTokens(headline) {
  const h = String(headline ?? '');
  const picks = [];
  for (const m of h.matchAll(/["“'‘]([^"”'’]{3,80})["”'’]/g)) picks.push(m[1]);
  for (const m of h.matchAll(/\b((?:(?:[A-Z][A-Za-z'’-]*|of|the|and|for)\s+){0,7}Act)\b/g)) picks.push(m[1]);
  for (const m of h.matchAll(/\b[A-Z]{3,6}s?\b/g)) picks.push(m[0]);
  return Array.from(new Set(tokenize(picks.join(' '))));
}

/** Build a t2-style token index from a Congress.gov /bill/{congress} LIST
 *  page's items ({congress, type, number, title} — the shape
 *  congress-fetch.mjs's fetchRecentlyUpdated returns). Untracked types and
 *  other congresses are skipped. df is attached so scoreCandidates-style
 *  rarity works over the small list too. */
export function buildListIndex(items, congress = CONGRESS) {
  const index = [];
  for (const it of items ?? []) {
    const type = String(it.type ?? '').toLowerCase();
    if (!TRACKED_TYPES.has(type)) continue;
    if (Number(it.congress ?? congress) !== congress) continue;
    const tokens = new Set(tokenize(it.title));
    if (tokens.size === 0) continue;
    index.push({ slug: `${type}-${it.number}-${congress}`, title: it.title, tokens });
  }
  return attachDf(index);
}

/** Resolve extracted nickname tokens against a list index, conservatively:
 *  the top candidate must (a) contain ALL the extracted tokens when there
 *  are 1-2 of them, or all-but-one when there are 3+, and (b) STRICTLY
 *  beat the runner-up — a tie is ambiguity, and the bridge has no t3 to
 *  hand ambiguity to, so it returns null rather than guess. Returns
 *  { slug, title } or null. */
export function matchNickname(tokens, listIndex) {
  if (!tokens || tokens.length === 0) return null;
  const scored = [];
  for (const e of listIndex) {
    let shared = 0;
    for (const t of tokens) if (e.tokens.has(t)) shared++;
    if (shared > 0) scored.push({ slug: e.slug, title: e.title, shared });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.shared - a.shared);
  const [top, runnerUp] = scored;
  const need = tokens.length <= 2 ? tokens.length : tokens.length - 1;
  if (top.shared >= need && (!runnerUp || top.shared > runnerUp.shared)) {
    return { slug: top.slug, title: top.title };
  }
  return null;
}
