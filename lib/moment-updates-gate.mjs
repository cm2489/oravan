/**
 * Moment-updates gate — the pure half of scripts/check-moment-updates.mjs and
 * the identity/selection/retention logic the collector (S3) and the page (S4)
 * both build on. Same split as lib/moments-gate.mjs / scripts/check-moments.mjs.
 *
 * IMPORT DISCIPLINE: this module imports from exactly ONE other module —
 * ./moments-gate.mjs — and that module is itself import-free (and free of
 * import.meta), so the whole chain loads under Playwright's transform for
 * tests/moment-updates.unit.spec.ts. The v1 vocabulary table is imported,
 * never copied: v2 spec §2.3, "one table, never copied." The same rule now
 * covers the two SPELLING helpers `esWord` and `eitherSpelling`, because a
 * word boundary that means one thing in layer 1 and another in layer 2 is how
 * a lint half-works for years without anyone noticing.
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
import { eitherSpelling, esWord, lintForbidden } from './moments-gate.mjs';

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

/**
 * Where an update may come from (v2 spec §5).
 *
 * `roll_call` joined 2026-09-25 (Phase 0 of the real-time plan): a roll call
 * read from data/votes.json — the chamber's own vote record (senate.gov's
 * roll-call XML, the House Clerk's EVS XML, Congress.gov's house-vote API),
 * which scripts/sync-votes.mjs stores. It is NOT `congress_actions`: that kind
 * names the Congress.gov /actions endpoint, which lags the Senate's vote
 * record by hours to a day, and filing a senate.gov tally under it would
 * misname where the fact came from.
 */
export const SOURCE_KINDS = ['congress_actions', 'tier0_feed', 'press', 'roll_call'];

/**
 * Source kinds whose `day` is the record's own calendar date, stored verbatim
 * as the date part of `occurred_at` — never re-bucketed through etDay. Both
 * supply a legislative date the chamber wrote down itself.
 */
export const VERBATIM_DAY_SOURCE_KINDS = ['congress_actions', 'roll_call'];

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
/** data/votes.json's roll-call id: lib/votes-core.mjs rollCallId. */
const ROLL_CALL_ID_RE = /^[hs]-\d{1,3}-[12]-\d{1,5}$/;

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

/* ------------------------------------------------------------------ *
 * THE SAME ACTION, RE-WORDED BY ITS OWN PUBLISHER (2026-09-25).
 *
 * Congress.gov edits an action's text AFTER first publishing it: once the
 * Congressional Record for the day is out, "Cloture motion on the measure
 * presented in Senate." becomes "… presented in Senate. (CR S4789)". The id
 * recipe hashes the text, so the edited row got a NEW id and was stored as a
 * second update — one real event, two rows, two of the day's five render
 * slots, and a second paid decode. Measured on s-4668-119
 * (paying-college-athletes): u_f0db9993 / u_05246d80 and u_86b9e54f /
 * u_d15dae4c on 2026-09-17, u_732a58b6 / u_48567655 on 2026-09-16 — each
 * pair recorded days apart, differing only by the trailing citation.
 *
 * eventText already drops "(consideration: CR …; text: CR …)", but that
 * pattern requires a colon and the Senate's bare "(CR S4789)" has none.
 *
 * The fix is a SECOND collapse key, deliberately NOT a change to identityKey:
 * the id recipe is what the gate re-derives on read, so widening it would
 * re-hash every stored row and fail the id check on the whole file. The key is
 * the task's own definition of "the same action": same vehicle, same action
 * date, same class, same chamber, same normalized text once every trailing
 * citation parenthetical is gone. Roll calls never reach it — a roll number
 * already names its event (identityKey) — and neither do press clusters.
 *
 * KEEPS THE EARLIEST (recorded_at), then the chamber record over the Library
 * of Congress echo, then id ascending: the earliest row is the one earlier
 * summary revisions already cite, and nothing the reader saw first moves.
 * ------------------------------------------------------------------ */

/** Every trailing citation parenthetical: "(CR S4789)", "(CR S4773-4774)",
 *  "(consideration: CR S4851)", "(text: CR H4731-4733)". */
const TRAILING_CITATION = /\s*\((?:consideration|text|cr)\b[^()]*\)\s*$/i;

/**
 * The action's text with the LOC echo prefix and EVERY trailing citation
 * parenthetical removed, and trailing periods/space trimmed — the sentence
 * the chamber wrote, stripped of where it was later printed.
 * @param {string} text
 * @returns {string}
 */
export function citationFreeText(text) {
  let t = stripEchoPrefix(text).trim();
  for (let i = 0; i < 4 && TRAILING_CITATION.test(t); i++) t = t.replace(TRAILING_CITATION, '').trim();
  return t.replace(/[.\s]+$/, '');
}

/**
 * Which chamber an update's record belongs to: the roll call's own chamber,
 * else the source system that wrote it, else the chamber the action text
 * names ("… in Senate", "Passed/agreed to in House: …"), else ''.
 * @param {Record<string, any>} update
 * @returns {'house'|'senate'|''}
 */
export function actionChamber(update) {
  const rc = String(update?.record?.roll_call?.chamber ?? '').toLowerCase();
  if (rc === 'house' || rc === 'senate') return rc;
  const sys = String(update?.record?.source_system ?? '');
  if (/\bsenate\b/i.test(sys)) return 'senate';
  if (/\bhouse\b/i.test(sys)) return 'house';
  const m = String(update?.record?.action_text ?? '').match(/\bin (?:the )?(senate|house)\b/i);
  return m ? /** @type {'house'|'senate'} */ (m[1].toLowerCase()) : '';
}

/**
 * The "same action" key, or null for anything the collapse must not touch
 * (a roll call, a press cluster, a row with no record text).
 * @param {Record<string, any>} update
 * @returns {string|null}
 */
export function sameActionKey(update) {
  const rec = update?.record;
  if (!rec || typeof rec.action_text !== 'string') return null;
  if (rec.roll_call && rec.roll_call.number !== undefined && rec.roll_call.number !== null) return null;
  const text = normalizeText(citationFreeText(rec.action_text));
  if (!text) return null;
  return `${update.vehicle}${update.day}${update.class}${actionChamber(update)}${text}`;
}

/** Does `a` beat `b` as the row to keep? Earliest recorded_at, then source, then id. */
function keepsOver(a, b) {
  const ta = Date.parse(a?.recorded_at);
  const tb = Date.parse(b?.recorded_at);
  const ra = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY;
  const rb = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY;
  if (ra !== rb) return ra < rb;
  const rankDelta = sourceRank(a) - sourceRank(b);
  if (rankDelta !== 0) return rankDelta > 0;
  return String(a?.id ?? '') < String(b?.id ?? '');
}

/**
 * Collapse rows that are the same action (sameActionKey), keeping the
 * earliest. Pure. Returns the survivors in their input order, plus the
 * dropped-id → kept-id map a caller needs to keep citations resolving.
 *
 * @param {Record<string, any>[]} updates
 * @returns {{ kept: Record<string, any>[], remap: Map<string, string> }}
 */
export function collapseSameActions(updates = []) {
  /** @type {Map<string, Record<string, any>>} */
  const winner = new Map();
  for (const u of updates ?? []) {
    const key = sameActionKey(u);
    if (!key) continue;
    const held = winner.get(key);
    if (!held || keepsOver(u, held)) winner.set(key, u);
  }
  /** @type {Map<string, string>} */
  const remap = new Map();
  const kept = [];
  for (const u of updates ?? []) {
    const key = sameActionKey(u);
    const w = key ? winner.get(key) : null;
    if (!w || w === u) {
      kept.push(u);
      continue;
    }
    if (u?.id && w.id && u.id !== w.id) remap.set(String(u.id), String(w.id));
  }
  return { kept, remap };
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
 *   2. The same action re-worded by its publisher (a trailing "(CR S4789)"
 *      added days later) collapses to its EARLIEST row — see
 *      collapseSameActions.
 *   3. Within a bucket, a record-class event (vote / status_change /
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

  const { kept } = collapseSameActions([...byIdentity.values()]);
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
 * `opts.reserveRevisions` holds N revision slots open for a caller that is
 * about to append. The nightly collector prunes BEFORE it summarizes — an
 * ordering that is load-bearing, not incidental (see the call site in
 * scripts/moment-updates.mjs) — so a prune that filled the cap exactly left
 * tonight's revision nowhere to go and the run committed MAX_REVISIONS + 1.
 * Reserving is the arithmetic fix; moving the prune is not (2026-08-06).
 *
 * @param {Record<string, any>} entry
 * @param {{ now?: Date|string|number, retired?: boolean, reserveRevisions?: number }} [opts]
 * @returns {Record<string, any>|null}
 */
export function pruneEntry(entry, opts = {}) {
  if (opts.retired) return null;
  if (!entry || typeof entry !== 'object') return entry ?? null;

  const now = opts.now ?? Date.now();
  const cutoff = shiftDay(etDay(now), -RETENTION_DAYS);

  const inRetention = (entry.updates ?? []).filter((u) => typeof u?.day === 'string' && u.day >= cutoff);

  // The same action re-worded by its publisher collapses to its earliest row
  // (collapseSameActions). Done HERE, in every mode, so the duplicates already
  // committed before the collapse existed are cleaned on the next run rather
  // than only when their moment happens to receive a new update — and `remap`
  // carries every citation of a dropped row over to the row that survives,
  // so no revision or correction is left pointing at nothing.
  const { kept: collapsed, remap } = collapseSameActions(inRetention);
  const remapped = (id) => remap.get(id) ?? id;

  /** @type {Map<string, Record<string, any>[]>} */
  const byDay = new Map();
  for (const u of collapsed) {
    if (!byDay.has(u.day)) byDay.set(u.day, []);
    byDay.get(u.day).push(u);
  }
  const capped = [];
  for (const [, dayUpdates] of byDay) capped.push(...selectDayUpdates(dayUpdates, HARD_DAY_CEILING));

  let updates = capped
    .sort(compareUpdates)
    .slice(0, MAX_UPDATES_PER_MOMENT)
    // A correction that named a collapsed row now names the row that stands
    // for the same action. Untouched rows are returned as the same object, so
    // a no-op prune stays byte-identical.
    .map((u) => (u?.class === 'correction' && u.corrects && remap.has(u.corrects) ? { ...u, corrects: remapped(u.corrects) } : u));

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

  // Clamped, and the zero-room case is spelled out: `.slice(-0)` is
  // `.slice(0)`, which would return the WHOLE array — silently the opposite of
  // a trim to nothing.
  const reserved = Math.min(MAX_REVISIONS, Math.max(0, Math.trunc(Number(opts.reserveRevisions) || 0)));
  const revisionRoom = MAX_REVISIONS - reserved;

  const revisions = (revisionRoom === 0 ? [] : [...(entry.summary_revisions ?? [])].slice(-revisionRoom))
    // Rewrite rather than drop: a revision's TEXT stays true whatever the
    // retention window does, and its remaining citations stay checkable. A
    // revision that ends up citing nothing is still an honest artifact of
    // what we said and when.
    .map((r) => {
      const ids = r?.grounded_in?.update_ids;
      if (!Array.isArray(ids)) return r;
      // A citation of a collapsed row is carried to its survivor first (and
      // de-duplicated — two rows for one action become one citation), then
      // anything that still resolves to nothing is dropped as before.
      const kept = [...new Set(ids.map(remapped))].filter((id) => survivingAfterCorrections.has(id));
      if (kept.length === ids.length && kept.every((id, i) => id === ids[i])) return r;
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
 *   2b. a vehicle's status KEY (the label the page prints) differs from the
 *      one the last revision was written with, when the caller passes
 *      `opts.statusKeys` (2026-09-29; see statusKeyChanges);
 *   3. an update was recorded after the last revision was generated;
 *   4. the last revision is older than SUMMARY_REANCHOR_DAYS.
 *
 * THE FLAP GUARD (2026-09-25). A status that goes A→B→A inside two days is
 * the pipeline correcting itself, not the issue moving — sjres-185-119 went
 * floor_vote→committee→floor_vote, and s-4668-119 read `committee` for one
 * night (2026-09-23) before #279 fixed the classifier. Each leg bought a paid
 * Sonnet rewrite, and the middle one published "is in committee" over a bill
 * the Senate was voting on (s_c0bcbd35).
 *
 * WHICH LEG IS HELD BACK, and why it is never the second one. The first draft
 * of this guard skipped the flip BACK (A→B→A: the return to A bought no
 * rewrite). That held back the fix, not the mistake: the revision written
 * from the misread B stayed up as the current "Where it stands" for up to
 * 48h more, where before the guard the next nightly replaced it within a day
 * — and it did so to save one ≈ $0.007 call. So a status that REVERTS a
 * change is a trigger like any other (revertingSlugs now only names it in the
 * log reason). What the guard still declines, because declining it keeps
 * nothing false on the page:
 *   - a `status_change` row that is one half of a flap (flapStatusChangeIds)
 *     does not count as "an update recorded after the revision". This branch
 *     is reached only when every current status already equals what the last
 *     revision was grounded in, so a flap there went A→B→A entirely BETWEEN
 *     two revisions and the page never showed B — the two legs net to nothing;
 *   - a status the bill's own status sentence does not support
 *     (`opts.unsupported`, computed by the runner as
 *     status !== mapStatus(statusBasisText(bill))) is not a trigger, and
 *     neither is a status_change row on such a vehicle — here the NEW status
 *     is the suspect one, so holding it back holds back the mistake.
 * A first-leg hold for supported statuses ("a new status must survive a
 * second nightly before it buys a rewrite") was considered and not built:
 * s_c0bcbd35's own changed_because is `status:… floor_vote→committee,
 * updates:+5`, so five new rows would have regenerated it that night anyway,
 * with the misread status in its grounding — the hold would have delayed
 * every real status change by a day and prevented nothing measured.
 *
 * @param {Record<string, any>} entry
 * @param {Record<string, string>} vehicleStatuses current slug -> status
 * @param {Date|string|number} [now]
 * @param {{ unsupported?: Set<string>, statusKeys?: Record<string, string> }} [opts]
 * @returns {boolean}
 */
export function summaryNeedsRefresh(entry, vehicleStatuses = {}, now = Date.now(), opts = {}) {
  return summaryRefreshReason(entry, vehicleStatuses, now, opts) !== null;
}

/** The flap window: two opposite status changes this close together are one flap. */
export const FLAP_WINDOW_HOURS = 48;
const FLAP_WINDOW_MS = FLAP_WINDOW_HOURS * 3_600_000;

const toMs = (now) => (now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now));

/**
 * The ids of `status_change` rows that are one half of a flap: a change on a
 * vehicle, and its exact reversal on the same vehicle, recorded within
 * FLAP_WINDOW_HOURS of each other. Both halves are returned.
 * @param {Record<string, any>[]} updates
 * @returns {Set<string>}
 */
export function flapStatusChangeIds(updates = []) {
  const rows = (updates ?? []).filter(
    (u) =>
      u?.class === 'status_change' &&
      u.record?.status_from &&
      u.record?.status_to &&
      u.record.status_from !== u.record.status_to,
  );
  const out = new Set();
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (a.vehicle !== b.vehicle) continue;
      if (a.record.status_from !== b.record.status_to || a.record.status_to !== b.record.status_from) continue;
      const ta = Date.parse(a.recorded_at);
      const tb = Date.parse(b.recorded_at);
      if (!Number.isFinite(ta) || !Number.isFinite(tb) || Math.abs(ta - tb) > FLAP_WINDOW_MS) continue;
      out.add(a.id);
      out.add(b.id);
    }
  }
  return out;
}

/**
 * Vehicles whose CURRENT status reverts a change the stored history made
 * within FLAP_WINDOW_HOURS of `now`: the last revision was grounded in B, the
 * revision before B took hold was grounded in A, B took hold inside the
 * window, and the corpus now says A again. A `status_change` row recording
 * A→B inside the window is the same evidence read from the timeline instead
 * (a flap can happen between two revisions).
 *
 * DIAGNOSTIC ONLY since the fix pass on 2026-09-25: a reverting status IS a
 * trigger (it is the correction of what the page says), and this set only
 * labels the refresh reason so the run log says why a rewrite was paid for.
 * @param {Record<string, any>} entry
 * @param {Record<string, string>} statuses current slug -> status
 * @param {Date|string|number} [now]
 * @returns {Set<string>}
 */
export function revertingSlugs(entry, statuses = {}, now = Date.now()) {
  const out = new Set();
  const revisions = entry?.summary_revisions ?? [];
  const last = revisions[revisions.length - 1];
  if (!last) return out;
  const nowMs = toMs(now);
  const statusAt = (r, slug) => r?.grounded_in?.vehicle_statuses?.[slug];

  for (const [slug, status] of Object.entries(statuses ?? {})) {
    const held = statusAt(last, slug);
    if (held === undefined || held === status) continue;
    let i = revisions.length - 1;
    while (i > 0 && statusAt(revisions[i - 1], slug) === held) i--;
    if (i > 0) {
      const before = statusAt(revisions[i - 1], slug);
      const since = Date.parse(revisions[i].generated_at);
      if (before === status && Number.isFinite(since) && nowMs - since <= FLAP_WINDOW_MS) out.add(slug);
    }
    for (const u of entry?.updates ?? []) {
      if (u?.class !== 'status_change' || u.vehicle !== slug) continue;
      if (u.record?.status_from !== status || u.record?.status_to !== held) continue;
      const t = Date.parse(u.recorded_at);
      if (Number.isFinite(t) && nowMs - t <= FLAP_WINDOW_MS) out.add(slug);
    }
  }
  return out;
}

/**
 * The status keys each raw status can be read as — lib/journey.ts
 * `statusKeyFor` and its script-side copy in scripts/moment-candidates.mjs.
 * A status not listed here is read as itself. The gate checks every stored
 * `grounded_in.vehicle_status_keys` value against this table, and
 * tests/summary-refresh-status-key.unit.spec.ts sweeps the whole corpus
 * through both statusKeyFor copies to check that the table still covers
 * every key they return.
 */
export const STATUS_KEY_READINGS = Object.freeze({
  passed_chamber: Object.freeze(['passed_chamber', 'adopted', 'passed_both']),
  floor_vote: Object.freeze(['floor_vote', 'floor_vote_stale', 'floor_activity', 'rejected']),
});

/**
 * Is `key` a key `status` can be read as?
 * @param {string} status
 * @param {string} key
 */
export function isStatusReading(status, key) {
  const readings = Object.hasOwn(STATUS_KEY_READINGS, status) ? STATUS_KEY_READINGS[status] : [status];
  return readings.includes(key);
}

/**
 * The measures whose status KEY — the label the page prints and the phrase
 * the summary prompt was handed — changed since `revision` was written, while
 * the raw status stayed the same. A raw status change is reported by the raw
 * comparison in summaryRefreshReason, never here.
 *
 * WHY THE KEY AND NOT ONLY THE RAW STATUS (2026-09-29). The raw status is
 * what `grounded_in.vehicle_statuses` stores, and it is not what the page
 * says. #368 taught the site to read a `passed_chamber` record as `adopted`
 * or `passed_both`, and #382 passed that reading to the summary writer. But a
 * revision written before them stays up: H.Con.Res. 86's raw status is still
 * `passed_chamber`, so the raw comparison found nothing new, and the
 * iran-war-powers revision s_5341187d (2026-09-26) kept saying "H. Con. Res.
 * 86 is also listed as Passed one chamber" under a bill page that says
 * "Adopted by both chambers". The same blind spot covers a real second-chamber
 * passage, which changes the status basis and the key but can leave the raw
 * status at `passed_chamber`.
 *
 * WHAT THE KEY IS COMPARED AGAINST:
 *   - `grounded_in.vehicle_status_keys[slug]`, which every revision written
 *     since 2026-09-29 stores (scripts/moment-updates.mjs);
 *   - on a revision written before that, the key its writer used, which is
 *     worked out from the raw status. Before #382 no writer read the passage
 *     readings, so a `passed_chamber` measure was handed "Passed one
 *     chamber", and every status outside STATUS_KEY_READINGS was handed
 *     itself. A `floor_vote` measure is SKIPPED: its key was clocked at
 *     write time from a record this revision does not store, so any
 *     reconstruction would be a guess. Its movement still arrives as an
 *     update or a raw status change, as before.
 *
 * NOT COUNTED: `floor_vote` → `floor_vote_stale`. That is the calendar
 * placement aging past its signal window. Nothing in the record moved, only
 * the clock, and the SUMMARY_REANCHOR_DAYS clock already handles that
 * (§6: a summary is regenerated only when the issue moved).
 *
 * A key change is a reason to rewrite, not a reason the page prints: the
 * revision's `changed_because` gets no token for it (see changedBecause in
 * scripts/moment-updates.mjs for why).
 *
 * @param {Record<string, any> | null | undefined} revision  the revision the page shows now
 * @param {Record<string, string> | null | undefined} statusKeys  current slug -> status key
 * @param {Record<string, string>} [vehicleStatuses]  current slug -> raw status
 * @returns {{ slug: string, from: string, to: string }[]}
 */
export function statusKeyChanges(revision, statusKeys, vehicleStatuses = {}) {
  const out = [];
  if (!revision || !statusKeys || typeof statusKeys !== 'object') return out;
  const groundedRaw = revision.grounded_in?.vehicle_statuses ?? {};
  const stored = revision.grounded_in?.vehicle_status_keys;
  const storedKeys = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : null;
  for (const [slug, key] of Object.entries(statusKeys)) {
    const raw = vehicleStatuses?.[slug];
    // A raw change is the raw comparison's to report, and a vehicle this
    // revision never grounded is a raw change too.
    if (raw === undefined || groundedRaw[slug] !== raw) continue;
    let held;
    if (storedKeys && typeof storedKeys[slug] === 'string') {
      held = storedKeys[slug];
    } else {
      if (raw === 'floor_vote') continue;
      held = raw;
    }
    if (held === key) continue;
    if (held === 'floor_vote' && key === 'floor_vote_stale') continue;
    out.push({ slug, from: held, to: key });
  }
  return out;
}

/**
 * Why this summary needs regenerating, as a short log string — or null when
 * nothing moved. summaryNeedsRefresh is this, as a boolean.
 *
 * `opts.statusKeys` (slug -> status key, read the way the page reads it) turns
 * on the status-key comparison (statusKeyChanges). A caller that omits it
 * gets the raw comparison only, as before 2026-09-29.
 * @param {Record<string, any>} entry
 * @param {Record<string, string>} vehicleStatuses
 * @param {Date|string|number} [now]
 * @param {{ unsupported?: Set<string>, statusKeys?: Record<string, string> }} [opts]
 * @returns {string|null}
 */
export function summaryRefreshReason(entry, vehicleStatuses = {}, now = Date.now(), opts = {}) {
  const revisions = entry?.summary_revisions ?? [];
  const last = revisions[revisions.length - 1];
  if (!last) return 'first summary';

  const unsupported = opts?.unsupported ?? new Set();

  const grounded = last.grounded_in?.vehicle_statuses ?? {};
  for (const [slug, status] of Object.entries(vehicleStatuses ?? {})) {
    if (grounded[slug] === status || unsupported.has(slug)) continue;
    // A reversal is the page being corrected: it triggers, and says so.
    return revertingSlugs(entry, { [slug]: status }, now).has(slug)
      ? `status ${slug} (reverts a change made inside ${FLAP_WINDOW_HOURS}h — the correction publishes)`
      : `status ${slug}`;
  }

  // The raw statuses all match. The page may still read one differently now
  // (see statusKeyChanges). A status its own sentence does not support is
  // held back here too, for the flap guard's reason.
  const keyChange = statusKeyChanges(last, opts?.statusKeys, vehicleStatuses).find((c) => !unsupported.has(c.slug));
  if (keyChange) return `status key ${keyChange.slug} ${keyChange.from}→${keyChange.to}`;

  const generatedAt = Date.parse(last.generated_at);
  if (!Number.isFinite(generatedAt)) return 'unparseable generated_at';

  // Reached only when every current status equals the grounded one (or is
  // unsupported) — so a flap pair recorded after the revision netted to
  // nothing the page does not already say.
  const flaps = flapStatusChangeIds(entry?.updates ?? []);
  for (const u of entry?.updates ?? []) {
    const recorded = Date.parse(u?.recorded_at);
    if (!Number.isFinite(recorded) || recorded <= generatedAt) continue;
    if (u?.class === 'status_change' && (flaps.has(u.id) || unsupported.has(u.vehicle))) continue;
    return `update ${u?.id ?? '(no id)'}`;
  }

  const nowMs = toMs(now);
  return nowMs - generatedAt > SUMMARY_REANCHOR_DAYS * DAY_MS ? 'reanchor' : null;
}

/**
 * How many revisions this entry already carries for one ET calendar day —
 * the per-question intraday cap reads this off the stored file, so it holds
 * across runs with no extra state.
 * @param {Record<string, any>} entry
 * @param {string} day 'YYYY-MM-DD' (ET)
 * @returns {number}
 */
export function revisionsOnDay(entry, day) {
  return (entry?.summary_revisions ?? []).filter((r) => etDay(r?.generated_at) === day).length;
}

/**
 * How many "Where it stands" ATTEMPTS this entry has spent on one ET day —
 * model calls, successful or not, nightly and intraday alike — read off
 * `entry.summary_attempts` ({ day, count }), which scripts/moment-updates.mjs
 * writes before each call. A revision count alone cannot bound spend: a
 * rejected reply stores nothing, so a model that keeps writing a rejected
 * sentence would be asked again on every landing. Summed over every entry it
 * is also the day's whole summary spend, which the collector holds under
 * MOMENT_SUMMARY_DAILY_CAP. A counter from another day is simply stale and
 * reads as zero.
 * @param {Record<string, any>} entry
 * @param {string} day 'YYYY-MM-DD' (ET)
 * @returns {number}
 */
export function summaryAttemptsOnDay(entry, day) {
  const a = entry?.summary_attempts;
  return a && a.day === day && Number.isInteger(a.count) && a.count > 0 ? a.count : 0;
}

/**
 * THE REFUSAL ALARM (2026-11-12). A refused "Where it stands" reply stores
 * nothing and the previous revision stands (rule 11), and a later run asks
 * again. Nothing retries, and until this alarm nothing said when the same
 * question kept being refused, so a summary could sit stale unnoticed.
 *
 * `entry.summary_refusals` ({ count, day, reason }) is written by
 * scripts/moment-updates.mjs writeSummaries beside `summary_attempts`:
 *   - count: how many model replies IN A ROW for this question were refused
 *     (a lint failure, a reply that is not JSON, or one with no EN/ES pair);
 *   - day: the ET day of the newest of them;
 *   - reason: the newest refusal's failures, one line, at most
 *     SUMMARY_REFUSAL_REASON_MAX characters.
 * It is deleted when a revision is stored for the question (by the model or
 * the record-only template) or the record-only template finds the current
 * revision already current. A call that fails before any reply (a network or
 * API error) and a run that does not ask (budget spent, deferred, nothing
 * moved) leave it as it is: neither is a refusal, and neither is a success.
 * Never rendered.
 *
 * At SUMMARY_REFUSAL_ALARM_RUNS refusals in a row the collector prints a
 * GitHub Actions `::warning::` naming the question and the reason, on that
 * run and on every refused run after it, and scripts/pipeline-health.mjs
 * raises a `summary-refused` alarm from the committed counter. Why 3: one
 * refusal is the lint working (it is strict on purpose and a later run writes
 * another); two can be chance; three is INTRADAY_SUMMARY_CAP, a whole ET
 * day's allowance of calls for one question, or three nightly runs in a row.
 * At that point waiting is not fixing it, and a person should read the
 * reason. No retry is added: each refusal already spent one model call.
 */
export const SUMMARY_REFUSAL_ALARM_RUNS = 3;
/** How much of the newest refusal's failures `summary_refusals.reason` keeps. */
export const SUMMARY_REFUSAL_REASON_MAX = 300;

/**
 * The counter after one more refused reply. PURE: returns the new value, the
 * caller stores it. `reason` is flattened to one line and cut to
 * SUMMARY_REFUSAL_REASON_MAX characters.
 * @param {Record<string, any>} entry
 * @param {string} day ET day (YYYY-MM-DD)
 * @param {string} reason
 * @returns {{ count: number, day: string, reason: string }}
 */
export function nextSummaryRefusals(entry, day, reason) {
  const prev = entry?.summary_refusals;
  const count = prev && Number.isInteger(prev.count) && prev.count > 0 ? prev.count + 1 : 1;
  let line = String(reason ?? '').replace(/\s+/g, ' ').trim() || 'refused';
  if (line.length > SUMMARY_REFUSAL_REASON_MAX) line = `${line.slice(0, SUMMARY_REFUSAL_REASON_MAX - 1)}…`;
  return { count, day, reason: line };
}

/**
 * What is wrong with a stored `summary_refusals` value, or null when it is
 * well-formed. Shared by checkMomentUpdates (CI, after the commit) and
 * verifyMomentUpdates (verify-sync, before the commit), so the shape is
 * defined once. The returned text follows the field path:
 * `: must be ...` for a malformed value, `.day: ... is in the future` for a
 * day past `nowDay` (an ET "YYYY-MM-DD"; skipped when null).
 * @param {unknown} f
 * @param {string|null} [nowDay]
 * @returns {string|null}
 */
export function summaryRefusalsProblem(f, nowDay = null) {
  if (
    !f ||
    typeof f !== 'object' ||
    Array.isArray(f) ||
    !Number.isInteger(f.count) ||
    f.count < 1 ||
    !DAY_RE.test(String(f.day)) ||
    !isNonEmptyString(f.reason) ||
    f.reason.length > SUMMARY_REFUSAL_REASON_MAX
  ) {
    return `: must be { count: an integer of 1 or more, day: "YYYY-MM-DD", reason: a non-empty string of at most ${SUMMARY_REFUSAL_REASON_MAX} characters }`;
  }
  if (nowDay && f.day > nowDay) return `.day: ${f.day} is in the future`;
  return null;
}

/**
 * The `::warning::` line for a question refused SUMMARY_REFUSAL_ALARM_RUNS or
 * more times in a row, or null below that. PURE. The message is escaped the
 * way GitHub's workflow commands require (%, CR, LF).
 * @param {string} momentId
 * @param {{ count: number, day: string, reason: string }} refusals
 * @returns {string | null}
 */
export function summaryRefusalWarning(momentId, refusals) {
  if (!refusals || !Number.isInteger(refusals.count) || refusals.count < SUMMARY_REFUSAL_ALARM_RUNS) return null;
  const msg = `moment-updates: the "Where it stands" summary of ${momentId} was refused on ${refusals.count} runs in a row (the newest on ${refusals.day} ET); the previous revision stands. Newest reason: ${refusals.reason}`;
  return `::warning::${msg.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`;
}

/* ------------------------------------------------------------------ *
 * The lint — three layers, both languages.
 * ------------------------------------------------------------------ */

/**
 * The Spanish hedges, ONE canonical accented spelling each — the pattern below
 * is built from this list, and so is the label the failure message prints.
 *
 * WHY A LIST AND NOT A REGEX LITERAL (2026-08-09). This was
 * `/\b(se espera|…|podría|podrían|estaría|estarían|…)\b/i`, accent-exact, and
 * the UNACCENTED spellings sailed straight through: `SPECULATION.es.test('La
 * medida podria aprobarse.')` was **false** while the accented form was
 * caught. That is not a hypothetical spelling — it is how a diacritic-dropping
 * model writes it, and it is the exact spelling scripts/moment-updates.mjs's
 * own prompts use when they tell the model which words are banned ("no …
 * 'podria', 'podrian', 'estaria' …", the decode prompt and the summary prompt
 * both). We handed the model a vocabulary in a spelling our own lint could not
 * see, on the path where nobody reads the sentence before it publishes.
 *
 * So the spellings are GENERATED (eitherSpelling) rather than typed twice: the
 * next term added to this list gets both spellings for free, which is the only
 * version of this fix that cannot rot. tests/moment-updates.unit.spec.ts
 * sweeps every term in both spellings so the guarantee is checked, not assumed.
 *
 * The BOUNDARY is Unicode (esWord, imported from the vocabulary table's module
 * so the two lints cannot mean different things by "word"). No current term
 * ends in an accented vowel, so ASCII `\b` happened to work here — but "quizá"
 * or "está por" would silently never match under `\b`, which is precisely the
 * failure lib/moments-gate.mjs's FORBIDDEN.es carried for three years.
 *
 * NOTE the deliberate omission of bare "may" from the English list: it
 * collides with the month, and "the Senate returns in May" is exactly the
 * plain record fact the law tells us to state. And note that these are exact
 * terms, not stems — "podríamos" is not matched today and is not matched now;
 * this change fixes SPELLING coverage, it does not widen the vocabulary.
 */
export const SPECULATION_ES_TERMS = [
  'se espera',
  'probablemente',
  'podría',
  'podrían',
  'estaría',
  'estarían',
  'previsto que',
  'a punto de',
  // `rumbo a` / `camino de` joined 2026-07-25 with their English twins — see
  // the note on the `en` pattern below.
  'rumbo a',
  'camino de',
];

/*
 * Layer 2, the speculation lint (§2.1). Forecast and hedge constructions on a
 * record class. Every construction that actually smuggles a prediction into
 * our voice is covered; see SPECULATION_ES_TERMS above for the Spanish half.
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
  es: esWord(SPECULATION_ES_TERMS.map(eitherSpelling).join('|')),
};

const SPECULATION_LABEL = {
  en: 'expected to / likely to / could / might / set to / poised to / on track to / heading to / headed for',
  // Derived, never re-typed: a hand-maintained twin of the list above is a
  // second place for a term to go missing, and the point of the list is that
  // there is exactly one.
  es: SPECULATION_ES_TERMS.join(' / '),
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
 *
 * `opts.groundedEvents` adds the ABSENCE lint (absenceClaims below): when the
 * record the summary was written from holds any vote or action in its window,
 * a sentence claiming nothing happened is rejected. Callers that pass nothing
 * get exactly the two layers they always got. `opts.rollCallsOnRecord` is how
 * many roll calls data/votes.json holds on the question's measures at ANY
 * date — not only inside the summary window; see absenceClaims for the one
 * sentence class it lets through when that answer is zero.
 *
 * `opts.numbers` adds part 1 of the NUMBER lint (unheldNumbers below): every
 * whole number from 0 to 435 the text states must be one `numberGrounding`
 * built from the data the text was written from. Omitted, nothing is
 * checked. Part 2, that the Spanish states the English's numbers, reads the
 * pair, not one string: numberParityFailure.
 *
 * @param {string} text
 * @param {'en'|'es'} lang
 * @param {{ groundedEvents?: boolean, rollCallsOnRecord?: number, numbers?: number[] | null }} [opts]
 * @returns {string[]}
 */
export function lintRevisionText(text, lang, opts = {}) {
  const failures = [];
  const value = String(text ?? '');
  for (const word of lintForbidden(value, lang)) {
    failures.push(`forbidden vocabulary "${word}" (inherited table, moments spec §3.3)`);
  }
  if (SPECULATION[lang]?.test(value)) {
    const hit = value.match(SPECULATION[lang])?.[0] ?? '';
    failures.push(`speculation "${hit}" in a summary revision — speculation never wears our voice (v2 spec §2)`);
  }
  if (opts?.groundedEvents) {
    for (const hit of absenceClaims(value, lang, { rollCallsOnRecord: opts.rollCallsOnRecord })) {
      failures.push(
        `absence claim "${hit}" over a record that is not empty — the grounding holds a vote or action in this window, so "nothing happened" is false`,
      );
    }
  }
  for (const n of unheldNumbers(value, opts?.numbers)) {
    failures.push(
      `number "${n}" that the record does not hold — every number from 0 to ${NUMBER_MAX} a summary states must be one the roll calls, updates and measures it was written from hold`,
    );
  }
  return failures;
}

/* ------------------------------------------------------------------ *
 * The ABSENCE lint (2026-09-25).
 *
 * On 2026-09-24 the "Where it stands" summary for iran-war-powers was
 * regenerated at 18:57:01Z and published "No new votes, tallies, or roll-call
 * numbers have been recorded for any of these measures in this period … the
 * current standing unchanged" — after the Senate had rejected H.Con.Res. 89,
 * 49-50 (Senate roll call 244, vote_date 1:45 PM ET = 17:45Z per senate.gov).
 * The same night's s-4668-119 summary omitted rolls 240/242/243, which
 * data/votes.json already held, because the collector never read that file.
 *
 * An absence claim is the one sentence a summary can write that the record
 * beside it can flatly contradict, and the prompt even invited it ("If
 * nothing has moved recently, say that plainly"). So: when the grounding
 * holds any vote or record event in the window, absence phrasing is a lint
 * failure, and the run keeps the previous revision (the existing rejection
 * path — there is no fallback for a summary).
 *
 * Deliberately phrase-level and deliberately strict: a relative claim like
 * "no further votes are recorded" after listing two is often TRUE, and it is
 * rejected anyway, because the lint cannot tell "further" from "at all" and a
 * rejected summary costs one call while a false one costs the reader. The
 * prompt tells the model not to write these sentences when the record is not
 * empty, so a rejection is the model disobeying, not the lint misfiring.
 *
 * NOT absence: the record's own "Roll no. 282" / "Calendar No. 501" (a "no"
 * followed by a period is an abbreviation), "49 yeas to 50 nays", "not agreed
 * to" (an outcome), and STALE_PLACEMENT_PHRASE, which is our own clocked
 * status phrase and is only ever handed to the model for a measure with no
 * activity in the window (scripts/moment-updates.mjs).
 *
 * ALSO NOT absence (fix pass, 2026-09-25), because the lint must not reject
 * the record's own words or a true outcome — each rejection spends one of the
 * day's three slots and leaves the previous revision up, which on
 * iran-war-powers was the false one:
 *   - Congress.gov's "(No short title on file)" placeholder. The vote record's
 *     questions carry it verbatim (Senate rolls 240 and 242 on S. 4668), the
 *     prompt hands those questions over word for word, and together with the
 *     prompt's own prescribed "by a recorded vote of" it read as
 *     "No … recorded". The placeholder is removed before matching, and the
 *     "no … recorded" pattern no longer reaches across a parenthesis.
 *   - "passed … unchanged" (and, since 2026-11-11, "passed … without changes"
 *     / "with no changes") / "aprobó … sin cambios": HOW a measure passed
 *     (without amendment), stated right after the passage verb in the same
 *     clause. "… and the status remains unchanged" is still caught.
 *   - "makes / would make no changes to …" / "no haría cambios a …", "no
 *     hace ningún cambio a …" (2026-11-12): what a bill's text would do, not
 *     a claim that nothing happened (BILL_MAKES_NO_CHANGE). "made no changes"
 *     (past) is still caught.
 * All three are TEXT-ONLY exemptions on purpose: the gate re-runs this lint on
 * stored revisions without data/votes.json, and a collector that accepted
 * what the gate then rejects would redden main after a commit.
 *
 * Kept strict on purpose: "no vote on final passage has been scheduled" and
 * "No hay fecha fijada". A claim that nothing is SCHEDULED is exactly the kind
 * the 2026-09-24 failure disproved within the hour (roll 244 carried no stored
 * floor signal at all), and the prompt now names it as a sentence not to write.
 *
 * AND ONE EXEMPTION THAT IS NOT TEXT-ONLY (2026-09-27, the 2026-09-27 audit
 * SY-23): "no roll call" / "no recorded vote" / "sin votación nominal" when the
 * VOTE FILE holds ZERO roll calls on the question's measures, at any date. On
 * 2026-09-26 the lint rejected the first "Where it stands" for
 * penny-production-and-cash-rounding — "absence claim 'no roll call' over a
 * record that is not empty" — whose vehicles passed by voice vote and
 * unanimous consent. The record held actions, so the lint fired; but the
 * sentence was about roll calls, and data/votes.json holds none on those
 * measures. A brand-new question has no previous revision to fall back on,
 * so the page rendered no "Where it stands" at all for two days.
 *   WHY ANY DATE, NOT THE WINDOW: these sentences carry no time scope — "no
 *   roll call has been taken on either measure", "passed … with no recorded
 *   vote" — so they are true only if NO roll call on the measure exists. A
 *   count of the summary window's roll calls would pass them over a measure
 *   whose recorded passage vote is a month old (H.R. 8800, House roll 278 on
 *   2026-07-22, outside a 14-day window). So the collector counts every roll
 *   call data/votes.json holds on the measures, with no date filter.
 *   WHY THIS ONE MAY READ THE VOTE FILE when the others above may not: those
 *   ids are STORED on the revision (`grounded_in.roll_calls_on_record`), so
 *   the gate re-running the lint on stored revisions sees exactly the count
 *   the collector saw — no data/votes.json needed, and the two can never
 *   disagree. A revision without that field — written before it existed, or
 *   one where the collector could not vouch for the count (below) — gets no
 *   exemption.
 *   WHAT THE VOTE FILE CANNOT SEE, stated rather than papered over:
 *   data/votes.json starts at its `_meta.floor` (2026-05-27 when this was
 *   written; 2025-01-03, the 119th Congress's first day, since the
 *   2026-09-29 back-fill). A roll call on a measure before that date is not
 *   in it. The collector closes the part of
 *   that gap it can: when any action text it holds for the measures (their
 *   retained updates and each bill's last action) names a recorded vote that
 *   the file does not hold, it stores no count and nothing is exempt. A roll
 *   call before the floor that no retained action text mentions is still
 *   invisible to this check.
 *   HOW NARROW: only a phrase that is about roll calls or recorded votes and
 *   nothing else — "no roll call", "no roll-call votes were taken on either
 *   measure", "no recorded vote", "without a recorded vote" (2026-11-11, the
 *   twin of "sin votación nominal"), "sin votación nominal", "no se registró
 *   ninguna votación nominal" — ending at punctuation. A bare "no votes" is
 *   still rejected (a voice vote IS a vote), and so is "no roll call or other
 *   action", because the phrase does not end where the roll-call claim ends.
 *
 * TWO SHAPES WITH NO "no" IN THEM (2026-10-06). A diagnostic run of the
 * penny summary prompt against the real model (workflow run 36884798035,
 * 2026-10-01, sample "baseline #4") passed every pattern here with "These
 * were the only actions listed for the bill in the last 14 days" and "S. 1525
 * and H.R. 3074 … neither had a new vote or action in this window", and the
 * Spanish "Estas fueron las únicas acciones registradas …" and "ninguno tuvo
 * un voto o una acción nuevos en este período". Both are absence claims: one
 * says nothing else happened, the other that nothing happened to two
 * measures. The negation sits in the subject ("neither", "none", "ninguno")
 * or in "the only" / "las únicas", so the "no"-anchored patterns never saw
 * it. Same posture as the rest of the lint: one clause, strict, a true
 * relative claim rejected with a false one. Pinned by
 * tests/moment-updates-text-gates.unit.spec.ts.
 *
 * THE ROWS, AND HOW FAR "BOTH LANGUAGES" IS PROVED (2026-11-11). Reviews of
 * this change kept finding a form caught in one language and not its twin
 * ("has not changed" / "no ha cambiado", "No further action was taken" / "No
 * se tomó ninguna otra acción"), and a probe of the patterns that day found
 * sixteen more ("sin actividad" / "without activity" among them). So
 * every pattern in ABSENCE below belongs to one of ten numbered rows, and
 * each row is a pair: an English pattern and its Spanish twin.
 *    1. "no" and an event noun: "no new votes", "No further action was
 *       taken", "There is no date set" / "No se registraron nuevas
 *       votaciones", "No hubo cambios", "No se tomaron más medidas".
 *    2. "without" / "sin" and an event noun: "without any action" / "sin
 *       ninguna acción".
 *    3. no … recorded / listed / shown: "No action is listed" / "No figura
 *       ninguna acción", "does not appear in the record" / "no aparece en el
 *       registro".
 *    4. nothing: "Nothing else happened" / "No pasó nada más".
 *    5. "unchanged" / "sin cambios".
 *    6. "has not changed / moved / advanced" / "no ha cambiado / se ha movido
 *       / ha avanzado".
 *    7. where it stood: "stays the same", "remains where it was" / "sigue
 *       igual", "permanece donde estaba".
 *    8. "has been quiet / inactive" / "ha estado inactivo / en calma".
 *    9. neither / none (ningún, ninguno, ni … ni) and a vote, action or
 *       change, in one clause.
 *   10. the only: "the only actions" / "las únicas acciones".
 * The twin table in tests/moment-updates-text-gates.unit.spec.ts lists, for
 * every row, sentences caught in both languages, and sentences left alone in
 * both: how a measure passed ("without amendment", "with no changes", "by
 * voice vote"), an outcome ("not agreed to"), the party-count sentences it
 * lists ("No Republican voted yes" / "Ningún republicano votó a favor", "No
 * hubo votos republicanos a favor", "No senator voted present" / "Ningún
 * senador votó presente"), what a bill would do ("Neither bill would change
 * the tax" / "Ningún proyecto cambiaría el impuesto", "The bill would make no
 * changes to Social Security" / "El proyecto no haría cambios al Seguro
 * Social"), and a named change ("includes the change" / "incluye el
 * cambio"). That table is the claim, complete as listed, sentence by
 * sentence. It is NOT a claim about a class: "a party count is left alone"
 * holds only for the party-count sentences the table lists. Rows 1 and 9 read
 * a vote noun or "voted" / "votó" and let through only the sides they name
 * (yes, no, present, for, against, in favor / sí, no, presente, a favor, en
 * contra, …), so a party count phrased any other way is read like an absence
 * claim, and may be read in one language and not the other.
 * KNOWN ONE-LANGUAGE SPLITS, the ones found so far (2026-11-12: four by the
 * author, four more by an independent review of 100 sentence pairs the same
 * day). The list is what has been found, not a promise that there are no
 * others. They are left as they are (no new round of phrase-by-phrase
 * patching; a refusal costs one model call and the previous summary stands):
 *   - "No senator voted "present"" is let through; "Ningún senador votó
 *     "presente"" is caught (the quotation mark hides the side).
 *   - "The Senate made no changes to it" (past) is caught; "El Senado no
 *     hizo cambios" is not ("no hizo ningún cambio" is).
 *   - "No changes were made to the bill" is caught; "No se hicieron cambios
 *     al proyecto" is not.
 *   - "The bill makes no changes." with nothing after it is caught; "El
 *     proyecto no hace cambios." is not (only "… to" / "… a" is exempt).
 *   - "No committee has acted on it" is let through; "Ningún comité ha
 *     actuado" is caught.
 *   - "The House has not scheduled a vote" is let through; "La Cámara no ha
 *     programado una votación" is caught. Of the eight, this is the one a
 *     real summary is most likely to say.
 *   - "No date has been set" is caught; "No se ha fijado fecha" is not.
 *   - "It was the sole roll call on the bill" is let through; "Fue la única
 *     votación nominal sobre el proyecto" is caught.
 * A form the table does not list is not claimed either way: a pattern is a
 * guess at a phrasing, and two languages phrase differently. "The bill did
 * not advance" / "El proyecto no avanzó" is caught in neither. To keep the
 * rows twins, three Spanish patterns were narrowed on 2026-11-11: "no se
 * movió", "no se celebró la audiencia" and "No hay quórum" are no longer
 * read, as their English twins never were.
 * ------------------------------------------------------------------ */

/**
 * The past-tense calendar phrase for an aged placement — ONE copy, imported
 * by scripts/moment-updates.mjs's RECORD_ONLY_PHRASE, so the absence lint's
 * exemption can never drift from the phrase the prompt hands out.
 */
export const STALE_PLACEMENT_PHRASE = {
  en: 'was placed on the floor calendar, and the official record shows no floor action on it since',
  es: 'se incluyó en el calendario del pleno, y el registro oficial no muestra ninguna acción en el pleno desde entonces',
};

// "no" as a word, but not the abbreviation in "Roll no. 282" / "Calendar No.
// 501", not a tally ("50 no votes"), and not the other half of "yes and no".
const NO_WORD = String.raw`(?<!\b(?:roll|vote|calendar|yes|yea|yeas|and|or)\s+)(?<!\d\s*)\bno\b(?!\.)`;

const ABSENCE = {
  en: [
    // ROW 1. "no new votes", "no floor or committee action", "no committee
    // markups", "no votes, tallies, or roll-call numbers", "no activity",
    // "No further action was taken", "There is no date set for a vote".
    new RegExp(
      String.raw`${NO_WORD}\s+(?:(?:new|further|additional|other|recent|recorded|more|subsequent)\s+)?(?:(?:floor|committee|recorded|roll[- ]call|legislative)\s+)?(?:(?:or|and)\s+(?:floor|committee)\s+)?(?:votes?|vote counts?|tall(?:y|ies)|roll[- ]calls?|actions?|activity|activities|movement|changes?|scheduling|developments?|steps?|progress|markups?|amendments?|hearings?|notices?|(?:vote\s+)?dates?)\b`,
      'i',
    ),
    // ROW 2, the twin of the Spanish "sin": "without any action", "without a
    // vote", "without activity". Not "without amendment" or "without
    // objection" (how a measure passed), which name no event noun here.
    /\bwithout\s+(?:any\s+|a\s+)?(?:(?:new|further|additional|other|more|recorded|floor|committee)\s+)*(?:votes?|actions?|activity|activities|movement|changes?|developments?|progress|steps?|records?|anything)\b/i,
    // ROW 3. "no … has been recorded / logged / appears in the record" — one clause,
    // and never across a parenthesis: "(No short title on file) by a recorded
    // vote" is two phrases, not one claim.
    new RegExp(String.raw`${NO_WORD}[^.;:()]{0,80}?\b(?:recorded|logged|reported|entered|appears?|shown|listed)\b`, 'i'),
    // …and "does not appear in the record", the twin of "no aparece en el
    // registro".
    /\b(?:does|do|did)\s+not\s+appear\s+in\s+the\s+record\b/i,
    // ROW 4. "Nothing has moved", "Nothing else happened", "Nothing appears in the record".
    /\bnothing\b[^.;:()]{0,40}?\b(?:moved|changed|happened|recorded|logged|new|reported|further|appears?|appeared|listed|shown)\b/i,
    // ROW 5. "unchanged" (the twin of "sin cambios", ROW 2 in Spanish).
    /\bunchanged\b/i,
    // ROW 6. "has not changed", "hasn't moved", "had not advanced".
    /\b(?:has|have|had)(?:\s+not|n['’]t)\s+(?:moved|changed|advanced|budged)\b/i,
    // ROW 7. "stands where it stood", "remains where it was", "stays the
    // same", "the same status as".
    /\b(?:stands?|stood|remains?|stays?|sits?)\s+(?:exactly\s+|just\s+)?where\s+(?:it|they)\s+(?:stood|was|were|sat)\b/i,
    /\b(?:stays?|stayed|remains?|remained)\s+(?:exactly\s+)?the\s+same\b/i,
    /\bsame\s+(?:status|standing|place|position)\s+(?:today\s+)?as\b/i,
    // ROW 8. "has been quiet / inactive / idle".
    /\b(?:has|have)\s+been\s+(?:quiet|inactive|idle|dormant)\b/i,
    // ROW 9 (2026-10-06): the two shapes a diagnostic sample of 2026-10-01 (workflow
    // run 36884798035, "baseline #4") got past every pattern above, because
    // neither sentence has a "no" in it. See the section note, 2026-10-06.
    //   "neither had a new vote or action in this window": the negation is
    //   the subject ("neither", "none of them"), and the clause names what
    //   did not happen. One clause: never across a comma or a parenthesis.
    //   A period inside a bill number ("S. 1525", "H.R. 3074", "H. Con. Res.
    //   89") does not end the clause: "Neither S. 1525 nor H.R. 3074 had a
    //   new vote". "voted" followed by a side ("none of the Republicans voted
    //   yes") is a party count, not an absence claim, and is left alone.
    //   "Neither measure has advanced" / "Neither measure advanced." is
    //   caught (a third independent check, 2026-10-06, found it missed in
    //   both languages); the adjective ("advanced nuclear reactors") is not,
    //   so "advanced" counts only after has/have/had or at punctuation.
    /\b(?:neither|none)\b(?:[^.;:,()]|\.(?=\s?(?:\d|(?:[HRJS]|Res|Con|Amdt)\.))){0,40}?(?<!\b(?:would|will|could|can|may|might|should|shall|must|to|not)\s+)\b(?:votes?(?!\s+(?:for|against|in\s+favou?r|yes|no|yea|nay|aye)\b)|voted(?!\s+(?:yes|no|yea|nay|present|for|against|in\s+favou?r|with|along)\b)|actions?|acted|activity|activities|movement|moved|(?:has|have|had)\s+advanced|advanced(?=\s*(?:[.;:,)]|$))|(?<!\b(?:the|this|that|these|those|its|their|his|her|our|your)\s+)changes?|developments?|steps?|progress)\b/i,
    // ROW 10. "These were the only actions listed for the bill in the last 14
    //   days", "the only movement recorded", "are the only ones in the last
    //   14 days": a claim that nothing ELSE happened. Often true, rejected
    //   anyway, for the reason the section note gives for "no further votes".
    //   "the only one to vote against it" / "who voted" / "that voted" is a
    //   statement about a roll call, like "none of the Republicans voted
    //   yes", and is left alone (a second independent check, 2026-10-06).
    /\bthe\s+(?:only|sole)\s+(?:(?:new|other|recent|recorded|floor|committee|two|three|four)\s+)*(?:actions?|votes?|movement|activity|activities|steps?|changes?|developments?|entries|events?|ones?(?!\s+(?:to\s+vote|who\s+vot(?:ed|es)|that\s+vot(?:ed|es))\b))\b/i,
  ],
  es: [
    // ROW 2. "sin cambios", "sin actividad", "sin movimiento", "sin ninguna
    // acción", "sin votación", "sin nada registrado".
    /\bsin\s+(?:ning[uú]n[ao]?\s+|nuev[oa]s?\s+|m[aá]s\s+|otr[oa]s?\s+)?(?:cambios?|actividad(?:es)?|movimientos?|acci[oó]n(?:es)?|votaci[oó]n(?:es)?|votos?|novedad(?:es)?|avances?|registros?|nada)(?![\p{L}])/iu,
    // ROW 3. "no se registraron", "no se ha registrado", "no se registró":
    // the twin of "no … recorded / reported / entered". (Until 2026-11-11 it
    // also read "no se movió", "no se celebró", "no se programó" with nothing
    // after them, which English, "did not move", never read.)
    /\bno\s+se\s+(?:ha\s+|han\s+|hab[ií]a\s+|hab[ií]an\s+)?(?:registr|report|anot)\p{L}*/iu,
    // "No aparecen en el registro sesiones de comité…", the twin of "does not
    // appear in the record" and of "No committee markups … appear in the record".
    /(?<![\p{L}])no\s+(?:aparec|const|figur)\p{L}*\s+en\s+el\s+registro(?![\p{L}])/iu,
    // ROW 1. "no hay", "no hubo", "no ha habido", and an event noun ("No
    // hubo cambios", "No hay fecha fijada"). "No hubo votos republicanos a
    // favor" is a party count, the twin of the English "No Republican votes
    // were cast for it", and is left alone. (Until 2026-11-11 any word after
    // "no hay" counted, "No hay quórum" too, which English never read.)
    /\bno\s+(?:hay|hubo|ha\s+habido|han\s+habido)\s+(?:(?:ning[uú]n[ao]?|m[aá]s|otr[oa]s?|nuev[oa]s?|un[ao]?)\s+)*(?:votaci[oó]n(?:es)?|votos?|conteos?|recuentos?|acci[oó]n(?:es)?|actividad(?:es)?|movimientos?|cambios?|novedad(?:es)?|pasos?|avances?|progresos?|enmiendas?|audiencias?|avisos?|fechas?|programaci[oó]n)(?![\p{L}])(?!\s+(?:republican|dem[oó]crat|independient)\p{L}*)/iu,
    // ROW 1 when Spanish puts a verb between the "no" and the noun: "No se
    // tomaron más acciones", "No tuvo actividad en comité", "No se
    // presentaron enmiendas", "No se ha programado ninguna votación", "El
    // registro no muestra votos".
    /(?<![\p{L}])no\s+(?:se\s+)?(?:(?:ha|han|hab[ií]a|hab[ií]an)\s+)?(?:tom|tuv|tien|tenid|present|celebr|realiz|program|registr|muestr|aparec|const|figur)\p{L}*\s+(?:(?:ning[uú]n[ao]?|m[aá]s|otr[oa]s?|nuev[oa]s?|un[ao]?)\s+)*(?:votaci[oó]n(?:es)?|votos?|conteos?|recuentos?|acci[oó]n(?:es)?|actividad(?:es)?|movimientos?|cambios?|novedad(?:es)?|pasos?|avances?|progresos?|enmiendas?|audiencias?|avisos?|fechas?)(?![\p{L}])/iu,
    // ROW 4. "Nada se ha movido", "Nada nuevo", and (2026-11-11) the twins of the
    // English "Nothing else happened" — "Nada más ocurrió", "Nada pasó",
    // "Nada más ha cambiado". One pattern, so a sentence is reported once.
    /\bnada\s+(?:nuevo|(?:m[aá]s\s+)?(?:(?:ha\s+)?(?:ocurri(?:do|[oó])|pasado|pas[oó]|sucedido|sucedi[oó]|cambiado|cambi[oó])|se\s+(?:ha\s+)?(?:movi(?:do|[oó])|registr(?:ado|[oó]))|aparec(?:e|i[oó])|figura|consta))(?![\p{L}])/iu,
    // "No pasó nada más", "No ocurrió nada", "No aparece nada en el registro",
    // "No se registró nada nuevo".
    /\bno\s+(?:ocurri[oó]|pas[oó]|sucedi[oó]|ha\s+(?:ocurrido|pasado|sucedido)|aparec\p{L}*|figur\p{L}*|const\p{L}*|se\s+(?:ha\s+)?registr\p{L}*)\s+nada(?![\p{L}])/iu,
    // ROW 1. "ninguna nueva votación", "ninguna otra acción", "ningún cambio".
    // "No se tomaron más medidas" ("tomar medidas" is "take action"; a bare
    // "medida" is a measure, and is not read).
    /(?<![\p{L}])no\s+se\s+(?:(?:ha|han)\s+)?tom\p{L}*\s+(?:(?:ning[uú]n[ao]?|m[aá]s|otr[oa]s?|nuev[oa]s?)\s+)*medidas?(?![\p{L}])/iu,
    /\bning[uú]n[ao]?\s+(?:(?:nuev[oa]|otr[oa]|m[aá]s)\s+)?(?:votaci[oó]n|acci[oó]n|actividad|cambio|movimiento|voto|avance|fecha)/iu,
    // ROW 6. "no ha cambiado", "no ha avanzado", "no se ha movido".
    /(?<![\p{L}])no\s+(?:se\s+)?(?:ha|han|hab[ií]a|hab[ií]an)\s+(?:movido|cambiado|avanzado|variado)(?![\p{L}])/iu,
    // ROW 7. "sigue igual", "sigue donde estaba", "el mismo estado que".
    /\b(?:sigue|siguen|permanece|permanecen|se\s+mantiene|se\s+mantienen)\s+(?:igual|(?:exactamente\s+)?donde\s+(?:estaba|estaban|se\s+encontraba|se\s+encontraban)|sin\s+cambios)/iu,
    /\b(?:el|la)\s+mism[oa]\s+(?:estado|estatus|situaci[oó]n|posici[oó]n)\s+que\b/iu,
    // ROW 8. "ha estado inactivo / tranquilo / en calma".
    /(?<![\p{L}])(?:ha|han)\s+(?:estado\s+(?:inactiv[oa]s?|tranquil[oa]s?|en\s+calma|quiet[oa]s?|parad[oa]s?)|habido\s+calma)(?![\p{L}])/iu,
    // ROW 9 and ROW 10 (2026-10-06), the Spanish twins of the two English shapes above (the
    // same sample wrote both): "ninguno tuvo un voto o una acción nuevos en
    // este período" and "Estas fueron las únicas acciones registradas",
    // "el único movimiento que consta", "son las únicas de los últimos 14 días".
    // The same two widenings as the English: a bill number's periods stay
    // inside the clause, and the passive "se votó" / "fue votado" ("Ninguno
    // de los dos se votó") reads like "neither was voted on"; a bare "votó a
    // favor" is a party count and is left alone. A plain "votó" / "votaron"
    // with no side after it ("Ni la Cámara ni el Senado votaron") is caught,
    // as the English "voted" is (a second independent check, 2026-10-06);
    // A fourth independent check, 2026-10-06: the subject may also be the
    // short masculine "ningún" before a noun ("Ningún proyecto tuvo una
    // votación nueva", "Ningún pleno votó"), the twin of "Neither bill had a
    // new vote"; "Ningún republicano votó a favor" stays a party count.
    // "el único que votó en contra" / "la única en votar", the twins of "the
    // only one to vote against it", are left alone. A third independent
    // check, 2026-10-06: "votaron en favor" / "en pro" is a side, like "voted
    // in favor", and is left alone; and the twins of the English "moved",
    // "acted" and "has advanced" are caught ("se ha movido", "se movió",
    // "actuó", "ha avanzado", "avanzó." — the adjective "avanzadas" is not).
    /(?<![\p{L}])ning(?:un[oa]|[uú]n)(?![\p{L}])(?:[^.;:,()]|\.(?=\s?(?:\d|(?:[HRJS]|Res|Con|Amdt)\.))){0,40}?(?<![\p{L}])(?:votos?(?![\p{L}])(?!\s+(?:a\s+favor|en\s+(?:favor|pro|contra)|s[ií]|no)(?![\p{L}]))|votaci[oó]n(?:es)?|acci[oó]n(?:es)?|actividad(?:es)?|movimientos?|(?<!(?<![\p{L}])(?:el|la|los|las|este|esta|estos|estas|ese|esa|esos|esas|su|sus)\s+)cambios?|avances?|novedad(?:es)?|se\s+vot(?:ó|o|aron)|vot(?:ó|aron)(?![\p{L}])(?!\s+(?:s[ií]|no|presente|a\s+favor|en\s+(?:favor|pro)|en\s+contra|por|con|junto)(?![\p{L}]))|votad[oa]s?|(?:se\s+)?(?:(?:ha|han|hab[ií]an?)\s+)?mov(?:ido|i[óo]|ieron)|(?:(?:ha|han|hab[ií]an?)\s+)?actu(?:ado|[óo]|aron)|(?:ha|han|hab[ií]an?)\s+avanzado|avanz(?:[óo]|aron)(?=\s*(?:[.;:,)]|$)))(?![\p{L}])/iu,
    // "Ni el S. 1525 ni el H.R. 3074 tuvo una votación nueva": the Spanish
    // "neither … nor", one clause.
    /(?<![\p{L}])ni\s+(?:[^.;:,()]|\.(?=\s?(?:\d|(?:[HRJS]|Res|Con|Amdt)\.))){1,40}?(?<![\p{L}])ni(?![\p{L}])(?:[^.;:,()]|\.(?=\s?(?:\d|(?:[HRJS]|Res|Con|Amdt)\.))){0,40}?(?<![\p{L}])(?:votos?(?![\p{L}])(?!\s+(?:a\s+favor|en\s+(?:favor|pro|contra)|s[ií]|no)(?![\p{L}]))|votaci[oó]n(?:es)?|acci[oó]n(?:es)?|actividad(?:es)?|movimientos?|(?<!(?<![\p{L}])(?:el|la|los|las|este|esta|estos|estas|ese|esa|esos|esas|su|sus)\s+)cambios?|avances?|novedad(?:es)?|se\s+vot(?:ó|o|aron)|vot(?:ó|aron)(?![\p{L}])(?!\s+(?:s[ií]|no|presente|a\s+favor|en\s+(?:favor|pro)|en\s+contra|por|con|junto)(?![\p{L}]))|votad[oa]s?|(?:se\s+)?(?:(?:ha|han|hab[ií]an?)\s+)?mov(?:ido|i[óo]|ieron)|(?:(?:ha|han|hab[ií]an?)\s+)?actu(?:ado|[óo]|aron)|(?:ha|han|hab[ií]an?)\s+avanzado|avanz(?:[óo]|aron)(?=\s*(?:[.;:,)]|$)))(?![\p{L}])/iu,
    /(?<![\p{L}])(?:el|la|los|las)\s+(?:(?:dos|tres|cuatro|otr[oa]s)\s+)?[uú]nic[oa]s?\s+(?:(?:nuev[oa]s?|otr[oa]s?|dos|tres|cuatro)\s+)*(?:(?:acci[oó]n(?:es)?|votaci[oó]n(?:es)?|votos?|movimientos?|actividad(?:es)?|pasos?|cambios?|medidas?|novedad(?:es)?|avances?|registros?|entradas?)(?![\p{L}])|(?=(?:de|del|en|que)\s|registrad[oa]s?(?![\p{L}]))(?!(?:que\s+vot(?:ó|o|aron)|en\s+votar)(?![\p{L}])))/iu,
  ],
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Congress.gov's placeholder title, as the vote record's questions carry it. */
const NO_SHORT_TITLE = /\(?\s*\bno short title on file\b\s*\)?/gi;

/**
 * A claim that no ROLL CALL / RECORDED VOTE happened, and nothing more — true
 * against the vote file whenever it holds zero roll calls on the question's
 * measures at any date (see the section note). The trailing lookahead is the
 * narrowness: the phrase must end at punctuation or the end of the text, so
 * "no roll call or other action" never matches.
 */
const ROLL_CALL_ABSENCE = {
  en: /\b(?:no|without\s+(?:a|any))\s+(?:(?:recorded|roll[- ]call)\s+votes?|roll[- ]calls?)(?:\s+(?:was|were|has\s+been|have\s+been|had\s+been)\s+(?:taken|held|recorded|requested|ordered|logged|called|cast))?(?:\s+(?:on|for|in)\s+(?:it|them|either(?:\s+\w+)?|any\s+of\s+(?:them|these(?:\s+\w+)?)|(?:this|that|the|each)\s+\w+(?:\s+\w+)?))?(?=\s*(?:[.;:,)]|$))/gi,
  es: /(?<![\p{L}])(?:sin|no\s+(?:hubo|ha\s+habido|hay|se\s+(?:ha\s+|han\s+)?(?:registr|celebr|realiz|tom|efectu)\p{L}*))\s+(?:ning[uú]n[ao]?\s+|una\s+)?(?:votaci[oó]n(?:es)?|votos?)\s+(?:nominal(?:es)?|registrad[oa]s?|con\s+registro)(?:\s+(?:sobre|en|para)\s+(?:ell[ao]s?|(?:est[ea]s?|es[ea]s?|la|el|las|los|cada|ningun[ao])\s+\p{L}+(?:\s+\p{L}+)?))?(?=\s*(?:[.;:,)]|$))/giu,
};

/**
 * "passed … unchanged" / "aprobó … sin cambios": the passage verb, then at most
 * a few words of object with no comma, semicolon, colon, parenthesis, copula,
 * conjunction or status noun between — then the adjective. Group 1 is kept,
 * the adjective is dropped, and the patterns below never see it.
 */
const PASSED_UNCHANGED = {
  en: /(\b(?:passed|adopted|approved|cleared|agreed\s+to|concurred\s+in)(?:\s+(?!(?:and|but|while|yet|so|then|since|remains?|remained|stays?|stayed|is|are|was|were|sits?|sat|stands?|stood|status|standing|position)\b)[^\s,;:()]+){0,6})\s+(?:unchanged|without\s+(?:any\s+)?changes?|with\s+no\s+changes?)\b/gi,
  es: /(\b(?:aprob[óo]|aprobaron|aprobad[oa]s?|adopt[óo]|adoptaron|adoptad[oa]s?)(?:\s+(?!(?:y|e|pero|mientras|luego|desde|sigue|siguen|permanece|permanecen|se|est[aá]|estado|estatus|situaci[oó]n)(?![\p{L}]))[^\s,;:()]+){0,8})\s+sin\s+cambios(?![\p{L}])/giu,
};

/**
 * WHAT A BILL WOULD DO (2026-11-12): "The bill would make no changes to
 * Social Security", "The bill makes no changes to the tax code" / "El
 * proyecto no haría cambios al Seguro Social", "no hace ningún cambio a la
 * ley". A statement about the bill's text, not a claim that nothing happened.
 * Only the present and conditional of "make" / "hacer" (makes, would make,
 * will make / hace, hacen, haría, harían, hará, harán), and only with "to" /
 * "in" / "a" / "al" / "en" right after the noun: "made no changes" (past) is
 * still read, and so is a bare "makes no changes." with nothing after it.
 * Group 1 (the verb) is kept; "no change(s)" / "ningún cambio" / "cambios" is
 * dropped, and the patterns below never see it. TEXT-ONLY, like the two
 * exemptions above.
 */
const BILL_MAKES_NO_CHANGE = {
  en: /(\b(?:makes|(?:would|will)\s+make))\s+no\s+changes?(?=\s+(?:to|in)\b)/gi,
  es: /((?<![\p{L}])no\s+(?:hace|hacen|har[ií]a|har[ií]an|har[aá]|har[aá]n))\s+(?:ning[uú]n\s+cambio|cambios?)(?=\s+(?:a|al|en)(?![\p{L}]))/giu,
};

/**
 * Every absence claim in one summary string, as the matched text (empty when
 * clean). Removed first — see the section note: the stale-placement phrase,
 * Congress.gov's "(No short title on file)", the "unchanged" / "sin cambios"
 * that follows a passage verb, "makes / would make no changes to" and its
 * Spanish twins (BILL_MAKES_NO_CHANGE), and — only when `opts.rollCallsOnRecord` is
 * exactly 0, i.e. the vote file is known to hold no roll call on the
 * question's measures at any date — a roll-call-only absence phrase.
 * `rollCallsOnRecord` undefined (a caller or a stored revision that does not
 * know the count, or a collector that could not vouch for it) exempts
 * nothing. A count of the summary WINDOW's roll calls is not this number and
 * must never be passed as it: see the section note.
 * @param {string} text
 * @param {'en'|'es'} lang
 * @param {{ rollCallsOnRecord?: number }} [opts]
 * @returns {string[]}
 */
export function absenceClaims(text, lang, opts = {}) {
  let value = String(text ?? '');
  const exempt = STALE_PLACEMENT_PHRASE[lang];
  if (exempt) value = value.replace(new RegExp(escapeRe(exempt), 'gi'), ' ');
  value = value.replace(NO_SHORT_TITLE, ' ');
  if (PASSED_UNCHANGED[lang]) value = value.replace(PASSED_UNCHANGED[lang], '$1');
  if (BILL_MAKES_NO_CHANGE[lang]) value = value.replace(BILL_MAKES_NO_CHANGE[lang], '$1');
  if (opts?.rollCallsOnRecord === 0 && ROLL_CALL_ABSENCE[lang]) value = value.replace(ROLL_CALL_ABSENCE[lang], ' ');
  const hits = [];
  for (const re of ABSENCE[lang] ?? []) {
    const m = value.match(re);
    if (m) hits.push(m[0].trim());
  }
  return hits;
}

/* ------------------------------------------------------------------ *
 * The NUMBER lint (2026-10-06; redesigned 2026-11-11).
 *
 * WHY. An independent check of PR #412 (2026-09-29, case D) put a summary
 * through every gate with an invented tally in it — "by a vote of 98 to 0",
 * over a measure the record says passed by unanimous consent — and it was
 * stored. Nothing compared a number in a summary with the record.
 *
 * WHY NOT A LIST OF TALLY PHRASINGS. The first version recognised a tally by
 * its written forms, one list per language ("98 to 0", "98 a 0", "98 votos
 * contra 0", …). Six reviews in a row each found a form read in one language
 * and not the other, or a true sentence refused in one language only. Two
 * lists of phrasings cannot be made to agree, so there are none.
 *
 * THE RULE, two parts, and neither reads a word of either language:
 *   1. GROUNDED. Every whole number from 0 to 435 in the English text must be
 *      a number the record the summary was written from holds
 *      (numberGrounding below). The Spanish text is held to the same set by
 *      the same code, so a number one language may state the other may too.
 *   2. THE SAME NUMBERS. The Spanish text must state exactly the whole
 *      numbers from 0 to 435 the English states, as many times each
 *      (numberParity below). A Spanish summary that drops, changes or adds
 *      one is refused.
 * A refused summary takes the existing path (rule 11): nothing is stored,
 * the previous revision stands, and a later run writes another.
 *
 * WHAT IS A NUMBER (statedNumbers). A run of the digits 0-9, read as one whole
 * number. A comma, a period, a no-break space (U+00A0) or a narrow no-break
 * space (U+202F) followed by exactly three digits is a thousands separator
 * and joins the run ("1,500", "1.500", "1 500" are each 1500); every other
 * character ends it ("77-22" is 77 and 22, "1.5" is 1 and 5, "119th" and
 * "119.º" are 119, "5(c)" is 5, "1:45" is 1 and 45). A plain space never
 * joins. Only a number from 0 to 435 is checked: no chamber has more
 * members, so a vote count is always in that range, and years, most bill
 * numbers and page numbers fall outside it.
 *
 * WHAT THE RECORD HOLDS (numberGrounding): the data the prompt was built
 * from, which is what the prompt printed plus two things it did not:
 *   - every number in each roll call handed to the prompt: the date, the
 *     roll number, the measure's number, the question and result as the
 *     chamber wrote them, the yea, nay, present and not-voting totals, and
 *     the same four for EVERY party group in its `totalsByParty`;
 *   - every number in each update handed to the prompt: the day, the
 *     measure's number, the record sentence (the chamber's own "Yea-Nay
 *     Vote. 77 - 22") for a record update, the outlet names for a press
 *     cluster;
 *   - every number in the identifier of each measure it printed a status
 *     for (the bill number and the Congress, "hconres-89-119");
 *   - the length of the summary window, which the prompt names ("LAST 14
 *     DAYS").
 * The two it holds that the prompt never printed: (1) the Congress number
 * (119), which comes from the measure's identifier ("hconres-89-119") while
 * the prompt prints only the label ("H. Con. Res. 89"); (2) the party
 * figures the prompt leaves out: partyTotalsPromptText
 * (lib/party-count-rule.mjs) prints only the groups PARTY_GROUP_NAME names
 * and drops a group with no members voting, and prints none at all while
 * PARTY_COUNTS is off, but numberGrounding takes every group in
 * `totalsByParty`. So the check is a little wider than the prompt: a number
 * from one of those two sources passes though the model was never shown it.
 * The prompt's own rule (state no number the record below does not print) is
 * the stricter of the two.
 * Not the prompt's own example ("by a recorded vote of 214 to 208 (Roll no.
 * 282)"): a number the model copies from an instruction is not the record's.
 *
 * WHAT IT REFUSES THAT IS TRUE. A number the record it was written from does
 * not hold is refused even when it is right: "needs 60 votes", "children 5 to
 * 17", "the Senate is split 53-47", "ruled 6-3", "COVID-19". The project's
 * rule is that the record is quoted, never narrated, and a summary is
 * written from that record alone; a refused summary costs one model call.
 * Part 2 refuses a pair whose Spanish writes in words a number the English
 * writes in digits ("3 measures" / "tres medidas"): the Spanish lacks a 3.
 * KNOWN ASYMMETRIES BETWEEN THE LANGUAGES, where a true pair is refused by
 * part 2 because the two languages write the same fact with different
 * digits or none:
 *   - 12-hour and 24-hour times: "5:30 p.m." states 5 and 30, "17:30" states
 *     17 and 30. A Spanish summary that writes the 24-hour time is refused.
 *   - "1" and "un": "1 not voting" states 1, "un senador no votó" states
 *     none. The same for "una", "uno", and any count Spanish writes as a
 *     word.
 * Both refuse (cost: one model call); neither lets a wrong number through.
 * The prompt asks for the same numbers, in digits, in both languages.
 * On 2026-11-11 no stored AI-written summary that carries its grounding
 * stated such a number (14 of 14 pass).
 *
 * WHAT IT CANNOT SEE, stated rather than papered over:
 *   - a number written in words: "ninety-eight to zero", "two-thirds", "dos
 *     tercios", "eleven votes short". Out of scope on purpose: the summaries
 *     write counts in digits, and words are not chased.
 *   - a number the record holds, used for something else: "passed 77 to 22"
 *     for a cloture vote of 77 to 22 on the same measure, or a party count of
 *     24 that is really the day of the month. It checks that each number is
 *     the record's, not that the sentence around it is. A small number is the
 *     most likely to be held by accident: every day of the month a printed
 *     date holds.
 *   - a number above 435: an invented bill number or year passes, in both
 *     languages alike. So does a pair written with a comma and no space
 *     ("220,204" reads as 220204, a thousands separator).
 *
 * A RECORD-ONLY REVISION (model RECORD_ONLY_MODEL) is not AI-written: it is
 * one fixed sentence filled in by scripts/moment-updates.mjs with the date of
 * the newest action on the measures (recordOnlyText), a date the revision
 * does not store. Part 1 does not apply to it; part 2 does.
 *
 * ON STORED REVISIONS the gate (checkMomentUpdates, `opts.rollCallsById`)
 * rebuilds the record from the revision's own grounding: its
 * `grounded_in.roll_calls`, the updates of its `grounded_in.update_ids`, and
 * the measures of its `grounded_in.vehicle_statuses`. data/votes.json keeps
 * a roll call it holds WITH its party totals as it is, but a roll call it
 * holds WITHOUT `totalsByParty` is fetched again and rewritten
 * (scripts/sync-votes.mjs isHeld, 2026-09-29). So the numbers the gate reads
 * are the numbers the prompt was built from, except that a roll call written
 * before its party totals were on file may have gained them since: the
 * stored check can only be wider than the collector's on that roll call,
 * never narrower. The 2026-09-29 back-fill re-read every roll call, so none
 * on file lacked them that day.
 *
 * RETENTION, AND WHY THE STORED CHECK IS WIDER THAN THE COLLECTOR'S. Updates
 * prune by age and by count (pruneEntry); revisions are kept by count, and
 * pruneEntry drops a pruned id from `grounded_in.update_ids`. So a number
 * the record held only through an update stops being held when that update
 * ages out, and a check that passed on the day it was written would fail
 * some 46 days later with no change to blame. Two things keep the stored
 * check from tightening with time:
 *   - it also accepts every number of every roll call the vote file holds on
 *     the question's measures at any date (`roll_calls_on_record`, and every
 *     roll call whose `bill` is one of its vehicles). Nothing in that set is
 *     pruned. The collector stays strict: it accepts only what its prompt
 *     printed.
 *   - a number no source holds is a VIOLATION only while retention cannot
 *     have dropped an update the revision was written from
 *     (groundingMayBePruned). After that it is a WARNING, never a guess.
 * Part 2 reads the stored text alone, which never changes, so it is enforced
 * on every stored revision.
 * ------------------------------------------------------------------ */

/** No chamber has more members than this; a bigger number is never a vote count. */
export const NUMBER_MAX = 435;

/**
 * The `model` of a revision that no model wrote (scripts/moment-updates.mjs
 * recordOnlyRevision, which imports this copy). lib/moment-updates.ts keeps
 * the page's copy; tests/settled-state.unit.spec.ts pins the two equal.
 */
export const RECORD_ONLY_MODEL = 'record-only';

/**
 * The collector's summary window: a revision is written from the updates of
 * its `as_of_day` and the SUMMARY_WINDOW_DAYS before it. It is
 * scripts/moment-updates.mjs's SUMMARY_WINDOW_DAYS, repeated here because a
 * lib module does not import the collector;
 * tests/moment-updates-text-gates.unit.spec.ts pins the two equal.
 */
export const STORED_SUMMARY_WINDOW_DAYS = 14;

/**
 * Can retention (pruneEntry) have dropped an update one stored revision was
 * written from? PURE. Returns why it can, or null when it cannot.
 *
 * pruneEntry drops an update when (1) its day is older than RETENTION_DAYS,
 * (2) its day holds more than HARD_DAY_CEILING updates, or (3) the moment
 * holds more than MAX_UPDATES_PER_MOMENT. The revision's window starts
 * STORED_SUMMARY_WINDOW_DAYS before its `as_of_day`, so (1) cannot have
 * touched it while `as_of_day` is within RETENTION_DAYS -
 * STORED_SUMMARY_WINDOW_DAYS days of today. (2) and (3) are read off what is
 * stored: a day or a moment AT its cap may have shed a row. A row collapsed
 * into its twin (collapseSameActions) keeps the same sentence, so it does not
 * count. Conservative by design: a "may" here costs a warning instead of a
 * violation, never the other way round.
 * @param {Record<string, any>} revision
 * @param {Record<string, any>[]} updates the moment's stored updates
 * @param {string} today ET day (YYYY-MM-DD)
 * @returns {string | null}
 */
export function groundingMayBePruned(revision, updates, today) {
  const asOf = revision?.as_of_day;
  if (typeof asOf !== 'string' || !DAY_RE.test(asOf)) return 'it has no as_of_day, so its window is unknown';
  const safeFrom = shiftDay(today, -(RETENTION_DAYS - STORED_SUMMARY_WINDOW_DAYS));
  if (asOf < safeFrom) {
    return `its window (from ${shiftDay(asOf, -STORED_SUMMARY_WINDOW_DAYS)}) reaches past the ${RETENTION_DAYS}-day retention`;
  }
  const list = Array.isArray(updates) ? updates : [];
  if (list.length >= MAX_UPDATES_PER_MOMENT) return `the question holds ${list.length} updates, the ${MAX_UPDATES_PER_MOMENT}-per-moment cap`;
  const windowFrom = shiftDay(asOf, -STORED_SUMMARY_WINDOW_DAYS);
  /** @type {Map<string, number>} */
  const perDay = new Map();
  for (const u of list) {
    if (typeof u?.day === 'string' && u.day >= windowFrom && u.day <= asOf) perDay.set(u.day, (perDay.get(u.day) ?? 0) + 1);
  }
  for (const [day, n] of perDay) {
    if (n >= HARD_DAY_CEILING) return `${day} holds ${n} updates, the ${HARD_DAY_CEILING}-per-day ceiling`;
  }
  return null;
}

/** A run of digits, with any thousands separator followed by exactly three digits (see WHAT IS A NUMBER). */
const NUMBER_RUN = /(?<![0-9])[0-9]+(?:[.,  ][0-9]{3}(?![0-9]))*/g;

/** Every whole number in one string, in order, in any range. PURE. */
function allNumbers(text) {
  return [...String(text ?? '').matchAll(NUMBER_RUN)].map((m) => Number(m[0].replace(/[^0-9]/g, '')));
}

/**
 * Every whole number from 0 to NUMBER_MAX one string states, in order, with
 * repeats. The same code for every language. PURE.
 * @param {string} text
 * @returns {number[]}
 */
export function statedNumbers(text) {
  return allNumbers(text).filter((n) => n <= NUMBER_MAX);
}

/**
 * The numbers the record holds, from the data a summary is written from (see
 * WHAT THE RECORD HOLDS). PURE; returns a sorted array so a caller can log it.
 * @param {{ rollCalls?: Record<string, any>[], updates?: Record<string, any>[], vehicles?: Iterable<string>, windowDays?: number }} [input]
 * @returns {number[]}
 */
export function numberGrounding({ rollCalls = [], updates = [], vehicles = [], windowDays } = {}) {
  /** @type {Set<number>} */
  const held = new Set();
  const take = (...values) => {
    for (const v of values) for (const n of allNumbers(v)) held.add(n);
  };
  for (const r of rollCalls ?? []) {
    if (!r || typeof r !== 'object') continue;
    take(r.date, r.roll, r.bill, r.question, r.result);
    for (const c of [r.totals, ...Object.values(r.totalsByParty ?? {})]) {
      if (c && typeof c === 'object') take(c.yea, c.nay, c.present, c.notVoting);
    }
  }
  for (const u of updates ?? []) {
    if (!u || typeof u !== 'object') continue;
    take(u.day, u.vehicle);
    if (u.class === 'press_cluster') take(...(u.source?.outlet_names ?? []));
    else take(u.record?.action_text);
  }
  for (const slug of vehicles ?? []) take(slug);
  if (Number.isInteger(windowDays)) held.add(/** @type {number} */ (windowDays));
  return [...held].sort((a, b) => a - b);
}

/**
 * Every number from 0 to NUMBER_MAX one string states that `grounding` does
 * not hold, once each, in the order stated. With no grounding (null /
 * undefined) nothing is checked: the caller does not know what the text was
 * written from. PURE.
 * @param {string} text
 * @param {number[] | null | undefined} grounding
 * @returns {number[]}
 */
export function unheldNumbers(text, grounding) {
  if (!grounding) return [];
  const held = new Set(grounding);
  return [...new Set(statedNumbers(text).filter((n) => !held.has(n)))];
}

/**
 * Part 2: does the Spanish state the same numbers from 0 to NUMBER_MAX as the
 * English, as many times each? Returns what one states and the other does
 * not, as sorted lists with repeats; both empty when they agree. PURE.
 * @param {string} en
 * @param {string} es
 * @returns {{ onlyEn: number[], onlyEs: number[] }}
 */
export function numberParity(en, es) {
  /** @type {Map<number, number>} */
  const balance = new Map();
  for (const n of statedNumbers(en)) balance.set(n, (balance.get(n) ?? 0) + 1);
  for (const n of statedNumbers(es)) balance.set(n, (balance.get(n) ?? 0) - 1);
  const onlyEn = [];
  const onlyEs = [];
  for (const [n, d] of [...balance].sort((a, b) => a[0] - b[0])) {
    for (let i = 0; i < Math.abs(d); i++) (d > 0 ? onlyEn : onlyEs).push(n);
  }
  return { onlyEn, onlyEs };
}

/**
 * Part 2 as a failure message, or null when the two agree. One wording for
 * the collector and the gate.
 * @param {string} en
 * @param {string} es
 * @returns {string | null}
 */
export function numberParityFailure(en, es) {
  const { onlyEn, onlyEs } = numberParity(en, es);
  if (onlyEn.length === 0 && onlyEs.length === 0) return null;
  const list = (xs) => (xs.length ? xs.join(', ') : 'none');
  return `the English and the Spanish state different numbers — only in the English: ${list(onlyEn)}; only in the Spanish: ${list(onlyEs)}`;
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
 * @param {{ now?: number, fileBytes?: number, pressOutletAdmits?: (domain: string, at: { on: string }) => boolean, pressOutletRated?: (domain: string) => boolean, rollCallsById?: Map<string, Record<string, any>> | Record<string, Record<string, any>> }} [opts]
 *   `pressOutletAdmits` is the outlet floor's `admits` (lib/press-outlets.mjs,
 *   owner ruling 2026-09-26). When supplied, every outlet a stored
 *   press_cluster names must pass it — AllSides-rated, or on the owner's
 *   allowlist ON THE ET DAY THE UPDATE WAS RECORDED (`on`, from its
 *   `recorded_at`). That is the list as it stood when the collector named the
 *   outlet, so an allowlist trial ending never fails the press updates it was
 *   part of, and the only thing that can is an edit that un-approves a day
 *   already published. scripts/check-moment-updates.mjs always supplies it; it
 *   is an option only so this module keeps its one import and the fixture
 *   suites that predate the floor keep their call shape.
 *   `pressOutletRated` is the floor's `isRated`. When supplied, a stored
 *   press_cluster must name at least ONE rated outlet: an allowlisted outlet
 *   carries no lean, so a cluster of allowlisted outlets alone would carry no
 *   balance evidence at all. check-moment-updates.mjs supplies it too.
 *   `rollCallsById` (2026-10-06) is data/votes.json's rollCalls by id (a Map
 *   or a plain object). When supplied, every number from 0 to 435 a stored
 *   AI-written revision states must be one its grounding, or a roll call on
 *   its question's measures, holds (part 1 of the NUMBER lint and its
 *   RETENTION note, above). check-moment-updates.mjs supplies it; fixture
 *   suites that predate it keep their call shape and skip part 1. Part 2
 *   (the Spanish states the English's numbers) runs on every revision.
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
    /** id -> class, so the absence check on revisions can tell a cited record
     *  event from a cited press cluster. */
    /** @type {Map<string, string>} */
    const classById = new Map(
      updates.filter((u) => u && typeof u === 'object').map((u) => [String(u.id), String(u.class)]),
    );
    /** id -> the stored update, for rebuilding what a revision's prompt
     *  printed (part 1 of the NUMBER lint). */
    /** @type {Map<string, Record<string, any>>} */
    const updateById = new Map(updates.filter((u) => u && typeof u === 'object').map((u) => [String(u.id), u]));
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
        const expected = VERBATIM_DAY_SOURCE_KINDS.includes(u.source?.kind)
          ? String(u.occurred_at).slice(0, 10)
          : etDay(u.occurred_at);
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
        if (typeof opts.pressOutletAdmits === 'function') {
          // Judged by the day the update was WRITTEN — the same ET day the
          // collector asked the floor about (pressClusterToCandidate) — never
          // by today's list. An unparseable recorded_at (already a violation
          // above) asks about no day at all, which admits rated outlets only.
          const on = Number.isFinite(recordedMs) ? etDay(u.recorded_at) : '';
          const refused = outlets.filter((o) => !opts.pressOutletAdmits(o, { on }));
          if (refused.length) {
            violations.push(
              `${up}.source.outlets: names ${refused.join(', ')} — a press update names only AllSides-rated outlets (or an outlet on the owner's allowlist on the day it was recorded, ${on || 'unknown'}), never an unrated one`,
            );
          }
        }
        if (typeof opts.pressOutletRated === 'function' && outlets.length && !outlets.some((o) => opts.pressOutletRated(o))) {
          violations.push(
            `${up}.source.outlets: none of ${outlets.join(', ')} is AllSides-rated — a press update needs at least one rated outlet; allowlisted outlets carry no lean and cannot stand alone`,
          );
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

    // ---- summary attempt counter (2026-09-25) -------------------------
    // Optional; the collector's spend bound for summary calls in both modes.
    if (entry.summary_attempts !== undefined) {
      const a = entry.summary_attempts;
      if (!a || typeof a !== 'object' || Array.isArray(a) || !DAY_RE.test(String(a.day)) || !Number.isInteger(a.count) || a.count < 0) {
        violations.push(`${at('summary_attempts')}: must be { day: "YYYY-MM-DD", count: a non-negative integer }`);
      } else if (nowDay && a.day > nowDay) {
        violations.push(`${at('summary_attempts')}.day: ${a.day} is in the future`);
      }
    }

    // ---- summary refusal counter (2026-11-12) --------------------------
    // Optional; the collector's alarm counter (SUMMARY_REFUSAL_ALARM_RUNS).
    if (entry.summary_refusals !== undefined) {
      const problem = summaryRefusalsProblem(entry.summary_refusals, nowDay);
      if (problem) violations.push(`${at('summary_refusals')}${problem}`);
    }

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
          // Part 2 of the NUMBER lint: the stored text never changes, so it
          // is enforced on every revision, whoever wrote it.
          if (isNonEmptyString(r.text.en) && isNonEmptyString(r.text.es)) {
            const parity = numberParityFailure(r.text.en, r.text.es);
            if (parity) violations.push(`${rp}.text.es: ${parity}`);
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
          // The status key each measure was described by (2026-09-29; see
          // statusKeyChanges). OPTIONAL: a revision written before it existed
          // has none. That revision is still valid, and the next one the
          // collector writes carries the field. When present, it covers
          // exactly the measures in vehicle_statuses, and each key is a
          // reading of that measure's raw status.
          if (grounded.vehicle_status_keys !== undefined) {
            const keys = grounded.vehicle_status_keys;
            if (!keys || typeof keys !== 'object' || Array.isArray(keys) || Object.keys(keys).length === 0) {
              violations.push(`${rp}.grounded_in.vehicle_status_keys: must be a non-empty { slug: status key } map`);
            } else if (vs && typeof vs === 'object' && !Array.isArray(vs)) {
              for (const [slug, key] of Object.entries(keys)) {
                if (!Object.hasOwn(vs, slug)) {
                  violations.push(`${rp}.grounded_in.vehicle_status_keys: "${slug}" has no status in grounded_in.vehicle_statuses`);
                } else if (typeof key !== 'string' || !isStatusReading(vs[slug], key)) {
                  violations.push(`${rp}.grounded_in.vehicle_status_keys: ${JSON.stringify(key)} is not a reading of "${slug}"'s status "${vs[slug]}"`);
                }
              }
              for (const slug of Object.keys(vs)) {
                if (!Object.hasOwn(keys, slug)) {
                  violations.push(`${rp}.grounded_in.vehicle_status_keys: missing "${slug}", which grounded_in.vehicle_statuses holds`);
                }
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
          // The roll calls the summary was handed (data/votes.json ids). Its
          // PRESENCE is also the marker of a revision written by a collector
          // that knew about the absence lint (2026-09-25) — see below.
          if (grounded.roll_calls !== undefined) {
            if (!Array.isArray(grounded.roll_calls)) {
              violations.push(`${rp}.grounded_in.roll_calls: must be an array of roll-call ids`);
            } else {
              for (const rid of grounded.roll_calls) {
                if (!ROLL_CALL_ID_RE.test(String(rid))) {
                  violations.push(`${rp}.grounded_in.roll_calls: ${JSON.stringify(rid)} is not a roll-call id (h|s-CONGRESS-SESSION-ROLL)`);
                }
              }
            }
          }
          // Every roll call data/votes.json held on the question's measures,
          // at ANY date, when the revision was written (2026-09-27, SY-23) —
          // the count the roll-call absence exemption reads. Absent means the
          // collector did not vouch for it, and then nothing is exempt.
          if (grounded.roll_calls_on_record !== undefined) {
            if (!Array.isArray(grounded.roll_calls_on_record)) {
              violations.push(`${rp}.grounded_in.roll_calls_on_record: must be an array of roll-call ids`);
            } else {
              for (const rid of grounded.roll_calls_on_record) {
                if (!ROLL_CALL_ID_RE.test(String(rid))) {
                  violations.push(`${rp}.grounded_in.roll_calls_on_record: ${JSON.stringify(rid)} is not a roll-call id (h|s-CONGRESS-SESSION-ROLL)`);
                }
              }
              // The window's roll calls are a subset of every roll call on the
              // measures; a revision that says otherwise was not written by
              // this collector, and its exemption count cannot be trusted.
              const onRecord = new Set(grounded.roll_calls_on_record.map(String));
              for (const rid of Array.isArray(grounded.roll_calls) ? grounded.roll_calls : []) {
                if (!onRecord.has(String(rid))) {
                  violations.push(`${rp}.grounded_in.roll_calls_on_record: missing ${JSON.stringify(rid)}, which grounded_in.roll_calls holds — every roll call in the window is also on the record`);
                }
              }
            }
          }

          // THE ABSENCE LINT, on what is stored. A revision that says nothing
          // happened while its own grounding holds a vote or record event is
          // false on its face. ENFORCED only on revisions carrying
          // `grounded_in.roll_calls` — the collector that writes that field is
          // the one that runs the lint before storing, so a violation here is
          // a real regression. Revisions written before it existed are
          // history (what we said, and when) and are never rewritten; the
          // CURRENT one is still flagged as a warning so a false "where it
          // stands" on the page is seen by a human.
          const eventIds = Array.isArray(grounded.update_ids)
            ? grounded.update_ids.filter((uid) => RECORD_BEARING_CLASSES.includes(classById.get(uid)))
            : [];
          const rolls = Array.isArray(grounded.roll_calls) ? grounded.roll_calls : [];
          if ((eventIds.length > 0 || rolls.length > 0) && r.text && typeof r.text === 'object') {
            // The stored count of every roll call on the measures, any date —
            // the SAME number the collector's lint saw (see ROLL_CALL_ABSENCE).
            // NOT grounded_in.roll_calls: that is the summary window only, and
            // "no recorded vote" is false over a measure whose recorded vote
            // is older than the window. Unknown when the field is absent, and
            // then nothing is exempt.
            const rollCallsOnRecord = Array.isArray(grounded.roll_calls_on_record) ? grounded.roll_calls_on_record.length : undefined;
            for (const lang of ['en', 'es']) {
              const hits = absenceClaims(r.text[lang], lang, { rollCallsOnRecord });
              if (hits.length === 0) continue;
              const msg = `${rp}.text.${lang}: absence claim "${hits[0]}" over a grounding that holds ${eventIds.length} record event(s) and ${rolls.length} roll call(s)`;
              if (Array.isArray(grounded.roll_calls)) violations.push(msg);
              else if (i === revisions.length - 1) warnings.push(`${msg} (written before the absence lint existed; the next revision replaces it)`);
            }
          }

          // PART 1 OF THE NUMBER LINT, on what is stored (see the NUMBER
          // section and its RETENTION note). The record is the revision's own
          // grounding — the roll calls, updates and measures its prompt
          // printed — widened by every roll call the vote file holds on the
          // question's measures at any date, so that it never shrinks as
          // retention prunes updates. Only where it can be built: the revision
          // carries `grounded_in.roll_calls` (the collector's marker, as
          // above), a model wrote it (not RECORD_ONLY_MODEL), and the caller
          // supplied the vote file. A roll call the vote file no longer holds
          // leaves the record unknown: a warning, never a guess. A number
          // nothing holds is a violation while retention cannot have dropped
          // an update the revision was written from, and a warning after.
          if (opts.rollCallsById && Array.isArray(grounded.roll_calls) && r.model !== RECORD_ONLY_MODEL && r.text && typeof r.text === 'object') {
            const byId = opts.rollCallsById;
            const lookup = (rid) => (byId instanceof Map ? byId.get(String(rid)) : byId[String(rid)]);
            const unknown = grounded.roll_calls.filter((rid) => !lookup(rid));
            if (unknown.length > 0) {
              warnings.push(`${rp}: numbers not checked — data/votes.json no longer holds ${unknown.map(String).join(', ')}, which grounded_in.roll_calls names`);
            } else {
              /** @type {Map<string, Record<string, any>>} */
              const rolls = new Map(grounded.roll_calls.map((rid) => [String(rid), lookup(rid)]));
              for (const rid of Array.isArray(grounded.roll_calls_on_record) ? grounded.roll_calls_on_record : []) {
                const rc = lookup(rid);
                if (rc) rolls.set(String(rid), rc);
              }
              for (const rc of byId instanceof Map ? byId.values() : Object.values(byId)) {
                if (rc && momentVehicles.has(rc.bill) && rc.id !== undefined) rolls.set(String(rc.id), rc);
              }
              const numbers = numberGrounding({
                rollCalls: [...rolls.values()],
                updates: (Array.isArray(grounded.update_ids) ? grounded.update_ids : []).map((uid) => updateById.get(String(uid))).filter(Boolean),
                vehicles: Object.keys(grounded.vehicle_statuses ?? {}),
                windowDays: STORED_SUMMARY_WINDOW_DAYS,
              });
              const mayBePruned = groundingMayBePruned(r, updates, nowDay);
              for (const lang of ['en', 'es']) {
                for (const n of unheldNumbers(r.text[lang], numbers)) {
                  const msg = `${rp}.text.${lang}: number "${n}" that its grounding does not hold (${grounded.roll_calls.length} roll call(s) in its window, ${rolls.size} on its measures, ${(grounded.update_ids ?? []).length} update(s) cited)`;
                  if (mayBePruned) warnings.push(`${msg} — not enforced: retention may have dropped an update it was written from (${mayBePruned})`);
                  else violations.push(msg);
                }
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
