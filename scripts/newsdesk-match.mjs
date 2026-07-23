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
 *    membership test (looksLegislative) and validates the LLM's output
 *    against the offered candidates (a hallucinated slug is never trusted
 *    — see newsdesk.mjs's resolveWithHaiku).
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
const CITATION_RE =
  /\b(H\.?\s?Con\.?\s?Res\.?|S\.?\s?Con\.?\s?Res\.?|H\.?\s?J\.?\s?Res\.?|S\.?\s?J\.?\s?Res\.?|H\.?\s?R\.?|S\.?)\s?(\d{1,5})\b/gi;

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

/** Lower-case, strip punctuation/accents, drop short + stop words. Returns
 *  a de-duplicated token array. */
export function tokenize(s) {
  const raw = String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics after NFKD (e.g. é -> e)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
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

/** Build the free-match index once per run: slug -> token set drawn from
 *  the bill's title + press_names + news_query (data/bills.json fields;
 *  there is no separate search-inputs.json). news_query is the corpus's
 *  own press-search phrasing (~2,255 bills carry one) — exactly the
 *  vocabulary headlines use, so it belongs in the t2 index alongside the
 *  formal title. Bills with no usable tokens are skipped. */
export function buildBillIndex(bills) {
  const index = [];
  for (const b of bills) {
    const text = [b.title, ...((b.press_names ?? [])), b.news_query].filter(Boolean).join(' ');
    const tokens = new Set(tokenize(text));
    if (tokens.size === 0) continue;
    index.push({ slug: slugOfBill(b), title: b.title, tokens });
  }
  return attachDf(index);
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

/** Score every indexed bill against a headline's tokens. `shared` is the
 *  raw shared-token count; `weight` is rarity-weighted (rare tokens count
 *  double — see RARE_TOKEN_MAX_DF); `ratio` stays raw-count-based so it
 *  keeps meaning "what fraction of the headline's own tokens matched".
 *  Sorted best-first by weight, then ratio. */
export function scoreCandidates(headline, billIndex) {
  const hTokens = tokenize(headline);
  if (hTokens.length === 0) return [];
  const df = billIndex.df ?? new Map();
  const scored = [];
  for (const entry of billIndex) {
    let shared = 0;
    let weight = 0;
    for (const t of hTokens) {
      if (entry.tokens.has(t)) {
        shared++;
        weight += (df.get(t) ?? Infinity) <= RARE_TOKEN_MAX_DF ? 2 : 1;
      }
    }
    if (weight >= T2_CANDIDATE_MIN_SHARED) {
      scored.push({ slug: entry.slug, title: entry.title, shared, weight, ratio: shared / hTokens.length });
    }
  }
  scored.sort((a, b) => b.weight - a.weight || b.ratio - a.ratio);
  return scored;
}

/** t2 verdict for one headline against the index:
 *   { tier: 't2', slug }        - one candidate is clearly the best match
 *   { tier: 'ambiguous', candidates } - 1+ plausible candidates, none
 *                                  clearly separated - t3's job
 *   null                        - no local signal at all
 *  Confidence thresholds run on the rarity-WEIGHTED count, so one rare +
 *  one common token (weight 3) can be confident where two common tokens
 *  (weight 2) cannot; a lone rare token (weight 2) is a candidate but
 *  never confident — it goes to t3 for disambiguation, not straight to a
 *  fire. */
export function matchLocal(headline, billIndex) {
  const candidates = scoreCandidates(headline, billIndex);
  if (candidates.length === 0) return null;
  const [top, runnerUp] = candidates;
  const confident =
    top.weight >= T2_CONFIDENT_MIN_SHARED &&
    top.ratio >= T2_CONFIDENT_MIN_RATIO &&
    (!runnerUp || top.weight >= runnerUp.weight * 1.5);
  if (confident) return { tier: 't2', slug: top.slug };
  return { tier: 'ambiguous', candidates: candidates.slice(0, 5) };
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
const LEGISLATIVE_SIGNAL_RE = /\b(bill|act|legislation|resolution|congress|senate|house|vote|voted|passed|introduced|amendment|committee|markup|filibuster|cloture|veto|vetoed|lawmakers?|representatives?|senators?|megabill|package|stopgap|continuing resolution|budget blueprint|reconciliation)\b/i;

/** Cheap pre-filter: does this headline look like it MIGHT be about a
 *  specific bill, before spending an LLM call disambiguating it? */
export function looksLegislative(headline) {
  return LEGISLATIVE_SIGNAL_RE.test(String(headline ?? ''));
}

// ---- the ≥2-outlet rule -------------------------------------------------
/**
 * Decide which bills fire this run.
 *   citationSlugs: Set<slug> matched by an explicit citation (t1) this run
 *     - fires on any single outlet, no corroboration needed.
 *   outletsBySlug: Map<slug, Set<outlet>> - outlets that matched this slug
 *     via t2/t3, ACCUMULATED across runs (the caller persists this in the
 *     seen-headlines cache) so corroboration can build up over multiple
 *     hourly polls, not just within one run's fetch window.
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
    if (outlets && outlets.size >= 2) {
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

// ---- the no-change-no-commit guard --------------------------------------
/** Given the syncOneBill outcome strings from this run's ON-FIRE actions,
 *  did anything actually mutate bills/es? Only 'refreshed' and 'added'
 *  touch the in-memory corpus; 'budget' (decode cap hit) and 'failed'
 *  don't. newsdesk.mjs only calls writeFileSync when this is true, so an
 *  hourly run with nothing to do never produces a diff for the workflow's
 *  own `git diff --cached --quiet` step to (redundantly, but harmlessly)
 *  confirm. */
export function anyDataChanged(outcomes) {
  return outcomes.some((o) => o === 'refreshed' || o === 'added');
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
 *  findCitations over the titles resolves the tracked types and silently
 *  drops the untracked ones (H.Con.Res/H.Res/S.Res/treaties/nominations) —
 *  no partial matches, by the same regex discipline t1 already pins.
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

/** Extract only CURRENT-Congress (119th) tracked-type slugs from the
 *  most-viewed-bills feed XML. Entries from any other congress are
 *  excluded, not remapped. */
export function extractMostViewedSlugs(xml, congress = CONGRESS) {
  const slugs = new Set();
  for (const m of String(xml ?? '').matchAll(MOST_VIEWED_RE)) {
    const type = TYPE_ALIASES[normalizeType(m[1])];
    if (!type) continue;
    if (Number(m[3]) !== congress) continue;
    slugs.add(`${type}-${String(Number(m[2]))}-${congress}`);
  }
  return [...slugs];
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
 *  headline text) appear, per the never-republish-feed-content rule. */
export function summarizePendingOutlets(pending, nowMs = Date.now()) {
  const holds = Object.entries(pending ?? {})
    .filter(([, e]) => (e?.outlets?.length ?? 0) === 1)
    .map(([slug, e]) => {
      const ageDays = Math.max(0, Math.floor((nowMs - Date.parse(e.updated ?? '')) / 86_400_000));
      return `${slug}<-${e.outlets[0]} (${Number.isFinite(ageDays) ? ageDays : '?'}d)`;
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
