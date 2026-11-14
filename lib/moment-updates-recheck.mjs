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
 *   1. SAME ROLL CALL (identity certain). The row carries a roll call, and an
 *      action that day carries the same chamber and roll number (the record's
 *      own recordedVotes, or "Record Vote Number: N" in its words). Equal
 *      words: unchanged. Otherwise the row takes that action's words, whatever
 *      changed (a corrected tally included): a roll number names one vote, and
 *      its id does not change. If two actions that day carry the number with
 *      different words, the chamber's own row is preferred to the Library of
 *      Congress echo; if that still leaves two, the row is left, with a warning.
 *   2. SAME WORDS. An action that day has the same words: unchanged (and a row
 *      marked withdrawn is REINSTATED).
 *   3. SAME ID. No same words, but an action that day hashes to the row's own
 *      id (the id reads only the first 120 characters, so a long action edited
 *      near its end): the row is NEVER withdrawn. It takes the action's words
 *      only under rule 4's rewording test; otherwise it is left, with a warning.
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
 *   5. WITHDRAWN. Nothing that day is within reach, the words are on no other
 *      date of the list, and the list holds at least one action on that day.
 *      The row is kept, marked `withdrawn_on`, and no longer printed.
 *   6. A ROW THAT NAMES AN AMENDMENT ("SA 6776", "S.Amdt. 6776", "H.Amdt. 12")
 *      is never withdrawn on the bill's list alone: an action on an amendment
 *      can move to the amendment's own record. The runner reads that
 *      amendment's list too. Same words there on that day: unchanged. Read,
 *      whole, and not holding them: withdrawn. Not read: left, with a warning.
 *   Words on another date (the record moved the action), or no action at all
 *   on the row's day while the list runs on both sides of it (a list missing a
 *   day): left, with a warning. Position is never used: an edit to the list is
 *   exactly what moves positions.
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
/** The share guard applies from this many checked rows up (every-row applies always). */
export const RECHECK_BILL_SHARE_MIN_ROWS = 3;

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
  if (!ca || !cb) return `"${a}" → "${b}" is not a swap between two outcome words`;
  if (ca !== cb) return `"${a}" → "${b}" changes which way it went (${ca} → ${cb})`;
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
    const live = (outcome, extra = {}) => results.push({ row, outcome, ...extra });

    // A row already withdrawn or held is only ever REINSTATED, when the record
    // lists its own words that day again; nothing else re-judges it, so a held
    // row never writes again night after night.
    if (row.withdrawn_on) {
      live(sameDay.some((l) => sameWords(l.words, words)) ? 'reinstated' : 'unchanged');
      continue;
    }

    // 1 · same roll call
    const rc = row.record.roll_call;
    if (rc && rc.number !== undefined && rc.number !== null) {
      const key = `${String(rc.chamber ?? '').toLowerCase()}:${Number(rc.number)}`;
      const carrying = sameDay.filter((l) => listedRolls(l.a).has(key));
      if (carrying.length) {
        if (carrying.some((l) => sameWords(l.words, words))) {
          live('unchanged');
          continue;
        }
        const own = carrying.filter((l) => !isEcho(l.a));
        const pool = own.length ? own : carrying;
        const distinct = [...new Map(pool.map((l) => [l.words.join(' '), l])).values()];
        if (distinct.length === 1) {
          live('reworded', { words: distinct[0].text, how: `same roll call (${key})`, index: distinct[0].index });
        } else {
          live('left', { why: `${distinct.length} actions that day carry roll call ${key} with different words` });
        }
        continue;
      }
    }

    // 2 · same words
    if (sameDay.some((l) => sameWords(l.words, words))) {
      live('unchanged');
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
      const ok = sameId.filter((l) => agrees(l) && !rewordingProblem(words, l.words));
      if (sameId.length === 1 && ok.length === 1) live('reworded', { words: ok[0].text, how: 'same id', index: ok[0].index });
      else live('left', { why: `an action that day still carries this row's id, but its words changed beyond a rewording (${rewordingProblem(words, sameId[0].words) ?? 'more than one such action'})` });
      continue;
    }

    // 4 · a rewording
    const reach = sameDay.filter((l) => !heldByOther(row, l) && withinReach(words, l.words));
    if (reach.length > 1) {
      live('left', { why: `${reach.length} actions that day are within reach of it` });
      continue;
    }
    if (reach.length === 1) {
      const [l] = reach;
      const problem = !agrees(l) ? 'the chamber or action code differs' : rewordingProblem(words, l.words);
      if (problem) live('left', { why: `the nearest action that day ("${l.text}") is not a rewording of it: ${problem}` });
      else live('reworded', { words: l.text, how: 'a rewording', index: l.index });
      continue;
    }

    // 5 / 6 · gone from that day
    const elsewhere = listed.find((l) => sameWords(l.words, words));
    if (elsewhere) {
      live('left', { why: `the record lists these words on ${elsewhere.day}, not ${row.day}` });
      continue;
    }
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
      const onAmendment = got.list.actions.some((a) => String(a.actionDate).slice(0, 10) === row.day && sameWords(recheckWords(a.text), words));
      if (onAmendment) {
        live('unchanged', { how: `held by amendment ${amendment}'s own record` });
        continue;
      }
    }
    live('withdrawn', { how: amendment ? `on neither the bill's list nor amendment ${amendment}'s` : "on no date of the bill's list" });
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
  return { checked: eligible.length, results };
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

/** The row ids accepted for `night` (an ET day), or an empty set. Malformed lists accept nothing. */
export function acceptedIds(obj, night) {
  if (acceptListProblems(obj).length || !obj) return new Set();
  return new Set(obj.accept.filter((e) => e.night === night).flatMap((e) => e.ids));
}

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
 * }} opts
 *   `fallbackText`: the record's words as a line in both languages
 *   (scripts/moment-updates-map.mjs fallbackTextFor). `lintText`: what the
 *   gate's update lint finds wrong with a row's printed line (both languages);
 *   a corrected row whose quote fails it is HELD (hidden) instead, so the
 *   night never writes a file the CI gate rejects. `accept`: tonight's
 *   one-night override (acceptedIds).
 */
export function recheckStore(store, listsBySlug, { now = Date.now(), fallbackText, lintText = () => [], amendmentLists = new Map(), accept = new Set() } = {}) {
  const nowIso = new Date(typeof now === 'number' || now instanceof Date ? now : Date.parse(now)).toISOString();
  const today = etDay(now);
  const retentionFloor = shiftDay(today, -RETENTION_DAYS);
  const changes = [];
  const left = [];
  const skipped = [];
  let checked = 0;
  const perBill = new Map();
  const planned = new Map();

  const slugs = new Set();
  for (const [momentId, entry] of Object.entries(store ?? {})) {
    if (momentId === '_meta') continue;
    for (const u of entry?.updates ?? []) if (isRecheckable(u, retentionFloor)) slugs.add(u.vehicle);
  }
  const unfit = new Map();
  for (const slug of [...slugs].sort()) {
    const problem = listProblem(listsBySlug?.get(slug), { slug });
    if (problem) {
      unfit.set(slug, problem);
      skipped.push(`${slug}: not checked tonight — ${problem}`);
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
      if (!isRecheckable(u, null) || unfit.has(u.vehicle)) continue;
      if (!byVehicle.has(u.vehicle)) byVehicle.set(u.vehicle, []);
      byVehicle.get(u.vehicle).push(u);
    }
    for (const [slug, rows] of byVehicle) {
      const { checked: n, results } = judgeBill(momentId, rows, listsBySlug.get(slug), { retentionFloor, amendmentList });
      checked += n;
      const tally = perBill.get(slug) ?? { checked: 0, changed: 0 };
      tally.checked += n;
      for (const r of results) {
        if (r.outcome === 'left') left.push(`${momentId}/${r.row.id} (${slug} ${r.row.day}): left as it is — ${r.why}`);
        if (r.outcome === 'unchanged' || r.outcome === 'left') continue;
        if (!planned.has(momentId)) planned.set(momentId, new Map());
        planned.get(momentId).set(r.row.id, { ...r, slug });
      }
      perBill.set(slug, tally);
    }
  }
  if (planned.size === 0) return { store, changes, left, skipped, refused: null, checked };

  const next = { ...store };
  for (const [momentId, results] of planned) {
    const entry = store[momentId];
    const taken = new Set((entry.updates ?? []).map((u) => u.id));
    const remap = new Map();
    const updates = (entry.updates ?? []).map((u) => {
      const r = results.get(u.id);
      if (!r) return u;
      const log = Array.isArray(u.rechecks) ? [...u.rechecks] : [];
      const base = { momentId, id: u.id, vehicle: u.vehicle, day: u.day, was: u.record.action_text, how: r.how ?? null, accepted: accept.has(u.id) };
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
      // reworded
      const fixed = { ...u, record: { ...u.record, action_text: r.words } };
      const newId = computeUpdateId(momentId, fixed);
      if (newId !== u.id && taken.has(newId)) {
        left.push(`${momentId}/${u.id} (${u.vehicle} ${u.day}): left as it is — the record's words "${r.words}" would give it the id of stored row ${newId}`);
        return u;
      }
      const text = fallbackText(fixed);
      const lintFailures = lintText({ ...fixed, text, ai: false });
      if (lintFailures.length) {
        // The record's new words cannot be printed as they stand (a quote the
        // update lint refuses): the row is HELD, hidden like a withdrawn row,
        // with both the earlier and the record's words kept. Never a file CI
        // rejects, and never the old line the record no longer holds.
        changes.push({ ...base, kind: 'held', now: r.words, why: lintFailures.join('; ') });
        return { ...u, withdrawn_on: today, rechecks: [...log, { on: today, at: nowIso, outcome: 'held', now: r.words }] };
      }
      taken.add(newId);
      if (newId !== u.id) remap.set(u.id, newId);
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
        rechecks: [...log, { on: today, at: nowIso, outcome: 'reworded', was: u.record.action_text, was_id: u.id }],
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

  // The guards on the night as a whole. Reinstatements and rows a person
  // accepted for tonight (the one-night override) do not count.
  const counted = changes.filter((c) => c.kind !== 'reinstated' && !c.accepted);
  for (const c of counted) perBill.get(planned.get(c.momentId).get(c.id).slug).changed++;
  let refused = null;
  if (counted.length > RECHECK_MAX_CHANGES) {
    refused = `${counted.length} rows would be corrected, withdrawn or held in one night, more than the ${RECHECK_MAX_CHANGES} the re-check allows at once — that looks like the source being wrong, not the record being edited`;
  } else {
    for (const [slug, t] of [...perBill].sort()) {
      if (t.changed === 0) continue;
      if (t.changed === t.checked) {
        refused = `every one of ${slug}'s ${t.checked} checked row(s) would be corrected, withdrawn or held in one night — that looks like the wrong list for that bill`;
        break;
      }
      if (t.checked >= RECHECK_BILL_SHARE_MIN_ROWS && t.changed / t.checked > RECHECK_MAX_BILL_SHARE) {
        refused = `${t.changed} of ${slug}'s ${t.checked} checked rows would be corrected, withdrawn or held in one night, more than half — that looks like the source being wrong for that bill`;
        break;
      }
    }
  }
  if (refused) return { store, changes, left, skipped, refused, checked };
  return { store: next, changes, left, skipped, refused: null, checked };
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

export { liveUpdates };
