/*
 * BILL SEARCH — one matcher for the corpus's free-text bill search, built for
 * both surfaces that have one: the MCP `search_bills` tool (lib/core/mcp.ts,
 * via its searchDocFor) and the on-site bills search (its card-shaped field
 * list is `teaserSearchDoc`, below). The 2026-09-27 audit (SY-21).
 *
 * WHAT IT REPLACES. Both surfaces used to match the WHOLE query as a single
 * substring of one field at a time. "Iran war powers" therefore found only
 * the one bill whose headline happened to contain that exact phrase, while
 * the corpus held twelve Iran war-powers resolutions; "hconres 89" found
 * nothing at all, because no field spells the citation that way. Two
 * surfaces, two hand-written copies of the rule, both wrong the same way.
 *
 * THE RULE, in three parts:
 *
 *   1. CITATIONS. A bill number anywhere in the query is read as a citation
 *      and normalised: "H.Con.Res. 89", "H. Con. Res. 89", "hconres 89",
 *      "hconres89" and the slug "hconres-89-119" all mean the same bill. A
 *      citation matches that bill EXACTLY — type and number, and Congress
 *      too when the query gave one (the slug form) — so "S. 89" never
 *      matches H.Con.Res. 89 on the "s89" inside "hconres89". Several
 *      citations in one query are alternatives (a bill carries exactly one
 *      number, so requiring all of them could only ever return nothing).
 *
 *   2. WORDS. Everything else is split into words — lower case, accents
 *      stripped, so "Irán" finds "Iran" and "inmigracion" finds
 *      "inmigración" — and EVERY word must appear somewhere in the bill's
 *      searchable text. Any field will do; the words need not share one.
 *      Each word matches as a substring, exactly as the whole phrase used
 *      to, and a word of four or more letters ending in a single "s" is
 *      searched without it ("resolutions" finds "Resolution", "fuerzas"
 *      finds "fuerza"). Both only ever WIDEN a match, so for a query with no
 *      bill number in it the result set is a SUPERSET of what the old
 *      whole-phrase rule returned: nothing a reader could find before is
 *      lost. There is no other stemming, on purpose — every further rule
 *      trades precision for recall in ways a reader cannot see.
 *
 *   3. FUNCTION WORDS ("the", "of", "de", "la", …) are dropped, unless the
 *      query holds nothing else. They carry no topic, and an agent that
 *      writes "war powers resolutions about Iran" should not lose every bill
 *      whose text never happens to say "about".
 *
 * WHAT A SURFACE SUPPLIES is only its list of fields (`billSearchDoc`); the
 * parsing, folding and matching are all here. The MCP tool's list is title,
 * short title, AI headline, AI summary and topic labels; the card-shaped
 * list (`teaserSearchDoc`) is title, AI headline and topic labels, because
 * the card payload is all the bills page has. Both also match the citation.
 *
 * ORDER is the caller's: the MCP tool sorts by urgency and breaks ties with
 * `compareLastActionDesc` (newest action first); the bills page keeps the
 * docket ladder's own order. Matching decides which bills appear, never
 * their rank.
 *
 * Plain .mjs with JSDoc types (the lib/urgency.mjs pattern) so the TS lib, a
 * client component and the unit tests can all import it unchanged. Written
 * to be safe in the browser: its regexes use NO lookbehind, which is a parse
 * error in Safari before 16.4 — and a parse error in a shared module takes
 * the whole page's script down with it. Pinned by
 * tests/bill-search.unit.spec.ts and, through the real MCP entry, by
 * tests/mcp-stdio.unit.spec.ts.
 */

/**
 * @typedef {{ key: string, congress: number | null }} CitationRef
 *   `key` is the compact type+number ("hconres89"); `congress` is set only
 *   when the source named one (a slug), and then must match too.
 * @typedef {{ citations: CitationRef[], words: string[] }} BillQuery
 * @typedef {{ text: string, citation: CitationRef | null }} BillSearchDoc
 */

/*
 * The eight bill types Congress numbers, longest spelling first so
 * "H.Con.Res." is tried before "H.R." at the same position. Every internal
 * dot or space is optional, which is what makes "H. Con. Res.", "H.Con.Res."
 * and "hconres" one type.
 */
const SEP = '[.\\s]*';
const TYPE_ALTERNATIVES = [
  ['h', 'con', 'res'],
  ['s', 'con', 'res'],
  ['h', 'j', 'res'],
  ['s', 'j', 'res'],
  ['h', 'res'],
  ['s', 'res'],
  ['h', 'r'],
  ['s'],
]
  .map((parts) => parts.join(SEP))
  .join('|');

/*
 * A citation: an optional boundary character (group 1, kept so the
 * replacement can put it back), the type (group 2), the number (group 3),
 * and an optional "-<congress>" (group 4) for the slug form.
 *
 * The boundary is spelled as a CONSUMED character class, not a lookbehind
 * (see the header). It excludes letters and digits — "veterans 2026" is not
 * S. 2026 — and also a period and an apostrophe: "U.S. 2026" is not S. 2026,
 * and neither is the possessive in "women's 2026" (the same trap
 * scripts/newsdesk-match.mjs documents for headlines).
 */
const CITATION_SOURCE = `(^|[^\\p{L}\\p{N}.'’])(${TYPE_ALTERNATIVES})${SEP}-?${SEP}(\\d{1,5})(?:-(\\d{2,3}))?(?![\\p{L}\\p{N}])`;

/** A fresh global matcher per call: a shared /g regex carries `lastIndex`. */
const citationRegex = () => new RegExp(CITATION_SOURCE, 'gu');

/*
 * Function words, English and Spanish. Deliberately short: only words that
 * carry no topic in either language. Domain words ("act", "bill", "ley",
 * "resolution") stay searchable — in some titles they are the point.
 */
export const SEARCH_STOPWORDS = new Set([
  // English
  'a', 'an', 'the', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'at', 'by',
  'with', 'from', 'into', 'about',
  // Spanish
  'el', 'la', 'los', 'las', 'lo', 'un', 'una', 'unos', 'unas', 'de', 'del',
  'al', 'y', 'e', 'o', 'u', 'en', 'con', 'por', 'para', 'sobre', 'que',
]);

/**
 * Lower-case and strip accents (NFD, then drop every combining mark), so the
 * query and the text compare on the same footing in both languages.
 * @param {unknown} s
 * @returns {string}
 */
export function foldSearchText(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/**
 * The words of a string, folded, split on anything that is not a letter or
 * a digit. Letters of every script are kept, so a query in another alphabet
 * stays a query (and honestly matches nothing) instead of folding away to an
 * empty string that would match everything.
 * @param {unknown} s
 * @returns {string[]}
 */
export function searchWords(s) {
  return foldSearchText(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * The plural fold: a word of 4+ characters ending in one "s" (not "ss") is
 * searched without it. The result is always a prefix of the word, so a text
 * that contained the word still contains its stem — the fold can only widen.
 * @param {string} w a folded word
 * @returns {string}
 */
export function searchStem(w) {
  return w.length >= 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

/** @param {RegExpExecArray | RegExpMatchArray} m @returns {CitationRef} */
function citationFromMatch(m) {
  const type = m[2].replace(/[^a-z]/g, '');
  const number = String(Number(m[3]));
  return { key: `${type}${number}`, congress: m[4] ? Number(m[4]) : null };
}

/**
 * Read a WHOLE string as one citation — a slug ("hconres-89-119") or a
 * display citation ("H.Con.Res. 89") — or null when it is anything else.
 * This is how a surface tells the matcher which bill a record is.
 * @param {string} s
 * @returns {CitationRef | null}
 */
export function readCitation(s) {
  const folded = foldSearchText(s).trim();
  const m = citationRegex().exec(folded);
  if (!m || m.index !== 0 || m[1] !== '' || m[0].length !== folded.length) return null;
  return citationFromMatch(m);
}

/**
 * Split a free-text query into the citations it names and the words it
 * searches for.
 * @param {string | null | undefined} query
 * @returns {BillQuery}
 */
export function parseBillQuery(query) {
  const folded = foldSearchText(query);
  /** @type {CitationRef[]} */
  const citations = [];
  let rest = '';
  let from = 0;
  for (const m of folded.matchAll(citationRegex())) {
    citations.push(citationFromMatch(m));
    // Keep the boundary character; the citation itself becomes a gap.
    rest += `${folded.slice(from, m.index)}${m[1]} `;
    from = (m.index ?? 0) + m[0].length;
  }
  rest += folded.slice(from);
  const all = searchWords(rest);
  const content = all.filter((w) => !SEARCH_STOPWORDS.has(w));
  // A query of nothing BUT function words still searches for them.
  const words = content.length > 0 || citations.length > 0 ? content : all;
  return { citations, words: [...new Set(words.map(searchStem))] };
}

/**
 * True when the query has nothing to search for (blank, or punctuation
 * only). Callers treat that exactly like no query at all.
 * @param {BillQuery} q
 */
export function isEmptyBillQuery(q) {
  return q.citations.length === 0 && q.words.length === 0;
}

/**
 * The searchable form of one bill: its fields folded into one space-joined
 * word string, plus its citation. The compact citation ("hconres89") joins
 * the text too, so a bare number ("89") or a bare type ("hconres") still
 * finds it the way the old identifier match did.
 *
 * Fields are joined with a space and every word is a run of letters or
 * digits, so a query word can never match across two fields' boundary.
 *
 * @param {string} citation the bill's slug or display citation
 * @param {ReadonlyArray<string | null | undefined>} fields
 * @returns {BillSearchDoc}
 */
export function billSearchDoc(citation, fields) {
  const ref = readCitation(citation);
  const parts = fields.filter(Boolean).map(foldSearchText);
  if (ref) parts.push(ref.key);
  // One pass over the joined text: every run of non-letters/digits becomes a
  // single space — the same words searchWords() would split out.
  return { text: ` ${parts.join(' ')} `.replace(/[^\p{L}\p{N}]+/gu, ' '), citation: ref };
}

/**
 * THE match. Every citation-free word must appear in the bill's text; when
 * the query names citations, the bill must be one of them.
 * @param {BillQuery} q
 * @param {BillSearchDoc} doc
 * @returns {boolean}
 */
export function matchesBillQuery(q, doc) {
  if (q.citations.length > 0) {
    const c = doc.citation;
    if (!c) return false;
    const named = q.citations.some((r) => r.key === c.key && (r.congress === null || r.congress === c.congress));
    if (!named) return false;
  }
  return q.words.every((w) => doc.text.includes(w));
}

/**
 * The card-shaped field list for the site's bills search: title, AI
 * headline, topic labels, and the citation read off the slug. One exported
 * list, so the page and any test that reasons about the page's matches can
 * never drift into two.
 * @param {{ slug: string, title: string, headline: string | null, tags: readonly string[] }} teaser
 * @param {(tag: string) => string} tagLabel the localized topic name
 * @returns {BillSearchDoc}
 */
export function teaserSearchDoc(teaser, tagLabel) {
  return billSearchDoc(teaser.slug, [teaser.title, teaser.headline, ...teaser.tags.map(tagLabel)]);
}

/**
 * Tie-break for equally ranked results: the most recent last action first,
 * an unknown date last. ISO dates compare correctly as strings.
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {number}
 */
export function compareLastActionDesc(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? 1 : a > b ? -1 : 0;
}
