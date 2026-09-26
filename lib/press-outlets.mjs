/**
 * WHICH OUTLETS MAY BE COUNTED AND NAMED AS "THE PRESS" — the outlet floor.
 *
 * Owner ruling, 2026-09-26: the outlets that may appear as coverage "from
 * across the press", and the outlets a Big Question timeline may name in a
 * press update, are AllSides-rated outlets ONLY (data/media-bias.json). He may
 * later trial a short list of approved outlets beyond that, so the rule is
 * built to take one without a code change: drop a data/press-allowlist.json
 * next to the ratings and every caller that loads the policy through here picks
 * it up. There is deliberately NO such file today.
 *
 * WHY A FLOOR AT ALL. Before this module the Big Question timeline's publish
 * rule asked one question — "is every partisan lean here on one side?" — and
 * an outlet with no rating has no lean, so a set made ENTIRELY of unrated
 * outlets passed as if it were the neutral, cross-checked case. Replayed over
 * every stored day of every Big Question vehicle on the 2026-09-26 corpus, the
 * old rule would have published four days and the floor publishes none: all
 * four were unrated-only (one pairs sana.sy, Syria's state news agency, with
 * jpost.com on s-3172). The same vehicles' stored coverage also carries
 * thegatewaypundit.com (s-4784) and naturalnews.com (sjres-172, sjres-181).
 * An outlet with no rating is not evidence of balance; it is the absence of
 * any evidence at all.
 *
 * What this module decides, and what it does not:
 *   - `admits(source)` — may this outlet be COUNTED toward a press claim and
 *     NAMED in one? Rated, or on the owner's allowlist.
 *   - `leanOf(source)` — the AllSides lean, or null. An allowlisted outlet is
 *     admitted but carries NO lean, so it cannot turn a one-sided set into a
 *     balanced one (the one-sided rule is asked only of rated outlets), and it
 *     cannot stand in for a rated outlet either: a press update needs at least
 *     ONE rated outlet (scripts/moment-updates-map.mjs pressClusterToCandidate,
 *     and the stored-file gate in lib/moment-updates-gate.mjs), so a set made
 *     only of allowlisted outlets — no lean evidence at all — never publishes
 *     as if it were balanced.
 *   - `allowlistName(source)` — the masthead the owner approved the outlet
 *     under, printed in a press update's `outlet_names`. Required on every
 *     allowlist entry, so an allowlisted outlet never renders under a
 *     guessed fallback like "Enr".
 *   - `isRated(source)` — the plain fact, recorded per article by
 *     scripts/sync-coverage.mjs so the render path can later say "across the
 *     press" only over rated outlets (that display change is the owner's).
 *   It does NOT reorder, rank, or weight anything by lean.
 *
 * Pure and import-free, like lib/moments-gate.mjs: the callers read the files
 * and hand the parsed objects in, so the unit suite drives every branch with
 * no filesystem.
 */

/** The vendored AllSides table. */
export const MEDIA_BIAS_PATH = 'data/media-bias.json';

/**
 * The owner-approved allowlist — OPTIONAL, and absent today. Shape, when it
 * exists (keys are bare lowercase domains, the same convention as
 * data/media-bias.json's `outlets`; the value records the approval):
 *
 *   {
 *     "_note": "Owner-approved outlets beyond the AllSides-rated set.",
 *     "outlets": {
 *       "example.com": { "name": "Example News", "approved_on": "YYYY-MM-DD", "note": "why" }
 *     }
 *   }
 *
 * `name` is REQUIRED (the masthead printed when the outlet is named); an entry
 * without one is a malformed entry, and fails the whole list closed.
 *
 * A malformed file FAILS CLOSED — the policy falls back to rated-only and
 * reports what was wrong, so a typo can only ever narrow what is named, never
 * widen it. scripts/check-moment-updates.mjs turns those reports into CI
 * violations, so a bad file is red on the pull request that adds it.
 */
export const PRESS_ALLOWLIST_PATH = 'data/press-allowlist.json';

const RATED_LEANS = new Set(['left', 'center', 'right']);

/**
 * Reduce an API source to a bare lowercase domain.
 *
 * DRIFT PIN: character-for-character lib/coverage.ts's `normalizeSource` —
 * the matcher the Read section renders through. scripts/moment-updates-map.mjs
 * re-exports THIS function (it used to hold its own copy), and
 * tests/moment-updates-collect.unit.spec.ts asserts it equal to the TS one
 * over the whole real corpus, so the floor and the page can never disagree
 * about which domain an article came from.
 *
 * @param {string|null|undefined} source
 * @returns {string}
 */
export function normalizeSource(source) {
  return (source ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

/** A key the allowlist may hold: already a bare lowercase domain. */
const isBareDomain = (key) =>
  typeof key === 'string' && key.includes('.') && normalizeSource(key) === key && !/\s/.test(key);

/**
 * Read an allowlist document. Never throws.
 *
 * @param {unknown} raw the parsed JSON, or null/undefined when the file does not exist
 * @returns {{ domains: Set<string>, names: Map<string, string>, problems: string[] }}
 *   `problems` non-empty means the file was rejected WHOLE (fail closed): a
 *   list the owner approved is approved as a list, and half-reading one would
 *   name outlets he never saw together.
 */
export function parsePressAllowlist(raw) {
  const none = () => ({ domains: new Set(), names: new Map() });
  if (raw === null || raw === undefined) return { ...none(), problems: [] };
  const problems = [];
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...none(), problems: ['root must be an object with an "outlets" map'] };
  }
  const outlets = /** @type {any} */ (raw).outlets;
  if (typeof outlets !== 'object' || outlets === null || Array.isArray(outlets)) {
    return { ...none(), problems: ['"outlets" must be an object keyed by bare outlet domain'] };
  }
  const domains = new Set();
  const names = new Map();
  for (const [key, entry] of Object.entries(outlets)) {
    if (!isBareDomain(key)) {
      problems.push(`"${key}" is not a bare lowercase domain (no scheme, no "www.", no path)`);
      continue;
    }
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (!name) {
      problems.push(`"${key}" has no "name" — the masthead to print when the outlet is named is required`);
      continue;
    }
    domains.add(key);
    names.set(key, name);
  }
  return problems.length ? { ...none(), problems } : { domains, names, problems };
}

/**
 * Build the outlet policy from the two tables.
 *
 * @param {{ ratings?: Record<string, string>|null, allowlist?: unknown }} tables
 *   `ratings` is data/media-bias.json's `outlets` map; `allowlist` is the parsed
 *   data/press-allowlist.json, or null/undefined when there is no such file.
 */
export function pressOutletPolicy({ ratings, allowlist } = {}) {
  const table = ratings && typeof ratings === 'object' ? ratings : {};
  const { domains: allowed, names, problems } = parsePressAllowlist(allowlist);

  /** @param {string|null|undefined} source @returns {'left'|'center'|'right'|null} */
  const leanOf = (source) => {
    const lean = table[normalizeSource(source)];
    return RATED_LEANS.has(lean) ? /** @type {'left'|'center'|'right'} */ (lean) : null;
  };
  /** @param {string|null|undefined} source */
  const isRated = (source) => leanOf(source) !== null;
  /** @param {string|null|undefined} source */
  const isAllowlisted = (source) => {
    const d = normalizeSource(source);
    return d !== '' && allowed.has(d);
  };
  /** @param {string|null|undefined} source */
  const admits = (source) => isRated(source) || isAllowlisted(source);
  /** @param {string|null|undefined} source @returns {string|null} */
  const allowlistName = (source) => names.get(normalizeSource(source)) ?? null;

  return {
    admits,
    isRated,
    isAllowlisted,
    allowlistName,
    leanOf,
    /** How many owner-approved domains are in force (0 today). */
    allowlistSize: allowed.size,
    /** Why the allowlist was rejected, if it was. Empty when absent or valid. */
    problems,
  };
}

/**
 * The one loader every caller uses, so "rated, plus the allowlist when there
 * is one" is decided in exactly one place. The caller supplies the I/O — this
 * module stays import-free.
 *
 * @param {{ readJSON: (path: string) => any, exists: (path: string) => boolean }} io
 */
export function loadPressOutletPolicy({ readJSON, exists }) {
  const ratings = exists(MEDIA_BIAS_PATH) ? readJSON(MEDIA_BIAS_PATH)?.outlets ?? {} : {};
  let allowlist = null;
  let unreadable = null;
  if (exists(PRESS_ALLOWLIST_PATH)) {
    try {
      allowlist = readJSON(PRESS_ALLOWLIST_PATH);
    } catch (e) {
      unreadable = `${PRESS_ALLOWLIST_PATH} is not valid JSON (${/** @type {Error} */ (e).message})`;
    }
  }
  const policy = pressOutletPolicy({ ratings, allowlist: unreadable ? null : allowlist });
  return unreadable ? { ...policy, problems: [unreadable, ...policy.problems] } : policy;
}
