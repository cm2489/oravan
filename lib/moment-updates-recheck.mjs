/**
 * THE NIGHTLY RE-CHECK OF STORED UPDATE LINES AGAINST THE RECORD (owner,
 * 2026-11-14, answer 92 a): "A nightly re-check of every stored update text
 * against the record: a line the record no longer holds is corrected to the
 * record's words or marked withdrawn, and the run says so."
 *
 * WHY. Congress.gov edits its action list after first publishing it. Two rows
 * on the college-athletes question (S. 4668) quoted words its list no longer
 * held when read on 2026-09-30: u_d5eaf6d9 stored "The committee substitute
 * withdrawn by Voice Vote." for 2026-09-24, where the list says "The committee
 * substitute tabled by Voice Vote."; and u_682cca41 stored "Cloture motion on
 * amendment SA 6776 presented in Senate." for 2026-09-17, a line on no row of
 * the BILL's list on any date (whether the AMENDMENT's own list still holds it
 * is not known: see rule 6 below).
 *
 * Pure: the runner (scripts/moment-updates.mjs, nightly mode) fetches the
 * lists and passes them in; everything that decides lives here so
 * tests/moment-updates-recheck.unit.spec.ts can drive it with no network.
 * Imports only the gate (itself import-clean).
 *
 * ---------------------------------------------------------------------------
 * WHICH ROWS. Every stored row whose quote came from Congress.gov's action
 * record (source.kind `congress_actions`: the actions list, and the bill-detail
 * status diff, whose latestAction is a row of that same list), inside
 * retention. NOT a roll call read from the chamber's vote record (senate.gov,
 * the House Clerk), a floor-feed signal or a press cluster.
 *
 * HOW WORDS ARE COMPARED. A sentence's WORDS are its letters and digits, in
 * order, lower-cased, after the Library of Congress echo prefix ("Passed/
 * agreed to in Senate: ") and every trailing Congressional Record citation are
 * removed. So spacing, case, citations and punctuation (straight or curly
 * apostrophes, a hyphen or an en dash in a tally, "S.4668" or "S. 4668") are
 * never changes. When the words are equal the row is UNCHANGED and nothing is
 * written, not even the record's punctuation: the quote already holds the
 * record's words, a write would re-identify the row and move every citation of
 * it for no change in what it says, and a second night must write nothing.
 *
 * THE RULES, in order, for one row against the actions its bill's list holds
 * on the row's own date:
 *   0. SAME WORDS that day: unchanged (a withdrawn row is REINSTATED). SAME
 *      WORDS ON ANOTHER DATE: left, with a warning (the record moved the
 *      action; this check does not re-date rows). Both come before every
 *      rewording rule, so a near-twin on the old day never wins over the
 *      row's own words elsewhere.
 *   1. SAME ROLL CALL. The row carries a roll call, and an action that day
 *      carries the same chamber and roll number (the record's recordedVotes,
 *      or "Record Vote Number: N" in its words). The row takes that action's
 *      words only when they are this vote's own sentence corrected: they
 *      differ from the stored words in digits, outcome words or "not" alone
 *      (a corrected tally or result; voteFrame), and no other stored row
 *      quotes them. The id does not change. Any other sentence carrying the
 *      number (a motion to reconsider the vote, say) is another action: left,
 *      with a warning. The chamber's own row is preferred to the Library of
 *      Congress echo; two different fitting sentences: left. A row whose roll
 *      number is on no action that day is left, with a warning: a vote's id is
 *      its roll number, so no rule below can tell it from another action, and
 *      it is never withdrawn on the bill's list alone.
 *   3. SAME ID. An action that day hashes to the row's own id (the id reads
 *      only the first 120 characters, so a long action edited near its end):
 *      the row is NEVER withdrawn. It takes the action's words only under
 *      rule 4's rewording test; otherwise it is left, with a warning.
 *   4. A REWORDING. Exactly one action that day is within reach of the row
 *      (at most 2 words added, removed or swapped, never more than a quarter of
 *      the sentence), it is no other stored row's action, and its words pass
 *      THE REWORDING TEST:
 *        the two sentences have the same number of words and differ in
 *        exactly ONE word, and both of those words are in the same OUTCOME
 *        CLASS below; no chamber says otherwise (where both name one), and no
 *        action code says otherwise (where both carry one).
 *      Every other word, every number, every name, "not", "no", "without",
 *      "House" and "Senate" stay exactly as they were. A word in no class
 *      (made, presented, considered, reported, ordered, …) is never swapped.
 *      Then the row takes the record's words: the earlier words and id are
 *      kept on it, and its old printed line is replaced (see recheckStore).
 *      An action within reach that fails the test, or two within reach: left,
 *      with a warning. Never withdrawn while something that day is that close.
 *   5. WITHDRAWN. Nothing that day is within reach, the words are on no date
 *      of the list, and the list holds at least one action on that day. The
 *      row is kept, marked `withdrawn_on`, and no longer printed.
 *   6. A ROW THAT NAMES AN AMENDMENT ("SA 6776", "S.Amdt. 6776", "H.Amdt. 12")
 *      is never withdrawn on the bill's list alone: an action on an amendment
 *      can move to the amendment's own record. The runner reads that list
 *      too, and it gets the same tests: the words that day (unchanged), the
 *      words on another date, or anything that day within reach (left, with
 *      a warning; nothing is rewritten from an amendment's list). Only a whole
 *      amendment list holding nothing like it lets the row be withdrawn; an
 *      amendment list not read leaves the row as it is.
 *   No action at all on the row's day while the list runs on both sides of it
 *   (a list missing a day): left, with a warning. Position is never used: an
 *   edit to the list is exactly what moves positions.
 *
 * HELD. A row whose new record words, quoted, fail the update lint (a
 * forecast phrase such as "expected to" is refused even inside a quote, and a
 * freshly collected action with such words is never stored at all) is HELD:
 * its record words and id are updated, it is hidden, and it is re-judged
 * against those newest words every night. The runner asks for a decode of
 * them every night; the first line that passes the lint is printed and the
 * row shows again. The run warns every night while a row is held, and
 * pipeline-health raises it on its standing issue.
 *
 * THE OUTCOME CLASSES, read from every word the record uses in
 * data/moment-updates.json and the saved Congress.gov lists (2026-11-14):
 *   carried ............ agreed, passed, invoked
 *   did not carry ...... rejected, failed
 *   set aside .......... withdrawn, tabled, fell
 * A swap inside one class changes how the record names what happened, never
 * which way it went. "withdrawn" → "tabled" (the committee substitute was set
 * aside, not adopted, either way) passes; "agreed to" → "rejected" crosses
 * carried / did not carry and fails; "invoked" → "not invoked" adds a word and
 * fails; "Passed Senate" → "Passed House" swaps a word in no class and fails.
 * That a set-aside word swaps for another is a judgement, written down here:
 * "withdrawn" (by its mover) and "tabled" (by a vote) are different
 * procedures, and the rule accepts the record's later word for the SAME
 * action only because everything else about it (date, chamber, code, every
 * other word, and no rival that day) is the same.
 *
 * THE GUARDS (rule 11: a wrong night from the source must never damage the
 * file).
 *   - A list is used only if it names the bill (or amendment) asked for, is
 *     whole (as many actions as its own pagination.count), is not empty, gives
 *     every action a date and is newest first. Otherwise nothing on it is
 *     judged that night.
 *   - A row dated after the newest action on its list is not judged.
 *   - The night is refused, every change of it unwritten, when more than
 *     RECHECK_MAX_CHANGES rows would change, or when EVERY checked row of one
 *     bill would change (however few), or when more than half of a bill's
 *     checked rows would (from 3 rows up). The run's error names each row.
 *   - THE ONE-NIGHT OVERRIDE: data/record-recheck-accept.json may name, for one
 *     ET night, the exact row ids a person has read and accepts; those rows are
 *     left out of the counts above on that night only. The runbook
 *     (docs/runbooks/record-recheck.md) says when to use it.
 * ---------------------------------------------------------------------------
 */
import {
  RETENTION_DAYS,
  actionChamber,
  citationFreeText,
  computeUpdateId,
  etDay,
  liveUpdates,
  normalizeText,
  shiftDay,
} from './moment-updates-gate.mjs';

/* ------------------------------------------------------------------ *
 * THE SWITCH (2026-11-14). One committed setting, changed only by a reviewed
 * one-line pull request, never by an environment variable:
 *
 *   'report' — REPORT ONLY. The nightly comparison runs exactly as in
 *              'apply' (every list check, guard and judgement), and then
 *              writes nothing to data/moment-updates.json: no corrected
 *              text, no new id, no `withdrawn_on`, no held row, no
 *              re-collection, no summary rewrite marked due, no use of the
 *              one-night accept file. It reports every row it would have
 *              changed and every row it would leave, with what the record
 *              holds now: a log line each, a table in the step summary, and
 *              data/record-recheck-report.json, which pipeline-health reads
 *              to raise an alarm.
 *   'apply'  — the nightly comparison changes stored rows as the rules below
 *              say, and still reports what it leaves.
 *
 * Shipped as 'report' (owner's answer 92 a is built, and switched on once an
 * independent check has passed the automatic correction).
 * ------------------------------------------------------------------ */
export const RECHECK_MODES = Object.freeze(['report', 'apply']);
/** @type {'report'|'apply'} */
export const RECHECK_MODE = 'report';

/** Where the nightly comparison keeps what it found, across nights (see nextRecheckReport). */
export const RECHECK_REPORT_PATH = 'data/record-recheck-report.json';
/** A bill not checked this many nights running raises an alarm (one or two flaky nights do not). */
export const RECHECK_UNCHECKED_ALARM_NIGHTS = 3;
/** Every list failing (0 rows checked while some are re-checkable) this many nights running raises an alarm. */
export const RECHECK_ZERO_CHECKED_ALARM_NIGHTS = 2;

/** The most words an action within reach may differ by (rule 4's reach). */
export const REWORD_MAX_WORDS = 2;

/**
 * The most rows one night may change, across every question, before every
 * change of the night is refused.
 *
 * READ FROM THE DATA, 2026-11-14: data/moment-updates.json holds 23 rows the
 * re-check reads, on 5 bills. Against Congress.gov's lists read 2026-09-30
 * (saved for 4 of those bills; 18 rows on or before those lists' newest day),
 * 2 differ from the bill's list: the two college-athletes rows above, the
 * whole backlog the owner's card found. A night that wants more than 4
 * changes is twice that backlog at once, which is what a source error looks
 * like, not the record being edited. Refusing costs one night; the run names
 * every row it held back, and the one-night override lets a person accept them.
 */
export const RECHECK_MAX_CHANGES = 4;
/** Above this share of one bill's checked rows changing at once, the night is refused. */
export const RECHECK_MAX_BILL_SHARE = 0.5;
/** The share guard applies from this many checked rows up. */
export const RECHECK_BILL_SHARE_MIN_ROWS = 3;
/** The every-row guard applies from this many checked rows up: a one-row bill is judged on its own. */
export const RECHECK_EVERY_ROW_MIN_ROWS = 2;

/** The outcome classes (see the header): a swap is allowed only inside one. */
export const OUTCOME_CLASSES = Object.freeze({
  carried: Object.freeze(['agreed', 'passed', 'invoked']),
  did_not_carry: Object.freeze(['rejected', 'failed']),
  set_aside: Object.freeze(['withdrawn', 'tabled', 'fell']),
});
const CLASS_OF = new Map(Object.entries(OUTCOME_CLASSES).flatMap(([k, ws]) => ws.map((w) => [w, k])));

/** The path of the one-night override list, relative to the repo root. */
export const RECHECK_ACCEPT_PATH = 'data/record-recheck-accept.json';

/** A sentence's words (see the header). */
export function recheckWords(text) {
  return normalizeText(citationFreeText(text)).match(/[a-z0-9]+/g) ?? [];
}

const sameWords = (a, b) => a.length === b.length && a.every((w, i) => w === b[i]);

/** Word-level edit distance (insert, delete, substitute one word) between two word lists. */
export function wordDistance(x, y) {
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

/** Is `to` within reach of `from` (rule 4's reach; not yet the rewording test)? */
export function withinReach(from, to) {
  const d = wordDistance(from, to);
  const budget = Math.min(REWORD_MAX_WORDS, Math.max(1, Math.floor(Math.max(from.length, to.length) / 4)));
  return d >= 1 && d <= budget;
}

/**
 * THE REWORDING TEST (rule 4): why `to` may not stand for `from`, or null when
 * it may. Word lists, as recheckWords returns them.
 * @param {string[]} from
 * @param {string[]} to
 * @returns {string|null}
 */
export function rewordingProblem(from, to) {
  if (sameWords(from, to)) return null;
  if (from.length !== to.length) return 'a word was added or removed';
  const diffs = from.map((w, i) => [w, to[i]]).filter(([a, b]) => a !== b);
  if (diffs.length !== 1) return `${diffs.length} words changed`;
  const [[a, b]] = diffs;
  const ca = CLASS_OF.get(a);
  const cb = CLASS_OF.get(b);
  if (!ca || !cb) return `the word ${a} → ${b} is not a swap between two outcome words`;
  if (ca !== cb) return `the word ${a} → ${b} changes which way it went (${ca} → ${cb})`;
  return null;
}

/** Is the stored row one the re-check reads? */
export function isRecheckable(update, retentionFloor) {
  return (
    update?.source?.kind === 'congress_actions' &&
    typeof update?.record?.action_text === 'string' &&
    update.record.action_text.trim() !== '' &&
    typeof update?.day === 'string' &&
    (!retentionFloor || update.day >= retentionFloor)
  );
}

/** slug -> { congress, type, number }, e.g. 's-4668-119' -> { 119, 's', 4668 }. */
function slugParts(slug) {
  const m = String(slug ?? '').match(/^([a-z]+)-(\d+)-(\d+)$/);
  return m ? { type: m[1], number: Number(m[2]), congress: Number(m[3]) } : null;
}

/**
 * The amendment a stored action names, as the key the runner fetches by
 * ("119-samdt-6776"), or null. Reads "SA 6776", "S.Amdt. 6776", "HA 12",
 * "H.Amdt. 12".
 */
export function amendmentNamed(text, congress) {
  const m = String(text ?? '').match(/\b(?:(S|H)\.\s?Amdt\.?\s?|(S|H)A\s)(\d+)\b/);
  if (!m || !congress) return null;
  const chamber = (m[1] ?? m[2]).toLowerCase();
  return `${congress}-${chamber}amdt-${Number(m[3])}`;
}

/**
 * Is a fetched action list fit to judge rows by? Null when it is, else why not.
 * `asked`: what was requested — { slug } for a bill, { amendment } for an
 * amendment key; the response's own `request` must name it.
 * @param {{ actions?: any[], total?: number|null, request?: Record<string, any>|null }|null|undefined} list
 * @param {{ slug?: string, amendment?: string }} [asked]
 * @returns {string|null}
 */
export function listProblem(list, asked = {}) {
  const actions = list?.actions;
  if (!Array.isArray(actions)) return 'the list was not fetched (a failed request, or a bill this run does not read)';
  const req = list.request ?? null;
  if (asked.slug) {
    const p = slugParts(asked.slug);
    if (!req || String(req.billType ?? '').toLowerCase() !== p?.type || Number(req.billNumber) !== p?.number || Number(req.congress) !== p?.congress) {
      return `the response does not name the bill asked for (${asked.slug}; it names ${req ? `${req.congress ?? '?'}-${req.billType ?? '?'}-${req.billNumber ?? '?'}` : 'none'})`;
    }
  }
  if (asked.amendment) {
    const [congress, type, number] = asked.amendment.split('-');
    const reqType = String(req?.amendmentType ?? req?.type ?? '').toLowerCase();
    if (!req || Number(req.amendmentNumber) !== Number(number) || Number(req.congress) !== Number(congress) || (reqType && reqType !== type)) {
      return `the response does not name the amendment asked for (${asked.amendment})`;
    }
  }
  if (actions.length === 0) return 'the list arrived empty';
  if (!Number.isInteger(list.total)) return 'the response does not say how many actions the list holds';
  if (actions.length !== list.total) return `the response holds ${actions.length} of the ${list.total} actions it says the list has`;
  const days = actions.map((a) => String(a?.actionDate ?? '').slice(0, 10));
  if (days.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) return 'an action in the list has no date';
  // The judgement reads each action's words: a list whose actions do not
  // carry them where they are expected (a renamed field) is not judged.
  const wordless = actions.filter((a) => typeof a?.text !== 'string' || !a.text.trim()).length;
  if (wordless) return `${wordless} of its ${actions.length} actions carry no words in "text" (a renamed or missing field)`;
  for (let i = 1; i < days.length; i++) if (days[i] > days[i - 1]) return 'the list is not newest first';
  return null;
}

/** The chamber a listed action belongs to, read the way a stored row's is. */
function listedChamber(action) {
  return actionChamber({ record: { action_text: action?.text, source_system: action?.sourceSystem?.name } });
}

/** The roll calls a listed action carries: "senate:243", from recordedVotes or its own words. */
function listedRolls(action) {
  const out = new Set();
  for (const rv of Array.isArray(action?.recordedVotes) ? action.recordedVotes : []) {
    const c = String(rv?.chamber ?? '').toLowerCase();
    if ((c === 'house' || c === 'senate') && Number.isInteger(Number(rv?.rollNumber))) out.add(`${c}:${Number(rv.rollNumber)}`);
  }
  const m = String(action?.text ?? '').match(/Record Vote Number:\s*(\d+)/i);
  const c = listedChamber(action);
  if (m && c) out.add(`${c}:${Number(m[1])}`);
  return out;
}

const isEcho = (action) => /library of congress/i.test(String(action?.sourceSystem?.name ?? ''));

/** One of the record's sentences, for a report: its words, its date, and (for an amendment's own list) the amendment. */
function sentence(l, source = null) {
  return { day: l.day, text: l.text, ...(source ? { source } : {}) };
}

/**
 * What the record holds, in words a person reads: Oravan's `note` first,
 * never quoted, then each of the record's sentences in its own quotation
 * marks, with its date (and, for an amendment's own list, which amendment)
 * OUTSIDE them. Rule 6: only the record's words go inside quotation marks.
 * `max`: quote at most that many, the ones nearest `near` (the stored words;
 * nearestSentences), and say outside the quotes how many more there are and
 * that every one is in the report file. A quotation is never cut short.
 * `md`: for GitHub markdown (quoteWords).
 * @param {string} note
 * @param {{ day: string, text: string, source?: string }[]} sentences
 * @param {{ md?: boolean, max?: number, near?: string }} [opts]
 */
export function renderRecord(note, sentences, { md = false, max = Infinity, near = '' } = {}) {
  const all = sentences ?? [];
  const shown = max < all.length ? nearestSentences(all, near, max) : all;
  const more = all.length - shown.length;
  const oneDay = new Set(all.map((x) => x.day)).size === 1;
  const list = shown.map((x) => `${quoteWords(x.text, { md })} (${x.day}${x.source ? `, amendment ${x.source}'s own list` : ''})`).join(', ');
  const tail = more > 0 ? `, and ${more} more action${more === 1 ? '' : 's'}${oneDay ? ' that day' : ''}; every one is in data/record-recheck-report.json` : '';
  return list ? `${note}: ${list}${tail}` : String(note ?? '');
}

/** How many of the record's sentences a line in a comment or step summary quotes (the report file keeps them all). */
export const RECHECK_SENTENCES_PER_LINE = 5;

/**
 * The `max` sentences nearest the stored words, shown in the record's own
 * order. Nearest, deterministically: the most distinct words in common with
 * the stored words (lower-cased, split on anything not a letter or digit);
 * a tie goes to the sentence earlier on the record's list (newest first).
 * @param {{ day: string, text: string, source?: string }[]} sentences
 * @param {string} near
 * @param {number} max
 */
export function nearestSentences(sentences, near, max) {
  const words = (t) => new Set(String(t ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const target = words(near);
  const scored = sentences.map((x, i) => ({ i, score: [...words(x.text)].filter((w) => target.has(w)).length }));
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const keep = new Set(scored.slice(0, max).map((s) => s.i));
  return sentences.filter((_, i) => keep.has(i));
}

/** Line breaks of every kind: each becomes one space wherever the words are shown (the one normalisation). */
const LINE_BREAK = /\r\n|[\n\r\u0085\u2028\u2029]/g;
/**
 * A quoted text GitHub would otherwise change or make ambiguous: a quotation
 * mark of its own, an @mention, an issue reference, an :emoji: code or a URL
 * scheme. Such a text is shown in a code span, where GitHub renders every
 * character as it is.
 */
const NEEDS_CODE_SPAN = /["“”@#]|:[a-z0-9_+-]+:|:\/\//i;

/**
 * The record's words (or the stored line's own words) in quotation marks, as
 * the reader must see them. Every line break becomes one space. `md` (a
 * GitHub comment, issue body or step summary): markdown and HTML specials are
 * escaped so they render as the characters they are, and a text that holds a
 * quotation mark (or an @, #, :code: or ://) is shown in a code span instead
 * of quotation marks, so its boundaries are never ambiguous. The report file
 * keeps the raw characters.
 * @param {string} text
 * @param {{ md?: boolean }} [opts]
 */
export function quoteWords(text, { md = false } = {}) {
  const t = String(text ?? '').replace(LINE_BREAK, ' ');
  if (!md) return `"${t}"`;
  if (NEEDS_CODE_SPAN.test(t)) {
    const run = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length));
    const fence = '`'.repeat(run + 1);
    const pad = /^`|`$/.test(t) || (/^ /.test(t) && / $/.test(t)) ? ' ' : '';
    return `${fence}${pad}${t}${pad}${fence}`;
  }
  return `"${t.replace(/[\\`*_[\]~]/g, '\\$&').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"`;
}

/**
 * A vote sentence with its tally and result taken out: every word but the
 * digits, the outcome words and "not". Two sentences with the same frame are
 * the same vote's sentence, its count or its result corrected.
 */
export function voteFrame(words) {
  return words.filter((w) => !/^\d+$/.test(w) && !CLASS_OF.has(w) && w !== 'not');
}

/** Is this row HELD: its record words stored, no printable line yet, so hidden? */
export function isHeld(update) {
  return Boolean(update?.withdrawn_on) && update?.rechecks?.at?.(-1)?.outcome === 'held';
}

/**
 * Judge every re-checkable row of ONE question on ONE bill. Pure.
 *
 * @param {string} momentId
 * @param {Record<string, any>[]} rows the question's stored rows on this bill (all of them; the
 *   judged ones are picked here, and every live one counts as "another row's action")
 * @param {{ actions: any[] }} list the bill's whole list (listProblem already null)
 * @param {{ retentionFloor: string, amendmentList?: (key: string) => ({ list: any, problem: string|null }|null) }} ctx
 * @returns {{ checked: number, results: { row: Record<string, any>, outcome: 'unchanged'|'reworded'|'withdrawn'|'reinstated'|'left', words?: string, how?: string, why?: string, index?: number }[] }}
 */
export function judgeBill(momentId, rows, list, ctx) {
  const listed = list.actions.map((a, index) => ({
    a,
    index,
    day: String(a.actionDate).slice(0, 10),
    words: recheckWords(a.text),
    text: String(a.text ?? '').trim(),
  }));
  const newestDay = listed[0].day;
  const oldestDay = listed[listed.length - 1].day;
  const eligible = rows.filter((u) => isRecheckable(u, ctx.retentionFloor) && u.day <= newestDay);
  // Rows dated after the list's newest action are not judged (the list does
  // not reach their day), but they are named: a list that lost its newest
  // action, night after night, is how a deleted action would otherwise go
  // unseen.
  const newer = rows.filter((u) => isRecheckable(u, ctx.retentionFloor) && u.day > newestDay && !u.withdrawn_on);
  // Words another live stored row already quotes, on its day: that row's action.
  const held = new Map();
  for (const u of liveUpdates(rows)) {
    if (!isRecheckable(u, null)) continue;
    const key = `${u.day}${recheckWords(u.record.action_text).join(' ')}`;
    held.set(key, (held.get(key) ?? 0) + 1);
  }
  const heldByOther = (row, l) => {
    const n = held.get(`${l.day}${l.words.join(' ')}`) ?? 0;
    const own = !row.withdrawn_on && sameWords(recheckWords(row.record.action_text), l.words) ? 1 : 0;
    return n - own > 0;
  };

  const results = [];
  for (const row of eligible) {
    const words = recheckWords(row.record.action_text);
    const sameDay = listed.filter((l) => l.day === row.day);
    // What the record holds that bears on this row, for the report: a LIST of
    // the record's own sentences (each with its date, and for an amendment's
    // own list its key, as separate fields), and a `note` in Oravan's words
    // that is never put inside quotation marks (renderRecord).
    const dayList = sameDay.map((l) => sentence(l));
    const live = (outcome, extra = {}) =>
      results.push({
        row,
        outcome,
        holds: dayList,
        note: sameDay.length ? 'that day the record lists' : `the list holds no action on ${row.day}`,
        ...extra,
      });

    // A row WITHDRAWN is only ever reinstated, when the record lists its own
    // words that day again. A row HELD (its record words stored but no line
    // printable yet; see recheckStore) is judged like any row against its
    // newest words, and stays held while they stand.
    if (row.withdrawn_on && !isHeld(row)) {
      live(sameDay.some((l) => sameWords(l.words, words)) ? 'reinstated' : 'unchanged');
      continue;
    }

    // Same words that day: unchanged.
    if (sameDay.some((l) => sameWords(l.words, words))) {
      live('unchanged');
      continue;
    }
    // The same words on ANOTHER date come before every rewording rule: the
    // record moved this action (this check does not re-date rows), and a
    // near-twin left on the old day is not it.
    const elsewhere = listed.find((l) => sameWords(l.words, words));
    if (elsewhere) {
      live('left', {
        why: sameDay.length
          ? `the record lists these words on ${elsewhere.day}, not ${row.day}`
          : `the list holds no action at all on ${row.day}, and the same words stand on ${elsewhere.day} — read as a list missing a day or a moved action, not a withdrawal`,
        holds: [sentence(elsewhere)],
        note: sameDay.length ? 'the record lists these words on another date' : `the list holds no action on ${row.day}; it lists these words on another date`,
      });
      continue;
    }

    // 1 · same roll call: the record's words are taken only when they are
    // this vote's own sentence corrected (they differ from the stored words in
    // digits, outcome words or "not" alone) and no other stored row quotes
    // them. Any other action that carries the roll number (a motion to
    // reconsider it, say) is another action: left, with a warning.
    const rc = row.record.roll_call;
    if (rc && rc.number !== undefined && rc.number !== null) {
      const key = `${String(rc.chamber ?? '').toLowerCase()}:${Number(rc.number)}`;
      const carrying = sameDay.filter((l) => listedRolls(l.a).has(key));
      if (carrying.length) {
        const fits = carrying.filter((l) => sameWords(voteFrame(l.words), voteFrame(words)) && !heldByOther(row, l));
        const own = fits.filter((l) => !isEcho(l.a));
        const pool = own.length ? own : fits;
        const distinct = [...new Map(pool.map((l) => [l.words.join(' '), l])).values()];
        if (distinct.length === 1) {
          live('reworded', { words: distinct[0].text, how: `same roll call (${key})`, index: distinct[0].index, holds: [sentence(distinct[0])], note: 'the record holds now' });
        } else if (distinct.length > 1) {
          live('left', { why: `${distinct.length} actions that day carry roll call ${key} with different words`, holds: distinct.map((l) => sentence(l)) });
        } else {
          live('left', {
            why: `roll call ${key} is on that day's list only in another sentence, which differs from this vote's own sentence beyond its tally or result, or which another stored row quotes`,
            holds: carrying.map((l) => sentence(l)),
          });
        }
        continue;
      }
      // No action that day carries the roll number. A vote's id is its roll
      // number, not its words, so no other rule can tell it apart; and the
      // chamber's own vote record (data/votes.json) still holds the vote. It
      // is never withdrawn on the bill's list: left, with a warning.
      live('left', { why: `roll call ${key} is not on that day's list; a recorded vote is never withdrawn on the bill's list alone` });
      continue;
    }

    const chamber = actionChamber(row);
    const code = row.record.action_code ?? null;
    const agrees = (l) => {
      const c = listedChamber(l.a);
      if (chamber && c && c !== chamber) return false;
      if (code && l.a.actionCode && String(l.a.actionCode) !== String(code)) return false;
      return true;
    };

    // 3 · same id (an edit past the id's first 120 characters)
    const sameId = sameDay.filter((l) => computeUpdateId(momentId, { ...row, record: { ...row.record, action_text: l.text } }) === row.id);
    if (sameId.length) {
      const ok = sameId.filter((l) => agrees(l) && !heldByOther(row, l) && !rewordingProblem(words, l.words));
      if (sameId.length === 1 && ok.length === 1) live('reworded', { words: ok[0].text, how: 'same id', index: ok[0].index, holds: [sentence(ok[0])], note: 'the record holds now' });
      else live('left', { why: `an action that day still carries this row's id, but its words changed beyond a rewording (${rewordingProblem(words, sameId[0].words) ?? 'more than one such action, or another row quotes it'})`, holds: sameId.map((l) => sentence(l)) });
      continue;
    }

    // 4 · a rewording
    const reach = sameDay.filter((l) => !heldByOther(row, l) && withinReach(words, l.words));
    if (reach.length > 1) {
      live('left', { why: `${reach.length} actions that day are within reach of it`, holds: reach.map((l) => sentence(l)) });
      continue;
    }
    if (reach.length === 1) {
      const [l] = reach;
      const problem = !agrees(l) ? 'the chamber or action code differs' : rewordingProblem(words, l.words);
      if (problem) live('left', { why: `the nearest action that day is not a rewording of it: ${problem}`, holds: [sentence(l)], note: 'the nearest action that day is' });
      else live('reworded', { words: l.text, how: 'a rewording', index: l.index, holds: [sentence(l)], note: 'the record holds now' });
      continue;
    }

    // 5 / 6 · gone from that day
    if (sameDay.length === 0) {
      live('left', {
        why:
          row.day > oldestDay
            ? `the list holds no action at all on ${row.day} while it runs on both sides of it — read as a list missing a day, not a withdrawal`
            : `the list holds no action on ${row.day}`,
      });
      continue;
    }
    const amendment = amendmentNamed(row.record.action_text, slugParts(row.vehicle)?.congress);
    if (amendment) {
      const got = ctx.amendmentList?.(amendment) ?? null;
      if (!got || got.problem) {
        live('left', {
          why: `it names amendment ${amendment}, and the action may have moved to the amendment's own record; that list was not usable (${got?.problem ?? 'not read'})`,
        });
        continue;
      }
      // The amendment's own list gets the same tests the bill's got: its
      // words that day (unchanged), its words on another date, or anything
      // that day within reach of them, all mean the record may still hold it:
      // left, with a warning. Only an amendment list that holds nothing like
      // it lets the row be withdrawn.
      const own = got.list.actions.map((a) => ({ day: String(a.actionDate).slice(0, 10), words: recheckWords(a.text), text: String(a.text ?? '').trim() }));
      if (own.some((a) => a.day === row.day && sameWords(a.words, words))) {
        live('unchanged', { how: `held by amendment ${amendment}'s own record` });
        continue;
      }
      const there = own.find((a) => sameWords(a.words, words));
      if (there) {
        live('left', { why: `amendment ${amendment}'s own record lists these words on ${there.day}, not ${row.day}`, holds: [sentence(there, amendment)], note: "the amendment's own record lists these words on another date" });
        continue;
      }
      const close = own.filter((a) => a.day === row.day && withinReach(words, a.words));
      if (close.length) {
        live('left', { why: `amendment ${amendment}'s own record lists something close that day; the re-check does not rewrite from an amendment's list`, holds: close.map((a) => sentence(a, amendment)), note: "that day the amendment's own record lists" });
        continue;
      }
    }
    // `holds` stays empty: the record no longer holds these words, and only
    // the record's words ever go inside a quote. What the record lists that
    // day goes in `how`, each sentence quoted on its own.
    live('withdrawn', {
      how: amendment ? `on neither the bill's list nor amendment ${amendment}'s` : "on no date of the bill's list",
      holds: dayList,
      note: 'the record no longer holds it; that day it lists',
    });
  }

  // Two rows taking one action: neither is the one. Left.
  const takers = new Map();
  for (const r of results) if (r.outcome === 'reworded') takers.set(r.index, (takers.get(r.index) ?? 0) + 1);
  for (const r of results) {
    if (r.outcome === 'reworded' && takers.get(r.index) > 1) {
      r.outcome = 'left';
      r.why = `${takers.get(r.index)} stored rows would take the same action`;
      delete r.words;
    }
  }
  return { checked: eligible.length, results, newer: newer.map((row) => ({ row, newest: newestDay })) };
}

/**
 * The amendments the stored rows name (only rows the re-check reads), so the
 * runner knows which amendment lists to fetch. Pure.
 * @param {Record<string, any>} store
 * @param {{ now?: Date|string|number }} [opts]
 * @returns {string[]} keys like "119-samdt-6776"
 */
export function amendmentsNamedInStore(store, { now = Date.now() } = {}) {
  const floor = shiftDay(etDay(now), -RETENTION_DAYS);
  const out = new Set();
  for (const [k, e] of Object.entries(store ?? {})) {
    if (k === '_meta') continue;
    for (const u of e?.updates ?? []) {
      if (!isRecheckable(u, floor)) continue;
      const a = amendmentNamed(u.record.action_text, slugParts(u.vehicle)?.congress);
      if (a) out.add(a);
    }
  }
  return [...out].sort();
}

/**
 * What is wrong with the one-night override file, or [] when it is absent or
 * well-formed: { accept: [{ night: "YYYY-MM-DD", ids: ["u_…", …], why: "…" }] }.
 * @param {unknown} obj
 * @returns {string[]}
 */
export function acceptListProblems(obj) {
  if (obj === undefined || obj === null) return [];
  const out = [];
  if (typeof obj !== 'object' || Array.isArray(obj) || !Array.isArray(obj.accept)) return [`${RECHECK_ACCEPT_PATH}: must be { "accept": [ … ] }`];
  obj.accept.forEach((e, i) => {
    const at = `${RECHECK_ACCEPT_PATH} accept[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return out.push(`${at}: must be an object`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.night))) out.push(`${at}.night: must be the ET night it applies to, YYYY-MM-DD`);
    if (!Array.isArray(e.ids) || e.ids.length === 0 || e.ids.some((id) => !/^u_[0-9a-f]{8}$/.test(String(id)))) {
      out.push(`${at}.ids: must be a non-empty list of row ids (u_ + 8 hex), exactly as the refused run named them`);
    }
    if (typeof e.why !== 'string' || e.why.trim().length < 10) out.push(`${at}.why: must say, in a sentence, why these rows are accepted`);
  });
  return out;
}

/**
 * Read the override file's TEXT: { value, problems }. Text that is not JSON is
 * a problem that names the file and the fix, never a raw SyntaxError.
 * @param {string} text
 */
export function parseAcceptFile(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return {
      value: undefined,
      problems: [
        `${RECHECK_ACCEPT_PATH}: is not valid JSON (${e.message}) — fix it to the shape { "accept": [ { "night": "YYYY-MM-DD", "ids": ["u_…"], "why": "…" } ] } (docs/runbooks/record-recheck.md), or delete the file`,
      ],
    };
  }
  return { value, problems: acceptListProblems(value) };
}

/** The row ids accepted for `night` (an ET day), or an empty set. Malformed lists accept nothing. */
export function acceptedIds(obj, night) {
  if (acceptListProblems(obj).length || !obj) return new Set();
  return new Set(obj.accept.filter((e) => e.night === night).flatMap((e) => e.ids));
}

/**
 * Each bill's latest action from data/bills.json, flagged `shared` when the
 * same sentence (its words) is another bill's latest action too. Pure.
 * @param {Iterable<Record<string, any>>} bills data/bills.json's records
 * @returns {Map<string, { date: string|null, text: string|null, shared: boolean }>}
 */
export function latestActionsBySlug(bills) {
  const all = [...(bills ?? [])];
  const count = new Map();
  for (const b of all) {
    const w = recheckWords(b?.last_action_text ?? '').join(' ');
    if (w) count.set(w, (count.get(w) ?? 0) + 1);
  }
  return new Map(
    all.map((b) => {
      const w = recheckWords(b?.last_action_text ?? '').join(' ');
      return [b?.full_identifier, { date: b?.last_action_date ?? null, text: b?.last_action_text ?? null, shared: (count.get(w) ?? 0) > 1 }];
    }),
  );
}

/**
 * Is there evidence that a list (which already names the bill asked for) is
 * really that bill's? Null when there is, else why not. A response's own
 * `request` echo can be wrong, and a list of another bill's actions under the
 * right label would read as a run of false differences. Evidence, from what
 * the data already holds (2026-11-14):
 *   1. the list holds the bill's latest action as data/bills.json has it
 *      (same date, same words) — bills.json is written from Congress.gov's
 *      bill-detail endpoint, a separate request, every night — and that
 *      sentence is no other bill's latest action (2,308 of 3,322 bills share
 *      their latest-action sentence with another bill on 2026-11-14:
 *      "Held at the desk.", "Referred to the House Committee on …"); or, when
 *      that does not settle it (a shared sentence, bills.json a night ahead
 *      of the list, or the record rewording that very action),
 *   2. at least half of the bill's stored rows the list reaches (dated on or
 *      before its newest action) stand on it word for word on their own dates.
 * @param {{ actions: any[] }} list
 * @param {Record<string, any>[]} rows the bill's live re-checkable rows, every question
 * @param {{ date: string|null, text: string|null, shared?: boolean }|null} latest `shared`: the same
 *   sentence is also another bill's latest action in data/bills.json (latestActionsBySlug)
 */
export function listEvidence(list, rows, latest) {
  const listed = list.actions.map((a) => ({ day: String(a.actionDate).slice(0, 10), words: recheckWords(a.text).join(' ') }));
  // A latest action that is boilerplate (the same sentence is another bill's
  // latest action too: "Held at the desk." is 139 bills' on 2026-11-14) is no
  // evidence on its own: another bill's list can hold it on the same day.
  if (latest?.date && latest?.text && !latest.shared) {
    const w = recheckWords(latest.text).join(' ');
    if (listed.some((l) => l.day === String(latest.date).slice(0, 10) && l.words === w)) return null;
  }
  const newest = listed[0]?.day ?? '';
  const reached = rows.filter((u) => u.day <= newest);
  if (reached.length === 0) return null; // nothing the list could contradict; rows newer than it are named apart
  const onIt = reached.filter((u) => listed.some((l) => l.day === u.day && l.words === recheckWords(u.record.action_text).join(' '))).length;
  if (onIt * 2 >= reached.length && onIt > 0) return null;
  return `the source looks wrong: the list does not hold the bill's latest action from data/bills.json${latest?.date ? ` (${latest.date})` : ''}, and only ${onIt} of the ${reached.length} stored row(s) it reaches stand on it`;
}

/**
 * @typedef {{
 *   store: Record<string, any>,
 *   changes: any[],
 *   left: string[],
 *   leftRows: any[],
 *   skipped: string[],
 *   skippedBills: { slug: string, why: string, rows: string[] }[],
 *   newerRows: any[],
 *   checked: number,
 *   recheckable: number,
 *   outOfScope: number,
 *   suspectBills: { slug: string, why: string }[],
 *   unconfirmed: any[],
 *   refused: string|null,
 * }} RecheckResult
 */

/**
 * Re-check every question's stored rows against each bill's action list, and
 * return the store with the night's outcomes applied, or, when a guard refuses
 * the night, the store untouched. Pure: `store` is never mutated.
 *
 * @param {Record<string, any>} store the parsed data/moment-updates.json
 * @param {Map<string, any>} listsBySlug each bill's whole action list ({ actions, total, request }); absent: not fetched
 * @param {{
 *   now?: Date|string|number,
 *   fallbackText: (row: Record<string, any>) => { en: string, es: string },
 *   lintText?: (row: Record<string, any>) => string[],
 *   amendmentLists?: Map<string, any>,
 *   accept?: Set<string>,
 *   scope?: Set<string>|null,
 *   latestBySlug?: Map<string, { date: string|null, text: string|null }>,
 *   perBill?: boolean,
 * }} opts
 *   `fallbackText`: the record's words as a line in both languages
 *   (scripts/moment-updates-map.mjs fallbackTextFor). `lintText`: what the
 *   gate's update lint finds wrong with a row's printed line (both languages);
 *   a corrected row whose quote fails it is HELD (hidden) instead, so the
 *   night never writes a file the CI gate rejects. `accept`: tonight's
 *   one-night override (acceptedIds).
 *   `scope`: the bills the collector reads tonight (scripts/moment-updates.mjs
 *   vehicleSlugs: every live question's vehicles, minus an ENDED Congress's,
 *   which the collector no longer fetches). Rows of any other bill are OUT OF
 *   SCOPE: counted as such, never as "not checked" and never as differences.
 *   null reads every bill.
 *   `latestBySlug`: each bill's latest action as data/bills.json holds it
 *   (last_action_date, last_action_text), for listEvidence.
 *   `perBill` (report mode): a bill whose list looks wrong is set apart on its
 *   own (`suspectBills`, its rows in `unconfirmed`), and every other bill's
 *   findings stand; `refused` stays null. Off (apply mode): any guard refuses
 *   the whole night, as before, and every row is unconfirmed.
 * @returns {RecheckResult}
 */
export function recheckStore(store, listsBySlug, { now = Date.now(), fallbackText, lintText = () => [], amendmentLists = new Map(), accept = new Set(), scope = null, latestBySlug = new Map(), perBill = false } = {}) {
  const nowIso = new Date(typeof now === 'number' || now instanceof Date ? now : Date.parse(now)).toISOString();
  const today = etDay(now);
  const retentionFloor = shiftDay(today, -RETENTION_DAYS);
  const changes = [];
  const left = [];
  /** The same as `left`, structured for the report file. */
  const leftRows = [];
  const skipped = [];
  /** The same as `skipped`, by bill. */
  const skippedBills = [];
  /** Rows dated after their bill's newest listed action: not judged, named. */
  const newerRows = [];
  let checked = 0;
  const perBill_ = new Map();
  const planned = new Map();

  const slugs = new Set();
  let outOfScope = 0;
  for (const [momentId, entry] of Object.entries(store ?? {})) {
    if (momentId === '_meta') continue;
    for (const u of entry?.updates ?? []) {
      if (!isRecheckable(u, retentionFloor)) continue;
      if (scope && !scope.has(u.vehicle)) outOfScope++;
      else slugs.add(u.vehicle);
    }
  }
  const unfit = new Map();
  for (const slug of [...slugs].sort()) {
    const list = listsBySlug?.get(slug);
    let problem = listProblem(list, { slug });
    if (!problem) {
      const rows = Object.entries(store ?? {})
        .filter(([k]) => k !== '_meta')
        .flatMap(([, e]) => (e?.updates ?? []).filter((u) => u?.vehicle === slug && isRecheckable(u, retentionFloor) && !u.withdrawn_on));
      problem = listEvidence(list, rows, latestBySlug.get(slug) ?? null);
    }
    if (problem) {
      unfit.set(slug, problem);
      skipped.push(`${slug}: not checked tonight — ${problem}`);
      const rowKeys = Object.entries(store ?? {})
        .filter(([k]) => k !== '_meta')
        .flatMap(([m, e]) => (e?.updates ?? []).filter((u) => u?.vehicle === slug && isRecheckable(u, retentionFloor) && !u.withdrawn_on).map((u) => `${m}/${u.id}`))
        .sort();
      skippedBills.push({ slug, why: problem, rows: rowKeys });
    }
  }
  const amendmentCache = new Map();
  const amendmentList = (key) => {
    if (!amendmentCache.has(key)) {
      const list = amendmentLists?.get(key);
      amendmentCache.set(key, list ? { list, problem: listProblem(list, { amendment: key }) } : null);
    }
    return amendmentCache.get(key);
  };

  for (const [momentId, entry] of Object.entries(store ?? {})) {
    if (momentId === '_meta') continue;
    const byVehicle = new Map();
    for (const u of entry?.updates ?? []) {
      if (!isRecheckable(u, null) || unfit.has(u.vehicle) || !slugs.has(u.vehicle)) continue;
      if (!byVehicle.has(u.vehicle)) byVehicle.set(u.vehicle, []);
      byVehicle.get(u.vehicle).push(u);
    }
    for (const [slug, rows] of byVehicle) {
      const { checked: n, results, newer } = judgeBill(momentId, rows, listsBySlug.get(slug), { retentionFloor, amendmentList });
      checked += n;
      for (const { row, newest } of newer) newerRows.push({ momentId, id: row.id, vehicle: slug, day: row.day, stored: row.record.action_text, newest });
      const tally = perBill_.get(slug) ?? { checked: 0, changed: 0, left: 0 };
      tally.checked += n;
      for (const r of results) {
        if (r.outcome === 'left') {
          tally.left++;
          left.push(`${momentId}/${r.row.id} (${slug} ${r.row.day}): left as it is — ${r.why}`);
          leftRows.push({ momentId, id: r.row.id, vehicle: slug, day: r.row.day, stored: r.row.record.action_text, record: r.holds ?? [], note: r.note ?? '', why: r.why });
        }
        if (r.outcome === 'unchanged' || r.outcome === 'left') continue;
        if (!planned.has(momentId)) planned.set(momentId, new Map());
        planned.get(momentId).set(r.row.id, { ...r, slug });
      }
      perBill_.set(slug, tally);
    }
  }
  // In scope only: an ended Congress's rows are counted apart (outOfScope).
  const recheckable = Object.entries(store ?? {})
    .filter(([k]) => k !== '_meta')
    .reduce((n, [, e]) => n + (e?.updates ?? []).filter((u) => isRecheckable(u, retentionFloor) && slugs.has(u.vehicle)).length, 0);
  /** @type {Record<string, any>} */
  const out = { changes, left, leftRows, skipped, skippedBills, newerRows, checked, recheckable, outOfScope };
  // The guards on the night as a whole. Reinstatements and rows a person
  // accepted for tonight (the one-night override) do not count.
  // Decided from tonight's judgements, BEFORE anything is applied, so a night
  // whose rows are only LEFT is guarded too.
  const counted = [...planned.values()].flatMap((m) => [...m.values()]).filter((r) => r.outcome !== 'reinstated' && !accept.has(r.row.id));
  for (const r of counted) perBill_.get(r.slug).changed++;
  // Why each bill looks like the wrong source tonight (null: it does not).
  // Rows LEFT count in both bill guards: a list on which most of a bill's
  // stored rows no longer stand is far likelier the wrong list than a record
  // rewritten wholesale. From 2 rows only: a bill with ONE row is judged on
  // its own (listEvidence already refuses a list that is not the bill's), so
  // a real change to a one-row bill is reported as one.
  const billProblem = (slug, t, nightLimit) => {
    const differ = t.changed + t.left;
    if (differ === 0) return null;
    if (nightLimit && t.changed > RECHECK_MAX_CHANGES) {
      return `${t.changed} of ${slug}'s rows would be corrected, withdrawn or held in one night, more than the ${RECHECK_MAX_CHANGES} the re-check allows at once — that looks like the source being wrong, not the record being edited`;
    }
    if (t.checked >= RECHECK_EVERY_ROW_MIN_ROWS && differ === t.checked) {
      return `every one of ${slug}'s ${t.checked} checked row(s) would be corrected, withdrawn, held or left in one night (${t.changed} changed, ${t.left} left) — that looks like the wrong list for that bill`;
    }
    if (t.checked >= RECHECK_BILL_SHARE_MIN_ROWS && differ / t.checked > RECHECK_MAX_BILL_SHARE) {
      return `${differ} of ${slug}'s ${t.checked} checked rows would be corrected, withdrawn, held or left in one night (${t.changed} changed, ${t.left} left), more than half — that looks like the source being wrong for that bill`;
    }
    return null;
  };
  let refused = null;
  /** @type {{ slug: string, why: string }[]} */
  const suspectBills = [];
  if (perBill) {
    // REPORT MODE refuses PER BILL (nothing is written either way): a bill
    // whose list looks wrong has its rows set apart as UNCONFIRMED; every
    // other bill's findings stand. The whole-night limit applies to each bill.
    for (const [slug, t] of [...perBill_].sort()) {
      const why = billProblem(slug, t, true);
      if (why) suspectBills.push({ slug, why });
    }
  } else if (counted.length > RECHECK_MAX_CHANGES) {
    // APPLY MODE refuses the WHOLE night, as before: nothing is written.
    refused = `${counted.length} rows would be corrected, withdrawn or held in one night, more than the ${RECHECK_MAX_CHANGES} the re-check allows at once — that looks like the source being wrong, not the record being edited`;
  } else {
    for (const [slug, t] of [...perBill_].sort()) {
      refused = billProblem(slug, t, false);
      if (refused) break;
    }
  }
  if (refused) for (const [slug, t] of perBill_) if (t.changed + t.left > 0) suspectBills.push({ slug, why: refused });
  out.suspectBills = suspectBills;
  out.unconfirmed = [];
  if (planned.size === 0) return finishGuards(store);

  const next = { ...store };
  for (const [momentId, results] of planned) {
    const entry = store[momentId];
    const taken = new Set((entry.updates ?? []).map((u) => u.id));
    const remap = new Map();
    const updates = (entry.updates ?? []).map((u) => {
      const r = results.get(u.id);
      if (!r) return u;
      const log = Array.isArray(u.rechecks) ? [...u.rechecks] : [];
      const base = { momentId, id: u.id, vehicle: u.vehicle, day: u.day, was: u.record.action_text, how: r.how ?? null, accepted: accept.has(u.id), record: r.holds ?? [], note: r.note ?? '' };
      if (r.outcome === 'withdrawn') {
        changes.push({ ...base, kind: 'withdrawn' });
        return { ...u, withdrawn_on: today, rechecks: [...log, { on: today, at: nowIso, outcome: 'withdrawn' }] };
      }
      if (r.outcome === 'reinstated') {
        changes.push({ ...base, kind: 'reinstated' });
        const rest = { ...u };
        delete rest.withdrawn_on;
        return { ...rest, rechecks: [...log, { on: today, at: nowIso, outcome: 'reinstated' }] };
      }
      // reworded (a held row re-judged against its newest words lands here too)
      const fixed = { ...u, record: { ...u.record, action_text: r.words } };
      delete fixed.withdrawn_on;
      const newId = computeUpdateId(momentId, fixed);
      if (newId !== u.id && taken.has(newId)) {
        const why = `the record's words would give it the id of stored row ${newId}`;
        left.push(`${momentId}/${u.id} (${u.vehicle} ${u.day}): left as it is — ${why}`);
        leftRows.push({ momentId, id: u.id, vehicle: u.vehicle, day: u.day, stored: u.record.action_text, record: r.holds ?? [], note: r.note ?? '', why });
        return u;
      }
      taken.add(newId);
      if (newId !== u.id) remap.set(u.id, newId);
      const text = fallbackText(fixed);
      const lintFailures = lintText({ ...fixed, text, ai: false });
      const entryBase = { on: today, at: nowIso, was: u.record.action_text, was_id: u.id };
      if (lintFailures.length) {
        // HELD. The record's words are stored (they are the truth, and the
        // row is re-judged against them each night), but Oravan has no line it
        // may print for them: quoted, they fail the update lint (a forecast
        // phrase such as "expected to" is refused even inside a quote, exactly
        // as it is for a freshly collected action, which the collector never
        // stores at all). So the row is hidden, keeps the line it printed
        // before (never shown again; CI lints every stored line), and the
        // runner asks for a decode of the new words each night: the first one
        // that passes the lint is printed and the row shows again. The run
        // warns every night while a row stays held, and pipeline-health
        // raises it on its standing issue.
        changes.push({ ...base, kind: 'held', newId, now: r.words, why: lintFailures.join('; ') });
        return { ...fixed, id: newId, text: u.text, ai: u.ai, withdrawn_on: today, rechecks: [...log, { ...entryBase, outcome: 'held', now: r.words }] };
      }
      changes.push({ ...base, kind: 'reworded', newId, now: r.words });
      // `id` keeps its place as the row's first key (spreading `u` kept it).
      return {
        ...fixed,
        id: newId,
        // The line printed so far was written from the earlier words; until a
        // decode of the record's words replaces it, the row prints the
        // record's words themselves (rule 4).
        text,
        ai: false,
        rechecks: [...log, { ...entryBase, outcome: 'reworded' }],
      };
    });
    const summary_revisions = remap.size
      ? (entry.summary_revisions ?? []).map((rev) => {
          const ids = rev?.grounded_in?.update_ids;
          if (!Array.isArray(ids) || !ids.some((id) => remap.has(id))) return rev;
          return { ...rev, grounded_in: { ...rev.grounded_in, update_ids: ids.map((id) => remap.get(id) ?? id) } };
        })
      : entry.summary_revisions;
    const remapped = updates.map((u) => (u?.corrects && remap.has(u.corrects) ? { ...u, corrects: remap.get(u.corrects) } : u));
    next[momentId] = { ...entry, updates: remapped, summary_revisions };
  }

  return finishGuards(refused ? store : next);

  /**
   * Set a suspect bill's rows apart as UNCONFIRMED (never findings), and return.
   * @returns {RecheckResult}
   */
  function finishGuards(storeOut) {
    const suspect = new Set(suspectBills.map((b) => b.slug));
    const take = (rows, verdictOf) =>
      rows.filter((r) => {
        if (!suspect.has(r.vehicle)) return true;
        out.unconfirmed.push({ ...r, verdict: verdictOf(r) });
        return false;
      });
    if (suspect.size) {
      out.changes = take(changes, (c) => ({ reworded: 'would-correct', withdrawn: 'would-withdraw', held: 'would-hold', reinstated: 'would-reinstate' })[c.kind]);
      out.leftRows = take(leftRows, () => 'left');
    }
    return /** @type {RecheckResult} */ ({ store: storeOut, ...out, refused });
  }
}

/**
 * The ids a model-written "Where it stands" cites that the re-check changed
 * AFTER it was written (a `rechecks` entry timed after the revision): that
 * summary was written from words the record no longer holds, so it is due a
 * rewrite, night after night, until a revision written after the change
 * stands. Empty when the current revision is record-only or hand-authored.
 * Pure; read off the stored file, so it survives a night whose budget ran out.
 * @param {Record<string, any>} entry
 * @returns {string[]}
 */
export function recheckPendingIds(entry) {
  const last = entry?.summary_revisions?.at(-1);
  if (!last) return [];
  const model = String(last.model ?? '').trim().toLowerCase();
  if (model === 'record-only' || model === 'hand-authored') return [];
  const written = Date.parse(last.generated_at);
  if (!Number.isFinite(written)) return [];
  const cited = new Set(last.grounded_in?.update_ids ?? []);
  return (entry.updates ?? [])
    .filter((u) => cited.has(u.id) && (u.rechecks ?? []).some((e) => e.outcome !== 'reinstated' && Date.parse(e.at) > written))
    .map((u) => u.id);
}

/**
 * Every HELD row in the store, as { momentId, id, vehicle, day, since, words }.
 * Pure. The runner retries a decode for each, every night, and warns; the
 * pipeline-health report raises them on its standing issue.
 * @param {Record<string, any>} store
 */
export function heldRows(store) {
  const out = [];
  for (const [momentId, entry] of Object.entries(store ?? {})) {
    if (momentId === '_meta') continue;
    for (const u of entry?.updates ?? []) {
      if (!isHeld(u)) continue;
      // The first of the trailing run of `held` entries: when it was first held.
      const log = u.rechecks ?? [];
      let first = log.length - 1;
      while (first > 0 && log[first - 1]?.outcome === 'held') first--;
      const since = log[first]?.on ?? u.withdrawn_on;
      out.push({ momentId, id: u.id, vehicle: u.vehicle, day: u.day, since, words: u.record?.action_text ?? '' });
    }
  }
  return out;
}

/**
 * A held row shown again with a line that passed the update lint (a decode of
 * its record words): the line is printed, the row is no longer hidden, and the
 * return is logged. Pure.
 * @param {Record<string, any>} row a held row
 * @param {{ en: string, es: string }} text the line, already lint-checked by the caller
 * @param {boolean} ai whether a model wrote it
 * @param {Date|string|number} now
 * @returns {Record<string, any>}
 */
export function releaseHeldRow(row, text, ai, now) {
  const at = new Date(typeof now === 'number' || now instanceof Date ? now : Date.parse(now)).toISOString();
  const out = { ...row, text, ai };
  delete out.withdrawn_on;
  out.rechecks = [...(row.rechecks ?? []), { on: etDay(now), at, outcome: 'reinstated' }];
  return out;
}

/* ------------------------------------------------------------------ *
 * THE REPORT FILE (data/record-recheck-report.json), written by the nightly
 * comparison in BOTH modes and read by pipeline-health. It holds what is
 * still unresolved, with the ET day each thing was first seen, so an alarm
 * names a row once when it is new and then counts it while it lasts:
 *   rows       "<moment>/<id>" -> { first_seen, verdict, vehicle, day, stored, record, why }
 *              verdict: would-correct | would-withdraw | would-hold |
 *              would-reinstate (report only, or a refused apply night) | left
 *   unchecked  "<slug>" -> { since, last, why }: a bill with re-checkable rows
 *              that was not checked (its list failed or was rejected): the
 *              first and the latest night of the streak
 *   zero_checked { since, last }: while re-checkable rows exist and none was
 *              checked at all
 *   newer      "<moment>/<id>" -> { since, last, vehicle, day, stored, newest }:
 *              a row dated after its bill's newest listed action
 *   suspect    "<slug>" -> { since, last, why, rows }: a bill whose list looked
 *              wrong (report mode sets each such bill apart on its own;
 *              apply mode refuses the whole night and lists every bill it
 *              touched). Its rows are UNCONFIRMED, each { first_seen, verdict,
 *              day, stored, record, note }, never named as differences.
 *   Every `record` is a LIST of the record's own sentences, { day, text,
 *   source? } (source: an amendment's key), and `note` says in Oravan's words
 *   what they are; only `text` is ever put in quotation marks (renderRecord).
 *   This shape is the first the file has had on main: no older file exists.
 * Only a streak carries its latest night, so the file changes every night
 * only while something is failing; otherwise only when what it says changes.
 * ------------------------------------------------------------------ */

const VERDICT_OF = { reworded: 'would-correct', withdrawn: 'would-withdraw', held: 'would-hold', reinstated: 'would-reinstate' };

/**
 * The report file after tonight's comparison. Pure.
 * @param {Record<string, any>|null|undefined} prev the file as committed, or null
 * @param {ReturnType<typeof recheckStore>} result tonight's comparison
 * @param {{ today: string, applied: boolean }} opts `applied`: whether tonight's changes were written
 *   (apply mode, not refused); when they were, they are no longer findings
 * @returns {{ schema: number, rows: Record<string, any>, unchecked: Record<string, any>, newer: Record<string, any>, suspect: Record<string, any>, zero_checked?: { since: string, last: string } }}
 */
export function nextRecheckReport(prev, result, { today, applied }) {
  const prevRows = prev?.rows && typeof prev.rows === 'object' ? prev.rows : {};
  const prevUnchecked = prev?.unchecked && typeof prev.unchecked === 'object' ? prev.unchecked : {};
  const prevNewer = prev?.newer && typeof prev.newer === 'object' ? prev.newer : {};
  const prevSuspect = prev?.suspect && typeof prev.suspect === 'object' ? prev.suspect : {};
  const suspectSlugs = new Set((result.suspectBills ?? []).map((b) => b.slug));
  /** @type {Record<string, any>} */
  let rows = {};
  if (result.refused) {
    // APPLY MODE refused the whole night: nothing it found is named as a
    // difference, and what earlier nights found stays as it was.
    rows = { ...prevRows };
  } else {
    const add = (key, v) => {
      rows[key] = { first_seen: prevRows[key]?.first_seen ?? today, ...v };
    };
    if (!applied) {
      for (const c of result.changes) {
        add(`${c.momentId}/${c.id}`, { verdict: VERDICT_OF[c.kind], vehicle: c.vehicle, day: c.day, stored: c.was, record: c.record ?? [], note: c.note ?? '', why: c.how ?? c.why ?? '' });
      }
    }
    for (const l of result.leftRows ?? []) {
      add(`${l.momentId}/${l.id}`, { verdict: 'left', vehicle: l.vehicle, day: l.day, stored: l.stored, record: l.record ?? [], note: l.note ?? '', why: l.why });
    }
    // A bill set apart tonight (its source looked wrong) keeps what earlier
    // nights found on it, untouched.
    for (const [key, r] of Object.entries(prevRows)) if (suspectSlugs.has(r?.vehicle) && !rows[key]) rows[key] = r;
  }
  const unchecked = {};
  for (const b of result.skippedBills ?? []) unchecked[b.slug] = { since: prevUnchecked[b.slug]?.since ?? today, last: today, why: b.why, rows: b.rows ?? [] };
  const newer = {};
  for (const n of result.newerRows ?? []) {
    const key = `${n.momentId}/${n.id}`;
    newer[key] = { since: prevNewer[key]?.since ?? today, last: today, vehicle: n.vehicle, day: n.day, stored: n.stored, newest: n.newest };
  }
  // A bill whose source looked wrong tonight, with the rows it would have
  // touched: UNCONFIRMED, each with the night it first appeared there.
  const suspect = {};
  for (const b of result.suspectBills ?? []) {
    const before = prevSuspect[b.slug]?.rows ?? {};
    const its = {};
    for (const u of (result.unconfirmed ?? []).filter((x) => x.vehicle === b.slug)) {
      const key = `${u.momentId}/${u.id}`;
      its[key] = { first_seen: before[key]?.first_seen ?? today, verdict: u.verdict, day: u.day, stored: u.was ?? u.stored, record: u.record ?? [], note: u.note ?? '' };
    }
    suspect[b.slug] = { since: prevSuspect[b.slug]?.since ?? today, last: today, why: b.why, rows: sortKeys(its) };
  }
  /** @type {{ schema: number, rows: Record<string, any>, unchecked: Record<string, any>, newer: Record<string, any>, suspect: Record<string, any>, zero_checked?: { since: string, last: string } }} */
  const out = { schema: 1, rows: sortKeys(rows), unchecked: sortKeys(unchecked), newer: sortKeys(newer), suspect: sortKeys(suspect) };
  if ((result.recheckable ?? 0) > 0 && result.checked === 0) out.zero_checked = { since: prev?.zero_checked?.since ?? today, last: today };
  return out;
}

function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * What is wrong with the report file, or [] (absent is fine).
 * @param {unknown} obj
 * @returns {string[]}
 */
function sentenceProblems(list, at) {
  if (!Array.isArray(list)) return [`${at}: must be a list of the record's sentences { day, text, source? }`];
  return list.flatMap((x, i) =>
    x && typeof x === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(String(x.day)) && typeof x.text === 'string' && x.text && (x.source === undefined || typeof x.source === 'string')
      ? []
      : [`${at}[${i}]: must be { day: YYYY-MM-DD, text, source? }`],
  );
}

export function recheckReportProblems(obj) {
  if (obj === undefined || obj === null) return [];
  const at = RECHECK_REPORT_PATH;
  if (typeof obj !== 'object' || Array.isArray(obj)) return [`${at}: must be an object`];
  const out = [];
  if (obj.schema !== 1) out.push(`${at}.schema: must be 1`);
  const day = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const verdicts = ['would-correct', 'would-withdraw', 'would-hold', 'would-reinstate', 'left'];
  if (!obj.rows || typeof obj.rows !== 'object' || Array.isArray(obj.rows)) out.push(`${at}.rows: must be an object`);
  else {
    for (const [k, r] of Object.entries(obj.rows)) {
      if (!/^[a-z0-9-]+\/u_[0-9a-f]{8}$/.test(k)) out.push(`${at}.rows: "${k}" is not "<moment>/<update id>"`);
      if (!r || typeof r !== 'object') { out.push(`${at}.rows.${k}: must be an object`); continue; }
      if (!day(r.first_seen)) out.push(`${at}.rows.${k}.first_seen: must be YYYY-MM-DD`);
      if (!verdicts.includes(r.verdict)) out.push(`${at}.rows.${k}.verdict: must be one of ${verdicts.join(' | ')}`);
      for (const f of ['vehicle', 'day', 'stored']) if (typeof r[f] !== 'string' || !r[f]) out.push(`${at}.rows.${k}.${f}: must be a non-empty string`);
      for (const f of ['note', 'why']) if (typeof r[f] !== 'string') out.push(`${at}.rows.${k}.${f}: must be a string`);
      out.push(...sentenceProblems(r.record, `${at}.rows.${k}.record`));
    }
  }
  if (!obj.unchecked || typeof obj.unchecked !== 'object' || Array.isArray(obj.unchecked)) out.push(`${at}.unchecked: must be an object`);
  else for (const [k, u] of Object.entries(obj.unchecked)) if (!u || !day(u.since) || !day(u.last) || u.last < u.since || typeof u.why !== 'string' || (u.rows !== undefined && !Array.isArray(u.rows))) out.push(`${at}.unchecked.${k}: must be { since: YYYY-MM-DD, last: YYYY-MM-DD not before since, why, rows?: [] }`);
  if (obj.newer !== undefined) {
    if (!obj.newer || typeof obj.newer !== 'object' || Array.isArray(obj.newer)) out.push(`${at}.newer: must be an object`);
    else for (const [k, u] of Object.entries(obj.newer)) if (!u || !day(u.since) || !day(u.last) || u.last < u.since || !day(u.day) || !day(u.newest)) out.push(`${at}.newer.${k}: must be { since, last, vehicle, day, stored, newest } with days`);
  }
  if (obj.suspect !== undefined) {
    if (!obj.suspect || typeof obj.suspect !== 'object' || Array.isArray(obj.suspect)) out.push(`${at}.suspect: must be an object`);
    else {
      for (const [slug, b] of Object.entries(obj.suspect)) {
        if (!b || !day(b.since) || !day(b.last) || b.last < b.since || typeof b.why !== 'string' || !b.rows || typeof b.rows !== 'object') { out.push(`${at}.suspect.${slug}: must be { since, last, why, rows }`); continue; }
        for (const [k, r] of Object.entries(b.rows)) {
          if (!r || !day(r.first_seen) || !verdicts.includes(r.verdict) || !day(r.day) || typeof r.stored !== 'string' || typeof r.note !== 'string') out.push(`${at}.suspect.${slug}.rows.${k}: must be { first_seen, verdict, day, stored, record, note }`);
          else out.push(...sentenceProblems(r.record, `${at}.suspect.${slug}.rows.${k}.record`));
        }
      }
    }
  }
  if (obj.zero_checked !== undefined && (!obj.zero_checked || !day(obj.zero_checked.since) || !day(obj.zero_checked.last) || obj.zero_checked.last < obj.zero_checked.since)) {
    out.push(`${at}.zero_checked: must be { since: YYYY-MM-DD, last: YYYY-MM-DD not before since }`);
  }
  return out;
}

export { liveUpdates };
