/**
 * Which bills the official record calls IDENTICAL to one another, and the
 * one rule for reading that relation. Import-free and pure, so the writer
 * (scripts/sync-related.mjs), the nightly gate (scripts/verify-sync.mjs), the
 * CI gate (scripts/check-related-bills.mjs) and the bill page's reader
 * (lib/coverage.ts) share one copy, and tests/related-bills.unit.spec.ts can
 * pin it on fixtures.
 *
 * WHY IT EXISTS (owner, 2026-11-13). His card read: "Show news about a bill's
 * twin under the bill? Whether an article about a bill's twin in the other
 * chamber, or a later bill carrying the same policy, is shown under the
 * bill." He chose: "Yes, show it under the bill as it is." So an article the
 * coverage sync stored under a bill's twin is also shown in that bill's
 * "How it's being covered" box, unchanged.
 *
 * WHERE THE RELATION COMES FROM: only the record. Congress.gov's related-bills
 * list for a bill (`/bill/{congress}/{type}/{number}/relatedbills`) gives, for
 * each related bill, one or more `relationshipDetails` of the form
 * `{ type, identifiedBy }`, where `identifiedBy` is "House", "Senate" or "CRS".
 * This file keeps exactly ONE type, KEPT_RELATION_TYPES: "Identical bill",
 * the record's own label for a bill with the same text. A similar title, a
 * shared topic or a model's guess never makes two bills twins (hard rule 6).
 *
 * WHAT IS LEFT OUT, AND WHY. The record's other labels ("Related bill",
 * "Procedurally related", "Text similarities", and the cross-Congress and
 * reintroduced kinds) say two bills touch, not that they are the same
 * measure: a rule that sets up debate on a bill, a bill that shares one
 * section with a 900-page package, last Congress's version. Showing one bill's
 * press under another on those would print articles about a different
 * measure under a box that says what it covers. A "later bill carrying the
 * same policy" (the card's second case) has no label of its own in the
 * related-bills list; the record says it, when it does, in action text, which
 * this does not parse. So later vehicles are not shown. A relation to a bill
 * of another Congress is dropped too: H.R. 1234 of the 119th and of the 120th
 * are different bills.
 *
 * ONE HOP, BOTH DIRECTIONS, NEVER ITSELF (twinsOf). A is B's twin when the
 * record lists either one as identical to the other. A twin's own twins are
 * not followed, so a bill that is its own twin's twin cannot loop, and a
 * chain of three never widens past what the record says about this bill.
 */

export const RELATED_BILLS_PATH = 'data/related-bills.json';
export const RELATED_BILLS_SCHEMA = 'related-bills/v1';

/** The record's relationship labels this site acts on. Compared exactly,
 *  ignoring case and surrounding space only. */
export const KEPT_RELATION_TYPES = Object.freeze(['Identical bill']);

/** Who may identify a relationship, per the Congress.gov API documentation. */
export const RELATION_IDENTIFIERS = Object.freeze(['House', 'Senate', 'CRS']);

/** Bill types the corpus tracks (scripts/congress-fetch.mjs's BILL_TYPES). */
const TRACKED_TYPES = new Set(['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres']);

/** The corpus's slug shape: `{type}-{number}-{congress}`. */
export const BILL_SLUG_RE = /^(hr|s|hjres|sjres|hconres|sconres)-[1-9]\d{0,4}-[1-9]\d{1,3}$/;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A file far above this is not a list of twins; it is a writer bug. */
export const RELATED_BILLS_MAX_BYTES = 2_000_000;

const isKeptType = (t) =>
  typeof t === 'string' && KEPT_RELATION_TYPES.some((k) => k.toLowerCase() === t.trim().toLowerCase());

/**
 * The identical bills one Congress.gov related-bills payload names for
 * `ownSlug`, as stored rows. Pure. Anything malformed is skipped, never
 * guessed at.
 *
 * @param {any} payload the parsed JSON of `/bill/{c}/{t}/{n}/relatedbills`
 * @param {string} ownSlug the bill the payload is for
 * @returns {{ slug: string, type: string, identifiedBy: string[] }[]}
 */
export function identicalFromRecord(payload, ownSlug) {
  const own = parseSlug(ownSlug);
  const list = Array.isArray(payload?.relatedBills) ? payload.relatedBills : [];
  /** @type {Map<string, { slug: string, type: string, identifiedBy: string[] }>} */
  const out = new Map();
  for (const rb of list) {
    const type = String(rb?.type ?? '').trim().toLowerCase();
    const number = String(rb?.number ?? '').trim();
    const congress = String(rb?.congress ?? '').trim();
    if (!TRACKED_TYPES.has(type) || !/^\d+$/.test(number) || !/^\d+$/.test(congress)) continue;
    const slug = `${type}-${Number(number)}-${Number(congress)}`;
    if (!BILL_SLUG_RE.test(slug) || slug === ownSlug) continue;
    // Same Congress only: a number is reused every Congress.
    if (!own || own.congress !== Number(congress)) continue;
    const details = Array.isArray(rb?.relationshipDetails) ? rb.relationshipDetails : [];
    const kept = details.filter((d) => isKeptType(d?.type));
    if (kept.length === 0) continue;
    const row = out.get(slug) ?? { slug, type: KEPT_RELATION_TYPES[0], identifiedBy: [] };
    for (const d of kept) {
      const who = String(d?.identifiedBy ?? '').trim();
      if (who && !row.identifiedBy.includes(who)) row.identifiedBy.push(who);
    }
    // A relation with no named identifier is not stored: the gate requires
    // one, and the record always names one in the documented shape.
    if (row.identifiedBy.length === 0) continue;
    row.identifiedBy.sort();
    out.set(slug, row);
  }
  return [...out.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/** @param {string} slug */
function parseSlug(slug) {
  const m = typeof slug === 'string' ? slug.match(/^([a-z]+)-(\d+)-(\d+)$/) : null;
  return m ? { type: m[1], number: Number(m[2]), congress: Number(m[3]) } : null;
}

/**
 * The bills the record calls identical to `slug`, one hop, either direction,
 * never `slug` itself, each once, sorted. Rows of any other type are ignored
 * here as well as at write time, so a file written by an older or broken
 * writer still cannot widen what is shown.
 *
 * @param {Record<string, unknown> | null | undefined} file data/related-bills.json
 * @param {string} slug
 * @returns {string[]}
 */
export function twinsOf(file, slug) {
  const out = new Set();
  if (!file || typeof file !== 'object' || typeof slug !== 'string') return [];
  const rowsOf = (k) => {
    const v = /** @type {any} */ (file)[k];
    return !k.startsWith('_') && Array.isArray(v) ? v : [];
  };
  for (const r of rowsOf(slug)) {
    if (r && isKeptType(r.type) && typeof r.slug === 'string' && r.slug !== slug) out.add(r.slug);
  }
  for (const k of Object.keys(file)) {
    if (k === slug) continue;
    for (const r of rowsOf(k)) {
      if (r && isKeptType(r.type) && r.slug === slug) out.add(k);
    }
  }
  return [...out].sort();
}

/**
 * The gate. Every finding is a failure: the file decides which press is shown
 * under which bill, so a row the rule above does not allow is damage.
 *
 * @param {{ data: any, fileBytes?: number, today: string, knownSlugs?: Set<string> | null }} args
 * @returns {{ failures: string[], notes: string[] }}
 */
export function verifyRelatedBills({ data, fileBytes, today, knownSlugs = null }) {
  const failures = [];
  const notes = [];
  const where = RELATED_BILLS_PATH;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { failures: [`${where} is not an object`], notes };
  }
  if (typeof fileBytes === 'number' && fileBytes > RELATED_BILLS_MAX_BYTES) {
    failures.push(`${where} is ${fileBytes} bytes, over the ${RELATED_BILLS_MAX_BYTES}-byte ceiling`);
  }
  const meta = data._meta;
  if (!meta || meta.schema !== RELATED_BILLS_SCHEMA) {
    failures.push(`${where}: _meta.schema is ${JSON.stringify(meta?.schema)}, expected "${RELATED_BILLS_SCHEMA}"`);
  } else if (
    !Array.isArray(meta.kept_types) ||
    meta.kept_types.length !== KEPT_RELATION_TYPES.length ||
    meta.kept_types.some((t, i) => t !== KEPT_RELATION_TYPES[i])
  ) {
    failures.push(`${where}: _meta.kept_types is ${JSON.stringify(meta.kept_types)}, expected ${JSON.stringify(KEPT_RELATION_TYPES)}`);
  }
  // The day the step last finished a run (or created the file): the clock the
  // daily health report's "not filled for more than 3 days" alarm reads.
  if (meta && (typeof meta.filled_at !== 'string' || !DAY_RE.test(meta.filled_at))) {
    failures.push(`${where}: _meta.filled_at is ${JSON.stringify(meta.filled_at)}, expected a YYYY-MM-DD day`);
  } else if (meta && meta.filled_at > today) {
    failures.push(`${where}: _meta.filled_at is ${meta.filled_at}, after today (${today})`);
  }
  const checked = data._checkedAt;
  if (!checked || typeof checked !== 'object' || Array.isArray(checked)) {
    failures.push(`${where}: _checkedAt is not an object`);
  } else {
    for (const [slug, day] of Object.entries(checked)) {
      if (!BILL_SLUG_RE.test(slug)) failures.push(`${where}: _checkedAt key "${slug}" is not a bill slug`);
      if (typeof day !== 'string' || !DAY_RE.test(day)) failures.push(`${where}: _checkedAt["${slug}"] is not a YYYY-MM-DD day`);
      else if (day > today) failures.push(`${where}: _checkedAt["${slug}"] is ${day}, after today (${today})`);
    }
  }
  const allowedMeta = new Set(['_meta', '_note', '_checkedAt']);
  let pairs = 0;
  for (const [key, rows] of Object.entries(data)) {
    if (key.startsWith('_')) {
      if (!allowedMeta.has(key)) failures.push(`${where}: unknown metadata key "${key}"`);
      continue;
    }
    if (!BILL_SLUG_RE.test(key)) {
      failures.push(`${where}: key "${key}" is not a bill slug`);
      continue;
    }
    if (knownSlugs && !knownSlugs.has(key)) failures.push(`${where}: "${key}" is not a bill in data/bills.json`);
    if (!checked || typeof checked !== 'object' || typeof checked[key] !== 'string') {
      failures.push(`${where}: "${key}" carries relations but no _checkedAt day`);
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      failures.push(`${where}: "${key}" is not a non-empty list (a bill with no identical bill is left out)`);
      continue;
    }
    const own = parseSlug(key);
    const seen = new Set();
    for (const r of rows) {
      const label = `${where}: "${key}" -> ${JSON.stringify(r?.slug)}`;
      if (!r || typeof r !== 'object') {
        failures.push(`${where}: "${key}" holds a row that is not an object`);
        continue;
      }
      const extra = Object.keys(r).filter((k) => !['slug', 'type', 'identifiedBy'].includes(k));
      if (extra.length) failures.push(`${label} carries unknown fields ${extra.join(', ')}`);
      if (typeof r.slug !== 'string' || !BILL_SLUG_RE.test(r.slug)) failures.push(`${label} is not a bill slug`);
      else {
        if (r.slug === key) failures.push(`${label}: a bill is listed as its own twin`);
        if (own && parseSlug(r.slug)?.congress !== own.congress) failures.push(`${label}: a twin of another Congress`);
        if (seen.has(r.slug)) failures.push(`${label}: listed twice`);
        seen.add(r.slug);
      }
      if (!isKeptType(r.type) || r.type !== KEPT_RELATION_TYPES[0]) {
        failures.push(`${label}: relation type ${JSON.stringify(r.type)} is not one this site acts on (${KEPT_RELATION_TYPES.join(', ')})`);
      }
      // Who identified it is carried as the record states it. The API
      // documents House, Senate and CRS; an unfamiliar name is noted, not
      // failed, because the relation itself is still the record's.
      if (
        !Array.isArray(r.identifiedBy) ||
        r.identifiedBy.length === 0 ||
        r.identifiedBy.some((w) => typeof w !== 'string' || w.trim() === '')
      ) {
        failures.push(`${label}: identifiedBy ${JSON.stringify(r.identifiedBy)} must be a non-empty list of names`);
      } else {
        for (const w of r.identifiedBy) {
          if (!RELATION_IDENTIFIERS.includes(w)) notes.push(`${label}: identified by "${w}", not one of ${RELATION_IDENTIFIERS.join(', ')}`);
        }
      }
      pairs++;
    }
  }
  notes.push(`${where}: ${Object.keys(data).filter((k) => !k.startsWith('_')).length} bills carry ${pairs} identical-bill relation(s); ${checked && typeof checked === 'object' ? Object.keys(checked).length : 0} bills checked`);
  return { failures, notes };
}

/**
 * Which bills scripts/sync-related.mjs looks up tonight, in order: never
 * checked first, then the oldest check, skipping any checked within the last
 * `recheckDays`, at most `perNight`. Pure.
 * @param {{ candidates: string[], checkedAt: Record<string,string>, today: string, perNight: number, recheckDays: number }} a
 */
export function planRelatedRun({ candidates, checkedAt, today, perNight, recheckDays }) {
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - recheckDays * 86_400_000).toISOString().slice(0, 10);
  return candidates
    .filter((s) => !(typeof checkedAt[s] === 'string' && checkedAt[s] > cutoff))
    .sort((a, b) => (checkedAt[a] ?? '').localeCompare(checkedAt[b] ?? '') || a.localeCompare(b))
    .slice(0, Math.max(0, perNight));
}

/**
 * The file's text, in a stable order (metadata first, then bills by slug), so
 * a night with no change is no diff. Shared by the writer and verify-sync's
 * restore.
 * @param {Record<string, any>} file
 * @returns {string}
 */
export function serializeRelatedBills(file) {
  const out = { _note: file._note, _meta: file._meta, _checkedAt: {} };
  for (const k of Object.keys(file._checkedAt ?? {}).sort()) out._checkedAt[k] = file._checkedAt[k];
  for (const k of Object.keys(file).filter((k) => !k.startsWith('_')).sort()) out[k] = file[k];
  return `${JSON.stringify(out, null, 1)}\n`;
}

/**
 * An empty, valid file: what the writer creates when none exists, dated
 * `filledAt` (the day it was created), which starts the health report's
 * staleness clock.
 * @param {string} filledAt YYYY-MM-DD
 * @returns {Record<string, any>}
 */
export function emptyRelatedBills(filledAt) {
  return {
    _note:
      'Generated by scripts/sync-related.mjs from Congress.gov\'s related-bills list. Only the record\'s "Identical bill" relation is kept (lib/related-bills.mjs). _meta.filled_at is the day the step last finished a run, or created this file. Keys starting with "_" are metadata.',
    _meta: { schema: RELATED_BILLS_SCHEMA, kept_types: [...KEPT_RELATION_TYPES], filled_at: filledAt },
    _checkedAt: {},
  };
}

/* ------------------------------------------------------------------ *
 * The daily health report's view of the step (lib/pipeline-health.mjs
 * alarms() and scripts/pipeline-health.mjs call these)
 * ------------------------------------------------------------------ */

/** The file counts as stale when its `_meta.filled_at` is more than this many days old. */
export const RELATED_STALE_DAYS = 3;

/** A STOPPED reason is cut to this many characters in an alarm. */
export const RELATED_REASON_MAX = 300;

/** What a person looks at first, on every related-bills alarm. */
const RELATED_RUNBOOK = 'What to look at first: docs/runbooks/related-bills.md';

/**
 * The step's own lines in one nightly log (scripts/sync-related.mjs). Matched
 * anywhere in a line, so the downloaded log's `sync<TAB>UNKNOWN STEP<TAB>time `
 * prefix, the byte-order mark GitHub puts before the first timestamp, and the
 * `##[error]` / `::error::` forms all count. ORDER-AWARE: what counts is what
 * follows the LAST `RELATED START:`, so a night's outcome is the outcome of
 * its own run.
 *   - `started`: a `RELATED START:` line is present.
 *   - `done`: the counts of the `RELATED DONE:` line after the last START, or null.
 *   - `stopped`: the reason on the `RELATED STOPPED:` line after the last START, or null.
 * A log from before this step existed has none of these lines and reads as
 * { started: false, done: null, stopped: null }, which raises nothing.
 * @param {string} log
 * @returns {{ started: boolean, done: { looked: number, planned: number, failed: number } | null, stopped: string | null }}
 */
export function parseRelatedTrouble(log) {
  let started = false;
  let done = null;
  let stopped = null;
  for (const line of String(log ?? '').split('\n')) {
    if (line.includes('RELATED START:')) {
      started = true;
      done = null;
      stopped = null;
    }
    const d = line.match(/RELATED DONE: looked up (\d+) of (\d+) planned \((\d+) failed/);
    if (d) done = { looked: Number(d[1]), planned: Number(d[2]), failed: Number(d[3]) };
    const s = line.match(/RELATED STOPPED: (.*)$/);
    if (s) stopped = s[1].trim();
  }
  return { started, done, stopped };
}

/**
 * How old the committed file's `_meta.filled_at` is, in whole UTC days, at
 * `now`. `readable` is false when the file is missing, unreadable, or carries
 * no usable day; the report treats that as stale (the site cannot build
 * without the file, so it is a fault whatever its cause).
 * @param {any} file the parsed data/related-bills.json, or null
 * @param {number} now ms
 * @returns {{ readable: boolean, filledAt: string | null, ageDays: number | null }}
 */
export function relatedStaleness(file, now) {
  const day = file?._meta?.filled_at;
  if (typeof day !== 'string' || !DAY_RE.test(day)) return { readable: false, filledAt: null, ageDays: null };
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  const ageDays = Math.round((today - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
  return { readable: true, filledAt: day, ageDays };
}

/**
 * The ⛔ lines the daily health report raises for the step, in
 * lib/pipeline-health.mjs's { code, text } shape. Plain words; each ends with
 * where to look first. These lines are public (the health issue), so they
 * carry only what the step printed, which never includes the key.
 *   (a) `related-bills-stopped`: the night's log holds a STOPPED line.
 *   (b) `related-bills-crashed`: START with neither DONE nor STOPPED after it.
 *   (c) `related-bills-stale`: the file's filled_at is more than
 *       RELATED_STALE_DAYS days old, or unreadable. STATE, not the log, so a
 *       step that is skipped, deleted or silently does nothing is caught too.
 *   Also `related-bills-lookups-failed`: the run finished but half or more of
 *   its lookups failed. Fewer failures raise nothing: each failed bill keeps
 *   its old relations and is first in line the next night.
 * A log with no RELATED lines (the nightly ran before this step existed, or
 * the report ran before tonight's nightly) raises nothing from the log; (c)
 * is the only reading of the file.
 * @param {{ trouble?: ReturnType<typeof parseRelatedTrouble> | null, staleness?: ReturnType<typeof relatedStaleness> | null } | null | undefined} related
 * @returns {{ code: string, text: string }[]}
 */
export function relatedAlarms(related) {
  const out = [];
  const t = related?.trouble;
  const step = 'the "Read identical bills from the record" step of the nightly bill sync';
  if (t?.stopped) {
    const why = t.stopped.length > RELATED_REASON_MAX ? `${t.stopped.slice(0, RELATED_REASON_MAX - 1)}…` : t.stopped;
    out.push({
      code: 'related-bills-stopped',
      text: `the nightly read of which bills the record calls identical stopped without updating its file. It said: "${why}" Bill pages keep showing the twin coverage they showed before, and the rest of the night was saved. ${RELATED_RUNBOOK}`,
    });
  } else if (t?.started && !t.done) {
    out.push({
      code: 'related-bills-crashed',
      text: `the nightly read of which bills the record calls identical started but never said it finished or stopped, so it crashed or was cut off; its file was not updated. The error is at the end of ${step}. ${RELATED_RUNBOOK}`,
    });
  } else if (t?.done && t.done.planned > 0 && t.done.failed * 2 >= t.done.planned) {
    out.push({
      code: 'related-bills-lookups-failed',
      text: `the nightly read of which bills the record calls identical could not reach Congress.gov for ${t.done.failed} of ${t.done.planned} bills; those bills kept what they had and go first tomorrow. ${RELATED_RUNBOOK}`,
    });
  }
  const st = related?.staleness;
  if (st && (!st.readable || st.ageDays > RELATED_STALE_DAYS)) {
    out.push({
      code: 'related-bills-stale',
      text: st.readable
        ? `data/related-bills.json was last filled on ${st.filledAt}, ${st.ageDays} days ago (the nightly fills it every night), so the list of twin bills is not being kept up to date. ${RELATED_RUNBOOK}`
        : `data/related-bills.json is missing or has no "last filled" date, so nobody can tell whether the list of twin bills is up to date. ${RELATED_RUNBOOK}`,
    });
  }
  return out;
}
