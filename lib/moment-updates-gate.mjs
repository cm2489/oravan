/**
 * Moment-updates gate — the pure half of scripts/check-moment-updates.mjs and
 * the identity/selection/retention logic the collector (S3) and the page (S4)
 * both build on. Same split as lib/moments-gate.mjs / scripts/check-moments.mjs.
 *
 * IMPORT DISCIPLINE: this module has exactly ONE import —
 * `lintForbidden` from ./moments-gate.mjs — and that module is itself
 * import-free (and free of import.meta), so the whole chain loads under
 * Playwright's transform for tests/moment-updates.unit.spec.ts. The v1
 * vocabulary table is imported, never copied: v2 spec §2.3, "one table,
 * never copied."
 *
 * ---------------------------------------------------------------------------
 * THE EDITORIAL LAW (owner-settled 2026-07-25, the project records §2) — this module is its enforcement surface:
 *
 *   "Truth about the record, attribution about the spin. When the record
 *    speaks, we say it plainly — numbers, dates, tallies, text — even when
 *    plainness lands harder on one side. Balance is not achieved by blunting
 *    facts. When the record is silent — motive, likelihood, what it really
 *    means — Oravan's voice stops, and named sources speak or nobody does.
 *    Speculation never wears our voice."
 *
 * How a script obeys a manifesto (§2's enforcement annex), mapped to code:
 *   1. Speculation lint on record classes ....... lintUpdateText layer 2
 *   2. Attribution requirement on press ......... lintUpdateText layer 3
 *   3. The inherited vocabulary table ........... lintUpdateText layer 1
 *                                                (imported from moments-gate)
 *   4. The record ships beside the voice ........ checkMomentUpdates requires
 *                                                a non-empty record.action_text
 *                                                on every non-press class
 *   5. What the lint cannot catch, structure does. Event classes are
 *      mechanical; press clusters inherit the two-outlet lean-diverse rule;
 *      the file records everything qualified, so selection is auditable.
 *
 * Cadence honesty (§3): the render cap is a CAP, NOT A QUOTA and NOT A WRITE
 * CAP. The store keeps every qualified event; RENDER_DAY_CAP only governs how
 * many a day renders, with an honest overflow line for the rest. A script
 * silently discarding a roll-call vote because four floor actions preceded it
 * would itself be an editorial act.
 * ---------------------------------------------------------------------------
 *
 * Deliberate decisions, written down so they read as decisions, not drift:
 *
 *  - HARD_DAY_CEILING is a STORAGE ENVELOPE, not the render cap. pruneEntry
 *    trims a (moment, day) bucket to it only in an anomalous 13+-event day,
 *    and trims by class priority, so a vote is never what gets dropped. The
 *    gate fails above the ceiling and warns above RENDER_DAY_CAP so a day
 *    that busy is always seen by a human.
 *  - The speculation lint deliberately omits bare "may". English "may"
 *    collides with the month name, and a legislative day in May is exactly
 *    the kind of literal record fact the law says to state plainly. The
 *    forecast constructions that actually smuggle a prediction into our
 *    voice ("expected to", "likely to", "set to", …) are all covered.
 *  - Two actions with identical normalized text, the same action code, and
 *    the same vehicle-day collapse to one. Congress.gov emits exactly this
 *    for multi-committee referrals (H.R. 9770's two H11100 rows on
 *    2026-07-18, identical text, different committees). Collapsing them is
 *    the honest render: one referral, stated once.
 *  - Revisions are speculation-linted too (lintRevisionText), not only
 *    vocabulary-linted. §2 scopes the speculation rule to record claims, but
 *    a "where it stands" summary is our voice on the record just as much as
 *    an update one-liner is, and a hedge there would wear our voice exactly
 *    as the law forbids. Attribution (layer 3) does not apply — a revision
 *    is grounded in the record, not in press.
 */
import { lintForbidden } from './moments-gate.mjs';

/* ------------------------------------------------------------------ *
 * Constants — the vocabulary the whole layer agrees on.
 * ------------------------------------------------------------------ */

/** The stored `_meta.schema` this gate understands. */
export const SCHEMA_VERSION = 1;

/** Every legal update class (v2 spec §4). */
export const UPDATE_CLASSES = [
  'vote',
  'status_change',
  'floor_action',
  'scheduled',
  'press_cluster',
  'correction',
];

/**
 * Render selection order (v2 spec §3): `vote > status_change > floor_action >
 * scheduled > press_cluster`, with `correction` above all of them — a
 * correction must NEVER be crowded out of a day by the very events it
 * corrects. A news surface without a working corrections mechanism isn't one.
 * @type {Record<string, number>}
 */
export const CLASS_PRIORITY = {
  correction: 6,
  vote: 5,
  status_change: 4,
  floor_action: 3,
  scheduled: 2,
  press_cluster: 1,
};

/** Where an update may come from (v2 spec §5). */
export const SOURCE_KINDS = ['congress_actions', 'tier0_feed', 'press'];

/**
 * Classes that carry a verbatim government record. `press_cluster` is the one
 * class whose `record` is null — everything else decodes something the
 * government wrote down (§2.4, "the record ships beside the voice").
 */
export const RECORD_BEARING_CLASSES = UPDATE_CLASSES.filter((c) => c !== 'press_cluster');

/**
 * Classes the speculation lint governs (§2.1). A record claim is stated
 * flatly or not stated. `correction` is included — correcting the record is
 * still speaking about the record.
 */
export const SPECULATION_LINT_CLASSES = ['vote', 'status_change', 'floor_action', 'scheduled', 'correction'];

/**
 * Classes whose presence in a (vehicle, day) suppresses a `scheduled` signal
 * for the same vehicle-day: the record beats the signal (§4, identity and
 * dedupe). `scheduled` itself is the signal, `press_cluster` is not a record.
 */
export const RECORD_EVENT_CLASSES = ['vote', 'status_change', 'floor_action', 'correction'];

/** Retention: 60 days / 200 updates / 30 revisions per moment (§4). */
export const RETENTION_DAYS = 60;
export const MAX_UPDATES_PER_MOMENT = 200;
export const MAX_REVISIONS = 30;

/** Up to five updates RENDER per day per moment — a cap, not a quota (§3). */
export const RENDER_DAY_CAP = 5;
/** Storage envelope; above this a (moment, day) is a violation, not a warning. */
export const HARD_DAY_CEILING = 12;

/** File-size thresholds (§4): warn at 384 KB, fail at 512 KB. */
export const SIZE_WARN_BYTES = 393_216;
export const SIZE_FAIL_BYTES = 524_288;

/** Hard ceiling on a rendered one-liner; the authoring target is tighter. */
export const TEXT_MAX_CHARS = 200;
export const TEXT_TARGET_CHARS = 160;

/** A summary re-anchors after this long even when nothing moved (§6). */
export const SUMMARY_REANCHOR_DAYS = 7;

/** How much action text feeds the voteless identity key. */
export const ACTION_TEXT_KEY_CHARS = 120;

/**
 * Clock-skew tolerance for the no-future-dates check. A GitHub runner and
 * Congress.gov do not share a clock; a few seconds of drift is not a
 * dishonest date.
 */
export const FUTURE_TOLERANCE_MS = 60_000;

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UPDATE_ID_RE = /^u_[0-9a-f]{8}$/;
const REVISION_ID_RE = /^s_[0-9a-f]{8}$/;

/* ------------------------------------------------------------------ *
 * Time — the ET calendar day, never the UTC bucket.
 * ------------------------------------------------------------------ */

/**
 * The America/New_York calendar day of an instant, as 'YYYY-MM-DD'.
 *
 * Same Intl.DateTimeFormat idiom as scripts/newsdesk-match.mjs's
 * mondayOfWeekET, and for the same reason: the UTC date is NOT the
 * legislative date. A 22:14 ET House vote carries a 02:14Z timestamp on the
 * following UTC day; bucketing it by UTC files Tuesday night's vote under
 * Wednesday, which is simply false about the record.
 *
 * A bare 'YYYY-MM-DD' string is returned verbatim — it is already a calendar
 * label with no instant attached, and re-interpreting it as UTC midnight
 * would shift it a day backwards into ET.
 *
 * @param {Date|string|number} dateOrIso
 * @returns {string} 'YYYY-MM-DD', or '' when the input is unparseable
 */
export function etDay(dateOrIso) {
  if (typeof dateOrIso === 'string' && DAY_RE.test(dateOrIso)) return dateOrIso;
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
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
 * Calendar arithmetic over day LABELS (not instants) — pure UTC-midnight
 * math on an ISO day string, so no timezone can shift the result.
 * @param {string} day 'YYYY-MM-DD'
 * @param {number} deltaDays
 * @returns {string} 'YYYY-MM-DD'
 */
export function shiftDay(day, deltaDays) {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return '';
  return new Date(t + deltaDays * DAY_MS).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * Identity — deterministic ids and the dedupe the live API demands.
 * ------------------------------------------------------------------ */

/**
 * FNV-1a, 32-bit, as 8 lowercase hex digits. Small and inline on purpose:
 * this module stays import-free apart from the vocabulary table, and a
 * content hash for update ids needs no cryptographic strength — it needs to
 * be identical in the collector, the gate, and the test suite.
 * @param {string} str
 * @returns {string}
 */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Lowercase, collapse all whitespace runs to one space, trim. */
export function normalizeText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The dedupe identity of one update, scoped to its (vehicle, day) by the
 * caller.
 *
 * LIVE FINDING (2026-07-25, v2 spec §4): the Congress.gov actions endpoint
 * returns the same floor event TWICE — once from the chamber's own source
 * system (actionCode H37100, carries actionTime) and once as a Library of
 * Congress echo (actionCode 8000, "Passed/agreed to in House: …") — with
 * DIFFERENT codes and DIFFERENT text. Text-based identity cannot collide
 * them. So: when a roll call is present, identity is chamber + roll number.
 * A roll call uniquely names its event; the chamber record is preferred and
 * the LOC echo suppressed (see sourceRank).
 *
 * Voteless actions key on (actionCode || action_type) plus the first
 * ACTION_TEXT_KEY_CHARS of normalized text — Senate actions carry a NULL
 * actionCode, which this tolerates by falling through to the type.
 *
 * A press cluster keys on its sorted outlet set: the same story from the
 * same outlets on the same day is one cluster, however the wire re-words it.
 *
 * @param {Record<string, any>} update
 * @returns {string}
 */
/**
 * Strip the Library-of-Congress echo's restating prefix ("Passed/agreed to in
 * House: ", "Failed of passage in Senate: ", …) so the echo and the chamber's
 * own row reduce to the same sentence. Anchored and bounded: only a leading
 * `<words> in <Chamber>: ` is removed, never text from the middle.
 */
export function stripEchoPrefix(text) {
  return String(text ?? '').replace(/^[^:]{0,60}\bin\s+(house|senate)\s*:\s*/i, '');
}

/**
 * Reduce an action's text to the EVENT it describes, so the chamber's row and
 * the Library-of-Congress echo of the same event reduce to the same string:
 * drop the echo's restating prefix, and drop the trailing Congressional-Record
 * citation parenthetical that only one of the pair carries
 * ("… by Unanimous Consent. (consideration: CR S2100; text: CR S2100)").
 * Citations are provenance, not identity — the refs array already carries them.
 */
export function eventText(text) {
  return stripEchoPrefix(text)
    .replace(/\s*\((consideration|text|cr)\s*:[^)]*\)\s*$/i, '')
    .trim();
}

export function identityKey(update) {
  const rc = update?.record?.roll_call;
  if (rc && rc.number !== undefined && rc.number !== null) {
    return `roll:${String(rc.chamber ?? '').toLowerCase()}:${rc.number}`;
  }
  if (update?.record) {
    // THE LOC ECHO, for voteless actions. Congress.gov emits most floor
    // events TWICE: the chamber's own row, and a Library of Congress echo
    // that re-states it with a different action_code and a
    // "Passed/agreed to in House: " style prefix. The roll-call branch above
    // collapses the pair whenever a recorded vote exists — but a voteless
    // milestone (unanimous consent, a discharge) has no roll number, so both
    // rows survived: one real event stored twice, burning two of the day's
    // five render slots on a page whose whole promise is no padding.
    // Verified on s-2280-119: 4 stored updates for 2 real events on
    // 2026-04-29 (pre-launch audit, 2026-07-25).
    //
    // Key on the SUBSTANCE instead: drop the LOC prefix and ignore the code
    // for LOC rows, so the echo hashes identically to the chamber row and
    // dedupeUpdates' existing source-rank tiebreak keeps the chamber record.
    // The action CODE is deliberately absent from the key: it is precisely
    // what differs between the two rows describing one event (the chamber
    // sends null + a type, the LOC echo sends its own numeric code). Identity
    // is the event, and on one vehicle, one day, one class, the normalized
    // event text IS the event. Two genuinely distinct actions sharing all of
    // that AND their first 120 characters are the same action.
    const text = normalizeText(eventText(update.record.action_text)).slice(
      0,
      ACTION_TEXT_KEY_CHARS,
    );
    return `act:${text}`;
  }
  const outlets = Array.isArray(update?.source?.outlets) ? [...update.source.outlets] : [];
  return `press:${outlets.map((o) => String(o).toLowerCase()).sort().join(',')}`;
}

/**
 * The canonical id recipe: FNV-1a over
 * (momentId, class, vehicle, occurredKey, identityKey), every part
 * whitespace- and case-normalized so a re-fetch whose text differs only in
 * spacing produces the SAME id and dedupes cleanly.
 *
 * Accepts the five parts as an array (in that order) or as a named object.
 * `occurredKey` is the LEGISLATIVE DAY, not the timestamp: an event's day is
 * stable, its recorded precision is not.
 *
 * @param {string[]|{momentId: string, class?: string, klass?: string, vehicle: string, occurredKey: string, identityKey: string}} parts
 * @returns {string} 'u_' + 8 hex digits
 */
export function updateId(parts) {
  const arr = Array.isArray(parts)
    ? parts
    : [parts?.momentId, parts?.class ?? parts?.klass, parts?.vehicle, parts?.occurredKey, parts?.identityKey];
  return `u_${fnv1a(arr.map((p) => normalizeText(p)).join(''))}`;
}

/**
 * The one-call form the collector and the gate both use, so there is exactly
 * one place the recipe can drift from.
 * @param {string} momentId
 * @param {Record<string, any>} update
 * @returns {string}
 */
export function computeUpdateId(momentId, update) {
  return updateId([momentId, update?.class, update?.vehicle, update?.day, identityKey(update)]);
}

/**
 * Revision ids: 's_' + FNV-1a over (momentId, as_of_day, generated_at). A
 * revision is an authored artifact with its own timestamp, so unlike an
 * update it is not content-addressed — the gate checks format and
 * uniqueness, not derivation.
 * @param {string[]|{momentId: string, asOfDay: string, generatedAt: string}} parts
 * @returns {string}
 */
export function revisionId(parts) {
  const arr = Array.isArray(parts) ? parts : [parts?.momentId, parts?.asOfDay, parts?.generatedAt];
  return `s_${fnv1a(arr.map((p) => normalizeText(p)).join(''))}`;
}

/** Chamber-source records outrank the Library of Congress echo. */
function sourceRank(update) {
  return /library of congress/i.test(String(update?.record?.source_system ?? '')) ? 0 : 1;
}

/** Deterministic file/render order: newest day first, then priority, then id. */
function compareUpdates(a, b) {
  if (a.day !== b.day) return a.day < b.day ? 1 : -1;
  const pa = CLASS_PRIORITY[a.class] ?? 0;
  const pb = CLASS_PRIORITY[b.class] ?? 0;
  if (pa !== pb) return pb - pa;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

const bucketOf = (u) => `${u?.vehicle}${u?.day}`;

/**
 * Merge `candidates` into `existing`, collapsing duplicates and applying the
 * record-beats-signal rule. Pure: neither argument is mutated.
 *
 * Rules, in order:
 *   1. Identity collapse within a (vehicle, day) bucket — see identityKey.
 *      On a collision the chamber-source record wins over the LOC echo; ties
 *      break on id ascending, so the result never depends on input order.
 *   2. Within a bucket, a record-class event (vote / status_change /
 *      floor_action / correction) suppresses every `scheduled` for that same
 *      vehicle-day. The record beats the signal.
 *
 * Returns the merged list in the file's deterministic order (newest day
 * first, then class priority, then id). Callers wanting "what is new" diff
 * the result against the ids they already had.
 *
 * @param {Record<string, any>[]} existing
 * @param {Record<string, any>[]} candidates
 * @returns {Record<string, any>[]}
 */
export function dedupeUpdates(existing = [], candidates = []) {
  /** @type {Map<string, Record<string, any>>} */
  const byIdentity = new Map();
  for (const u of [...(existing ?? []), ...(candidates ?? [])]) {
    if (!u || typeof u !== 'object') continue;
    const key = `${bucketOf(u)}${u.class}${identityKey(u)}`;
    const held = byIdentity.get(key);
    if (!held) {
      byIdentity.set(key, u);
      continue;
    }
    const rankDelta = sourceRank(u) - sourceRank(held);
    const wins = rankDelta > 0 || (rankDelta === 0 && String(u.id ?? '') < String(held.id ?? ''));
    if (wins) byIdentity.set(key, u);
  }

  const kept = [...byIdentity.values()];
  const bucketsWithRecord = new Set(
    kept.filter((u) => RECORD_EVENT_CLASSES.includes(u.class)).map(bucketOf),
  );
  return kept
    .filter((u) => !(u.class === 'scheduled' && bucketsWithRecord.has(bucketOf(u))))
    .sort(compareUpdates);
}

/* ------------------------------------------------------------------ *
 * Selection, grouping, retention.
 * ------------------------------------------------------------------ */

/**
 * Which updates of ONE day render, and in what order (v2 spec §3): class
 * priority descending, then id ascending as the deterministic tie-break.
 * Because `correction` sits at the top of CLASS_PRIORITY, a correction can
 * never be crowded out of its own day.
 *
 * @param {Record<string, any>[]} updates one day's updates
 * @param {number} [cap]
 * @returns {Record<string, any>[]}
 */
export function selectDayUpdates(updates, cap = RENDER_DAY_CAP) {
  return [...(updates ?? [])]
    .sort((a, b) => {
      const pa = CLASS_PRIORITY[a?.class] ?? 0;
      const pb = CLASS_PRIORITY[b?.class] ?? 0;
      if (pa !== pb) return pb - pa;
      return String(a?.id) < String(b?.id) ? -1 : String(a?.id) > String(b?.id) ? 1 : 0;
    })
    .slice(0, Math.max(0, cap));
}

/**
 * @typedef {object} DayGroup
 * @property {string}   day       'YYYY-MM-DD' (ET legislative day)
 * @property {Record<string, any>[]} updates   every update on that day, priority-ordered
 * @property {Record<string, any>[]} rendered  the ≤ RENDER_DAY_CAP that render
 * @property {number}   overflow  how many the honest overflow line accounts for
 * @property {boolean}  quiet     true when nothing was recorded that day
 * @property {boolean}  isToday   true for the current ET day
 */

/**
 * Group updates into a CONTIGUOUS window of ET days, newest first — every day
 * in the window is present, including the ones with nothing in them.
 *
 * A quiet day is a first-class render, computed here, never a stored fake
 * update (§3): the site that would rather show you an empty page than pad it.
 * `isToday` exists because today's silence and last Tuesday's silence are
 * different sentences — "nothing recorded YET today" vs. a plain past-tense
 * line — and only the caller with the message catalogue can say them.
 *
 * @param {Record<string, any>[]} updates
 * @param {number} windowDays
 * @param {Date|string|number} [now]
 * @returns {DayGroup[]}
 */
export function groupByDay(updates, windowDays, now = Date.now()) {
  const today = etDay(now);
  const days = [];
  for (let i = 0; i < Math.max(0, windowDays); i++) days.push(shiftDay(today, -i));

  /** @type {Map<string, Record<string, any>[]>} */
  const byDay = new Map();
  for (const u of updates ?? []) {
    if (!u?.day) continue;
    if (!byDay.has(u.day)) byDay.set(u.day, []);
    byDay.get(u.day).push(u);
  }

  return days.map((day) => {
    const all = selectDayUpdates(byDay.get(day) ?? [], Number.POSITIVE_INFINITY);
    const rendered = all.slice(0, RENDER_DAY_CAP);
    return {
      day,
      updates: all,
      rendered,
      overflow: all.length - rendered.length,
      quiet: all.length === 0,
      isToday: day === today,
    };
  });
}

/**
 * Retention pass over ONE moment's entry (§4): 60 days, 200 updates, 30
 * revisions, and the HARD_DAY_CEILING storage envelope. Pure — returns a new
 * entry, never mutates.
 *
 * `opts.retired` deletes the entry outright (returns null): a retired
 * moment's updates leave the file entirely, because git history IS the
 * archive and a second archive file nothing renders is dead weight.
 *
 * Ordering of the trims matters and is deliberate: retention first (age is
 * the honest reason to forget), then the per-day envelope BY CLASS PRIORITY
 * (so an anomalous 13-event day sheds press clusters, never the roll call),
 * then the whole-entry cap newest-first.
 *
 * @param {Record<string, any>} entry
 * @param {{ now?: Date|string|number, retired?: boolean }} [opts]
 * @returns {Record<string, any>|null}
 */
export function pruneEntry(entry, opts = {}) {
  if (opts.retired) return null;
  if (!entry || typeof entry !== 'object') return entry ?? null;

  const now = opts.now ?? Date.now();
  const cutoff = shiftDay(etDay(now), -RETENTION_DAYS);

  const inRetention = (entry.updates ?? []).filter((u) => typeof u?.day === 'string' && u.day >= cutoff);

  /** @type {Map<string, Record<string, any>[]>} */
  const byDay = new Map();
  for (const u of inRetention) {
    if (!byDay.has(u.day)) byDay.set(u.day, []);
    byDay.get(u.day).push(u);
  }
  const capped = [];
  for (const [, dayUpdates] of byDay) capped.push(...selectDayUpdates(dayUpdates, HARD_DAY_CEILING));

  let updates = capped.sort(compareUpdates).slice(0, MAX_UPDATES_PER_MOMENT);

  // REFERENTIAL INTEGRITY. Updates prune by AGE, revisions trimmed by COUNT
  // only — so around day 61 the oldest surviving revisions still pointed at
  // update ids that had just been pruned away, and the gate treats an
  // unresolvable `grounded_in.update_id` as a violation. check-moment-updates
  // is a required step on every PR and every push to main, so this was a
  // scheduled, self-inflicted CI outage with no code change to blame it on
  // (pre-launch audit, 2026-07-25).
  //
  // A `correction` is the mirror case: it must never outlive the update it
  // corrects, or it becomes an annotation on nothing.
  const surviving = new Set(updates.map((u) => u.id));
  updates = updates.filter((u) => u.class !== 'correction' || !u.corrects || surviving.has(u.corrects));
  const survivingAfterCorrections = new Set(updates.map((u) => u.id));

  const revisions = [...(entry.summary_revisions ?? [])]
    .slice(-MAX_REVISIONS)
    // Rewrite rather than drop: a revision's TEXT stays true whatever the
    // retention window does, and its remaining citations stay checkable. A
    // revision that ends up citing nothing is still an honest artifact of
    // what we said and when.
    .map((r) => {
      const ids = r?.grounded_in?.update_ids;
      if (!Array.isArray(ids)) return r;
      const kept = ids.filter((id) => survivingAfterCorrections.has(id));
      if (kept.length === ids.length) return r;
      return { ...r, grounded_in: { ...r.grounded_in, update_ids: kept } };
    });

  return { ...entry, updates, summary_revisions: revisions };
}

/**
 * Does this moment's "where it stands" summary need regenerating? (§6 — a
 * summary is regenerated ONLY when the issue actually moved, and always from
 * the record; the prior revision is stored, never fed back.)
 *
 * True when ANY of:
 *   1. there is no revision at all;
 *   2. a vehicle's status differs from what the last revision was grounded in;
 *   3. an update was recorded after the last revision was generated;
 *   4. the last revision is older than SUMMARY_REANCHOR_DAYS.
 *
 * @param {Record<string, any>} entry
 * @param {Record<string, string>} vehicleStatuses current slug -> status
 * @param {Date|string|number} [now]
 * @returns {boolean}
 */
export function summaryNeedsRefresh(entry, vehicleStatuses = {}, now = Date.now()) {
  const revisions = entry?.summary_revisions ?? [];
  const last = revisions[revisions.length - 1];
  if (!last) return true;

  const grounded = last.grounded_in?.vehicle_statuses ?? {};
  for (const [slug, status] of Object.entries(vehicleStatuses ?? {})) {
    if (grounded[slug] !== status) return true;
  }

  const generatedAt = Date.parse(last.generated_at);
  if (!Number.isFinite(generatedAt)) return true;

  for (const u of entry?.updates ?? []) {
    const recorded = Date.parse(u?.recorded_at);
    if (Number.isFinite(recorded) && recorded > generatedAt) return true;
  }

  const nowMs = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  return nowMs - generatedAt > SUMMARY_REANCHOR_DAYS * DAY_MS;
}

/* ------------------------------------------------------------------ *
 * The lint — three layers, both languages.
 * ------------------------------------------------------------------ */

/*
 * Layer 2, the speculation lint (§2.1). Forecast and hedge constructions on a
 * record class. NOTE the deliberate omission of bare "may": in English it
 * collides with the month, and "the Senate returns in May" is exactly the
 * plain record fact the law tells us to state. Every construction that
 * actually smuggles a prediction into our voice is still covered.
 */
const SPECULATION = {
  // `heading to` / `headed for` / `rumbo a` / `camino de` joined 2026-07-25
  // (pre-launch audit). They are OUR OWN idiom, which is exactly why they
  // slipped: the UI's floor_vote label is "Heading to a vote", the summary
  // prompt is instructed to reuse the UI's status phrases verbatim, and a
  // published Sonnet revision therefore asserted "S.J.Res. 185 and S.J.Res.
  // 172 are heading to a vote" 400px above its own timeline recording that
  // both motions were REJECTED. A forecast is a forecast in our voice even
  // when we are the ones who taught it the words.
  en: /\b(expected to|likely to|could|might|set to|poised to|on track to|heading (to|for)|headed (to|for))\b/i,
  es: /\b(se espera|probablemente|podría|podrían|estaría|estarían|previsto que|a punto de|rumbo a|camino de)\b/i,
};

const SPECULATION_LABEL = {
  en: 'expected to / likely to / could / might / set to / poised to / on track to / heading to / headed for',
  es: 'se espera / probablemente / podría / podrían / estaría / estarían / previsto que / a punto de / rumbo a / camino de',
};

/**
 * Lint one update string. Three layers, per the enforcement annex (§2):
 *
 *   1. the INHERITED vocabulary table (lib/moments-gate.mjs — one table,
 *      never copied): advocacy verbs, crisis/attack/scheme, party-as-
 *      adversary framing, with the quoted-official-title exemption;
 *   2. SPECULATION on record classes — a record claim is stated flatly or
 *      not stated;
 *   3. ATTRIBUTION on press_cluster — the text must NAME one of its source
 *      outlets, in EACH language. Non-record claims never appear
 *      unattributed: "when the record is silent … named sources speak or
 *      nobody does."
 *
 * @param {string} text
 * @param {'en'|'es'} lang
 * @param {string} klass one of UPDATE_CLASSES
 * @param {string[]} [outletNames] source.outlet_names — required for press_cluster
 * @returns {string[]} failure strings (empty = clean)
 */
export function lintUpdateText(text, lang, klass, outletNames = []) {
  const failures = [];
  const value = String(text ?? '');

  for (const word of lintForbidden(value, lang)) {
    failures.push(`forbidden vocabulary "${word}" (inherited table, moments spec §3.3)`);
  }

  if (SPECULATION_LINT_CLASSES.includes(klass) && SPECULATION[lang]?.test(value)) {
    const hit = value.match(SPECULATION[lang])?.[0] ?? '';
    failures.push(
      `speculation "${hit}" on a ${klass} update — a record claim is stated flatly or not stated (${SPECULATION_LABEL[lang]})`,
    );
  }

  if (klass === 'press_cluster') {
    const names = (outletNames ?? []).filter((n) => typeof n === 'string' && n.trim());
    if (names.length === 0) {
      failures.push('press_cluster has no source.outlet_names — attribution is not optional');
    } else if (!names.some((n) => value.toLowerCase().includes(n.trim().toLowerCase()))) {
      failures.push(
        `press_cluster text names none of its outlets (${names.join(', ')}) — when the record is silent, named sources speak or nobody does`,
      );
    }
  }

  return failures;
}

/**
 * Lint one summary-revision string: the inherited vocabulary table plus the
 * speculation lint. See this file's header for why revisions get layer 2 even
 * though §2.1 scopes it to record classes.
 * @param {string} text
 * @param {'en'|'es'} lang
 * @returns {string[]}
 */
export function lintRevisionText(text, lang) {
  const failures = [];
  const value = String(text ?? '');
  for (const word of lintForbidden(value, lang)) {
    failures.push(`forbidden vocabulary "${word}" (inherited table, moments spec §3.3)`);
  }
  if (SPECULATION[lang]?.test(value)) {
    const hit = value.match(SPECULATION[lang])?.[0] ?? '';
    failures.push(`speculation "${hit}" in a summary revision — speculation never wears our voice (v2 spec §2)`);
  }
  return failures;
}

/* ------------------------------------------------------------------ *
 * The gate.
 * ------------------------------------------------------------------ */

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isHttps = (v) => typeof v === 'string' && /^https:\/\//.test(v);

/**
 * Validate data/moment-updates.json.
 *
 * @param {Record<string, any>} updatesObj parsed data/moment-updates.json
 * @param {Record<string, any>} moments    parsed data/moments.json
 * @param {Set<string>} billSlugs          full_identifier set from data/bills.json
 * @param {{ now?: number, fileBytes?: number }} [opts]
 * @returns {{ violations: string[], warnings: string[] }}
 */
export function checkMomentUpdates(updatesObj, moments, billSlugs, opts = {}) {
  const now = opts.now ?? Date.now();
  const nowDay = etDay(now);
  /** @type {string[]} */ const violations = [];
  /** @type {string[]} */ const warnings = [];

  if (!updatesObj || typeof updatesObj !== 'object' || Array.isArray(updatesObj)) {
    return {
      violations: ['data/moment-updates.json: root must be an object keyed by moment id'],
      warnings,
    };
  }

  const meta = updatesObj._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    violations.push('_meta: missing — the file records its schema version and when it was generated');
  } else {
    if (meta.schema !== SCHEMA_VERSION) {
      violations.push(`_meta.schema: ${JSON.stringify(meta.schema)} is not the known schema version ${SCHEMA_VERSION}`);
    }
    if (!isNonEmptyString(meta.generated_at) || !Number.isFinite(Date.parse(meta.generated_at))) {
      violations.push('_meta.generated_at: missing or not a parseable ISO datetime');
    }
  }

  if (typeof opts.fileBytes === 'number') {
    if (opts.fileBytes >= SIZE_FAIL_BYTES) {
      violations.push(
        `data/moment-updates.json is ${opts.fileBytes} bytes, at or past the ${SIZE_FAIL_BYTES}-byte ceiling — prune retention before adding more`,
      );
    } else if (opts.fileBytes >= SIZE_WARN_BYTES) {
      warnings.push(`data/moment-updates.json is ${opts.fileBytes} bytes, past the ${SIZE_WARN_BYTES}-byte warning line`);
    }
  }

  /** Every id in the file, so `corrects` and `update_ids` can be resolved. */
  const seenIds = new Set();

  for (const [momentId, entry] of Object.entries(updatesObj)) {
    if (momentId === '_meta') continue;
    const at = (f) => `${momentId}.${f}`;

    const moment = moments?.[momentId];
    if (!moment) {
      violations.push(`${momentId}: no such moment in data/moments.json — updates never invent a moment`);
      continue;
    }
    if (moment.status === 'retired') {
      violations.push(
        `${momentId}: the moment is stored-retired — a retired moment's updates are deleted, not kept (v2 spec §4, git history is the archive)`,
      );
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      violations.push(`${momentId}: entry must be an object { updates, summary_revisions }`);
      continue;
    }

    const momentVehicles = new Set((moment.vehicles ?? []).map((v) => v?.slug).filter(Boolean));

    // ---- updates -----------------------------------------------------
    const updates = entry.updates;
    if (!Array.isArray(updates)) {
      violations.push(`${at('updates')}: must be an array`);
      continue;
    }
    if (updates.length > MAX_UPDATES_PER_MOMENT) {
      violations.push(
        `${at('updates')}: ${updates.length} updates exceeds the ${MAX_UPDATES_PER_MOMENT}-per-moment retention cap`,
      );
    }

    const idsHere = new Set();
    /** @type {Map<string, number>} */
    const perDay = new Map();

    updates.forEach((u, i) => {
      const up = at(`updates[${i}]`);
      if (!u || typeof u !== 'object' || Array.isArray(u)) {
        violations.push(`${up}: must be an object`);
        return;
      }

      // id
      if (!UPDATE_ID_RE.test(String(u.id))) {
        violations.push(`${up}.id: ${JSON.stringify(u.id)} is not a well-formed update id (u_ + 8 hex)`);
      } else if (idsHere.has(u.id)) {
        violations.push(`${up}.id: "${u.id}" is duplicated inside ${momentId}`);
      } else {
        idsHere.add(u.id);
        seenIds.add(u.id);
      }

      // class / source kind
      if (!UPDATE_CLASSES.includes(u.class)) {
        violations.push(`${up}.class: ${JSON.stringify(u.class)} is not one of ${UPDATE_CLASSES.join(' | ')}`);
        return;
      }
      const source = u.source;
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        violations.push(`${up}.source: missing — every update names where it came from`);
      } else if (!SOURCE_KINDS.includes(source.kind)) {
        violations.push(`${up}.source.kind: ${JSON.stringify(source.kind)} is not one of ${SOURCE_KINDS.join(' | ')}`);
      }

      // vehicle must belong to THIS moment
      if (!isNonEmptyString(u.vehicle)) {
        violations.push(`${up}.vehicle: missing`);
      } else if (!billSlugs.has(u.vehicle)) {
        violations.push(`${up}.vehicle: "${u.vehicle}" does not exist in data/bills.json — never invent bill facts`);
      } else if (!momentVehicles.has(u.vehicle)) {
        violations.push(
          `${up}.vehicle: "${u.vehicle}" is not one of ${momentId}'s vehicles — an update belongs to the moment whose fight it is`,
        );
      }

      // dates
      const day = u.day;
      if (!isNonEmptyString(day) || !DAY_RE.test(day)) {
        violations.push(`${up}.day: missing or not YYYY-MM-DD`);
      } else {
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
        if (nowDay && day > nowDay) {
          violations.push(`${up}.day: ${day} is in the future (today in ET is ${nowDay}) — never a date the record does not support`);
        }
      }
      if (!['day', 'time'].includes(u.occurred_precision)) {
        violations.push(`${up}.occurred_precision: ${JSON.stringify(u.occurred_precision)} must be "day" or "time"`);
      }
      const occurredMs = Date.parse(u.occurred_at);
      if (!isNonEmptyString(u.occurred_at) || !Number.isFinite(occurredMs)) {
        violations.push(`${up}.occurred_at: missing or unparseable`);
      } else if (occurredMs > now + FUTURE_TOLERANCE_MS) {
        violations.push(`${up}.occurred_at: ${u.occurred_at} is in the future`);
      } else if (isNonEmptyString(day) && DAY_RE.test(day)) {
        // The LEGISLATIVE day. congress_actions supplies actionDate already
        // ET-derived, so its day is the date PART of occurred_at verbatim;
        // everything else (clusters, tier-0 signals) buckets by ET day.
        const expected =
          u.source?.kind === 'congress_actions' ? String(u.occurred_at).slice(0, 10) : etDay(u.occurred_at);
        if (day !== expected) {
          violations.push(
            `${up}.day: ${day} does not match occurred_at ${u.occurred_at} (expected ${expected}) — the legislative day is not the UTC bucket`,
          );
        }
      }
      const recordedMs = Date.parse(u.recorded_at);
      if (!isNonEmptyString(u.recorded_at) || !Number.isFinite(recordedMs)) {
        violations.push(`${up}.recorded_at: missing or unparseable`);
      } else {
        if (recordedMs > now + FUTURE_TOLERANCE_MS) {
          violations.push(`${up}.recorded_at: ${u.recorded_at} is in the future`);
        }
        if (Number.isFinite(occurredMs) && recordedMs < occurredMs) {
          violations.push(
            `${up}.recorded_at: ${u.recorded_at} precedes occurred_at ${u.occurred_at} — the pipeline cannot see an event before it happens`,
          );
        }
      }

      // refs
      const refs = source?.refs;
      if (!Array.isArray(refs) || refs.length === 0) {
        violations.push(`${up}.source.refs: must be a non-empty array of https URLs`);
      } else {
        for (const ref of refs) {
          if (!isHttps(ref)) violations.push(`${up}.source.refs: ${JSON.stringify(ref)} is not an https URL`);
        }
      }

      // record vs press_cluster
      const outletNames = Array.isArray(source?.outlet_names) ? source.outlet_names : [];
      if (u.class === 'press_cluster') {
        if (u.record !== null) {
          violations.push(`${up}.record: must be null on a press_cluster — a cluster decodes coverage, not the record`);
        }
        if (Array.isArray(refs) && refs.length < 2) {
          violations.push(`${up}.source.refs: a press_cluster needs ≥2 refs (the inherited two-outlet corroboration rule)`);
        }
        const outlets = Array.isArray(source?.outlets) ? source.outlets.filter(isNonEmptyString) : [];
        if (new Set(outlets.map((o) => o.toLowerCase())).size < 2) {
          violations.push(`${up}.source.outlets: a press_cluster needs ≥2 DISTINCT outlets, never a single-lean channel`);
        }
        if (outletNames.filter(isNonEmptyString).length === 0) {
          violations.push(`${up}.source.outlet_names: missing — a cluster names the outlets it attributes to`);
        }
      } else {
        const rec = u.record;
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
          violations.push(`${up}.record: missing — every non-press update ships the record beside the voice (v2 spec §2.4)`);
        } else {
          if (!isNonEmptyString(rec.action_text)) {
            violations.push(`${up}.record.action_text: missing — the verbatim government text is what makes a wrong decode falsifiable`);
          }
          if (rec.roll_call !== undefined && rec.roll_call !== null) {
            if (!['house', 'senate'].includes(rec.roll_call.chamber)) {
              violations.push(`${up}.record.roll_call.chamber: must be "house" or "senate"`);
            }
            if (!Number.isInteger(rec.roll_call.number)) {
              violations.push(`${up}.record.roll_call.number: must be an integer roll number`);
            }
          }
        }
      }

      // correction
      if (u.class === 'correction' && !isNonEmptyString(u.corrects)) {
        violations.push(`${up}.corrects: a correction must name the update id it corrects — a news surface without corrections isn't one`);
      }

      // ai flag
      if (typeof u.ai !== 'boolean') {
        violations.push(`${up}.ai: must be a boolean — AI content is always labeled`);
      }

      // text + the three lint layers
      const text = u.text;
      if (!text || typeof text !== 'object' || Array.isArray(text)) {
        violations.push(`${up}.text: must be an object { en, es }`);
      } else {
        for (const lang of ['en', 'es']) {
          const value = text[lang];
          if (!isNonEmptyString(value)) {
            violations.push(`${up}.text.${lang}: missing or empty — every EN string needs its ES sibling (bilingual-parity hard rule)`);
            continue;
          }
          if (value.length > TEXT_MAX_CHARS) {
            violations.push(`${up}.text.${lang}: ${value.length} chars exceeds the ${TEXT_MAX_CHARS}-char ceiling`);
          } else if (value.length > TEXT_TARGET_CHARS) {
            warnings.push(`${up}.text.${lang}: ${value.length} chars is past the ${TEXT_TARGET_CHARS}-char authoring target`);
          }
          for (const failure of lintUpdateText(value, lang, u.class, outletNames)) {
            violations.push(`${up}.text.${lang}: ${failure}`);
          }
        }
      }

      // id derivation — the collector, the gate, and the tests must agree on
      // one recipe or dedupe silently stops working.
      if (UPDATE_ID_RE.test(String(u.id)) && isNonEmptyString(u.vehicle) && isNonEmptyString(day)) {
        const expectedId = computeUpdateId(momentId, u);
        if (expectedId !== u.id) {
          violations.push(
            `${up}.id: "${u.id}" is not the id this update's content hashes to ("${expectedId}") — ids come from computeUpdateId, never by hand`,
          );
        }
      }
    });

    for (const [day, count] of perDay) {
      if (count > HARD_DAY_CEILING) {
        violations.push(
          `${momentId} ${day}: ${count} updates exceeds the ${HARD_DAY_CEILING}-per-day storage ceiling — prune before committing`,
        );
      } else if (count > RENDER_DAY_CAP) {
        warnings.push(
          `${momentId} ${day}: ${count} updates — only ${RENDER_DAY_CAP} render, the rest show as the overflow line (cap, not quota)`,
        );
      }
    }

    // corrections resolve inside their own moment
    updates.forEach((u, i) => {
      if (u?.class === 'correction' && isNonEmptyString(u.corrects) && !idsHere.has(u.corrects)) {
        violations.push(
          `${at(`updates[${i}]`)}.corrects: "${u.corrects}" does not resolve inside ${momentId} — a correction points at the update it corrects`,
        );
      }
    });

    // ---- summary revisions --------------------------------------------
    const revisions = entry.summary_revisions;
    if (!Array.isArray(revisions)) {
      violations.push(`${at('summary_revisions')}: must be an array (append-only; current = .at(-1))`);
    } else {
      if (revisions.length > MAX_REVISIONS) {
        violations.push(`${at('summary_revisions')}: ${revisions.length} exceeds the ${MAX_REVISIONS}-revision cap`);
      }
      let previousMs = -Infinity;
      const revIds = new Set();
      revisions.forEach((r, i) => {
        const rp = at(`summary_revisions[${i}]`);
        if (!r || typeof r !== 'object' || Array.isArray(r)) {
          violations.push(`${rp}: must be an object`);
          return;
        }
        if (!REVISION_ID_RE.test(String(r.id))) {
          violations.push(`${rp}.id: ${JSON.stringify(r.id)} is not a well-formed revision id (s_ + 8 hex)`);
        } else if (revIds.has(r.id)) {
          violations.push(`${rp}.id: "${r.id}" is duplicated inside ${momentId}`);
        } else {
          revIds.add(r.id);
        }
        const generatedMs = Date.parse(r.generated_at);
        if (!isNonEmptyString(r.generated_at) || !Number.isFinite(generatedMs)) {
          violations.push(`${rp}.generated_at: missing or unparseable`);
        } else {
          if (generatedMs > now + FUTURE_TOLERANCE_MS) {
            violations.push(`${rp}.generated_at: ${r.generated_at} is in the future`);
          }
          if (generatedMs < previousMs) {
            violations.push(`${rp}.generated_at: ${r.generated_at} is out of order — summary_revisions is append-only and chronological`);
          }
          previousMs = generatedMs;
        }
        if (!isNonEmptyString(r.as_of_day) || !DAY_RE.test(r.as_of_day)) {
          violations.push(`${rp}.as_of_day: missing or not YYYY-MM-DD`);
        } else if (nowDay && r.as_of_day > nowDay) {
          violations.push(`${rp}.as_of_day: ${r.as_of_day} is in the future`);
        }
        if (!isNonEmptyString(r.model)) {
          violations.push(`${rp}.model: missing — the summary names the model that wrote it (AI content is always labeled)`);
        }
        if (!Array.isArray(r.changed_because) || r.changed_because.length === 0) {
          violations.push(`${rp}.changed_because: must be a non-empty array — a revision says why it exists`);
        }

        if (!r.text || typeof r.text !== 'object' || Array.isArray(r.text)) {
          violations.push(`${rp}.text: must be an object { en, es }`);
        } else {
          for (const lang of ['en', 'es']) {
            const value = r.text[lang];
            if (!isNonEmptyString(value)) {
              violations.push(`${rp}.text.${lang}: missing or empty — every EN string needs its ES sibling (bilingual-parity hard rule)`);
              continue;
            }
            for (const failure of lintRevisionText(value, lang)) {
              violations.push(`${rp}.text.${lang}: ${failure}`);
            }
          }
        }

        const grounded = r.grounded_in;
        if (!grounded || typeof grounded !== 'object' || Array.isArray(grounded)) {
          violations.push(`${rp}.grounded_in: missing — a summary that cannot say what it is grounded in is speculation`);
        } else {
          const vs = grounded.vehicle_statuses;
          if (!vs || typeof vs !== 'object' || Array.isArray(vs) || Object.keys(vs).length === 0) {
            violations.push(`${rp}.grounded_in.vehicle_statuses: must be a non-empty { slug: status } map`);
          } else {
            for (const slug of Object.keys(vs)) {
              if (!momentVehicles.has(slug)) {
                violations.push(`${rp}.grounded_in.vehicle_statuses: "${slug}" is not one of ${momentId}'s vehicles`);
              }
            }
          }
          if (!Array.isArray(grounded.update_ids)) {
            violations.push(`${rp}.grounded_in.update_ids: must be an array of update ids`);
          } else {
            for (const uid of grounded.update_ids) {
              if (!idsHere.has(uid)) {
                violations.push(`${rp}.grounded_in.update_ids: "${uid}" does not resolve inside ${momentId}`);
              }
            }
          }
          if (grounded.refs !== undefined) {
            if (!Array.isArray(grounded.refs)) {
              violations.push(`${rp}.grounded_in.refs: must be an array of https URLs`);
            } else {
              for (const ref of grounded.refs) {
                if (!isHttps(ref)) violations.push(`${rp}.grounded_in.refs: ${JSON.stringify(ref)} is not an https URL`);
              }
            }
          }
        }
      });
    }
  }

  // A live moment with no state summary renders a dated timeline under a
  // heading with nothing to say. Not a failure (a moment may open before its
  // first summary run), but always worth a human's eye.
  for (const [momentId, moment] of Object.entries(moments ?? {})) {
    if (moment?.status !== 'live') continue;
    const entry = updatesObj[momentId];
    if (!entry || !Array.isArray(entry.summary_revisions) || entry.summary_revisions.length === 0) {
      warnings.push(`${momentId}: live moment with zero summary revisions — "Where it stands" has nothing to render yet`);
    }
  }

  return { violations, warnings };
}
