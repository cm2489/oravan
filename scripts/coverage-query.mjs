/**
 * The pure, testable half of the nightly coverage sync — the same
 * script/pure-sibling split scripts/newsdesk.mjs uses with
 * newsdesk-match.mjs, and for the same reason: scripts/sync-coverage.mjs runs
 * its work at module top level (and process.exit(0)s without NEWS_API_KEY),
 * so nothing in it can be imported by a test. Anything here is I/O-free.
 * Shared with the eval harness (scripts/eval-coverage-queries.mjs) and pinned
 * by tests/coverage-query.unit.spec.ts.
 *
 * Contents: the search-query builder (below) and the TheNewsAPI rate-limit
 * header reader (bottom).
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
