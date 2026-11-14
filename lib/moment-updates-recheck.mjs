/**
 * THE NIGHTLY RE-CHECK OF STORED UPDATE LINES AGAINST THE RECORD (owner,
 * 2026-11-14, answer 92 a): "A nightly re-check of every stored update text
 * against the record: a line the record no longer holds is corrected to the
 * record's words or marked withdrawn, and the run says so."
 *
 * WHY. Congress.gov edits its action list after first publishing it. Two rows
 * on the college-athletes question (S. 4668) quoted words the record no longer
 * held: u_d5eaf6d9 stored "The committee substitute withdrawn by Voice Vote."
 * for 2026-09-24, where the record's list (read 2026-09-30) says "The
 * committee substitute tabled by Voice Vote."; and u_682cca41 stored "Cloture
 * motion on amendment SA 6776 presented in Senate." for 2026-09-17, a line on
 * no row of the list on any date. Rule 6: the record is quoted, never
 * narrated, and a quote the record no longer holds is neither.
 *
 * Pure: the runner (scripts/moment-updates.mjs, nightly mode) fetches each
 * bill's whole action list and passes it in; everything that decides lives
 * here so tests/moment-updates-recheck.unit.spec.ts can drive it with no
 * network. Imports only the gate (itself import-clean).
 *
 * ---------------------------------------------------------------------------
 * WHICH ROWS. Every stored row whose quote came from Congress.gov's action
 * record (source.kind `congress_actions`: the actions list, and the bill-detail
 * status diff, whose latestAction is a row of that same list), inside
 * retention. NOT a roll call read from the chamber's vote record (senate.gov,
 * the House Clerk): that is a different record, and the action list never
 * carries its words; NOT a floor-feed signal or a press cluster.
 *
 * THE MATCHING RULE ("the same action"). For one row, on its bill, against
 * the actions the record lists ON THE ROW'S OWN DATE:
 *   - The words compared are the action's sentence with the Library of
 *     Congress echo prefix ("Passed/agreed to in Senate: "), every trailing
 *     Congressional Record citation ("(CR S4789)", "(consideration: CR …)"),
 *     trailing periods, case and runs of whitespace removed (the gate's
 *     citationFreeText + normalizeText). So whitespace and citation
 *     differences are never changes.
 *   1. UNCHANGED: some action that day reads the same. Nothing is written.
 *   2. REWORDED: no action that day reads the same, and exactly one action
 *      that day is the same action in other words:
 *        - no other stored row of the bill already reads as it (else it is
 *          that row's action, not this one's);
 *        - the same chamber, where both say which;
 *        - the same action code, where both carry one;
 *        - the same numbers, in the same order (tallies, roll numbers,
 *          amendment and calendar numbers name WHICH action it is; a changed
 *          number is a different action);
 *        - at most REWORD_MAX_WORDS words added, removed or swapped, and never
 *          more than a quarter of the longer sentence's words (at least one is
 *          always allowed).
 *      The stored quote becomes the record's words, verbatim; the earlier
 *      words and the earlier id are kept on the row (`rechecks`), with the
 *      ET day the change was found.
 *   3. WITHDRAWN: no action that day reads the same or passes 2, and no action
 *      on ANY date reads the same. The row is kept and marked `withdrawn_on`
 *      (the ET day it was found gone); the reader stops printing it.
 *   Anything else is left as it is, with a warning, never guessed at: two or
 *   more actions qualify under 2 (ambiguous), two stored rows would take the
 *   same action, the same words now sit on another date (the record moved the
 *   action; this check does not re-date rows), or the record's words would
 *   give the row the id of a row already stored.
 *   A row marked withdrawn that the record lists again (rule 1) is
 *   REINSTATED: `withdrawn_on` is removed and the return is logged on the row.
 *
 *   Position is NOT part of the rule: a position is where the list placed the
 *   action when it was read, and an edit to the list is exactly what moves
 *   positions. Dates, chamber, code and numbers are the action's own facts.
 *
 * THE GUARDS (rule 11: the source being wrong for a night must never damage
 * the file).
 *   - A bill whose list did not arrive, arrived empty, is not newest first, or
 *     is not whole (the response's own pagination.count says more actions
 *     exist than it holds) is not checked at all that night.
 *   - A row dated after the newest action in the list is not judged: the list
 *     as fetched does not reach that day.
 *   - The whole night: more than RECHECK_MAX_CHANGES corrections and
 *     withdrawals together, or more than half of any one bill's checked rows
 *     (when that is 3 or more rows), refuses EVERY change of the night and
 *     says why (recheckStore's `refused`). See RECHECK_MAX_CHANGES for the
 *     number and the data it was read from.
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

/** The most words a rewording may add, remove or swap. */
export const REWORD_MAX_WORDS = 2;

/**
 * The most corrections and withdrawals one night may write, across every
 * question, before the whole night's changes are refused.
 *
 * READ FROM THE DATA, 2026-11-14: data/moment-updates.json holds 23 rows the
 * re-check reads (source congress_actions, inside retention) on 5 bills.
 * Against Congress.gov's lists read 2026-09-30 (saved for 4 of those bills;
 * 18 of the rows are on or before those lists' newest day), exactly 2 differ
 * from the record: the two college-athletes rows above, the whole backlog the
 * card found. A night that wants more than 4 changes is twice that backlog at
 * once, which is what a source error looks like (a list served stale or for
 * another bill, a short response that slipped past the guards above) rather
 * than the record being edited. Refusing costs one night's healing; the next
 * night tries again, and the run's error names every row it held back.
 */
export const RECHECK_MAX_CHANGES = 4;

/** Above this share of one bill's checked rows changing at once, the night is refused. */
export const RECHECK_MAX_BILL_SHARE = 0.5;
/** The per-bill share guard applies only from this many checked rows up. */
export const RECHECK_BILL_SHARE_MIN_ROWS = 3;

/** The words two action sentences are compared on. */
export function recheckWords(text) {
  return normalizeText(citationFreeText(text));
}

/** The numbers in a sentence, in order (citations already removed). */
function numbersOf(words) {
  return words.match(/\d+/g) ?? [];
}

/** Word-level edit distance (insert, delete, substitute one word). */
export function wordDistance(a, b) {
  const x = a.match(/[a-z0-9]+/g) ?? [];
  const y = b.match(/[a-z0-9]+/g) ?? [];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return { distance: prev[y.length], longer: Math.max(x.length, y.length) };
}

/** Is `b` the same action as `a` in other words, by the word budget of rule 2? */
export function isRewording(a, b) {
  if (!a || !b || a === b) return false;
  const na = numbersOf(a);
  const nb = numbersOf(b);
  if (na.length !== nb.length || na.some((n, i) => n !== nb[i])) return false;
  const { distance, longer } = wordDistance(a, b);
  const budget = Math.min(REWORD_MAX_WORDS, Math.max(1, Math.floor(longer / 4)));
  return distance >= 1 && distance <= budget;
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

/**
 * Is a fetched action list fit to judge rows by? Null when it is, else why not.
 * @param {{ actions?: any[], total?: number|null }|null|undefined} list
 * @returns {string|null}
 */
export function listProblem(list) {
  const actions = list?.actions;
  if (!Array.isArray(actions)) return 'the list was not fetched (a failed request, or a bill this run does not read)';
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

/**
 * Judge every re-checkable row of ONE question on ONE bill. Pure.
 *
 * @param {Record<string, any>[]} rows the question's stored rows on this bill
 * @param {{ actions: any[] }} list the bill's whole action list (listProblem already null)
 * @param {string} retentionFloor
 * @returns {{ checked: number, results: { row: Record<string, any>, outcome: 'unchanged'|'reworded'|'withdrawn'|'reinstated'|'left', words?: string, why?: string }[] }}
 */
export function judgeBill(rows, list, retentionFloor) {
  const listed = list.actions.map((a) => ({
    a,
    day: String(a.actionDate).slice(0, 10),
    words: recheckWords(a.text),
    text: String(a.text ?? '').trim(),
  }));
  const newestDay = listed[0].day;
  const wordsAnyDay = new Set(listed.map((l) => l.words));
  const eligible = rows.filter((u) => isRecheckable(u, retentionFloor) && u.day <= newestDay);
  // Words some stored row of this bill already reads as, on its own day —
  // the action that row already stands for. Withdrawn rows stand for nothing.
  const heldWords = new Set(
    rows.filter((u) => isRecheckable(u, null) && !u.withdrawn_on).map((u) => `${u.day}${recheckWords(u.record.action_text)}`),
  );

  const results = [];
  /** listed index -> rows that would take it as their rewording */
  const claims = new Map();
  for (const row of eligible) {
    const words = recheckWords(row.record.action_text);
    const sameDay = listed.filter((l) => l.day === row.day);
    if (sameDay.some((l) => l.words === words)) {
      results.push({ row, outcome: row.withdrawn_on ? 'reinstated' : 'unchanged' });
      continue;
    }
    if (row.withdrawn_on) {
      results.push({ row, outcome: 'unchanged' }); // still gone; already marked
      continue;
    }
    const chamber = actionChamber(row);
    const code = row.record.action_code ?? null;
    const candidates = sameDay.filter((l) => {
      if (heldWords.has(`${l.day}${l.words}`)) return false;
      const c = listedChamber(l.a);
      if (chamber && c && c !== chamber) return false;
      if (code && l.a.actionCode && String(l.a.actionCode) !== String(code)) return false;
      return isRewording(words, l.words);
    });
    if (candidates.length === 1) {
      const index = listed.indexOf(candidates[0]);
      if (!claims.has(index)) claims.set(index, []);
      claims.get(index).push(row);
      results.push({ row, outcome: 'reworded', words: candidates[0].text, index });
      continue;
    }
    if (candidates.length > 1) {
      results.push({ row, outcome: 'left', why: `${candidates.length} actions that day could be its rewording` });
      continue;
    }
    if (wordsAnyDay.has(words)) {
      const moved = listed.find((l) => l.words === words);
      results.push({ row, outcome: 'left', why: `the record lists these words on ${moved.day}, not ${row.day}` });
      continue;
    }
    results.push({ row, outcome: 'withdrawn' });
  }
  // Two rows taking one action: neither is the one, by this rule. Left.
  for (const r of results) {
    if (r.outcome === 'reworded' && claims.get(r.index).length > 1) {
      r.outcome = 'left';
      r.why = `${claims.get(r.index).length} stored rows would take the same action as their rewording`;
      delete r.words;
    }
  }
  return { checked: eligible.length, results };
}

/**
 * Re-check every question's stored rows against each bill's action list, and
 * return the store with the night's outcomes applied — or, when a guard
 * refuses the night, the store untouched. Pure: `store` is never mutated.
 *
 * @param {Record<string, any>} store the parsed data/moment-updates.json
 * @param {Map<string, { actions?: any[], total?: number|null }|null>} listsBySlug each bill's whole action list (absent or null: not fetched)
 * @param {{ now?: Date|string|number, fallbackText: (row: Record<string, any>) => { en: string, es: string } }} opts
 *   `fallbackText`: the record's words as a line in both languages
 *   (scripts/moment-updates-map.mjs fallbackTextFor); a corrected row prints
 *   it until a fresh decode of the new words replaces it.
 * @returns {{
 *   store: Record<string, any>,
 *   changes: { momentId: string, kind: 'reworded'|'withdrawn'|'reinstated', id: string, newId?: string, vehicle: string, day: string, was: string, now?: string }[],
 *   left: string[],
 *   skipped: string[],
 *   refused: string|null,
 *   checked: number,
 * }}
 */
export function recheckStore(store, listsBySlug, { now = Date.now(), fallbackText } = {}) {
  const today = etDay(now);
  const retentionFloor = shiftDay(today, -RETENTION_DAYS);
  const changes = [];
  const left = [];
  const skipped = [];
  let checked = 0;
  /** slug -> { checked, changed } summed over every question */
  const perBill = new Map();
  /** momentId -> Map(row id -> result) */
  const planned = new Map();

  const slugs = new Set();
  for (const [momentId, entry] of Object.entries(store ?? {})) {
    if (momentId === '_meta') continue;
    for (const u of entry?.updates ?? []) if (isRecheckable(u, retentionFloor)) slugs.add(u.vehicle);
  }
  /** slug -> why it is not checked tonight */
  const unfit = new Map();
  for (const slug of [...slugs].sort()) {
    const problem = listProblem(listsBySlug?.get(slug));
    if (problem) {
      unfit.set(slug, problem);
      skipped.push(`${slug}: not checked tonight — ${problem}`);
    }
  }

  for (const [momentId, entry] of Object.entries(store ?? {})) {
    if (momentId === '_meta') continue;
    const byVehicle = new Map();
    for (const u of entry?.updates ?? []) {
      if (!isRecheckable(u, retentionFloor) || unfit.has(u.vehicle)) continue;
      if (!byVehicle.has(u.vehicle)) byVehicle.set(u.vehicle, []);
      byVehicle.get(u.vehicle).push(u);
    }
    for (const [slug, rows] of byVehicle) {
      const { checked: n, results } = judgeBill(rows, listsBySlug.get(slug), retentionFloor);
      checked += n;
      const tally = perBill.get(slug) ?? { checked: 0, changed: 0 };
      tally.checked += n;
      for (const r of results) {
        if (r.outcome === 'left') left.push(`${momentId}/${r.row.id} (${slug} ${r.row.day}): left as it is — ${r.why}`);
        if (r.outcome === 'reworded' || r.outcome === 'withdrawn') tally.changed++;
        if (r.outcome !== 'unchanged' && r.outcome !== 'left') {
          if (!planned.has(momentId)) planned.set(momentId, new Map());
          planned.get(momentId).set(r.row.id, r);
        }
      }
      perBill.set(slug, tally);
    }
  }

  // Nothing to apply: the store itself comes back, untouched.
  if (planned.size === 0) return { store, changes, left, skipped, refused: null, checked };

  // Apply, per question.
  const next = { ...store };
  for (const [momentId, results] of planned) {
    const entry = store[momentId];
    const taken = new Set((entry.updates ?? []).map((u) => u.id));
    /** old id -> new id */
    const remap = new Map();
    const updates = (entry.updates ?? []).map((u) => {
      const r = results.get(u.id);
      if (!r) return u;
      const rechecks = Array.isArray(u.rechecks) ? [...u.rechecks] : [];
      if (r.outcome === 'withdrawn') {
        changes.push({ momentId, kind: 'withdrawn', id: u.id, vehicle: u.vehicle, day: u.day, was: u.record.action_text });
        return { ...u, withdrawn_on: today, rechecks: [...rechecks, { on: today, outcome: 'withdrawn' }] };
      }
      if (r.outcome === 'reinstated') {
        changes.push({ momentId, kind: 'reinstated', id: u.id, vehicle: u.vehicle, day: u.day, was: u.record.action_text });
        const rest = { ...u };
        delete rest.withdrawn_on;
        return { ...rest, rechecks: [...rechecks, { on: today, outcome: 'reinstated' }] };
      }
      // reworded
      const record = { ...u.record, action_text: r.words };
      const base = { ...u, record };
      const newId = computeUpdateId(momentId, base);
      if (newId !== u.id && taken.has(newId)) {
        left.push(`${momentId}/${u.id} (${u.vehicle} ${u.day}): left as it is — the record's words "${r.words}" would give it the id of stored row ${newId}`);
        const tally = perBill.get(u.vehicle);
        if (tally) tally.changed--;
        return u;
      }
      taken.add(newId);
      if (newId !== u.id) remap.set(u.id, newId);
      changes.push({ momentId, kind: 'reworded', id: u.id, newId, vehicle: u.vehicle, day: u.day, was: u.record.action_text, now: r.words });
      const corrected = {
        ...base,
        id: newId,
        // The line printed so far was written from the earlier words. Until a
        // decode of the record's words replaces it, the row prints the
        // record's words themselves (rule 4: never a line the record no
        // longer supports).
        text: fallbackText(base),
        ai: false,
        rechecks: [...rechecks, { on: today, outcome: 'reworded', was: u.record.action_text, was_id: u.id }],
      };
      // `id` stays the row's first key (spreading `u` kept its place).
      return corrected;
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

  // The guards on the night as a whole.
  const changed = changes.filter((c) => c.kind !== 'reinstated').length;
  let refused = null;
  if (changed > RECHECK_MAX_CHANGES) {
    refused = `${changed} rows would be corrected or withdrawn in one night, more than the ${RECHECK_MAX_CHANGES} the re-check allows at once — that looks like the source being wrong, not the record being edited; nothing was changed`;
  } else {
    for (const [slug, t] of [...perBill].sort()) {
      if (t.checked >= RECHECK_BILL_SHARE_MIN_ROWS && t.changed / t.checked > RECHECK_MAX_BILL_SHARE) {
        refused = `${t.changed} of ${slug}'s ${t.checked} checked rows would be corrected or withdrawn in one night, more than half — that looks like the source being wrong for that bill; nothing was changed`;
        break;
      }
    }
  }
  if (refused) return { store, changes, left, skipped, refused, checked };
  return { store: next, changes, left, skipped, refused: null, checked };
}

export { liveUpdates };
