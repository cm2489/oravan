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
 * ---- Three-tier match design, cheapest first ----
 * t1 (findCitations): regex over explicit bill-number citations
 *    ("H.R. 1234", "S. 567", "H.J.Res. 45"). Free, resolves directly to a
 *    slug for any of our four tracked types (hr, s, hjres, sjres; the
 *    119th Congress). Fires on ANY single outlet — an explicit citation is
 *    unambiguous, so no corroboration is required.
 * t2 (matchLocal): free normalized-token overlap against the corpus's own
 *    bill titles + press_names (data/bills.json fields — there is no
 *    separate data/search-inputs.json; press_names/news_query live
 *    directly on each bill object). A confident single match skips the LLM
 *    entirely; an ambiguous shortlist (multiple plausible candidates, or a
 *    weak-but-present signal on a legislative-looking headline) is handed
 *    to t3.
 * t3 (resolved by scripts/newsdesk.mjs's one batched Haiku call): ONLY
 *    headlines t2 left ambiguous. This module supplies the batch
 *    membership test (looksLegislative) and validates the LLM's output
 *    against the offered candidates (a hallucinated slug is never trusted
 *    — see newsdesk.mjs's resolveWithHaiku).
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
export const TRACKED_TYPES = new Set(['hr', 's', 'hjres', 'sjres']);

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
const CITATION_RE = /\b(H\.?\s?J\.?\s?Res\.?|S\.?\s?J\.?\s?Res\.?|H\.?\s?R\.?|S\.?)\s?(\d{1,5})\b/gi;

function normalizeType(raw) {
  return raw.replace(/[^a-zA-Z]/g, '').toLowerCase();
}

const TYPE_ALIASES = { h: null, hr: 'hr', s: 's', hjres: 'hjres', sjres: 'sjres' };

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

/** Build the free-match index once per run: slug -> token set drawn from
 *  the bill's title + press_names (data/bills.json fields; there is no
 *  separate search-inputs.json). Bills with no usable tokens are skipped. */
export function buildBillIndex(bills) {
  const index = [];
  for (const b of bills) {
    const text = [b.title, ...((b.press_names ?? []))].filter(Boolean).join(' ');
    const tokens = new Set(tokenize(text));
    if (tokens.size === 0) continue;
    index.push({ slug: slugOfBill(b), title: b.title, tokens });
  }
  return index;
}

const T2_CONFIDENT_MIN_SHARED = 3;
const T2_CONFIDENT_MIN_RATIO = 0.6;
const T2_CANDIDATE_MIN_SHARED = 2;

/** Score every indexed bill against a headline's tokens by raw shared-token
 *  count (+ratio of the headline's own tokens). Sorted best-first. */
export function scoreCandidates(headline, billIndex) {
  const hTokens = tokenize(headline);
  if (hTokens.length === 0) return [];
  const scored = [];
  for (const entry of billIndex) {
    let shared = 0;
    for (const t of hTokens) if (entry.tokens.has(t)) shared++;
    if (shared >= T2_CANDIDATE_MIN_SHARED) {
      scored.push({ slug: entry.slug, title: entry.title, shared, ratio: shared / hTokens.length });
    }
  }
  scored.sort((a, b) => b.shared - a.shared || b.ratio - a.ratio);
  return scored;
}

/** t2 verdict for one headline against the index:
 *   { tier: 't2', slug }        - one candidate is clearly the best match
 *   { tier: 'ambiguous', candidates } - 1+ plausible candidates, none
 *                                  clearly separated - t3's job
 *   null                        - no local signal at all */
export function matchLocal(headline, billIndex) {
  const candidates = scoreCandidates(headline, billIndex);
  if (candidates.length === 0) return null;
  const [top, runnerUp] = candidates;
  const confident =
    top.shared >= T2_CONFIDENT_MIN_SHARED &&
    top.ratio >= T2_CONFIDENT_MIN_RATIO &&
    (!runnerUp || top.shared >= runnerUp.shared * 1.5);
  if (confident) return { tier: 't2', slug: top.slug };
  return { tier: 'ambiguous', candidates: candidates.slice(0, 5) };
}

// ---- t3 gating: only headlines that look legislative -------------------
const LEGISLATIVE_SIGNAL_RE = /\b(bill|act|legislation|resolution|congress|senate|house|vote|voted|passed|introduced|amendment|committee|markup|filibuster|cloture|veto|vetoed|lawmakers?|representatives?|senators?)\b/i;

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
 * Returns { fired: Set<slug>, reason: Map<slug, 'citation'|'corroborated'> }.
 */
export function decideFires(citationSlugs, outletsBySlug) {
  const fired = new Set();
  const reason = new Map();
  for (const slug of citationSlugs) {
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
