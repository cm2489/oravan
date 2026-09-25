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
 *   3. an update was recorded after the last revision was generated;
 *   4. the last revision is older than SUMMARY_REANCHOR_DAYS.
 *
 * THE FLAP GUARD (2026-09-25). A status that goes A→B→A inside two days is
 * the pipeline correcting itself, not the issue moving — sjres-185-119 went
 * floor_vote→committee→floor_vote, and s-4668-119 read `committee` for one
 * night (2026-09-23) before #279 fixed the classifier. Each leg bought a paid
 * Sonnet rewrite, and the middle one published "is in committee" over a bill
 * the Senate was voting on. So, per `opts`:
 *   - a status that REVERTS a change made within FLAP_WINDOW_HOURS
 *     (revertingSlugs) is not a trigger;
 *   - a status the bill's own status sentence does not support
 *     (`opts.unsupported`, computed by the runner as
 *     status !== mapStatus(statusBasisText(bill))) is not a trigger;
 *   - a `status_change` update that is one half of a flap
 *     (flapStatusChangeIds), or that sits on a reverting/unsupported vehicle,
 *     does not count as "an update recorded after the revision".
 * Every other trigger is unchanged, and so is every caller that passes no
 * `opts` beyond the flap pair itself.
 *
 * @param {Record<string, any>} entry
 * @param {Record<string, string>} vehicleStatuses current slug -> status
 * @param {Date|string|number} [now]
 * @param {{ unsupported?: Set<string> }} [opts]
 * @returns {boolean}
 */
export function summaryNeedsRefresh(entry, vehicleStatuses = {}, now = Date.now(), opts = {}) {
  return summaryRefreshReason(entry, vehicleStatuses, now, opts) !== null;
}

/** The flap window: a reversal inside this many hours is not movement. */
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
 * Why this summary needs regenerating, as a short log string — or null when
 * nothing moved. summaryNeedsRefresh is this, as a boolean.
 * @param {Record<string, any>} entry
 * @param {Record<string, string>} vehicleStatuses
 * @param {Date|string|number} [now]
 * @param {{ unsupported?: Set<string> }} [opts]
 * @returns {string|null}
 */
export function summaryRefreshReason(entry, vehicleStatuses = {}, now = Date.now(), opts = {}) {
  const revisions = entry?.summary_revisions ?? [];
  const last = revisions[revisions.length - 1];
  if (!last) return 'first summary';

  const unsupported = opts?.unsupported ?? new Set();
  const reverting = revertingSlugs(entry, vehicleStatuses, now);
  const quiet = (slug) => reverting.has(slug) || unsupported.has(slug);

  const grounded = last.grounded_in?.vehicle_statuses ?? {};
  for (const [slug, status] of Object.entries(vehicleStatuses ?? {})) {
    if (grounded[slug] !== status && !quiet(slug)) return `status ${slug}`;
  }

  const generatedAt = Date.parse(last.generated_at);
  if (!Number.isFinite(generatedAt)) return 'unparseable generated_at';

  const flaps = flapStatusChangeIds(entry?.updates ?? []);
  for (const u of entry?.updates ?? []) {
    const recorded = Date.parse(u?.recorded_at);
    if (!Number.isFinite(recorded) || recorded <= generatedAt) continue;
    if (u?.class === 'status_change' && (flaps.has(u.id) || quiet(u.vehicle))) continue;
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
 * How many intraday "Where it stands" ATTEMPTS this entry has spent on one ET
 * day — model calls, successful or not — read off `entry.summary_attempts`
 * ({ day, count }), which scripts/moment-updates.mjs writes before each
 * intraday call. A revision count alone cannot bound spend: a rejected reply
 * stores nothing, so a model that keeps writing a rejected sentence would be
 * asked again on every landing. A counter from another day is simply stale
 * and reads as zero.
 * @param {Record<string, any>} entry
 * @param {string} day 'YYYY-MM-DD' (ET)
 * @returns {number}
 */
export function summaryAttemptsOnDay(entry, day) {
  const a = entry?.summary_attempts;
  return a && a.day === day && Number.isInteger(a.count) && a.count > 0 ? a.count : 0;
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
 * get exactly the two layers they always got.
 *
 * @param {string} text
 * @param {'en'|'es'} lang
 * @param {{ groundedEvents?: boolean }} [opts]
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
    for (const hit of absenceClaims(value, lang)) {
      failures.push(
        `absence claim "${hit}" over a record that is not empty — the grounding holds a vote or action in this window, so "nothing happened" is false`,
      );
    }
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
    // "no new votes", "no floor or committee action", "no committee markups",
    // "no votes, tallies, or roll-call numbers", "no activity".
    new RegExp(
      String.raw`${NO_WORD}\s+(?:(?:new|further|additional|other|recent|recorded|more|subsequent)\s+)?(?:(?:floor|committee|recorded|roll[- ]call|legislative)\s+)?(?:(?:or|and)\s+(?:floor|committee)\s+)?(?:votes?|vote counts?|tall(?:y|ies)|roll[- ]calls?|actions?|activity|activities|movement|changes?|scheduling|developments?|steps?|progress|markups?|amendments?|hearings?|notices?)\b`,
      'i',
    ),
    // "no … has been recorded / logged / appears in the record" — one clause.
    new RegExp(String.raw`${NO_WORD}[^.;:]{0,80}?\b(?:recorded|logged|reported|entered|appears?|shown|listed)\b`, 'i'),
    /\bnothing\b[^.;:]{0,40}?\b(?:moved|changed|happened|recorded|logged|new|reported|further)\b/i,
    /\bunchanged\b/i,
    /\b(?:has|have|had)\s+not\s+(?:moved|changed|advanced|budged)\b/i,
    /\b(?:stands?|stood|remains?|stays?|sits?)\s+(?:exactly\s+|just\s+)?where\s+(?:it|they)\s+(?:stood|was|were|sat)\b/i,
    /\bsame\s+(?:status|standing|place|position)\s+(?:today\s+)?as\b/i,
    /\b(?:has|have)\s+been\s+quiet\b/i,
  ],
  es: [
    // "sin cambios", "sin actividad", "sin movimiento", "sin ninguna acción",
    // "sin nada registrado".
    /\bsin\s+(?:ning[uú]n[ao]?\s+|nuev[oa]s?\s+|m[aá]s\s+|otr[oa]s?\s+)?(?:cambios?|actividad(?:es)?|movimientos?|acci[oó]n(?:es)?|votaci[oó]n(?:es)?|votos?|novedad(?:es)?|avances?|registros?|nada)(?![\p{L}])/iu,
    // "no se registraron", "no se ha registrado", "no se registró".
    /\bno\s+se\s+(?:ha\s+|han\s+|hab[ií]a\s+|hab[ií]an\s+)?(?:registr|movi|mov|produj|produc|report|anot|celebr|program)\p{L}*/iu,
    // "no aparecen en el registro", "no hay", "no hubo".
    /\bno\s+(?:hay|hubo|ha\s+habido|han\s+habido|aparecen?|constan?|muestran?|figuran?)(?![\p{L}])/iu,
    /\bnada\s+(?:se\s+ha\s+movido|ha\s+cambiado|nuevo|ha\s+ocurrido|se\s+ha\s+registrado)/iu,
    /\bning[uú]n[ao]?\s+(?:nuev[oa]\s+)?(?:votaci[oó]n|acci[oó]n|actividad|cambio|movimiento|voto|avance)/iu,
    /\b(?:sigue|siguen|permanece|permanecen|se\s+mantiene|se\s+mantienen)\s+(?:igual|exactamente\s+donde|sin\s+cambios)/iu,
    /\b(?:el|la)\s+mism[oa]\s+(?:estado|estatus|situaci[oó]n|posici[oó]n)\s+que\b/iu,
  ],
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every absence claim in one summary string, as the matched text (empty when
 * clean). The stale-placement phrase is removed first — see the section note.
 * @param {string} text
 * @param {'en'|'es'} lang
 * @returns {string[]}
 */
export function absenceClaims(text, lang) {
  let value = String(text ?? '');
  const exempt = STALE_PLACEMENT_PHRASE[lang];
  if (exempt) value = value.replace(new RegExp(escapeRe(exempt), 'gi'), ' ');
  const hits = [];
  for (const re of ABSENCE[lang] ?? []) {
    const m = value.match(re);
    if (m) hits.push(m[0].trim());
  }
  return hits;
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
    /** id -> class, so the absence check on revisions can tell a cited record
     *  event from a cited press cluster. */
    /** @type {Map<string, string>} */
    const classById = new Map(
      updates.filter((u) => u && typeof u === 'object').map((u) => [String(u.id), String(u.class)]),
    );
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

    // ---- intraday attempt counter (2026-09-25) ------------------------
    // Optional; the collector's spend bound for intraday summary calls.
    if (entry.summary_attempts !== undefined) {
      const a = entry.summary_attempts;
      if (!a || typeof a !== 'object' || Array.isArray(a) || !DAY_RE.test(String(a.day)) || !Number.isInteger(a.count) || a.count < 0) {
        violations.push(`${at('summary_attempts')}: must be { day: "YYYY-MM-DD", count: a non-negative integer }`);
      } else if (nowDay && a.day > nowDay) {
        violations.push(`${at('summary_attempts')}.day: ${a.day} is in the future`);
      }
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
            for (const lang of ['en', 'es']) {
              const hits = absenceClaims(r.text[lang], lang);
              if (hits.length === 0) continue;
              const msg = `${rp}.text.${lang}: absence claim "${hits[0]}" over a grounding that holds ${eventIds.length} record event(s) and ${rolls.length} roll call(s)`;
              if (Array.isArray(grounded.roll_calls)) violations.push(msg);
              else if (i === revisions.length - 1) warnings.push(`${msg} (written before the absence lint existed; the next revision replaces it)`);
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
