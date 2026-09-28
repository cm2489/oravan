/**
 * ADDED PRESS NAMES — the names the press prints for a bill that its generated
 * search handles lack, read from an owner-approved data file and OR-ed onto the
 * nightly coverage query (scripts/coverage-query.mjs queryWithAddedNames).
 *
 * WHY THIS EXISTS (2026-09-27). A bill's press_names are generated once, at
 * decode time, by scripts/search-inputs.mjs, and that prompt may only use names
 * the OFFICIAL TITLE supports. That rule is right (it stopped invented names),
 * and it leaves two kinds of bill unsearchable by the name the press uses:
 *   - a formal long title has no press name at all: H.Con.Res. 89, "Directing
 *     the President, pursuant to section 5(c) of the War Powers Resolution, to
 *     remove United States Armed Forces from hostilities with Iran", is printed
 *     as "Iran War Powers Resolution";
 *   - a short title the press shortens: H.R. 3633, "Digital Asset Market
 *     Clarity Act", is printed as "CLARITY Act".
 * There was no way to add a name short of hand-editing data/bills.json, a
 * generated file the nightly rewrites. This is that way, and it is the only one.
 *
 * WHAT IT DOES, AND ONLY THIS:
 *   - It ADDS. An added name is OR-ed onto the bill's query; nothing generated
 *     is removed, reordered or replaced, and the subject-query arm stays
 *     (queryWithAddedNames). data/bills.json is never written.
 *   - It feeds the nightly coverage search (scripts/sync-coverage.mjs) and its
 *     eval harness (scripts/eval-coverage-queries.mjs), nothing else. The
 *     newsdesk's t2 index (scripts/newsdesk-match.mjs buildBillIndex) and the
 *     GDELT intake's per-question terms (questionTerms) still read
 *     data/bills.json's press_names only: the newsdesk's floor-record family
 *     test reads each bill's token set, so a name shared by the Iran
 *     resolutions would change how it separates them, and that is not measured.
 *   - Nothing here is displayed. press_names are search input, never page text.
 *
 * EVERY NAME CARRIES ITS EVIDENCE. An entry cites the stored headlines that
 * print the name (title, URL, outlet, date, and the bill it was stored under),
 * and a name that no cited headline prints is rejected. The evidence is copied
 * INTO the file rather than pointed at, because data/coverage.json rotates:
 * a pointer would go stale the week the article ages out.
 *
 * A MALFORMED FILE FAILS CLOSED, like data/press-allowlist.json
 * (lib/press-outlets.mjs): one problem anywhere and no name is added that
 * night, and the problems are reported. So a typo can only ever fall back to
 * the generated names — the behaviour before this file — never widen a query
 * with a name nobody checked. tests/press-names.unit.spec.ts parses the real
 * file, so a bad file is red on the pull request that adds it.
 *
 * Shape (keys are coverage slugs, e.g. "hr-3633-119"):
 *
 *   {
 *     "_note": "…",
 *     "bills": {
 *       "hr-3633-119": {
 *         "add": ["CLARITY Act"],
 *         "note": "optional: why",
 *         "evidence": [
 *           { "title": "CLARITY Act Fails 49-50: SEC, CFTC Write Rules Anyway",
 *             "url": "https://…", "source": "financefeeds.com",
 *             "published": "2026-09-24", "stored_under": "hr-3633-119" }
 *         ]
 *       }
 *     }
 *   }
 *
 * Pure: the caller does the I/O (loadPressNames takes readJSON/exists), so the
 * unit suite drives every branch with no filesystem.
 */
import { isUsablePressName } from './coverage-query.mjs';

export const PRESS_NAMES_PATH = 'data/press-names.json';

/** At most this many names added per bill — the generator's own ceiling. */
export const MAX_ADDED_NAMES = 3;

const SLUG = /^(hr|s|hjres|sjres|hconres|sconres|hres|sres)-[1-9]\d*-[1-9]\d*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_KEYS = new Set(['add', 'evidence', 'note']);
const EVIDENCE_KEYS = new Set(['title', 'url', 'source', 'published', 'stored_under']);

/* Word-boundary phrase test, case-insensitive, apostrophe-form-insensitive,
   punctuation and quote marks read as a space: "CLARITY Act" is printed in
   "…as CLARITY Act Stalls", "Common Cents Act" in "the ‘Common Cents’ Act",
   "Kayleigh's Law" in "Kayleigh’s Law". An apostrophe inside a word stays. */
const words = (s) => {
  const ws = String(s ?? '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .split(/[^a-z0-9']+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
  return ` ${ws.join(' ')} `;
};

/**
 * Does this headline print this name?
 * @param {string} title @param {string} name
 */
export function printsName(title, name) {
  const n = words(name);
  return n.trim() !== '' && words(title).includes(n);
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Read a press-names document. Never throws.
 *
 * @param {unknown} raw the parsed JSON, or null/undefined when there is no file
 * @returns {{ bySlug: Map<string, string[]>, problems: string[] }}
 *   `problems` non-empty means the file was rejected WHOLE: `bySlug` is empty.
 */
export function parsePressNames(raw) {
  const none = { bySlug: new Map(), problems: [] };
  if (raw === null || raw === undefined) return none;
  if (!isObject(raw)) return { bySlug: new Map(), problems: ['root must be an object with a "bills" map'] };
  const bills = /** @type {any} */ (raw).bills;
  if (!isObject(bills)) return { bySlug: new Map(), problems: ['"bills" must be an object keyed by coverage slug (e.g. "hr-3633-119")'] };

  const problems = [];
  const bySlug = new Map();
  for (const [slug, entry] of Object.entries(bills)) {
    const at = `"${slug}"`;
    if (!SLUG.test(slug)) {
      problems.push(`${at} is not a coverage slug (type-number-congress, lowercase, e.g. "hr-3633-119")`);
      continue;
    }
    if (!isObject(entry)) {
      problems.push(`${at} must be an object with "add" and "evidence"`);
      continue;
    }
    for (const k of Object.keys(entry)) if (!ENTRY_KEYS.has(k)) problems.push(`${at} has an unknown key "${k}" (allowed: ${[...ENTRY_KEYS].join(', ')})`);

    const add = entry.add;
    if (!Array.isArray(add) || add.length === 0) {
      problems.push(`${at}: "add" must be a non-empty list of names`);
      continue;
    }
    if (add.length > MAX_ADDED_NAMES) problems.push(`${at}: at most ${MAX_ADDED_NAMES} added names per bill (it has ${add.length})`);
    const names = [];
    const seen = new Set();
    for (const n of add) {
      if (!isUsablePressName(n)) {
        problems.push(`${at}: ${JSON.stringify(n)} is not a usable name (empty, over 60 characters, or a bare bill citation)`);
        continue;
      }
      const name = n.trim();
      if (seen.has(name.toLowerCase())) {
        problems.push(`${at}: "${name}" is listed twice`);
        continue;
      }
      seen.add(name.toLowerCase());
      names.push(name);
    }

    const evidence = entry.evidence;
    if (!Array.isArray(evidence) || evidence.length === 0) {
      problems.push(`${at}: "evidence" must list the stored headlines that print each name`);
      continue;
    }
    const titles = [];
    evidence.forEach((e, i) => {
      const where = `${at} evidence[${i}]`;
      if (!isObject(e)) {
        problems.push(`${where} must be an object`);
        return;
      }
      for (const k of Object.keys(e)) if (!EVIDENCE_KEYS.has(k)) problems.push(`${where} has an unknown key "${k}" (allowed: ${[...EVIDENCE_KEYS].join(', ')})`);
      if (typeof e.title !== 'string' || e.title.trim() === '') problems.push(`${where} has no "title"`);
      else titles.push(e.title);
      if (typeof e.url !== 'string' || !/^https?:\/\/\S+$/.test(e.url)) problems.push(`${where} has no http(s) "url"`);
      if (e.published !== undefined && (typeof e.published !== 'string' || !DAY.test(e.published))) problems.push(`${where}: "published" must be YYYY-MM-DD`);
      if (e.stored_under !== undefined && (typeof e.stored_under !== 'string' || !SLUG.test(e.stored_under))) problems.push(`${where}: "stored_under" must be a coverage slug`);
    });
    for (const name of names) {
      if (!titles.some((t) => printsName(t, name))) problems.push(`${at}: no cited headline prints "${name}"`);
    }
    bySlug.set(slug, names);
  }
  return problems.length ? { bySlug: new Map(), problems } : { bySlug, problems };
}

/**
 * The one loader the callers use. The caller supplies the I/O.
 *
 * @param {{ readJSON: (path: string) => any, exists: (path: string) => boolean }} io
 * @returns {{ bySlug: Map<string, string[]>, problems: string[] }}
 */
export function loadPressNames({ readJSON, exists }) {
  if (!exists(PRESS_NAMES_PATH)) return parsePressNames(null);
  let raw;
  try {
    raw = readJSON(PRESS_NAMES_PATH);
  } catch (e) {
    return { bySlug: new Map(), problems: [`${PRESS_NAMES_PATH} is not valid JSON (${/** @type {Error} */ (e).message})`] };
  }
  return parsePressNames(raw);
}

/**
 * Slugs the file names that the corpus does not hold. Not a parse problem (the
 * corpus is the nightly's, and a bill can arrive a night late), so the nightly
 * warns and carries on; the unit test on the real file requires none.
 *
 * @param {Map<string, string[]>} bySlug @param {Iterable<string>} corpusSlugs
 * @returns {string[]}
 */
export function unknownPressNameSlugs(bySlug, corpusSlugs) {
  const known = new Set(corpusSlugs);
  return [...bySlug.keys()].filter((s) => !known.has(s)).sort();
}

/**
 * The run-log line: what the file adds tonight. One line, stable wording.
 * @param {Map<string, string[]>} bySlug
 */
export function formatPressNames(bySlug) {
  const n = [...bySlug.values()].reduce((sum, v) => sum + v.length, 0);
  if (n === 0) return `no added names (${PRESS_NAMES_PATH} absent or empty)`;
  const list = [...bySlug].map(([s, v]) => `${s}: ${v.map((x) => `"${x}"`).join(', ')}`).join('; ');
  return `${n} added name(s) on ${bySlug.size} bill(s) — ${list}`;
}
