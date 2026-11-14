import { expect, test } from '@playwright/test';
/*
 * THE NIGHTLY RE-CHECK OF STORED LINES AGAINST THE RECORD (owner, 2026-11-14,
 * answer 92 a): "A nightly re-check of every stored update text against the
 * record: a line the record no longer holds is corrected to the record's
 * words or marked withdrawn, and the run says so."
 *
 * Every rule, outcome and guard of lib/moment-updates-recheck.mjs is pinned
 * here on stubbed action lists, including each case the independent check of
 * 2026-11-14 raised: a corrected vote tally, a long action edited past its
 * id's first 120 characters, punctuation-only edits, outcome flips, a wrong
 * bill's list, a list missing a day, a row naming an amendment, a quote the
 * lint refuses, the one-night override, a re-check that throws, and a
 * summary rewrite that must stay due until done.
 *
 * The list stub is the committed S. 4668 fixture (Congress.gov, 2026-09-25)
 * with the one change the record has made since, read on 2026-09-30:
 * "withdrawn" became "tabled" (both words appear in the repo's tests
 * already). Pure: no network, no model.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkMomentUpdates,
  collapseRedundantStatusChanges,
  collapseSameActions,
  computeUpdateId,
  liveUpdates,
  lintUpdateText,
  pruneEntry,
  recheckFieldProblems,
} from '../lib/moment-updates-gate.mjs';
import {
  OUTCOME_CLASSES,
  RECHECK_MAX_CHANGES,
  acceptListProblems,
  acceptedIds,
  amendmentNamed,
  amendmentsNamedInStore,
  heldRows,
  isHeld,
  judgeBill,
  nextRecheckReport,
  parseAcceptFile,
  recheckReportProblems,
  releaseHeldRow,
  voteFrame,
  listProblem,
  recheckPendingIds,
  recheckStore,
  recheckWords,
  rewordingProblem,
  withinReach,
} from '../lib/moment-updates-recheck.mjs';
import { verifyMomentUpdates } from '../lib/verify-moment-updates.mjs';
import { readableEntry } from '../lib/moment-updates';
import { fallbackTextFor } from '../scripts/moment-updates-map.mjs';
import {
  amendmentActionsPath,
  fetchWholeActionList,
  guardedRecheck,
  planSummaries,
  recheckSummaryMarkdown,
  recollectDayCandidates,
  recordMovedSince,
  writeStaleRecheckFallbacks,
  writeSummaries,
} from '../scripts/moment-updates.mjs';
import { alarms, formatHealthAlarmComment, parseRecheckTrouble, recheckFindings, recheckHeldRows } from '../lib/pipeline-health.mjs';

// The rows are the stored JSON shape, read loosely, as the gate itself reads them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
type List = { actions: Row[]; total: number | null; request: Row | null };

const MOMENT = 'paying-college-athletes';
const VEHICLE = 's-4668-119';
const NOW = Date.parse('2026-11-14T23:00:00Z'); // 6 PM ET
const TODAY = '2026-11-14';
const readJson = (p: string) => JSON.parse(readFileSync(join(process.cwd(), p), 'utf8'));
const REQUEST = { billType: 's', billNumber: '4668', congress: '119' };

const FIXTURE: Row[] = readJson('tests/fixtures/congress-actions-s4668.json').actions;
/** S. 4668's list as the record holds it now: the fixture, with "withdrawn" read as "tabled". */
const RECORD_NOW: Row[] = FIXTURE.map((a) =>
  a.text === 'The committee substitute withdrawn by Voice Vote.' ? { ...a, text: 'The committee substitute tabled by Voice Vote.' } : a,
);
const list = (actions: Row[], total: number | null = actions.length, request: Row | null = REQUEST): List => ({ actions, total, request });
const lists = (actions: Row[] = RECORD_NOW) => new Map([[VEHICLE, list(actions)]]);
const senate = (day: string, text: string, extra: Row = {}) => ({ actionDate: day, text, sourceSystem: { name: 'Senate' }, ...extra });
const newestFirst = (actions: Row[]) => [...actions].sort((a, b) => (a.actionDate < b.actionDate ? 1 : a.actionDate > b.actionDate ? -1 : 0));

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
const said = (text: string, over: Row = {}) => row({ ...over, record: { action_text: text, action_code: null, action_type: 'Floor', source_system: 'Senate', ...(over.record ?? {}) } });

/** The two college-athletes rows as the store holds them on 2026-11-14, verbatim. */
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
/** Rows of the same bill the record still holds (spacing and a citation aside). */
const HELD = [
  said('Cloture motion on the measure presented in Senate.'),
  said('Motion to proceed to measure considered in Senate.'),
  said('Cloture on the measure, as amended, invoked in Senate by Yea-Nay Vote. 74 - 25. Record Vote Number: 243.', { class: 'vote', day: '2026-09-24' }),
  said('Considered by Senate.   (consideration: CR S4851)', { day: '2026-09-22', class: 'status_change', record: { action_type: 'latestAction', source_system: 'Congress.gov bill detail' } }),
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
const lintText = (r: Row) => (['en', 'es'] as const).flatMap((lang) => lintUpdateText(r.text[lang], lang, r.class, []));
const run = (s: Row, l: Map<string, List> = lists(), extra: Row = {}) => recheckStore(s, l, { now: NOW, fallbackText: fallbackTextFor, lintText, ...extra });
const byId = (s: Row, id: string) => s[MOMENT].updates.find((u: Row) => u.id === id);
const kinds = (r: Row) => r.changes.map((c: Row) => [c.kind, c.id]);

test.describe('words and the rewording test', () => {
  test('spacing, case, citations and punctuation are never a change', () => {
    const same = (a: string, b: string) => expect(recheckWords(a)).toEqual(recheckWords(b));
    same('Considered by Senate.   (consideration: CR S4851)', 'considered by senate.');
    same('Passed/agreed to in Senate: Passed Senate. (CR S5044)', 'Passed Senate.');
    same("Motion by Senator Thune's office", 'Motion by Senator Thune’s office');
    same('Yea-Nay Vote. 74 - 25.', 'Yea-Nay Vote. 74–25.');
    same('Received S. 4668 in the House.', 'Received S.4668 in the House.');
  });

  test('the outcome classes are the ones written in the header', () => {
    expect(OUTCOME_CLASSES).toEqual({ carried: ['agreed', 'passed', 'invoked'], did_not_carry: ['rejected', 'failed'], set_aside: ['withdrawn', 'tabled', 'fell'] });
  });

  test('a swap inside one outcome class passes; anything that changes which way it went fails', () => {
    const p = (a: string, b: string) => rewordingProblem(recheckWords(a), recheckWords(b));
    expect(p('The committee substitute withdrawn by Voice Vote.', 'The committee substitute tabled by Voice Vote.')).toBeNull();
    expect(p('Motion to proceed agreed to in Senate by Voice Vote.', 'Motion to proceed rejected in Senate by Voice Vote.')).not.toBeNull();
    expect(p('Amendment SA 1 agreed in Senate.', 'Amendment SA 1 rejected in Senate.')).toMatch(/changes which way it went \(carried → did_not_carry\)/);
    expect(p('Amendment SA 1 passed in Senate.', 'Amendment SA 1 tabled in Senate.')).toMatch(/changes which way it went/);
    expect(p('Motion to proceed agreed to in Senate.', 'Motion to proceed not agreed to in Senate.')).toMatch(/added or removed/);
    expect(p('Cloture on the measure invoked in Senate.', 'Cloture on the measure not invoked in Senate.')).toMatch(/added or removed/);
    expect(p('Passed Senate without amendment by Voice Vote.', 'Passed House without amendment by Voice Vote.')).toMatch(/not a swap between two outcome words/);
    expect(p('Motion to proceed made in Senate.', 'Motion to proceed considered in Senate.')).toMatch(/not a swap between two outcome words/);
    expect(p('Motion A withdrawn in Senate.', 'Motion B tabled in Senate.')).toMatch(/2 words changed/);
    expect(p('Cloture invoked by Yea-Nay Vote. 74 - 25.', 'Cloture invoked by Yea-Nay Vote. 74 - 24.')).toMatch(/not a swap between two outcome words/);
    expect(p('Amendment SA 1 withdrawn in Senate.', 'Amendment SA 1 tabled by Senator Cruz in Senate.')).toMatch(/added or removed/);
  });

  test('reach: two words at most, never more than a quarter of the sentence', () => {
    const r = (a: string, b: string) => withinReach(recheckWords(a), recheckWords(b));
    expect(r('The committee substitute withdrawn by Voice Vote.', 'The committee substitute tabled by Voice Vote.')).toBe(true);
    expect(r('Held at the desk.', 'Received in the House.')).toBe(false);
  });
});

test.describe('the two college-athletes rows', () => {
  test('"withdrawn by Voice Vote" takes the record\'s "tabled by Voice Vote" (one set-aside word for another), with the earlier words and id kept', () => {
    const r = run(store());
    expect(r.refused).toBeNull();
    const change = r.changes.find((c: Row) => c.id === WITHDRAWN_WORDS.id)!;
    expect(change).toMatchObject({ kind: 'reworded', how: 'a rewording', now: 'The committee substitute tabled by Voice Vote.' });
    const fixed = byId(r.store, change.newId!);
    expect(fixed.record.action_text).toBe('The committee substitute tabled by Voice Vote.');
    expect(fixed.id).toBe(computeUpdateId(MOMENT, fixed));
    expect(fixed.rechecks).toEqual([
      { on: TODAY, at: new Date(NOW).toISOString(), outcome: 'reworded', was: 'The committee substitute withdrawn by Voice Vote.', was_id: WITHDRAWN_WORDS.id },
    ]);
    expect(fixed.text).toEqual(fallbackTextFor(fixed));
    expect(fixed.text.es).toContain('tabled');
    expect(fixed.ai).toBe(false);
    expect(r.store[MOMENT].summary_revisions[0].grounded_in.update_ids).toEqual([fixed.id, CLOTURE_SA6776.id]);
  });

  test('the cloture motion on SA 6776 is LEFT, not withdrawn, while the amendment\'s own list has not been read', () => {
    const r = run(store());
    expect(byId(r.store, CLOTURE_SA6776.id)).toBe(CLOTURE_SA6776);
    expect(r.left.join('\n')).toMatch(/u_682cca41 .*names amendment 119-samdt-6776/);
    expect(kinds(r)).toEqual([['reworded', WITHDRAWN_WORDS.id]]);
  });

  test('the rest is untouched, and a second night writes nothing', () => {
    const first = run(store());
    for (const u of HELD) expect(byId(first.store, u.id)).toBe(u);
    const second = run(first.store);
    expect(second.changes).toEqual([]);
    expect(second.store).toBe(first.store);
  });
});

test.describe('rule 1: a vote is never hidden when the record corrects it', () => {
  const VOTE = said('Cloture on the measure, as amended, invoked in Senate by Yea-Nay Vote. 74 - 25. Record Vote Number: 243.', {
    class: 'vote',
    day: '2026-09-24',
    record: { roll_call: { chamber: 'senate', number: 243 } },
  });
  const corrected = (text: string) =>
    newestFirst([...RECORD_NOW.filter((a) => !/Record Vote Number: 243/.test(a.text)), senate('2026-09-24', text, { recordedVotes: [{ chamber: 'Senate', rollNumber: 243 }] })]);

  test('a corrected tally becomes the record\'s words, under the same id, and stays on the page', () => {
    const words = 'Cloture on the measure, as amended, invoked in Senate by Yea-Nay Vote. 74 - 24. Record Vote Number: 243.';
    const r = run(store([VOTE, ...HELD.slice(0, 2)], []), lists(corrected(words)));
    expect(kinds(r)).toEqual([['reworded', VOTE.id]]);
    const fixed = byId(r.store, VOTE.id);
    expect(fixed.record.action_text).toBe(words);
    expect(Object.hasOwn(fixed, 'withdrawn_on')).toBe(false);
    expect(readableEntry(r.store[MOMENT]).updates.map((u) => u.id)).toContain(VOTE.id);
    expect(r.changes[0].how).toBe('same roll call (senate:243)');
  });

  test('the roll number in the record\'s words is enough when recordedVotes is absent', () => {
    const words = 'Cloture on the measure, as amended, invoked in Senate by Yea-Nay Vote. 75 - 25. Record Vote Number: 243.';
    const actions = newestFirst([...RECORD_NOW.filter((a) => !/Record Vote Number: 243/.test(a.text)), senate('2026-09-24', words)]);
    const r = run(store([VOTE, ...HELD.slice(0, 2)], []), lists(actions));
    expect(byId(r.store, VOTE.id).record.action_text).toBe(words);
  });

  test('even "invoked" to "not invoked" is taken when the roll number names the vote', () => {
    const words = 'Cloture on the measure, as amended, not invoked in Senate by Yea-Nay Vote. 74 - 25. Record Vote Number: 243.';
    const r = run(store([VOTE, ...HELD.slice(0, 2)], []), lists(corrected(words)));
    expect(byId(r.store, VOTE.id).record.action_text).toBe(words);
  });

  test("the chamber's own row is preferred to the Library of Congress echo of the same roll call", () => {
    const words = 'Cloture on the measure, as amended, invoked in Senate by Yea-Nay Vote. 74 - 24. Record Vote Number: 243.';
    const actions = newestFirst([
      ...RECORD_NOW.filter((a) => !/Record Vote Number: 243/.test(a.text)),
      senate('2026-09-24', words, { recordedVotes: [{ chamber: 'Senate', rollNumber: 243 }] }),
      { actionDate: '2026-09-24', text: 'Cloture invoked in Senate: Cloture on the measure, as amended, invoked in Senate by Yea-Nay Vote. 74 - 23. Record Vote Number: 243.', sourceSystem: { name: 'Library of Congress' }, recordedVotes: [{ chamber: 'Senate', rollNumber: 243 }] },
    ]);
    const r = run(store([VOTE, ...HELD.slice(0, 2)], []), lists(actions));
    expect(byId(r.store, VOTE.id).record.action_text).toBe(words);
  });

  test('two different sentences carrying the roll number: left, never hidden', () => {
    const actions = newestFirst([
      ...RECORD_NOW.filter((a) => !/Record Vote Number: 243/.test(a.text)),
      senate('2026-09-24', 'Cloture on the measure, as amended, invoked in Senate by Yea-Nay Vote. 74 - 24. Record Vote Number: 243.'),
      senate('2026-09-24', 'Cloture on the measure, as amended, invoked in Senate by Yea-Nay Vote. 74 - 23. Record Vote Number: 243.'),
    ]);
    const r = run(store([VOTE, ...HELD.slice(0, 2)], []), lists(actions));
    expect(r.changes).toEqual([]);
    expect(r.left.join('\n')).toContain('carry roll call senate:243');
  });

  test('rule 3: a long action edited past its id\'s first 120 characters is never withdrawn', () => {
    const long = 'Motion by Senator Thune to recommit to Senate Committee on Commerce, Science, and Transportation with instructions to report back forthwith with the following amendment (SA 6781) withdrawn in Senate.';
    const r0 = said(long, { day: '2026-09-22' });
    const edit = (tail: string) => newestFirst([...RECORD_NOW.filter((a) => !/Thune to recommit/.test(a.text) || a.actionDate !== '2026-09-22'), senate('2026-09-22', long.replace('withdrawn in Senate.', tail))]);
    // An outcome flip past the 120 characters: left, never hidden.
    const flip = run(store([r0, ...HELD], []), lists(edit('agreed in Senate.')));
    expect(flip.changes).toEqual([]);
    expect(flip.left.join('\n')).toContain("still carries this row's id");
    // A swap inside one class: taken, same id.
    const swap = run(store([r0, ...HELD], []), lists(edit('tabled in Senate.')));
    expect(kinds(swap)).toEqual([['reworded', r0.id]]);
    expect(swap.changes[0].newId).toBe(r0.id);
  });
});

test.describe('rule 2: punctuation-only edits are unchanged, on both nights', () => {
  for (const [stored, listed] of [
    ["Motion by Senator Thune's office made in Senate.", 'Motion by Senator Thune’s office made in Senate.'],
    ['Cloture invoked in Senate by Yea-Nay Vote. 74 - 25.', 'Cloture invoked in Senate by Yea-Nay Vote. 74–25.'],
    ['Received S. 4668 in the Senate.', 'Received S.4668 in the Senate.'],
  ]) {
    test(`"${stored}" against "${listed}"`, () => {
      const u = said(stored, { day: '2026-09-15' });
      const actions = newestFirst([...RECORD_NOW, senate('2026-09-15', listed)]);
      const first = run(store([u, ...HELD], []), lists(actions));
      expect(first.changes).toEqual([]);
      expect(first.left).toEqual([]);
      expect(first.store).toBe(first.store);
      expect(run(first.store, lists(actions)).changes).toEqual([]);
    });
  }
});

test.describe('left as it is', () => {
  test('the words now sit on another date: left, with a warning, not withdrawn', () => {
    const moved = said('Cloture motion on the measure presented in Senate.', { day: '2026-09-16' });
    const r = run(store([moved, ...HELD.slice(1)], []));
    expect(r.changes).toEqual([]);
    expect(r.left.join('\n')).toContain('the record lists these words on 2026-09-17');
  });

  test('a rewording that would give the row the id of a stored row: left', () => {
    const day = '2026-09-16';
    const actions = newestFirst([...RECORD_NOW, senate(day, 'Motion B tabled in Senate.')]);
    const old = said('Motion B withdrawn in Senate.', { day });
    // A withdrawn twin already holds the record's words, and so the id they hash to.
    const twin: Row = { ...said('Motion B tabled in Senate.', { day }), withdrawn_on: '2026-10-01', rechecks: [{ on: '2026-10-01', at: '2026-10-01T20:00:00.000Z', outcome: 'withdrawn' }] };
    const r = run(store([old, twin, ...HELD], []), lists(actions));
    expect(kinds(r)).toEqual([['reinstated', twin.id]]);
    expect(r.left.join('\n')).toContain('would give it the id of stored row');
  });
});

test.describe('round 3: a row never quotes another action, and is never hidden while the record holds it', () => {
  const VOTE = said('Cloture on the measure, as amended, invoked in Senate by Yea-Nay Vote. 74 - 25. Record Vote Number: 243.', {
    class: 'vote',
    day: '2026-09-24',
    record: { roll_call: { chamber: 'senate', number: 243 } },
  });
  const without243 = RECORD_NOW.filter((a) => !/Record Vote Number: 243/.test(a.text));
  const RECONSIDER = 'Motion to reconsider the vote by which cloture on the measure was invoked (Record Vote No. 243) entered in Senate.';

  test('1a · the vote is gone from its day and a motion to reconsider carries roll 243 in recordedVotes: left, never rewritten', () => {
    const actions = newestFirst([...without243, senate('2026-09-24', RECONSIDER, { recordedVotes: [{ chamber: 'Senate', rollNumber: 243 }] })]);
    const r = run(store([VOTE, ...HELD.slice(0, 2)], []), lists(actions));
    expect(r.changes).toEqual([]);
    expect(byId(r.store, VOTE.id).record.action_text).toBe(VOTE.record.action_text);
    expect(r.left.join('\n')).toContain('is on that day\'s list only in another sentence');
  });

  test('1b · the same, with "Record Vote Number: 243" in the other action\'s own words', () => {
    const actions = newestFirst([...without243, senate('2026-09-24', 'Motion to reconsider entered in Senate. Record Vote Number: 243.')]);
    const r = run(store([VOTE, ...HELD.slice(0, 2)], []), lists(actions));
    expect(r.changes).toEqual([]);
    expect(r.left).toHaveLength(1);
  });

  test("1c · the vote's own sentence corrected, but another stored row already quotes it: left", () => {
    const words = 'Cloture on the measure, as amended, invoked in Senate by Yea-Nay Vote. 74 - 24. Record Vote Number: 243.';
    const quoting = said(words, { day: '2026-09-24', class: 'status_change', record: { action_type: 'latestAction', source_system: 'Congress.gov bill detail' } });
    const actions = newestFirst([...without243, senate('2026-09-24', words, { recordedVotes: [{ chamber: 'Senate', rollNumber: 243 }] })]);
    const r = run(store([VOTE, quoting, ...HELD.slice(0, 2)], []), lists(actions));
    expect(r.changes).toEqual([]);
    expect(byId(r.store, VOTE.id).record.action_text).toBe(VOTE.record.action_text);
  });

  test('1d · no action that day carries the roll number at all: left, never withdrawn, never rewritten', () => {
    const actions = newestFirst([...without243, senate('2026-09-24', 'Some other action entirely in Senate.')]);
    const r = run(store([VOTE, ...HELD.slice(0, 2)], []), lists(actions));
    expect(r.changes).toEqual([]);
    expect(r.left.join('\n')).toContain('is not on that day\'s list; a recorded vote is never withdrawn');
  });

  test('voteFrame keeps every word but digits, outcome words and "not"', () => {
    expect(voteFrame(recheckWords('Cloture not invoked by Yea-Nay Vote. 49 - 50.'))).toEqual(['cloture', 'by', 'yea', 'nay', 'vote']);
  });

  test("2 · the row's own words on another date win over a near-twin on its day: left, not rewritten to the twin", () => {
    const u = said('Motion to proceed to measure withdrawn in Senate.', { day: '2026-09-17' });
    const actions = newestFirst([...RECORD_NOW, senate('2026-09-18', 'Motion to proceed to measure withdrawn in Senate.'), senate('2026-09-17', 'Motion to proceed to measure tabled in Senate.')]);
    const r = run(store([u, ...HELD], []), lists(actions));
    expect(r.changes).toEqual([]);
    expect(r.left.join('\n')).toContain('the record lists these words on 2026-09-18, not 2026-09-17');
  });

  const KEY = '119-samdt-6776';
  const amendment = (actions: Row[]) => new Map([[KEY, { actions: newestFirst(actions), total: actions.length, request: { amendmentNumber: '6776', congress: '119', type: 'SAMDT' } }]]);
  test("3a · the amendment's own list has the words on another date: left, not withdrawn", () => {
    const r = run(store(), lists(), { amendmentLists: amendment([senate('2026-09-18', 'Cloture motion on amendment SA 6776 presented in Senate.')]) });
    expect(byId(r.store, CLOTURE_SA6776.id)).toBe(CLOTURE_SA6776);
    expect(r.left.join('\n')).toContain(`amendment ${KEY}'s own record lists these words on 2026-09-18`);
  });

  test("3b · the amendment's own list has it reworded that day (\"filed\"): left, not withdrawn, not rewritten", () => {
    const r = run(store(), lists(), { amendmentLists: amendment([senate('2026-09-17', 'Cloture motion on amendment SA 6776 filed in Senate.')]) });
    expect(byId(r.store, CLOTURE_SA6776.id)).toBe(CLOTURE_SA6776);
    expect(r.left.join('\n')).toContain('lists something close that day');
  });
});

test.describe('round 3: a withdrawn row\'s day is read again in the same run', () => {
  test('a longer sentence the record put in its place is collected (with its position), and one already stored is not', () => {
    const day = '2026-09-17';
    const longer = 'Cloture motion on amendment SA 6776 to the measure presented in Senate, as modified by unanimous consent.';
    const actions = newestFirst([...RECORD_NOW, senate(day, longer)]);
    // One stored row is the list's own action, word for word (its id is the candidate's).
    const exact = said('Motion to proceed to measure considered in Senate. (CR S4773-4774)', { day });
    const s0 = store([HELD[0], exact], []);
    const got = recollectDayCandidates([{ momentId: MOMENT, vehicle: VEHICLE, day, list: list(actions) }], s0, { now: new Date(NOW), recordedAt: new Date(NOW).toISOString(), room: 40 });
    const texts = got.map((c: Row) => c.record.action_text);
    expect(texts).toContain(longer);
    expect(texts).not.toContain('Cloture motion on the measure presented in Senate. (CR S4789)'); // already stored (same action)
    expect(got.map((c: Row) => c.id)).not.toContain(exact.id); // already stored, same id
    expect(got.find((c: Row) => c.record.action_text === longer)!.record.day_position).toBeGreaterThanOrEqual(0);
    expect(recollectDayCandidates([{ momentId: MOMENT, vehicle: VEHICLE, day, list: list(actions) }], s0, { now: new Date(NOW), recordedAt: new Date(NOW).toISOString(), room: 0 })).toEqual([]);
  });
});

test.describe('round 3: trouble reaches a person', () => {
  test("pipeline-health reads a refusal, a throw and a malformed accept list from the nightly's log, in either annotation form", () => {
    const log = [
      'sync\tCollect Moment updates\t2026-11-15T02:01:00Z ##[error]moment-updates record re-check refused: every one of s-4668-119\'s 1 checked row(s) would be corrected, withdrawn or held in one night — that looks like the wrong list for that bill. Nothing was changed; docs/runbooks/record-recheck.md says how to accept these rows for one night.',
      '::error::moment-updates record re-check failed and changed nothing: Error: boom',
      '::error::moment-updates record re-check: data/record-recheck-accept.json: is not valid JSON (x) — nothing is accepted',
    ].join('\n');
    const t = parseRecheckTrouble(log);
    expect(t.refused).toMatch(/^every one of s-4668-119/);
    expect(t.failed).toBe(true);
    expect(t.acceptMalformed).toBe(true);
    expect(parseRecheckTrouble('nothing to see')).toEqual({ refused: null, failed: false, acceptMalformed: false, zeroChecked: false, reported: 0 });
  });

  test('each becomes a ⛔ alarm on the standing issue, and a held row does too', () => {
    const day = '2026-09-16';
    const u = said('Motion to proceed withdrawn in Senate.', { day });
    const actions = newestFirst([...RECORD_NOW.filter((a) => a.actionDate !== day), senate(day, 'Motion to proceed tabled in Senate.')]);
    const heldStore = run(store([u, ...HELD], []), lists(actions), { lintText: () => ['x'] }).store;
    const list2 = alarms({ nightly: { conclusion: 'success' }, recheck: { refused: 'too many', failed: true, acceptMalformed: true, held: recheckHeldRows(heldStore) } });
    const codes = list2.map((a: Row) => a.code);
    expect(codes).toEqual(expect.arrayContaining(['record-recheck-refused', 'record-recheck-failed', 'record-recheck-accept-malformed', 'record-recheck-held']));
    const comment = formatHealthAlarmComment({ date: '2026-11-15', alarms: list2, runUrl: null });
    expect(comment).toContain('refused to change stored timeline lines');
    expect(comment).toContain('HELD by the record re-check');
    expect(alarms({ nightly: { conclusion: 'success' }, recheck: { refused: null, failed: false, acceptMalformed: false, held: [] } }).map((a: Row) => a.code)).not.toContain('record-recheck-held');
  });

  test('a malformed accept file names the file and the fix, never a raw SyntaxError', () => {
    const { value, problems } = parseAcceptFile('{ "accept": [ ');
    expect(value).toBeUndefined();
    expect(problems[0]).toMatch(/^data\/record-recheck-accept\.json: is not valid JSON .* fix it to the shape .* or delete the file$/);
    expect(parseAcceptFile('{"accept":[]}').problems).toEqual([]);
  });
});

test.describe('which rows are read', () => {
  test('rows the action list never carried are never checked: a roll call read from the vote record, a floor-feed signal', () => {
    const roll = said('On Passage of the Bill S. 4668: Bill Passed.', { class: 'vote', source: { kind: 'roll_call', refs: ['https://www.senate.gov/x.xml'] }, record: { action_type: 'roll_call', source_system: 'senate.gov' } });
    const signal = said('S.4668 on the floor today', { class: 'scheduled', source: { kind: 'tier0_feed', refs: ['https://www.congress.gov/rss'] }, record: { action_type: 'tier0', source_system: 'feed' } });
    const r = run(store([roll, signal, ...HELD], []));
    expect(r.changes).toEqual([]);
    expect(r.checked).toBe(HELD.length);
  });

  test('a row older than retention is not checked', () => {
    const old = said('Not on the record.', { day: '2026-08-05' });
    const r = run(store([old, ...HELD], []));
    expect(r.changes).toEqual([]);
    expect(r.checked).toBe(HELD.length);
  });
});

test.describe('rule 4: an outcome flip is never printed as the record\'s words', () => {
  const day = '2026-09-15';
  const base = RECORD_NOW.filter((a) => a.actionDate !== day);
  for (const [stored, listed] of [
    ['Motion to proceed agreed to in Senate by Voice Vote.', 'Motion to proceed rejected in Senate by Voice Vote.'],
    ['Motion to proceed agreed to in Senate by Voice Vote.', 'Motion to proceed not agreed to in Senate by Voice Vote.'],
    ['Cloture on the motion to proceed invoked in Senate.', 'Cloture on the motion to proceed not invoked in Senate.'],
  ]) {
    test(`"${stored}" → "${listed}": left as it is, with a warning, not rewritten, not withdrawn`, () => {
      const u = said(stored, { day });
      const r = run(store([u, ...HELD], []), lists(newestFirst([...base, senate(day, listed)])));
      expect(r.changes).toEqual([]);
      expect(r.left.join('\n')).toContain(`${u.id} `);
    });
  }

  test('"Passed Senate" → "Passed House" where neither row names a chamber in its source: left', () => {
    const u = said('Passed Senate without amendment by Voice Vote.', { day, record: { source_system: 'Library of Congress' } });
    const r = run(store([u, ...HELD], []), lists(newestFirst([...base, { actionDate: day, text: 'Passed House without amendment by Voice Vote.', sourceSystem: { name: 'Library of Congress' } }])));
    expect(r.changes).toEqual([]);
    expect(r.left).toHaveLength(1);
  });

  test('another chamber, or another action code, with an otherwise acceptable swap: left', () => {
    // One same-class word apart; only the chamber (read from the source) or the code tells them apart.
    const house = [{ actionDate: day, text: 'Motion to proceed passed by Voice Vote.', actionCode: 'H1', sourceSystem: { name: 'House floor actions' } }];
    const u1 = said('Motion to proceed agreed by Voice Vote.', { day });
    expect(run(store([u1, ...HELD], []), lists(newestFirst([...base, ...house]))).left.join('\n')).toContain('chamber or action code');
    const u2 = said('Motion to proceed agreed by Voice Vote.', { day, record: { action_code: 'H2', source_system: 'House floor actions' } });
    expect(run(store([u2, ...HELD], []), lists(newestFirst([...base, ...house]))).left.join('\n')).toContain('chamber or action code');
  });

  test('two actions within reach that day: left', () => {
    const u = said('Amendment SA 1 withdrawn in Senate.', { day });
    const actions = newestFirst([...base, senate(day, 'Amendment SA 1 tabled in Senate.'), senate(day, 'Amendment SA 1 fell in Senate.')]);
    const r = run(store([u, ...HELD], []), lists(actions), { amendmentLists: new Map() });
    expect(r.changes).toEqual([]);
    expect(r.left.join('\n')).toContain('2 actions that day are within reach');
  });

  test('an action another stored row (one collected tonight included) already quotes is never this row\'s rewording', () => {
    const quoted = said('Motion to proceed tabled in Senate.', { day, class: 'vote' });
    const u = said('Motion to proceed withdrawn in Senate.', { day });
    const r = run(store([quoted, u, ...HELD], []), lists(newestFirst([...base, senate(day, 'Motion to proceed tabled in Senate.')])));
    expect(kinds(r)).toEqual([['withdrawn', u.id]]);
  });

  test('two rows that would take one action: both left', () => {
    const a = said('Motion A withdrawn in Senate.', { day });
    const b = said('Motion A fell in Senate.', { day, class: 'status_change', record: { action_type: 'latestAction', source_system: 'Congress.gov bill detail' } });
    const r = run(store([a, b, ...HELD], []), lists(newestFirst([...base, senate(day, 'Motion A tabled in Senate.')])));
    expect(r.changes).toEqual([]);
    expect(r.left.join('\n')).toContain('2 stored rows would take the same action');
  });
});

test.describe('the guards: a wrong night from the source never withdraws a row', () => {
  const s = store();
  for (const [name, l] of [
    ['the list did not arrive', new Map()],
    ['it arrived empty', lists([])],
    ['it is shorter than the count it gives', new Map([[VEHICLE, list(RECORD_NOW.slice(0, 10), RECORD_NOW.length)]])],
    ['it gives no count', new Map([[VEHICLE, list(RECORD_NOW, null)]])],
    ['it is not newest first', lists([...RECORD_NOW].reverse())],
    ["it is another bill's list", new Map([[VEHICLE, list(RECORD_NOW, RECORD_NOW.length, { billType: 's', billNumber: '4784', congress: '119' })]])],
    ['it names no bill', new Map([[VEHICLE, list(RECORD_NOW, RECORD_NOW.length, null)]])],
  ] as [string, Map<string, List>][]) {
    test(`${name}: the bill is not checked, nothing changes`, () => {
      const r = run(s, l);
      expect(r.changes).toEqual([]);
      expect(r.store).toBe(s);
      expect(r.skipped.join('\n')).toContain(VEHICLE);
    });
  }

  test('listProblem names each', () => {
    expect(listProblem(undefined, { slug: VEHICLE })).toMatch(/not fetched/);
    expect(listProblem(list([]), { slug: VEHICLE })).toMatch(/empty/);
    expect(listProblem(list(RECORD_NOW.slice(0, 3), 25), { slug: VEHICLE })).toMatch(/holds 3 of the 25/);
    expect(listProblem(list(RECORD_NOW, null), { slug: VEHICLE })).toMatch(/does not say how many/);
    expect(listProblem(list([...RECORD_NOW].reverse()), { slug: VEHICLE })).toMatch(/not newest first/);
    expect(listProblem(list(RECORD_NOW), { slug: 'hr-1-119' })).toMatch(/does not name the bill asked for/);
    expect(listProblem(list(RECORD_NOW), { slug: VEHICLE })).toBeNull();
  });

  test("a wrong bill's list on a bill with two rows (one a vote) changes nothing", () => {
    const vote = said('Passed Senate by Yea-Nay Vote. 60 - 40. Record Vote Number: 9.', { class: 'vote', day: '2026-10-01', vehicle: 'hr-1-119', record: { roll_call: { chamber: 'senate', number: 9 } } });
    const other = said('Held at the desk.', { day: '2026-10-01', vehicle: 'hr-1-119' });
    const wrong = list(RECORD_NOW, RECORD_NOW.length, REQUEST); // S. 4668's list, served for H.R. 1
    const r = recheckStore(store([vote, other], []), new Map([['hr-1-119', wrong]]), { now: NOW, fallbackText: fallbackTextFor });
    expect(r.changes).toEqual([]);
    expect(r.skipped.join('\n')).toContain('does not name the bill asked for');
  });

  test('every checked row of one bill changing at once is refused, however few', () => {
    const one = said('Motion to proceed withdrawn in Senate.', { day: '2026-09-16' });
    const actions = newestFirst([...RECORD_NOW.filter((a) => a.actionDate !== '2026-09-16'), senate('2026-09-16', 'Motion to proceed tabled in Senate.')]);
    const r = run(store([one], []), lists(actions));
    expect(r.refused).toMatch(/every one of s-4668-119's 1 checked row/);
    expect(r.store[MOMENT].updates[0]).toBe(one);
  });

  test('more than half of one bill\'s checked rows (from 3 up) is refused', () => {
    const a = said('Motion X withdrawn in Senate.', { day: '2026-09-16' });
    const b = said('Motion Y withdrawn in Senate.', { day: '2026-09-16' });
    const actions = newestFirst([...RECORD_NOW.filter((x) => x.actionDate !== '2026-09-16'), senate('2026-09-16', 'Motion X tabled in Senate.'), senate('2026-09-16', 'Motion Y tabled in Senate.')]);
    const r = run(store([a, b, HELD[0]], []), lists(actions));
    expect(r.refused).toMatch(/2 of s-4668-119's 3 checked rows/);
  });

  test(`more than ${RECHECK_MAX_CHANGES} changes in one night: refused, store untouched, every row named`, () => {
    const many = Array.from({ length: RECHECK_MAX_CHANGES + 1 }, (_, i) => said(`Motion ${i} withdrawn in Senate.`, { day: '2026-09-16' }));
    const actions = newestFirst([...RECORD_NOW.filter((x) => x.actionDate !== '2026-09-16'), ...many.map((_, i) => senate('2026-09-16', `Motion ${i} tabled in Senate.`))]);
    const held = Array.from({ length: 10 }, (_, i) => ({ ...HELD[0], id: `u_0000000${i}` }));
    const s2 = store([...many, ...held], []);
    const r = run(s2, lists(actions));
    expect(r.refused).toMatch(new RegExp(`${RECHECK_MAX_CHANGES + 1} rows would be corrected`));
    expect(r.store).toBe(s2);
    const md = recheckSummaryMarkdown(r);
    for (const u of many) expect(md).toContain(u.id);
    expect(md).toContain('docs/runbooks/record-recheck.md');
  });

  test('a list missing a middle day is read as partial: the rows of that day are left, not withdrawn, and nothing flips back the next night', () => {
    const missing = RECORD_NOW.filter((a) => a.actionDate !== '2026-09-22');
    const a = said('Motion by Senator Thune to recommit fell in Senate.', { day: '2026-09-22' });
    const b = said('Considered by Senate.', { day: '2026-09-22' });
    const s1 = store([a, b, ...HELD.slice(0, 2)], []);
    const night1 = run(s1, lists(missing));
    expect(night1.changes).toEqual([]);
    expect(night1.left.join('\n')).toContain('list missing a day');
    const night2 = run(night1.store, lists(RECORD_NOW));
    expect(night2.changes.filter((c: Row) => c.kind === 'reinstated')).toEqual([]);
  });

  test('a row dated after the newest action on its list is not judged', () => {
    const later = said('Held at the desk.', { day: '2026-10-05', record: { action_code: 'H15000', source_system: 'House floor actions' } });
    const { checked, results } = judgeBill(MOMENT, [later], list(RECORD_NOW), { retentionFloor: '2026-09-15' });
    expect(checked).toBe(0);
    expect(results).toEqual([]);
  });
});

test.describe('rule 6: a row that names an amendment', () => {
  const KEY = '119-samdt-6776';
  const amendmentList = (actions: Row[], request: Row | null = { amendmentNumber: '6776', congress: 119, type: 'SAMDT' }) => ({ actions, total: actions.length, request });

  test('reads the amendment it names, in every spelling', () => {
    expect(amendmentNamed('Cloture motion on amendment SA 6776 presented in Senate.', 119)).toBe(KEY);
    expect(amendmentNamed('On the Amendment S.Amdt. 6776 to S. 4668', 119)).toBe(KEY);
    expect(amendmentNamed('H.Amdt. 12 agreed to', 119)).toBe('119-hamdt-12');
    expect(amendmentNamed('Considered by Senate.', 119)).toBeNull();
    expect(amendmentsNamedInStore(store(), { now: NOW })).toEqual([KEY]);
    expect(amendmentActionsPath(KEY)).toBe('/amendment/119/samdt/6776/actions');
  });

  test("held by the amendment's own list that day: unchanged", () => {
    const own = amendmentList([senate('2026-09-17', 'Cloture motion on amendment SA 6776 presented in Senate. (CR S4789)')]);
    const r = run(store(), lists(), { amendmentLists: new Map([[KEY, own]]) });
    expect(byId(r.store, CLOTURE_SA6776.id)).toBe(CLOTURE_SA6776);
    expect(r.left.join('\n')).not.toContain(CLOTURE_SA6776.id);
  });

  test("on neither the bill's list nor the amendment's: withdrawn", () => {
    const own = amendmentList([senate('2026-09-22', 'Cloture on amendment SA 6776 invoked in Senate by Yea-Nay Vote. 70 - 21. Record Vote Number: 240.')]);
    const r = run(store(), lists(), { amendmentLists: new Map([[KEY, own]]) });
    expect(r.changes.find((c: Row) => c.id === CLOTURE_SA6776.id)).toMatchObject({ kind: 'withdrawn', how: `on neither the bill's list nor amendment ${KEY}'s` });
    const gone = byId(r.store, CLOTURE_SA6776.id);
    expect(gone.withdrawn_on).toBe(TODAY);
    expect(readableEntry(r.store[MOMENT]).updates.map((u) => u.id)).not.toContain(CLOTURE_SA6776.id);
  });

  test("another amendment's list, or a partial one: left", () => {
    for (const bad of [amendmentList([senate('2026-09-17', 'x')], { amendmentNumber: '6777', congress: 119 }), { ...amendmentList([senate('2026-09-17', 'x')]), total: 9 }]) {
      const r = run(store(), lists(), { amendmentLists: new Map([[KEY, bad]]) });
      expect(byId(r.store, CLOTURE_SA6776.id)).toBe(CLOTURE_SA6776);
      expect(r.left.join('\n')).toContain('names amendment');
    }
  });
});

test.describe('held: a corrected line the update lint refuses is stored but hidden until a decode passes', () => {
  const day = '2026-09-16';
  const u = said('Motion to proceed withdrawn in Senate.', { day });
  const actions = newestFirst([...RECORD_NOW.filter((a) => a.actionDate !== day), senate(day, 'Motion to proceed tabled in Senate.')]);
  const refuse = () => ['en: refused by the lint'];

  test("the row takes the record's words and id, keeps its old line, and is hidden; the file passes the gate and the pre-commit check", () => {
    const r = run(store([u, ...HELD], []), lists(actions), { lintText: refuse });
    expect(r.changes.map((c: Row) => c.kind)).toEqual(['held']);
    const newId = r.changes[0].newId;
    const kept = byId(r.store, newId);
    expect(kept.record.action_text).toBe('Motion to proceed tabled in Senate.');
    expect(kept.text).toEqual(u.text);
    expect(kept.withdrawn_on).toBe(TODAY);
    expect(kept.rechecks.at(-1)).toMatchObject({ outcome: 'held', was: 'Motion to proceed withdrawn in Senate.', was_id: u.id, now: 'Motion to proceed tabled in Senate.' });
    expect(isHeld(kept)).toBe(true);
    expect(heldRows(r.store)).toEqual([{ momentId: MOMENT, id: newId, vehicle: VEHICLE, day, since: TODAY, words: 'Motion to proceed tabled in Senate.' }]);
    expect(readableEntry(r.store[MOMENT]).updates.map((x) => x.id)).not.toContain(newId);
    expect(recheckFieldProblems(kept, TODAY)).toEqual([]);
    expect(verifyMomentUpdates({ updates: r.store, now: NOW }).failures).toEqual([]);
    // A second night: the record still says it, so nothing is written.
    expect(run(r.store, lists(actions), { lintText: refuse }).changes).toEqual([]);
  });

  test('a held row is re-judged against its NEWEST words: when the record changes them again to words that pass, it shows', () => {
    const night1 = run(store([u, ...HELD], []), lists(actions), { lintText: refuse });
    const later = newestFirst([...RECORD_NOW.filter((a) => a.actionDate !== day), senate(day, 'Motion to proceed fell in Senate.')]);
    const night2 = run(night1.store, lists(later));
    expect(night2.changes.map((c: Row) => c.kind)).toEqual(['reworded']);
    const shown = byId(night2.store, night2.changes[0].newId);
    expect(Object.hasOwn(shown, 'withdrawn_on')).toBe(false);
    expect(shown.record.action_text).toBe('Motion to proceed fell in Senate.');
    expect(recheckFieldProblems(shown, TODAY)).toEqual([]);
  });

  test('a decode that passes the lint releases it (releaseHeldRow), and the gate accepts the result', () => {
    const night1 = run(store([u, ...HELD], []), lists(actions), { lintText: refuse });
    const held = byId(night1.store, night1.changes[0].newId);
    const out = releaseHeldRow(held, { en: 'The Senate tabled the motion to proceed.', es: 'El Senado dejó sobre la mesa la moción para proceder.' }, true, NOW);
    expect(Object.hasOwn(out, 'withdrawn_on')).toBe(false);
    expect(out.ai).toBe(true);
    expect(out.rechecks.at(-1)).toMatchObject({ outcome: 'reinstated', on: TODAY });
    expect(recheckFieldProblems(out, TODAY)).toEqual([]);
  });

  test('the real lint: a vote corrected through its roll number to words with "expected to" is held, not printed', () => {
    const vote = said('Cloture on the measure invoked in Senate by Yea-Nay Vote. 74 - 25. Record Vote Number: 243.', { class: 'vote', day: '2026-09-24', record: { roll_call: { chamber: 'senate', number: 243 } } });
    const words = 'Cloture on the measure invoked in Senate by Yea-Nay Vote. 74 - 24. Record Vote Number: 243.';
    // (A frame-preserving correction cannot add words, so the real-lint case is
    // shown on the quote the gate would print: the lint is what decides.)
    const r = run(store([vote, ...HELD.slice(0, 2)], []), lists(newestFirst([...RECORD_NOW.filter((a) => !/Record Vote Number: 243/.test(a.text)), senate('2026-09-24', words, { recordedVotes: [{ chamber: 'Senate', rollNumber: 243 }] })])), { lintText: () => lintUpdateText('The vote is expected to stand.', 'en', 'vote', []) });
    expect(r.changes.map((c: Row) => c.kind)).toEqual(['held']);
    expect(byId(r.store, vote.id).record.action_text).toBe(words);
  });

  test('the pre-commit check runs the same update lint as CI, so a line CI rejects never commits', () => {
    const bad = { ...HELD[0], text: { en: 'The Senate is expected to vote.', es: 'Se espera que el Senado vote.' } };
    const { failures } = verifyMomentUpdates({ updates: store([bad], []), now: NOW });
    expect(failures.join('\n')).toContain('fail the lint check-moment-updates runs');
  });
});

test.describe('reinstated', () => {
  test('a withdrawn row the record lists again is an event again, and nothing else re-judges a withdrawn row', () => {
    const u: Row = { ...said('Motion Z made in Senate.', { day: '2026-09-17' }), withdrawn_on: '2026-10-01', rechecks: [{ on: '2026-10-01', at: '2026-10-01T23:00:00.000Z', outcome: 'withdrawn' }] };
    const back = run(store([u, ...HELD], []), lists(newestFirst([...RECORD_NOW, senate('2026-09-17', 'Motion Z made in Senate.')])));
    expect(kinds(back)).toEqual([['reinstated', u.id]]);
    expect(Object.hasOwn(byId(back.store, u.id), 'withdrawn_on')).toBe(false);
    const near = run(store([u, ...HELD], []), lists(newestFirst([...RECORD_NOW, senate('2026-09-17', 'Motion Z presented in Senate.')])));
    expect(near.changes).toEqual([]);
  });
});

test.describe('the one-night override', () => {
  const many = Array.from({ length: RECHECK_MAX_CHANGES + 1 }, (_, i) => said(`Motion ${i} withdrawn in Senate.`, { day: '2026-09-16' }));
  const actions = newestFirst([...RECORD_NOW.filter((x) => x.actionDate !== '2026-09-16'), ...many.map((_, i) => senate('2026-09-16', `Motion ${i} tabled in Senate.`))]);
  const held = Array.from({ length: 10 }, (_, i) => ({ ...HELD[0], id: `u_0000000${i}` }));
  const file = { accept: [{ night: TODAY, ids: [many[0].id, many[1].id], why: 'Read both against congress.gov All Actions today.' }] };

  test('rows a person accepted for tonight are left out of the counts, on that night only', () => {
    expect(run(store([...many, ...held], []), lists(actions)).refused).not.toBeNull();
    const tonight = run(store([...many, ...held], []), lists(actions), { accept: acceptedIds(file, TODAY) });
    expect(tonight.refused).toBeNull();
    expect(tonight.changes.filter((c: Row) => c.accepted).map((c: Row) => c.id)).toEqual([many[0].id, many[1].id]);
    expect(acceptedIds(file, '2026-11-15').size).toBe(0);
  });

  test('a malformed file accepts nothing, and CI names what is wrong', () => {
    for (const bad of [{ accept: [{ night: 'tonight', ids: [many[0].id], why: 'a good long reason' }] }, { accept: [{ night: TODAY, ids: [], why: 'a good long reason' }] }, { accept: [{ night: TODAY, ids: ['x'], why: 'a good long reason' }] }, { accept: [{ night: TODAY, ids: [many[0].id], why: '' }] }, { nope: true }]) {
      expect(acceptListProblems(bad).length).toBeGreaterThan(0);
      expect(acceptedIds(bad, TODAY).size).toBe(0);
    }
    expect(acceptListProblems(file)).toEqual([]);
    expect(acceptListProblems(undefined)).toEqual([]);
  });
});

test.describe('what the page, the summaries and the collapses do with a hidden row', () => {
  const KEY = '119-samdt-6776';
  const after = run(store(), lists(), { amendmentLists: new Map([[KEY, { actions: [senate('2026-09-01', 'Submitted in the Senate.')], total: 1, request: { amendmentNumber: 6776, congress: 119 } }]]) }).store;
  const updates: Row[] = after[MOMENT].updates;

  test('the page never reads it', () => {
    expect(byId(after, CLOTURE_SA6776.id).withdrawn_on).toBe(TODAY);
    const read = readableEntry(after[MOMENT]);
    expect(read.updates.map((u) => u.id)).not.toContain(CLOTURE_SA6776.id);
    expect(liveUpdates(updates).map((u: Row) => u.id)).not.toContain(CLOTURE_SA6776.id);
  });

  test('a live row is never folded into it, and it is never folded into a live one', () => {
    const gone = byId(after, CLOTURE_SA6776.id);
    const same = said(`${CLOTURE_SA6776.record.action_text} (CR S1)`, { recorded_at: '2026-09-19T00:00:00Z' });
    expect(collapseSameActions([gone, same]).kept).toHaveLength(2);
    const status = said(CLOTURE_SA6776.record.action_text, { class: 'status_change', record: { action_type: 'latestAction', source_system: 'Congress.gov bill detail' } });
    expect(collapseRedundantStatusChanges([gone, status]).kept).toHaveLength(2);
  });

  test('it is no news to a summary', () => {
    const entry = { updates: [byId(after, CLOTURE_SA6776.id)], summary_revisions: [{ grounded_in: { update_ids: [], roll_calls: [] } }] };
    expect(recordMovedSince(entry, [], '2026-09-01')).toBe(false);
  });

  test('a model-written summary citing a row changed after it was written stays due until a later revision stands; a record-only one never is', () => {
    const entry = (rev: Row) => ({ updates, summary_revisions: [rev] });
    const cites = { ...REVISION, generated_at: '2026-11-10T12:00:00Z' };
    expect(recheckPendingIds(entry(cites))).toContain(CLOTURE_SA6776.id);
    // A night later, the budget spent: still due, read off the file.
    expect(recheckPendingIds(entry(cites))).toEqual(recheckPendingIds(entry(cites)));
    expect(recheckPendingIds(entry({ ...cites, generated_at: '2026-11-15T01:00:00Z' }))).toEqual([]);
    expect(recheckPendingIds(entry({ ...cites, model: 'record-only' }))).toEqual([]);

    const moments = { [MOMENT]: { status: 'live', vehicles: [{ slug: VEHICLE }] } };
    const bills = new Map([[VEHICLE, { status: 'floor_vote', last_action_text: 'x', last_action_date: '2026-09-24', bill_type: 's' }]]);
    const plan = (rev: Row) => planSummaries({ mode: 'nightly', moments, store: { [MOMENT]: entry(rev) }, billBySlug: bills, now: Date.parse('2026-11-15T02:00:00Z'), unsupportedStatus: () => false })[0];
    expect(plan({ ...cites, grounded_in: { ...cites.grounded_in, vehicle_statuses: { [VEHICLE]: 'floor_vote' } } })).toMatchObject({ reason: expect.stringContaining('record re-check') });
  });
});

test.describe('the CI gate and the pre-commit check', () => {
  const moments = readJson('data/moments.json');
  const bills: { full_identifier: string }[] = readJson('data/bills.json');
  const slugs = new Set(bills.map((b) => b.full_identifier));
  const violationsOf = (s: Row) => checkMomentUpdates(s, moments, slugs, { now: NOW }).violations.filter((v: string) => /rechecks|withdrawn_on/.test(v));
  const failuresOf = (s: Row) => verifyMomentUpdates({ updates: s, now: NOW }).failures.filter((f: string) => f.includes('re-check'));
  const at = new Date(NOW).toISOString();

  test('accept what the re-check writes', () => {
    const after = run(store()).store;
    expect(violationsOf(after)).toEqual([]);
    expect(failuresOf(after)).toEqual([]);
  });

  const gone = (over: Row) => ({ ...CLOTURE_SA6776, withdrawn_on: TODAY, rechecks: [{ on: TODAY, at, outcome: 'withdrawn' }], ...over });
  for (const [name, u] of [
    ['withdrawn_on with no rechecks entry', { ...CLOTURE_SA6776, withdrawn_on: TODAY }],
    ['withdrawn_on in the future', gone({ withdrawn_on: '2026-11-20', rechecks: [{ on: '2026-11-20', at: '2026-11-20T23:00:00.000Z', outcome: 'withdrawn' }] })],
    ["withdrawn_on before the row's own day", gone({ withdrawn_on: '2026-09-01', rechecks: [{ on: '2026-09-01', at: '2026-09-01T20:00:00.000Z', outcome: 'withdrawn' }] })],
    ['withdrawn_on that is not a day', gone({ withdrawn_on: 'yesterday' })],
    ['a last entry that hid the row, with no withdrawn_on', { ...CLOTURE_SA6776, rechecks: [{ on: TODAY, at, outcome: 'held', now: 'x' }] }],
    ['a correction that does not keep the earlier words', { ...CLOTURE_SA6776, rechecks: [{ on: TODAY, at, outcome: 'reworded', was_id: 'u_00000001' }] }],
    ['a correction with no earlier id', { ...CLOTURE_SA6776, rechecks: [{ on: TODAY, at, outcome: 'reworded', was: 'x' }] }],
    ["a hold that does not keep the record's words", gone({ rechecks: [{ on: TODAY, at, outcome: 'held' }] })],
    ['a hold that does not keep the earlier words', gone({ rechecks: [{ on: TODAY, at, outcome: 'held', now: CLOTURE_SA6776.record.action_text, was_id: 'u_00000001' }] })],
    ['a hold with no earlier id', gone({ rechecks: [{ on: TODAY, at, outcome: 'held', now: CLOTURE_SA6776.record.action_text, was: 'x' }] })],
    ["a hold whose words are not the row's record words", gone({ rechecks: [{ on: TODAY, at, outcome: 'held', now: 'other words', was: 'x', was_id: 'u_00000001' }] })],
    ['an entry with no time', gone({ rechecks: [{ on: TODAY, outcome: 'withdrawn' }] })],
    ['an entry whose time is a number, not an ISO string', gone({ rechecks: [{ on: TODAY, at: NOW, outcome: 'withdrawn' }] })],
    ['an entry whose time is on another day', gone({ rechecks: [{ on: TODAY, at: '2026-11-10T12:00:00.000Z', outcome: 'withdrawn' }] })],
    ['an unknown outcome', { ...CLOTURE_SA6776, rechecks: [{ on: TODAY, at, outcome: 'deleted' }] }],
    ['entries out of order', { ...CLOTURE_SA6776, rechecks: [{ on: TODAY, at, outcome: 'reinstated' }, { on: '2026-10-01', at: '2026-10-01T20:00:00.000Z', outcome: 'reinstated' }] }],
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
  test('fetchWholeActionList reads every page, and keeps the request the response names', async () => {
    const all = Array.from({ length: 600 }, (_, i) => ({ actionDate: '2026-09-17', text: `a${i}` }));
    const offsets: number[] = [];
    const got = await fetchWholeActionList('/bill/119/s/4668/actions', async (_path: string, p: { limit: number; offset: number }) => {
      offsets.push(p.offset);
      return { actions: all.slice(p.offset, p.offset + p.limit), pagination: { count: all.length }, request: REQUEST };
    });
    expect(offsets).toEqual([0, 250, 500]);
    expect(got).toMatchObject({ total: 600, request: REQUEST });
    expect(got.actions).toHaveLength(600);
  });

  test('a re-check that throws costs the night nothing: the store is restored and the failure is reported', async () => {
    let s: Row = { a: 1 };
    const out = await guardedRecheck(
      async () => {
        s = { a: 2 };
        throw new Error('boom');
      },
      () => s,
      (next: Row) => {
        s = next;
      },
    );
    expect(out).toEqual({ failed: 'threw', mode: null, corrected: [], recollect: [] });
    expect(s).toEqual({ a: 1 });
    expect(await guardedRecheck(async () => ({ mode: 'apply', refused: 'x', corrected: [{ momentId: 'm', id: 'u' }], recollect: [] }), () => s, () => {})).toEqual({ failed: 'refused', mode: 'apply', corrected: [], recollect: [] });
    expect(await guardedRecheck(async () => ({ mode: 'apply', refused: null, corrected: [{ momentId: 'm', id: 'u' }], recollect: [] }), () => s, () => {})).toEqual({ failed: null, mode: 'apply', corrected: [{ momentId: 'm', id: 'u' }], recollect: [] });
  });

  test('main() runs the re-check AFTER the night\'s collection is merged and pruned, and BEFORE the summaries', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/moment-updates.mjs'), 'utf8');
    const body = src.slice(src.indexOf('async function main()'));
    const merge = body.indexOf('// ---- merge ----');
    const prune = body.indexOf('pruneStore(store, moments');
    const recheck = body.indexOf('guardedRecheck(recheckStoredLines');
    const plan = body.indexOf('planSummaries({');
    expect(merge).toBeGreaterThan(0);
    expect(prune).toBeGreaterThan(merge);
    expect(recheck).toBeGreaterThan(prune);
    expect(plan).toBeGreaterThan(recheck);
  });

  test('the step summary names every change', () => {
    const md = recheckSummaryMarkdown(run(store()));
    expect(md).toContain("| corrected to the record's words | paying-college-athletes | u_d5eaf6d9 → u_5e188495 | 2026-09-24 | The committee substitute withdrawn by Voice Vote. | The committee substitute tabled by Voice Vote. |");
    expect(md).toContain('| left as it is | paying-college-athletes | u_682cca41 | 2026-09-17 | Cloture motion on amendment SA 6776 presented in Senate. |');
    const report = recheckSummaryMarkdown(run(store()), { mode: 'report' });
    expect(report).toContain('Report only: nothing in data/moment-updates.json was changed.');
    expect(report).toContain('| would correct | paying-college-athletes |');
  });
});

test('the committed file carries no malformed re-check field', () => {
  const real = readJson('data/moment-updates.json');
  for (const [id, entry] of Object.entries(real) as [string, Row][]) {
    if (id === '_meta') continue;
    for (const u of entry.updates) expect(recheckFieldProblems(u, TODAY), `${id}/${u.id}`).toEqual([]);
  }
});

test.describe('round 4: the report file, the alarms, and the apply-mode fixes', () => {
  const r0 = run(store());

  test('nextRecheckReport: what would change and what is left, each with what the record holds now and the day first seen', () => {
    const notApplied = nextRecheckReport(null, r0, { today: TODAY, applied: false });
    expect(Object.keys(notApplied.rows)).toEqual(['paying-college-athletes/u_682cca41', 'paying-college-athletes/u_d5eaf6d9']);
    expect(notApplied.rows['paying-college-athletes/u_d5eaf6d9']).toMatchObject({ first_seen: TODAY, verdict: 'would-correct', stored: 'The committee substitute withdrawn by Voice Vote.', record: 'The committee substitute tabled by Voice Vote.' });
    expect(recheckReportProblems(notApplied)).toEqual([]);
    // Applied: the corrected row is no longer a finding; the left row still is.
    expect(Object.keys(nextRecheckReport(null, r0, { today: TODAY, applied: true }).rows)).toEqual(['paying-college-athletes/u_682cca41']);
    // A later night keeps the first-seen day; a resolved row drops out.
    const later = nextRecheckReport(notApplied, r0, { today: '2026-11-20', applied: false });
    expect(later.rows['paying-college-athletes/u_d5eaf6d9'].first_seen).toBe(TODAY);
    expect(JSON.stringify(later)).toBe(JSON.stringify(notApplied)); // nothing new: the file does not change
  });

  test('item 1: a bill not checked keeps a streak, and every list failing is recorded as zero checked', () => {
    const none = run(store(), new Map());
    expect(none.checked).toBe(0);
    expect(none.recheckable).toBeGreaterThan(0);
    const n1 = nextRecheckReport(null, none, { today: '2026-11-14', applied: false });
    const n2 = nextRecheckReport(n1, none, { today: '2026-11-15', applied: false });
    const n3 = nextRecheckReport(n2, none, { today: '2026-11-16', applied: false });
    expect(n3.unchecked[VEHICLE]).toMatchObject({ since: '2026-11-14', last: '2026-11-16' });
    expect(n3.zero_checked).toEqual({ since: '2026-11-14', last: '2026-11-16' });
    const morning = (file: Row, day: string) => recheckFindings(file, { now: Date.parse(`${day}T13:00:00Z`) });
    // One night: nothing is raised. Two nights of nothing checked: the silent alarm. Three nights: the bill alarm too.
    const codes = (file: Row, day: string) => alarms({ nightly: { conclusion: 'success' }, recheck: { findings: morning(file, day) } }).map((a: Row) => a.code);
    expect(codes(n1, '2026-11-15')).not.toContain('record-recheck-silent');
    expect(codes(n1, '2026-11-15')).not.toContain('record-recheck-unchecked');
    expect(codes(n2, '2026-11-16')).toContain('record-recheck-silent');
    expect(codes(n2, '2026-11-16')).not.toContain('record-recheck-unchecked');
    expect(codes(n3, '2026-11-17')).toContain('record-recheck-unchecked');
    // A night that checks again ends both streaks.
    const back = nextRecheckReport(n3, run(store()), { today: '2026-11-17', applied: false });
    expect(back.unchecked).toEqual({});
    expect(back.zero_checked).toBeUndefined();
  });

  test('item 2: a new finding is NAMED once (page, stored words, what the record holds), then counted each day while it lasts', () => {
    const file = nextRecheckReport(null, r0, { today: '2026-11-14', applied: true });
    const day1 = alarms({ nightly: { conclusion: 'success' }, recheck: { findings: recheckFindings(file, { now: Date.parse('2026-11-15T13:00:00Z') }) } });
    const named = day1.find((a: Row) => a.code === 'record-recheck-new')!;
    expect(named.text).toContain('paying-college-athletes/u_682cca41 on /questions/paying-college-athletes (2026-09-17): stored "Cloture motion on amendment SA 6776 presented in Senate."');
    expect(named.text).toContain('the record holds now');
    expect(named.text).toContain('docs/runbooks/record-recheck.md');
    const day3 = alarms({ nightly: { conclusion: 'success' }, recheck: { findings: recheckFindings(file, { now: Date.parse('2026-11-17T13:00:00Z') }) } });
    expect(day3.map((a: Row) => a.code)).toEqual(expect.arrayContaining(['record-recheck-open']));
    expect(day3.map((a: Row) => a.code)).not.toContain('record-recheck-new');
    expect(day3.find((a: Row) => a.code === 'record-recheck-open')!.text).toMatch(/^1 stored timeline line\(s\) still differ/);
  });

  test('pipeline-health on five logs: report-only, refusal, zero-checked, left-row, and an ordinary night that raises nothing', () => {
    const reportLog = '::notice::moment-updates record re-check REPORT: would correct paying-college-athletes/u_d5eaf6d9 (s-4668-119 2026-09-24, /questions/paying-college-athletes) — stored: "a" — the record holds now: "b"';
    const refusalLog = '##[error]moment-updates record re-check refused: 5 rows would be corrected, withdrawn or held in one night. Nothing was changed; see the runbook.';
    const zeroLog = '##[error]moment-updates record re-check checked 0 of 23 re-checkable row(s) tonight: every list failed or was rejected (s-4668-119: x)';
    const leftLog = '##[warning]moment-updates record re-check REPORT: left paying-college-athletes/u_682cca41 (s-4668-119 2026-09-17, /questions/paying-college-athletes) — stored: "a" — the record holds now: "b" — why';
    const ordinary = 'record re-check (apply): 18 of 23 re-checkable stored row(s) checked on 4 bill(s) and 0 amendment(s); 0 changed, 0 left as they are\nDONE: no change';
    expect(parseRecheckTrouble(reportLog)).toMatchObject({ reported: 1, refused: null, zeroChecked: false });
    expect(parseRecheckTrouble(refusalLog).refused).toBe('5 rows would be corrected, withdrawn or held in one night');
    expect(parseRecheckTrouble(zeroLog).zeroChecked).toBe(true);
    expect(parseRecheckTrouble(leftLog).reported).toBe(1);
    expect(parseRecheckTrouble(ordinary)).toEqual({ refused: null, failed: false, acceptMalformed: false, zeroChecked: false, reported: 0 });
    const quiet = { schema: 1, rows: {}, unchecked: {} };
    const raised = alarms({ nightly: { conclusion: 'success' }, recheck: { ...parseRecheckTrouble(ordinary), held: [], findings: recheckFindings(quiet, { now: NOW }) } });
    expect(raised.filter((a: Row) => a.code.startsWith('record-recheck'))).toEqual([]);
    expect(alarms({ nightly: { conclusion: 'success' }, recheck: { ...parseRecheckTrouble(refusalLog), held: [], findings: null } }).map((a: Row) => a.code)).toContain('record-recheck-refused');
  });

  test('the report file shape is enforced, and absent is fine', () => {
    expect(recheckReportProblems(undefined)).toEqual([]);
    expect(recheckReportProblems({ schema: 1, rows: { bad: {} }, unchecked: {} }).length).toBeGreaterThan(0);
    expect(recheckReportProblems({ schema: 1, rows: {}, unchecked: { x: { since: '2026-11-15', last: '2026-11-14', why: '' } } }).length).toBe(1);
    expect(recheckFindings({ schema: 2 }, { now: NOW })).toBeNull();
    expect(recheckReportProblems({ schema: 2, rows: {}, unchecked: {} })).toEqual([`data/record-recheck-report.json.schema: must be 1`]);
  });

  test('item 3: the follow-up runs under the same restore-and-report: a forced throw restores the store and names the stage', async () => {
    let s: Row = { a: 1 };
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: string) => errors.push(String(m));
    try {
      const out = await guardedRecheck(
        async () => {
          s = { a: 'half-done' };
          throw new Error('decode exploded');
        },
        () => s,
        (next: Row) => {
          s = next;
        },
        'record re-check follow-up',
      );
      expect(out.failed).toBe('threw');
    } finally {
      console.error = orig;
    }
    expect(s).toEqual({ a: 1 });
    expect(errors.join('\n')).toContain('moment-updates record re-check follow-up failed and changed nothing');
    expect(parseRecheckTrouble(errors.join('\n')).failed).toBe(true);
    const src = readFileSync(join(process.cwd(), 'scripts/moment-updates.mjs'), 'utf8');
    expect(src).toMatch(/guardedRecheck\(\s*async \(\) => \{\s*if \(recheck\.corrected\.length\) pruneStore[\s\S]*?await recheckFollowUp\(anthropic, recheck\);[\s\S]*?'record re-check follow-up',/);
  });

  test('item 4: when the rewrite of a stale model summary does not land (the call fails), the record-only sentence is written that night', async () => {
    const day = '2026-09-16';
    const u = said('Motion to proceed withdrawn in Senate.', { day });
    const actions = newestFirst([...RECORD_NOW.filter((a) => a.actionDate !== day), senate(day, 'Motion to proceed tabled in Senate.')]);
    const rev = { ...REVISION, generated_at: '2026-11-13T12:00:00Z', grounded_in: { vehicle_statuses: { [VEHICLE]: 'floor_vote' }, update_ids: [u.id] } };
    const after = run(store([u, ...HELD], [rev]), lists(actions)).store;
    expect(recheckPendingIds(after[MOMENT]).length).toBe(1);
    const moments = { [MOMENT]: { status: 'live', vehicles: [{ slug: VEHICLE }] } };
    const bills = new Map([[VEHICLE, { status: 'floor_vote', last_action_text: 'x', last_action_date: '2026-09-24', bill_type: 's' }]]);
    const plan = planSummaries({ mode: 'nightly', moments, store: after, billBySlug: bills, now: Date.parse('2026-11-15T02:00:00Z'), unsupportedStatus: () => false });
    expect(plan[0].reason).toContain('record re-check');
    const failing = { messages: { create: async () => { throw new Error('model down'); } } };
    await writeSummaries({ plan, store: after, moments, anthropic: failing, cap: 8 });
    expect(after[MOMENT].summary_revisions.at(-1).model).not.toBe('record-only');
    expect(writeStaleRecheckFallbacks({ plan, store: after, moments })).toBe(1);
    const last = after[MOMENT].summary_revisions.at(-1);
    expect(last.model).toBe('record-only');
    expect(last.text.en).toBeTruthy();
    expect(last.text.es).toBeTruthy();
    expect(recheckPendingIds(after[MOMENT])).toEqual([]);
    expect(writeStaleRecheckFallbacks({ plan, store: after, moments })).toBe(0);
    // main() runs it right after writeSummaries, every night.
    const src = readFileSync(join(process.cwd(), 'scripts/moment-updates.mjs'), 'utf8');
    const body = src.slice(src.indexOf('async function main()'));
    expect(body).toMatch(/await writeSummaries\(\{[^}]*\}\);\s*\/\/[\s\S]{0,400}?const fallbacks = writeStaleRecheckFallbacks\(\{ plan, store, moments \}\);/);
  });

  test('item 5: re-collection never adds an action a stored row of the bill already quotes on another day', () => {
    const moved = said('Cloture motion on amendment SA 6776 to the measure presented in Senate, as modified by unanimous consent.', { day: '2026-09-17' });
    const actions = newestFirst([...RECORD_NOW, senate('2026-09-18', moved.record.action_text)]);
    const got = recollectDayCandidates([{ momentId: MOMENT, vehicle: VEHICLE, day: '2026-09-18', list: list(actions) }], store([moved, ...HELD], []), { now: new Date(NOW), recordedAt: new Date(NOW).toISOString(), room: 40 });
    expect(got.map((c: Row) => c.record.action_text)).not.toContain(moved.record.action_text);
  });

  test('confirm: a held row whose record words later change beyond the rewording rule is left (still hidden) and reported; changed out of reach, it is withdrawn', () => {
    const day = '2026-09-16';
    const u = said('Motion to proceed withdrawn in Senate.', { day });
    const first = newestFirst([...RECORD_NOW.filter((a) => a.actionDate !== day), senate(day, 'Motion to proceed tabled in Senate.')]);
    const held = run(store([u, ...HELD], []), lists(first), { lintText: () => ['x'] });
    const heldId = held.changes[0].newId;
    const near = newestFirst([...RECORD_NOW.filter((a) => a.actionDate !== day), senate(day, 'Motion to proceed rejected in Senate.')]);
    const n2 = run(held.store, lists(near));
    expect(n2.changes).toEqual([]);
    expect(isHeld(byId(n2.store, heldId))).toBe(true);
    expect(n2.leftRows.map((l: Row) => l.id)).toEqual([heldId]);
    expect(nextRecheckReport(null, n2, { today: TODAY, applied: true }).rows[`${MOMENT}/${heldId}`].verdict).toBe('left');
    const far = newestFirst([...RECORD_NOW.filter((a) => a.actionDate !== day), senate(day, 'Something else entirely happened in the Senate today.')]);
    const n3 = run(held.store, lists(far));
    expect(n3.changes.map((c: Row) => c.kind)).toEqual(['withdrawn']);
  });

  test('confirm and fix: hidden rows do not count toward the 12-a-day ceiling, so they never crowd out a live row', () => {
    const day = '2026-09-17';
    const live = Array.from({ length: 12 }, (_, i) => said(`Live action ${i} presented in Senate.`, { day }));
    const hidden: Row[] = Array.from({ length: 3 }, (_, i) => ({ ...said(`Hidden action ${i} in Senate.`, { day, class: 'vote' }), withdrawn_on: TODAY, rechecks: [{ on: TODAY, at: new Date(NOW).toISOString(), outcome: 'withdrawn' }] }));
    const pruned = pruneEntry({ updates: [...hidden, ...live], summary_revisions: [] }, { now: NOW })!;
    const ids = pruned.updates.map((u: Row) => u.id);
    for (const u of live) expect(ids).toContain(u.id);
    for (const u of hidden) expect(ids).toContain(u.id);
    expect(verifyMomentUpdates({ updates: store(pruned.updates, []), now: NOW }).failures.filter((f: string) => f.includes('per-day'))).toEqual([]);
    const moments = readJson('data/moments.json');
    const slugs = new Set((readJson('data/bills.json') as { full_identifier: string }[]).map((b) => b.full_identifier));
    expect(checkMomentUpdates(store(pruned.updates, []), moments, slugs, { now: NOW }).violations.filter((v: string) => v.includes('per-day storage ceiling'))).toEqual([]);
  });
});
