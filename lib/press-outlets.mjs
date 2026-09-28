/**
 * WHICH OUTLETS MAY BE COUNTED AND NAMED AS "THE PRESS" — the outlet floor.
 *
 * Owner ruling, 2026-09-26: the outlets that may appear as coverage "from
 * across the press", and the outlets a Big Question timeline may name in a
 * press update, are AllSides-rated outlets ONLY (data/media-bias.json). He may
 * later trial a short list of approved outlets beyond that, so the rule is
 * built to take one without a code change: drop a data/press-allowlist.json
 * next to the ratings and every caller that loads the policy through here picks
 * it up. No such file ships with this module; one arrives only in a pull
 * request the owner merges himself (merging it IS the approval).
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
 *   - `admits(source, { on })` — may this outlet be COUNTED toward a press
 *     claim and NAMED in one, on ET day `on`? Rated, or on the owner's
 *     allowlist on that day.
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
 * EVERY ALLOWLIST ENTRY IS DATED, AND JUDGED BY THE DAY (P1 of the owner's
 * trial proposal, 2026-09-26). An entry admits its outlet only on the ET days
 * from `approved_on` through `trial_ends` (or through `ended_on`, once the
 * owner marks it ended), so a list nobody renews goes back to rated-only by
 * itself. A stored record is judged against the list AS IT STOOD ON THE DAY
 * THE RECORD WAS WRITTEN: scripts/check-moment-updates.mjs passes each press
 * update's `recorded_at` day as `on`. Without that, the day a trial ended
 * every press update that had named the outlet — kept 60 days
 * (RETENTION_DAYS, lib/moment-updates-gate.mjs) — would fail CI, and the only
 * "fix" would be rewriting published timeline history. Ended entries stay in
 * the file for exactly that reason: they admit nothing new, and history still
 * validates.
 *
 * Pure and import-free, like lib/moments-gate.mjs: the callers read the files
 * and hand the parsed objects in, so the unit suite drives every branch with
 * no filesystem. The one clock read is the loader's default `today`.
 */

/** The vendored AllSides table. */
export const MEDIA_BIAS_PATH = 'data/media-bias.json';

/**
 * The owner-approved allowlist — OPTIONAL. Shape, when it exists:
 *
 *   {
 *     "_note": "Owner-approved outlets beyond the AllSides-rated set.",
 *     "outlets": [
 *       {
 *         "domain": "example.com",       bare lowercase domain, the same
 *                                        convention as data/media-bias.json
 *         "name": "Example News",        the masthead printed when named
 *         "approved_on": "YYYY-MM-DD",   first ET day the outlet is admitted
 *         "trial_ends": "YYYY-MM-DD",    last ET day it is admitted; at most
 *                                        TRIAL_MAX_DAYS after approved_on
 *         "status": "active",            "active" or "ended"
 *         "ended_on": "YYYY-MM-DD",      ONLY with "ended": the last ET day
 *                                        it was admitted (≤ trial_ends)
 *         "approved_by": "…", "reason": "…", "topics": ["…"], "note": "…"
 *                                        optional record; never read as policy
 *       }
 *     ]
 *   }
 *
 * `outlets` is an ARRAY of dated entries. The earlier keyed-by-domain object
 * form carried no dates, so it is refused whole — and that refusal is also a
 * lock on the landing order: a main that predates the dated reader refuses
 * this array (its "must be an object" check), fails closed to rated-only and
 * turns check-moment-updates red, so a list can never be live without expiry.
 *
 * Renewing an outlet is a NEW entry for the same domain, starting the day the
 * owner renews it: the old entry's days keep validating the records written in
 * them. Two entries for one domain must carry the same `name` and must not
 * share a day.
 *
 * Every field above except the optional record is REQUIRED, and a field this
 * module does not know is refused, so a typo (`trial_end`) can never leave a
 * list that looks dated but is not. Any problem FAILS THE WHOLE LIST CLOSED —
 * the policy falls back to rated-only and reports what was wrong, so a typo can
 * only ever narrow what is named, never widen it. scripts/check-moment-updates.mjs
 * turns those reports into CI violations, so a bad file is red on the pull
 * request that adds it. Nothing here depends on today's date, so a file that is
 * valid on the day it merges stays valid: time alone never turns CI red.
 */
export const PRESS_ALLOWLIST_PATH = 'data/press-allowlist.json';

/** The trial ceiling: an entry may run at most this many days past its
 *  `approved_on`, so every extension is a deliberate, dated edit. */
export const TRIAL_MAX_DAYS = 30;

/** The two states an entry may be in. */
export const ALLOWLIST_STATUSES = Object.freeze(['active', 'ended']);

/** Every field an entry may carry. Anything else is refused (see above). */
const ENTRY_FIELDS = new Set([
  'domain',
  'name',
  'approved_on',
  'trial_ends',
  'status',
  'ended_on',
  'approved_by',
  'reason',
  'topics',
  'note',
]);

const RATED_LEANS = new Set(['left', 'center', 'right']);

const DAY_MS = 86_400_000;

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
 * A real calendar day written 'YYYY-MM-DD' — '2026-02-30' is refused, not
 * rolled over into March.
 *
 * @param {unknown} v
 * @returns {v is string}
 */
export function isCalendarDay(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const ms = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v;
}

/** Whole days from day `a` to day `b` (both already calendar days). */
const daysFrom = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/**
 * The calendar day in America/New_York — the pipeline's legislative day, the
 * same clock as lib/moment-updates-gate.mjs's `etDay` (pinned equal by
 * tests/press-outlets.unit.spec.ts; copied, not imported, to keep this module
 * import-free).
 *
 * A bare 'YYYY-MM-DD' string is already a day and comes back unchanged, as
 * `etDay` does: read as an instant it would be UTC midnight, which is the
 * evening before in Washington, so a caller passing a publishedAt day would be
 * judged one day early.
 *
 * @param {Date|string|number} [instant] defaults to now
 * @returns {string} 'YYYY-MM-DD', or '' when the instant is unparseable
 */
export function etDayOf(instant = Date.now()) {
  if (typeof instant === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(instant)) return instant;
  const d = instant instanceof Date ? instant : new Date(instant);
  if (!Number.isFinite(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * @typedef {{
 *   domain: string, name: string, approved_on: string, trial_ends: string,
 *   status: 'active'|'ended', ended_on: string|null, last_day: string,
 *   approved_by: string|null, reason: string|null, topics: string[], note: string|null,
 * }} AllowlistEntry
 *   `last_day` is derived: `ended_on` for an ended entry, else `trial_ends`.
 */

/**
 * Check one entry. Returns the problems found (empty when it is sound) and the
 * normalized entry when it is.
 *
 * @param {unknown} entry
 * @param {number} i its index, for messages
 * @returns {{ problems: string[], entry: AllowlistEntry|null }}
 */
function readEntry(entry, i) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { problems: [`outlets[${i}] must be an object`], entry: null };
  }
  const e = /** @type {Record<string, any>} */ (entry);
  const label = typeof e.domain === 'string' && e.domain ? `"${e.domain}"` : `outlets[${i}]`;
  const problems = [];

  const unknown = Object.keys(e).filter((k) => !ENTRY_FIELDS.has(k));
  if (unknown.length) {
    problems.push(
      `${label} has field(s) this reader does not know: ${unknown.join(', ')} — allowed: ${[...ENTRY_FIELDS].join(', ')}`,
    );
  }
  if (!isBareDomain(e.domain)) {
    problems.push(`${label}: "domain" must be a bare lowercase domain (no scheme, no "www.", no path)`);
  }
  const name = typeof e.name === 'string' ? e.name.trim() : '';
  if (!name) {
    problems.push(`${label} has no "name" — the masthead to print when the outlet is named is required`);
  }

  const approvedOk = isCalendarDay(e.approved_on);
  if (!approvedOk) problems.push(`${label}: "approved_on" must be a real day written YYYY-MM-DD`);
  const endsOk = isCalendarDay(e.trial_ends);
  if (!endsOk) {
    problems.push(`${label}: "trial_ends" must be a real day written YYYY-MM-DD — an entry with no end never ends`);
  }
  if (approvedOk && endsOk) {
    const span = daysFrom(e.approved_on, e.trial_ends);
    if (span < 0) problems.push(`${label}: "trial_ends" ${e.trial_ends} is before "approved_on" ${e.approved_on}`);
    if (span > TRIAL_MAX_DAYS) {
      problems.push(
        `${label}: "trial_ends" ${e.trial_ends} is ${span} days after "approved_on" ${e.approved_on} — the ceiling is ${TRIAL_MAX_DAYS}; renew with a new entry instead`,
      );
    }
  }

  const status = e.status;
  if (!ALLOWLIST_STATUSES.includes(status)) {
    problems.push(`${label}: "status" must be one of ${ALLOWLIST_STATUSES.map((s) => `"${s}"`).join(', ')}`);
  }
  if (status === 'ended') {
    if (!isCalendarDay(e.ended_on)) {
      problems.push(`${label}: an "ended" entry needs "ended_on", the last day it was admitted (YYYY-MM-DD)`);
    } else if (approvedOk && endsOk && (e.ended_on < e.approved_on || e.ended_on > e.trial_ends)) {
      problems.push(`${label}: "ended_on" ${e.ended_on} must fall between "approved_on" and "trial_ends"`);
    }
  } else if (e.ended_on !== undefined) {
    problems.push(`${label}: "ended_on" is only for an "ended" entry`);
  }

  for (const k of ['approved_by', 'reason', 'note']) {
    if (e[k] !== undefined && typeof e[k] !== 'string') problems.push(`${label}: "${k}" must be text when present`);
  }
  if (
    e.topics !== undefined &&
    !(Array.isArray(e.topics) && e.topics.every((t) => typeof t === 'string' && t.trim().length > 0))
  ) {
    problems.push(`${label}: "topics" must be a list of non-empty strings when present`);
  }

  if (problems.length) return { problems, entry: null };
  return {
    problems,
    entry: {
      domain: e.domain,
      name,
      approved_on: e.approved_on,
      trial_ends: e.trial_ends,
      status,
      ended_on: status === 'ended' ? e.ended_on : null,
      last_day: status === 'ended' ? e.ended_on : e.trial_ends,
      approved_by: e.approved_by ?? null,
      reason: e.reason ?? null,
      topics: Array.isArray(e.topics) ? [...e.topics] : [],
      note: e.note ?? null,
    },
  };
}

/**
 * Read an allowlist document. Never throws. Never looks at the clock: whether
 * an entry is IN FORCE is asked later, per day, by the policy.
 *
 * @param {unknown} raw the parsed JSON, or null/undefined when the file does not exist
 * @returns {{ entries: AllowlistEntry[], domains: Set<string>, names: Map<string, string>, problems: string[] }}
 *   `problems` non-empty means the file was rejected WHOLE (fail closed): a
 *   list the owner approved is approved as a list, and half-reading one would
 *   name outlets he never saw together. `domains` holds every domain the file
 *   names on ANY day.
 */
export function parsePressAllowlist(raw) {
  const none = () => ({ entries: [], domains: new Set(), names: new Map() });
  if (raw === null || raw === undefined) return { ...none(), problems: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...none(), problems: ['root must be an object with an "outlets" list'] };
  }
  const outlets = /** @type {any} */ (raw).outlets;
  if (!Array.isArray(outlets)) {
    return {
      ...none(),
      problems: [
        typeof outlets === 'object' && outlets !== null
          ? '"outlets" must be a list of dated entries — the keyed-by-domain form carried no trial dates and is refused'
          : '"outlets" must be a list of dated entries',
      ],
    };
  }

  const problems = [];
  /** @type {AllowlistEntry[]} */ const entries = [];
  outlets.forEach((item, i) => {
    const { problems: p, entry } = readEntry(item, i);
    problems.push(...p);
    if (entry) entries.push(entry);
  });

  // One domain, several entries: a renewal. Same masthead, no shared day.
  /** @type {Map<string, AllowlistEntry[]>} */ const byDomain = new Map();
  for (const e of entries) {
    if (!byDomain.has(e.domain)) byDomain.set(e.domain, []);
    byDomain.get(e.domain).push(e);
  }
  for (const [domain, list] of byDomain) {
    if (list.length < 2) continue;
    if (new Set(list.map((e) => e.name)).size > 1) {
      problems.push(`"${domain}" appears under more than one name (${[...new Set(list.map((e) => e.name))].join(', ')})`);
    }
    const sorted = [...list].sort((a, b) => a.approved_on.localeCompare(b.approved_on));
    for (let k = 1; k < sorted.length; k++) {
      if (sorted[k].approved_on <= sorted[k - 1].last_day) {
        problems.push(
          `"${domain}" has two entries that share days (${sorted[k - 1].approved_on}…${sorted[k - 1].last_day} and ${sorted[k].approved_on}…${sorted[k].last_day}) — a renewal starts after the previous entry's last day`,
        );
      }
    }
  }

  if (problems.length) return { ...none(), problems };
  return {
    entries,
    domains: new Set(byDomain.keys()),
    names: new Map(entries.map((e) => [e.domain, e.name])),
    problems,
  };
}

/**
 * Build the outlet policy from the two tables.
 *
 * @param {{ ratings?: Record<string, string>|null, allowlist?: unknown, today?: string }} tables
 *   `ratings` is data/media-bias.json's `outlets` map; `allowlist` is the parsed
 *   data/press-allowlist.json, or null/undefined when there is no such file.
 *   `today` is the ET day a question without its own `on` is asked about.
 *   With no valid `today` and no `on`, the allowlist admits NOTHING: an
 *   undated question gets the rated-only answer, never an open one.
 */
export function pressOutletPolicy({ ratings, allowlist, today } = {}) {
  const table = ratings && typeof ratings === 'object' ? ratings : {};
  const { entries, names, problems } = parsePressAllowlist(allowlist);
  const defaultDay = isCalendarDay(today) ? today : null;

  /** @type {Map<string, AllowlistEntry[]>} */ const byDomain = new Map();
  for (const e of entries) {
    if (!byDomain.has(e.domain)) byDomain.set(e.domain, []);
    byDomain.get(e.domain).push(e);
  }

  /**
   * The day a question is about: its own `on`, else the policy's `today`.
   * A malformed `on` answers null, never the default — a caller that tried to
   * name a day and got it wrong must not be judged against a different one.
   * @param {unknown} at
   */
  const dayOf = (at) => {
    const on = at && typeof at === 'object' ? /** @type {any} */ (at).on : undefined;
    if (on === undefined) return defaultDay;
    return isCalendarDay(on) ? on : null;
  };
  /** @param {AllowlistEntry} e @param {string} day */
  const covers = (e, day) => e.approved_on <= day && day <= e.last_day;

  /** @param {string|null|undefined} source @returns {'left'|'center'|'right'|null} */
  const leanOf = (source) => {
    const lean = table[normalizeSource(source)];
    return RATED_LEANS.has(lean) ? /** @type {'left'|'center'|'right'} */ (lean) : null;
  };
  /** @param {string|null|undefined} source */
  const isRated = (source) => leanOf(source) !== null;
  /**
   * On the owner's allowlist on that day?
   * @param {string|null|undefined} source
   * @param {{ on?: string }} [at] the ET day asked about; defaults to `today`
   */
  const isAllowlisted = (source, at) => {
    const day = dayOf(at);
    if (!day) return false;
    const list = byDomain.get(normalizeSource(source));
    return !!list && list.some((e) => covers(e, day));
  };
  /**
   * @param {string|null|undefined} source
   * @param {{ on?: string }} [at] the ET day asked about; defaults to `today`
   */
  const admits = (source, at) => isRated(source) || isAllowlisted(source, at);
  /** The approved masthead, on any day — history keeps its names. @param {string|null|undefined} source @returns {string|null} */
  const allowlistName = (source) => names.get(normalizeSource(source)) ?? null;

  const inForceToday = defaultDay
    ? new Set(entries.filter((e) => covers(e, defaultDay)).map((e) => e.domain))
    : new Set();

  return {
    admits,
    isRated,
    isAllowlisted,
    allowlistName,
    leanOf,
    /** The ET day questions without their own `on` are asked about, or null. */
    today: defaultDay,
    /** How many owner-approved domains are in force on `today` (0 with no file, or no day). */
    allowlistSize: inForceToday.size,
    /**
     * Every entry in the file, in file order, each with whether it is in force
     * on `today` — the record the daily digest reports from. Copies: editing
     * them changes nothing.
     */
    entries: () => entries.map((e) => ({ ...e, topics: [...e.topics], in_force_today: !!defaultDay && covers(e, defaultDay) })),
    /** Why the allowlist was rejected, if it was. Empty when absent or valid. */
    problems,
  };
}

/**
 * The one loader every caller uses, so "rated, plus the allowlist when there
 * is one" is decided in exactly one place. The caller supplies the I/O — this
 * module stays import-free.
 *
 * @param {{ readJSON: (path: string) => any, exists: (path: string) => boolean, today?: string }} io
 *   `today` is the ET day the run is about; it defaults to the ET day now. A
 *   caller with its own run clock (scripts/moment-updates.mjs) passes it, so
 *   every stamp in one run agrees.
 */
export function loadPressOutletPolicy({ readJSON, exists, today = etDayOf() }) {
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
  const policy = pressOutletPolicy({ ratings, allowlist: unreadable ? null : allowlist, today });
  return unreadable ? { ...policy, problems: [unreadable, ...policy.problems] } : policy;
}
