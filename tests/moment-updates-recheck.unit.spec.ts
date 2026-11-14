import { expect, test } from '@playwright/test';
/*
 * THE NIGHTLY RE-CHECK OF STORED LINES AGAINST THE RECORD (owner, 2026-11-14,
 * answer 92 a): "A nightly re-check of every stored update text against the
 * record: a line the record no longer holds is corrected to the record's
 * words or marked withdrawn, and the run says so."
 *
 * Every outcome and every guard is pinned here on stubbed action lists, with
 * the two college-athletes rows the card found as the worked case: S. 4668's
 * "The committee substitute withdrawn by Voice Vote." (u_d5eaf6d9, 2026-09-24),
 * which Congress.gov's list now gives as "… tabled by Voice Vote.", and
 * "Cloture motion on amendment SA 6776 presented in Senate." (u_682cca41,
 * 2026-09-17), which no row of the list holds. The list stub is the
 * committed S. 4668 fixture (Congress.gov, 2026-09-25) with the one change
 * the record has made since: "withdrawn" read as "tabled" (both words appear
 * in the repo's tests already). Pure: no network, no model.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkMomentUpdates,
  collapseRedundantStatusChanges,
  collapseSameActions,
  computeUpdateId,
  liveUpdates,
  recheckFieldProblems,
} from '../lib/moment-updates-gate.mjs';
import {
  RECHECK_MAX_CHANGES,
  isRewording,
  judgeBill,
  listProblem,
  recheckStore,
  recheckWords,
} from '../lib/moment-updates-recheck.mjs';
import { verifyMomentUpdates } from '../lib/verify-moment-updates.mjs';
import { readableEntry } from '../lib/moment-updates';
import { fallbackTextFor } from '../scripts/moment-updates-map.mjs';
import { fetchWholeActionList, planSummaries, recheckSummaryMarkdown, recordMovedSince } from '../scripts/moment-updates.mjs';

// The rows are the stored JSON shape, read loosely, as the gate itself reads them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const MOMENT = 'paying-college-athletes';
const VEHICLE = 's-4668-119';
const NOW = Date.parse('2026-11-14T23:00:00Z'); // 6 PM ET
const TODAY = '2026-11-14';
const readJson = (p: string) => JSON.parse(readFileSync(join(process.cwd(), p), 'utf8'));

const FIXTURE: Row[] = readJson('tests/fixtures/congress-actions-s4668.json').actions;
/** S. 4668's list as the record holds it now: the fixture, with "withdrawn" read as "tabled". */
const RECORD_NOW: Row[] = FIXTURE.map((a) =>
  a.text === 'The committee substitute withdrawn by Voice Vote.' ? { ...a, text: 'The committee substitute tabled by Voice Vote.' } : a,
);
const list = (actions: Row[], total: number | null = actions.length) => ({ actions, total });
const lists = (actions: Row[] = RECORD_NOW) => new Map([[VEHICLE, list(actions)]]);

function row(over: Row): Row {
  const base: Row = {
    class: 'floor_action',
    vehicle: VEHICLE,
    day: '2026-09-17',
    occurred_at: '2026-09-17',
    occurred_precision: 'day',
    recorded_at: '2026-09-18T14:29:25.757Z',
    text: { en: 'A line.', es: 'Una línea.' },
    source: { kind: 'congress_actions', refs: ['https://www.congress.gov/bill/119th-congress/senate-bill/4668'] },
    record: { action_text: 'An action.', action_code: null, action_type: 'Floor', source_system: 'Senate' },
    ai: false,
    ...over,
  };
  if (over.day && !over.occurred_at) base.occurred_at = over.day;
  return { ...base, id: over.id ?? computeUpdateId(MOMENT, base) };
}

/** The two rows as the store holds them on 2026-11-14, verbatim. */
const WITHDRAWN_WORDS = row({
  class: 'status_change',
  day: '2026-09-24',
  recorded_at: '2026-09-25T13:41:33.041Z',
  text: { en: '“The committee substitute withdrawn by Voice Vote.”', es: 'Registro oficial, en inglés: “The committee substitute withdrawn by Voice Vote.”' },
  record: {
    action_text: 'The committee substitute withdrawn by Voice Vote.',
    action_code: null,
    action_type: 'latestAction',
    source_system: 'Congress.gov bill detail',
    status_from: 'floor_vote',
    status_to: 'committee',
  },
});
const CLOTURE_SA6776 = row({
  text: {
    en: 'On September 17, 2026, the Senate presented a cloture motion on amendment SA 6776 to S. 4668.',
    es: 'El 17 de septiembre de 2026, el Senado presentó una moción de cierre sobre la enmienda SA 6776 a S. 4668.',
  },
  record: { action_text: 'Cloture motion on amendment SA 6776 presented in Senate.', action_code: null, action_type: 'Floor', source_system: 'Senate' },
  ai: true,
});
/** Rows of the same bill the record still holds (one with its citation since added). */
const HELD = [
  row({ record: { action_text: 'Cloture motion on the measure presented in Senate.', action_code: null, action_type: 'Floor', source_system: 'Senate' } }),
  row({ record: { action_text: 'Motion to proceed to measure considered in Senate.', action_code: null, action_type: 'Floor', source_system: 'Senate' } }),
  row({ class: 'vote', day: '2026-09-24', record: { action_text: 'Cloture on the measure, as amended, invoked in Senate by Yea-Nay Vote. 74 - 25. Record Vote Number: 243.', action_code: null, action_type: 'Floor', source_system: 'Senate' } }),
  row({ day: '2026-09-22', class: 'status_change', record: { action_text: 'Considered by Senate.   (consideration: CR S4851)', action_code: null, action_type: 'latestAction', source_system: 'Congress.gov bill detail' } }),
];
const REVISION = {
  id: 's_00000001',
  generated_at: '2026-09-26T18:10:04.667Z',
  as_of_day: '2026-09-26',
  text: { en: 'x', es: 'x' },
  grounded_in: { vehicle_statuses: { [VEHICLE]: 'floor_vote' }, update_ids: [WITHDRAWN_WORDS.id, CLOTURE_SA6776.id] },
  changed_because: ['x'],
  model: 'claude-sonnet-5-5',
};
const store = (updates: Row[] = [WITHDRAWN_WORDS, CLOTURE_SA6776, ...HELD], revisions: Row[] = [REVISION]) => ({
  _meta: { schema: 1, generated_at: '2026-11-13T21:27:01.988Z' },
  [MOMENT]: { updates, summary_revisions: revisions },
});
const run = (s: Row, l = lists()) => recheckStore(s, l, { now: NOW, fallbackText: fallbackTextFor });
const byId = (s: Row, id: string) => s[MOMENT].updates.find((u: Row) => u.id === id);

test.describe('the matching rule', () => {
  test('whitespace, case and citations are never a change', () => {
    expect(recheckWords('Considered by Senate.   (consideration: CR S4851)')).toBe(recheckWords('considered by senate.'));
    expect(recheckWords('Passed/agreed to in Senate: Passed Senate. (CR S5044)')).toBe(recheckWords('Passed Senate.'));
  });

  test('one word swapped is a rewording; a changed number, or a different action of the same shape, is not', () => {
    const w = (t: string) => recheckWords(t);
    expect(isRewording(w('The committee substitute withdrawn by Voice Vote.'), w('The committee substitute tabled by Voice Vote.'))).toBe(true);
    expect(isRewording(w('Cloture invoked by Yea-Nay Vote. 74 - 25.'), w('Cloture invoked by Yea-Nay Vote. 74 - 24.'))).toBe(false);
    expect(
      isRewording(w('Cloture motion on the measure presented in Senate.'), w('Cloture motion on the motion to proceed to the measure presented in Senate.')),
    ).toBe(false);
    expect(isRewording(w('Held at the desk.'), w('Received in the House.'))).toBe(false);
    expect(isRewording(w('Cloture motion on amendment SA 6776 presented in Senate.'), w('Cloture motion on the measure presented in Senate.'))).toBe(false);
  });
});

test.describe('the three outcomes, on the two college-athletes rows', () => {
  test('REWORDED: "withdrawn by Voice Vote" becomes the record\'s "tabled by Voice Vote", with the earlier words and id kept', () => {
    const r = run(store());
    expect(r.refused).toBeNull();
    const change = r.changes.find((c: Row) => c.id === WITHDRAWN_WORDS.id)!;
    expect(change).toMatchObject({ kind: 'reworded', was: 'The committee substitute withdrawn by Voice Vote.', now: 'The committee substitute tabled by Voice Vote.' });
    const fixed = byId(r.store, change.newId!);
    expect(fixed.record.action_text).toBe('The committee substitute tabled by Voice Vote.');
    expect(fixed.id).toBe(computeUpdateId(MOMENT, fixed));
    expect(fixed.id).not.toBe(WITHDRAWN_WORDS.id);
    expect(fixed.rechecks).toEqual([{ on: TODAY, outcome: 'reworded', was: 'The committee substitute withdrawn by Voice Vote.', was_id: WITHDRAWN_WORDS.id }]);
    // The line printed before was written from the old words: it is replaced
    // by the record's new words in both languages, never kept.
    expect(fixed.text).toEqual(fallbackTextFor(fixed));
    expect(fixed.text.en).toContain('tabled');
    expect(fixed.text.es).toContain('tabled');
    expect(fixed.ai).toBe(false);
    expect(byId(r.store, WITHDRAWN_WORDS.id)).toBeUndefined();
  });

  test('a summary that cited the corrected row now cites it by its new id', () => {
    const r = run(store());
    const newId = r.changes.find((c: Row) => c.kind === 'reworded')!.newId;
    expect(r.store[MOMENT].summary_revisions[0].grounded_in.update_ids).toEqual([newId, CLOTURE_SA6776.id]);
  });

  test('a correction that named the corrected row names its new id', () => {
    const correction = row({ class: 'correction', day: '2026-09-25', corrects: WITHDRAWN_WORDS.id, record: { action_text: 'A correction.', action_code: null, action_type: 'Floor', source_system: 'Senate' } });
    const r = run(store([WITHDRAWN_WORDS, CLOTURE_SA6776, ...HELD, correction]));
    const newId = r.changes.find((c: Row) => c.kind === 'reworded')!.newId;
    expect(byId(r.store, correction.id).corrects).toBe(newId);
  });

  test('WITHDRAWN: the cloture motion on SA 6776, on no row of the record, is kept and marked with the day it was found gone', () => {
    const r = run(store());
    expect(r.changes.find((c: Row) => c.id === CLOTURE_SA6776.id)).toMatchObject({ kind: 'withdrawn', was: 'Cloture motion on amendment SA 6776 presented in Senate.' });
    const gone = byId(r.store, CLOTURE_SA6776.id);
    expect(gone.withdrawn_on).toBe(TODAY);
    expect(gone.rechecks).toEqual([{ on: TODAY, outcome: 'withdrawn' }]);
    expect(gone.record).toEqual(CLOTURE_SA6776.record);
    expect(gone.text).toEqual(CLOTURE_SA6776.text);
  });

  test('UNCHANGED: every other row is the same object, and the night has exactly two changes', () => {
    const r = run(store());
    expect(r.changes.map((c: Row) => c.kind).sort()).toEqual(['reworded', 'withdrawn']);
    for (const u of HELD) expect(byId(r.store, u.id)).toBe(u);
    expect(r.checked).toBe(6);
  });

  test('a second night writes nothing', () => {
    const first = run(store());
    const second = run(first.store);
    expect(second.changes).toEqual([]);
    expect(second.store).toEqual(first.store);
  });

  test('REINSTATED: a withdrawn row the record lists again is an event again, and the return is logged', () => {
    const first = run(store());
    const back = [...RECORD_NOW, { actionDate: '2026-09-17', text: 'Cloture motion on amendment SA 6776 presented in Senate.', sourceSystem: { name: 'Senate' } }]
      .sort((a, b) => (a.actionDate < b.actionDate ? 1 : a.actionDate > b.actionDate ? -1 : 0));
    const r = run(first.store, lists(back));
    expect(r.changes.map((c: Row) => [c.kind, c.id])).toEqual([['reinstated', CLOTURE_SA6776.id]]);
    const row2 = byId(r.store, CLOTURE_SA6776.id);
    expect(Object.hasOwn(row2, 'withdrawn_on')).toBe(false);
    expect(row2.rechecks.map((e: Row) => e.outcome)).toEqual(['withdrawn', 'reinstated']);
  });
});

test.describe('left as it is, never guessed', () => {
  test('the words now sit on another date: left, with a warning', () => {
    const moved = row({ day: '2026-09-16', record: { action_text: 'Cloture motion on the measure presented in Senate.', action_code: null, action_type: 'Floor', source_system: 'Senate' } });
    const r = run(store([moved]));
    expect(r.changes).toEqual([]);
    expect(r.left.join('\n')).toContain('the record lists these words on 2026-09-17');
  });

  test('two actions that day could be its rewording: left', () => {
    const actions = [
      { actionDate: '2026-09-17', text: 'Amendment SA 1 adopted in Senate.', sourceSystem: { name: 'Senate' } },
      { actionDate: '2026-09-17', text: 'Amendment SA 1 rejected in Senate.', sourceSystem: { name: 'Senate' } },
    ];
    const r = run(store([row({ record: { action_text: 'Amendment SA 1 withdrawn in Senate.', action_code: null, action_type: 'Floor', source_system: 'Senate' } })]), lists(actions));
    expect(r.changes).toEqual([]);
    expect(r.left.join('\n')).toContain('2 actions that day could be its rewording');
  });

  test('an action another stored row already reads as is never taken as this row\'s rewording', () => {
    const actions = [{ actionDate: '2026-09-17', text: 'Motion to proceed adopted in Senate.', sourceSystem: { name: 'Senate' } }];
    const held = row({ class: 'vote', record: { action_text: 'Motion to proceed adopted in Senate.', action_code: null, action_type: 'Floor', source_system: 'Senate' } });
    const near = row({ record: { action_text: 'Motion to proceed rejected in Senate.', action_code: null, action_type: 'Floor', source_system: 'Senate' } });
    const r = run(store([held, near]), lists(actions));
    expect(r.changes.map((c: Row) => [c.kind, c.id])).toEqual([['withdrawn', near.id]]);
  });

  test('another chamber, or another action code, is another action', () => {
    const house = [{ actionDate: '2026-09-17', text: 'Motion to proceed adopted in House.', actionCode: 'H1', sourceSystem: { name: 'House floor actions' } }];
    // One word apart, so only the chamber tells them apart.
    const senateRow = row({ record: { action_text: 'Motion to proceed adopted in Senate.', action_code: null, action_type: 'Floor', source_system: 'Senate' } });
    expect(isRewording(recheckWords(senateRow.record.action_text), recheckWords(house[0].text))).toBe(true);
    expect(run(store([senateRow]), lists(house)).changes.map((c: Row) => c.kind)).toEqual(['withdrawn']);
    // One word apart, same chamber: only the code tells them apart.
    const coded = row({ record: { action_text: 'Motion to proceed rejected in House.', action_code: 'H2', action_type: 'Floor', source_system: 'House floor actions' } });
    expect(isRewording(recheckWords(coded.record.action_text), recheckWords(house[0].text))).toBe(true);
    expect(run(store([coded]), lists(house)).changes.map((c: Row) => c.kind)).toEqual(['withdrawn']);
  });

  test('two stored rows that would take one action: both left', () => {
    const actions = [{ actionDate: '2026-09-17', text: 'Motion A made in Senate.', sourceSystem: { name: 'Senate' } }];
    const a = row({ record: { action_text: 'Motion B made in Senate.', action_code: null, action_type: 'Floor', source_system: 'Senate' } });
    const b = row({ class: 'status_change', record: { action_text: 'Motion C made in Senate.', action_code: null, action_type: 'latestAction', source_system: 'Congress.gov bill detail' } });
    const r = run(store([a, b]), lists(actions));
    expect(r.changes).toEqual([]);
    expect(r.left).toHaveLength(2);
  });

  test('a rewording that would give the row the id of a stored row: left', () => {
    const actions = [{ actionDate: '2026-09-17', text: 'Motion A made in Senate.', sourceSystem: { name: 'Senate' } }];
    const old = row({ record: { action_text: 'Motion B made in Senate.', action_code: null, action_type: 'Floor', source_system: 'Senate' } });
    // A withdrawn twin already holds the record's words (and so the id they hash to).
    const twin = { ...row({ record: { action_text: 'Motion A made in Senate.', action_code: null, action_type: 'Floor', source_system: 'Senate' } }), withdrawn_on: '2026-10-01', rechecks: [{ on: '2026-10-01', outcome: 'withdrawn' }] };
    const r = run(store([old, twin]), lists(actions.concat([])));
    // The twin is reinstated (the record holds its words); the old row is left.
    expect(r.changes.map((c: Row) => c.kind)).toEqual(['reinstated']);
    expect(r.left.join('\n')).toContain('would give it the id of stored row');
  });

  test('rows the action list never carried are never checked: a roll call read from the vote record, a floor-feed signal', () => {
    const roll = row({ class: 'vote', source: { kind: 'roll_call', refs: ['https://www.senate.gov/x.xml'] }, record: { action_text: 'On Passage of the Bill S. 4668: Bill Passed.', action_code: null, action_type: 'roll_call', source_system: 'senate.gov' } });
    const signal = row({ class: 'scheduled', source: { kind: 'tier0_feed', refs: ['https://www.congress.gov/rss'] }, record: { action_text: 'S.4668 on the floor today', action_code: null, action_type: 'tier0', source_system: 'feed' } });
    const r = run(store([roll, signal]));
    expect(r.changes).toEqual([]);
    expect(r.checked).toBe(0);
  });

  test('a row older than retention is not checked', () => {
    const old = row({ day: '2026-08-05', record: { action_text: 'Not on the record.', action_code: null, action_type: 'Floor', source_system: 'Senate' } });
    expect(run(store([old])).changes).toEqual([]);
  });
});

test.describe('the guards: a wrong night from the source never withdraws a row', () => {
  const s = store();
  for (const [name, l] of [
    ['the list did not arrive', new Map()],
    ['it arrived empty', lists([])],
    ['it is shorter than the count it gives (a partial page)', new Map([[VEHICLE, list(RECORD_NOW.slice(0, 10), RECORD_NOW.length)]])],
    ['it gives no count', new Map([[VEHICLE, list(RECORD_NOW, null)]])],
    ['it is not newest first', lists([...RECORD_NOW].reverse())],
  ] as [string, Map<string, { actions: Row[]; total: number | null }>][]) {
    test(`${name}: the bill is not checked, nothing changes`, () => {
      const r = run(s, l);
      expect(r.changes).toEqual([]);
      expect(r.store).toBe(s);
      expect(r.skipped.join('\n')).toContain(VEHICLE);
    });
  }

  test('listProblem names each', () => {
    expect(listProblem(undefined)).toMatch(/not fetched/);
    expect(listProblem(list([]))).toMatch(/empty/);
    expect(listProblem(list(RECORD_NOW.slice(0, 3), 25))).toMatch(/holds 3 of the 25/);
    expect(listProblem(list(RECORD_NOW, null))).toMatch(/does not say how many/);
    expect(listProblem(list([...RECORD_NOW].reverse()))).toMatch(/not newest first/);
    expect(listProblem(list(RECORD_NOW))).toBeNull();
  });

  test('a row dated after the newest action in the list is not judged', () => {
    const later = row({ day: '2026-10-05', record: { action_text: 'Held at the desk.', action_code: 'H15000', action_type: 'Floor', source_system: 'House floor actions' } });
    const { checked, results } = judgeBill([later], list(RECORD_NOW), '2026-09-15');
    expect(checked).toBe(0);
    expect(results).toEqual([]);
  });

  test(`more than ${RECHECK_MAX_CHANGES} changes in one night: every change is refused, the store is untouched, and the reason says so`, () => {
    const gone = Array.from({ length: RECHECK_MAX_CHANGES + 1 }, (_, i) =>
      row({ record: { action_text: `Not on the record ${i}.`, action_code: null, action_type: 'Floor', source_system: 'Senate' } }),
    );
    const held = Array.from({ length: 10 }, () => HELD[0]).map((u, i) => ({ ...u, id: `u_0000000${i}` }));
    const s2 = store([...gone, ...held]);
    const r = run(s2);
    expect(r.refused).toMatch(new RegExp(`${RECHECK_MAX_CHANGES + 1} rows would be corrected or withdrawn in one night`));
    expect(r.store).toBe(s2);
    expect(r.changes).toHaveLength(RECHECK_MAX_CHANGES + 1);
    expect(recheckSummaryMarkdown(r)).toContain('Refused, nothing changed');
  });

  test(`exactly ${RECHECK_MAX_CHANGES} changes is allowed`, () => {
    const gone = Array.from({ length: RECHECK_MAX_CHANGES }, (_, i) =>
      row({ record: { action_text: `Not on the record ${i}.`, action_code: null, action_type: 'Floor', source_system: 'Senate' } }),
    );
    const r = run(store([...gone, ...HELD, ...HELD.map((u, i) => ({ ...u, id: `u_1000000${i}` }))]));
    expect(r.refused).toBeNull();
    expect(r.changes).toHaveLength(RECHECK_MAX_CHANGES);
  });

  test('more than half of one bill\'s checked rows at once: refused', () => {
    const r = run(store([CLOTURE_SA6776, WITHDRAWN_WORDS, HELD[0]]));
    expect(r.refused).toMatch(/2 of s-4668-119's 3 checked rows/);
    expect(r.changes.every((c: Row) => c.kind !== 'reinstated')).toBe(true);
  });
});

test.describe('what the page, the summaries and the collapses do with a withdrawn row', () => {
  const after = run(store()).store;
  const updates: Row[] = after[MOMENT].updates;

  test('the page never reads it', () => {
    const read = readableEntry(after[MOMENT]);
    expect(read.updates.map((u) => u.id)).not.toContain(CLOTURE_SA6776.id);
    expect(read.updates).toHaveLength(updates.length - 1);
    expect(liveUpdates(updates).map((u: Row) => u.id)).not.toContain(CLOTURE_SA6776.id);
  });

  test('a live row is never folded into it, and it is never folded into a live one', () => {
    const gone = byId(after, CLOTURE_SA6776.id);
    const same = row({ recorded_at: '2026-09-19T00:00:00Z', record: { ...CLOTURE_SA6776.record, action_text: `${CLOTURE_SA6776.record.action_text} (CR S1)` } });
    expect(collapseSameActions([gone, same]).kept).toHaveLength(2);
    const status = row({ class: 'status_change', record: { ...CLOTURE_SA6776.record, action_type: 'latestAction', source_system: 'Congress.gov bill detail' } });
    expect(collapseRedundantStatusChanges([gone, status]).kept).toHaveLength(2);
  });

  test('it is no news to a summary', () => {
    const entry = { updates: [byId(after, CLOTURE_SA6776.id)], summary_revisions: [{ grounded_in: { update_ids: [], roll_calls: [] } }] };
    expect(recordMovedSince(entry, [], '2026-09-01')).toBe(false);
  });

  test('a model-written summary that cites a changed row is rewritten; a record-only one is not', () => {
    const moments = { [MOMENT]: { status: 'live', vehicles: [{ slug: VEHICLE }] } };
    const bills = new Map([[VEHICLE, { status: 'floor_vote', last_action_text: 'x', last_action_date: '2026-09-24', bill_type: 's' }]]);
    const rev = { ...REVISION, generated_at: '2026-11-14T12:00:00Z', grounded_in: { ...REVISION.grounded_in, update_ids: [CLOTURE_SA6776.id] } };
    const plan = (r: Row, rechecked: Set<string>) =>
      planSummaries({ mode: 'nightly', moments, store: { [MOMENT]: { updates, summary_revisions: [r] } }, billBySlug: bills, now: NOW, rechecked, unsupportedStatus: () => false })[0];
    expect(plan(rev, new Set([CLOTURE_SA6776.id]))).toMatchObject({ generate: true, reason: expect.stringContaining('record re-check') });
    expect(plan(rev, new Set()).generate).toBe(false);
    expect(plan({ ...rev, model: 'record-only' }, new Set([CLOTURE_SA6776.id])).generate).toBe(false);
  });
});

test.describe('the CI gate and the pre-commit check', () => {
  const moments = readJson('data/moments.json');
  const bills: { full_identifier: string }[] = readJson('data/bills.json');
  const slugs = new Set(bills.map((b) => b.full_identifier));
  const violationsOf = (s: Row) =>
    checkMomentUpdates(s, moments, slugs, { now: NOW }).violations.filter((v: string) => /rechecks|withdrawn_on/.test(v));
  const failuresOf = (s: Row) => verifyMomentUpdates({ updates: s, now: NOW }).failures.filter((f: string) => f.includes('re-check'));

  test('accept what the re-check writes', () => {
    const after = run(store()).store;
    expect(violationsOf(after)).toEqual([]);
    expect(failuresOf(after)).toEqual([]);
  });

  const gone = (over: Row) => ({ ...CLOTURE_SA6776, withdrawn_on: TODAY, rechecks: [{ on: TODAY, outcome: 'withdrawn' }], ...over });
  for (const [name, u] of [
    ['withdrawn_on with no rechecks entry', { ...CLOTURE_SA6776, withdrawn_on: TODAY }],
    ['withdrawn_on in the future', gone({ withdrawn_on: '2026-11-20', rechecks: [{ on: '2026-11-20', outcome: 'withdrawn' }] })],
    ['withdrawn_on before the row\'s own day', gone({ withdrawn_on: '2026-09-01', rechecks: [{ on: '2026-09-01', outcome: 'withdrawn' }] })],
    ['withdrawn_on that is not a day', gone({ withdrawn_on: 'yesterday' })],
    ['a last entry that withdrew the row, with no withdrawn_on', { ...CLOTURE_SA6776, rechecks: [{ on: TODAY, outcome: 'withdrawn' }] }],
    ['a correction that does not keep the earlier words', { ...CLOTURE_SA6776, rechecks: [{ on: TODAY, outcome: 'reworded', was_id: 'u_00000001' }] }],
    ['a correction with no earlier id', { ...CLOTURE_SA6776, rechecks: [{ on: TODAY, outcome: 'reworded', was: 'x' }] }],
    ['an unknown outcome', { ...CLOTURE_SA6776, rechecks: [{ on: TODAY, outcome: 'deleted' }] }],
    ['entries out of order', { ...CLOTURE_SA6776, rechecks: [{ on: TODAY, outcome: 'reinstated' }, { on: '2026-10-01', outcome: 'reinstated' }] }],
    ['an empty log', { ...CLOTURE_SA6776, rechecks: [] }],
    ['re-check fields on a row the action list never carried', gone({ source: { kind: 'roll_call', refs: ['https://www.senate.gov/x.xml'] } })],
  ] as [string, Row][]) {
    test(`refuse ${name}`, () => {
      expect(recheckFieldProblems(u, TODAY).length).toBeGreaterThan(0);
      expect(violationsOf(store([u, ...HELD], []))).not.toEqual([]);
      expect(failuresOf(store([u, ...HELD], []))).toHaveLength(1);
    });
  }
});

test.describe('the runner', () => {
  test('fetchWholeActionList reads every page until it holds the count the response gives', async () => {
    const all = Array.from({ length: 600 }, (_, i) => ({ actionDate: '2026-09-17', text: `a${i}` }));
    const offsets: number[] = [];
    const got = await fetchWholeActionList(VEHICLE, async (_path: string, p: { limit: number; offset: number }) => {
      offsets.push(p.offset);
      return { actions: all.slice(p.offset, p.offset + p.limit), pagination: { count: all.length } };
    });
    expect(offsets).toEqual([0, 250, 500]);
    expect(got.actions).toHaveLength(600);
    expect(got.total).toBe(600);
  });

  test('the step summary names every correction and withdrawal', () => {
    const md = recheckSummaryMarkdown(run(store()));
    expect(md).toContain('was "The committee substitute withdrawn by Voice Vote."'.replace('was', 'Was'));
    expect(md).toContain('now "The committee substitute tabled by Voice Vote."');
    expect(md).toContain(`${CLOTURE_SA6776.id}: withdrawn (the record no longer holds it)`);
  });
});

test('the committed file passes the gate with no re-check fields yet, and every row it holds is one the reader prints', () => {
  const real = readJson('data/moment-updates.json');
  for (const [id, entry] of Object.entries(real) as [string, Row][]) {
    if (id === '_meta') continue;
    for (const u of entry.updates) expect(recheckFieldProblems(u, TODAY), `${id}/${u.id}`).toEqual([]);
  }
});
