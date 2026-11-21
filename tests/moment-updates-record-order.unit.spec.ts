import { expect, test } from '@playwright/test';
/*
 * SAME-DAY ITEMS IN THE ORDER THE RECORD LISTS THEM (owner, 2026-11-14,
 * answer 89 a): "Store each action's position as the record lists it at
 * intake … and order same-day items by it from then on. Past items keep
 * today's order."
 *
 * Pinned here, layer by layer: what Congress.gov's actions list gives (newest
 * first, read on the committed S. 4668 fixture), the position the collector
 * stores at intake and when it stores none, the reader's order on a day that
 * has positions, on a day that mixes old and new rows, and on a day with two
 * bills, the render cap that still picks by class priority, and the CI gate
 * and the pre-commit check that accept the field and refuse a malformed one.
 * Pure: no network, no model.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  RENDER_DAY_CAP,
  checkMomentUpdates,
  computeUpdateId,
  dayPositionProblem,
  groupByDay,
  orderDayByRecord,
  selectDayUpdates,
} from '../lib/moment-updates-gate.mjs';
import { verifyMomentUpdates } from '../lib/verify-moment-updates.mjs';
import { actionToCandidate, recordDayPositions } from '../scripts/moment-updates-map.mjs';

// The rows are the stored JSON shape, read loosely, as the gate itself reads them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const FIXTURES = join(process.cwd(), 'tests', 'fixtures');
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
/** S. 4668's actions as Congress.gov returned them on 2026-09-25 (committed with #304). */
const S4668 = readJson(join(FIXTURES, 'congress-actions-s4668.json')).actions as Row[];

const MOMENT = 'paying-college-athletes';
const VEHICLE = 's-4668-119';
const NOW = Date.parse('2026-09-30T16:00:00Z');

/** A stored row, id derived the way the collector derives it. */
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
  return { ...base, id: over.id ?? computeUpdateId(MOMENT, base) };
}
const ids = (rows: Row[]) => rows.map((u) => u.id);

test.describe('what Congress.gov gives', () => {
  test('every saved actions response in the repo lists its actions newest first', () => {
    const files = readdirSync(FIXTURES).filter((f) => /^congress-actions-.*\.json$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const days = (readJson(join(FIXTURES, f)).actions as Row[]).map((a) => String(a.actionDate));
      for (let i = 1; i < days.length; i++) expect(days[i] <= days[i - 1], `${f} [${i}]`).toBe(true);
    }
  });

  test("S. 4668's September 17 actions, as the record lists them (top = listed first)", () => {
    const sept17 = S4668.filter((a) => a.actionDate === '2026-09-17').map((a) => String(a.text).slice(0, 40));
    expect(sept17).toEqual([
      'Cloture motion on the measure presented ',
      'Motion by Senator Thune to recommit to S',
      'Measure laid before Senate by motion. (c',
      'Motion to proceed to consideration of me',
      'Motion to proceed to measure considered ',
    ]);
  });
});

test.describe('recordDayPositions: the position stored at intake', () => {
  test('counts within the day from the action listed last, which is 0', () => {
    const p = recordDayPositions(S4668);
    const at = (day: string) => S4668.map((a, i) => (a.actionDate === day ? p[i] : undefined)).filter((x) => x !== undefined);
    expect(at('2026-09-17')).toEqual([4, 3, 2, 1, 0]);
    expect(at('2026-09-24')).toEqual([2, 1, 0]);
    expect(at('2026-09-16')).toEqual([0]);
    expect(at('2026-06-24')).toEqual([2, 1, 0]);
  });

  test('a later day arriving at the top does not move an earlier day\'s positions', () => {
    const later = [{ actionDate: '2026-09-28', text: 'Passed Senate with an amendment.' }, ...S4668];
    const before = recordDayPositions(S4668);
    const after = recordDayPositions(later);
    expect(after.slice(1)).toEqual(before);
    expect(after[0]).toBe(0);
  });

  test('stores none when the list is not newest first (fail closed to the old order)', () => {
    expect(recordDayPositions([...S4668].reverse()).every((p) => p === null)).toBe(true);
  });

  test('on a page cut short, stores none for its oldest day, which may go on to the next page', () => {
    const page = S4668.slice(0, 13); // 2026-09-24 … 2026-09-15 (one of its two rows)
    const p = recordDayPositions(page, { total: S4668.length });
    page.forEach((a, i) => {
      if (a.actionDate === '2026-09-15') expect(p[i]).toBeNull();
      else expect(p[i]).not.toBeNull();
    });
    // The same page, said to be the whole list, numbers its oldest day too.
    expect(recordDayPositions(page, { total: page.length }).every((x) => x !== null)).toBe(true);
  });

  test('an action with no date gets none', () => {
    expect(recordDayPositions([{ actionDate: '2026-09-17' }, { text: 'x' }, { actionDate: '2026-09-17' }])).toEqual([1, null, 0]);
  });

  test('actionToCandidate stores it as record.day_position, and the id does not depend on it', () => {
    const action = S4668.find((a) => String(a.text).startsWith('Cloture motion on the measure presented'))!;
    const args = { momentId: MOMENT, vehicle: VEHICLE, action, recordedAt: '2026-09-18T14:29:25.757Z' };
    const withPos = actionToCandidate({ ...args, dayPosition: 4 })!;
    const without = actionToCandidate(args)!;
    expect(withPos.record.day_position).toBe(4);
    expect(Object.hasOwn(without.record, 'day_position')).toBe(false);
    expect(actionToCandidate({ ...args, dayPosition: null })!.record).toEqual(without.record);
    expect(withPos.id).toBe(without.id);
  });
});

test.describe('orderDayByRecord: the order a day renders in', () => {
  // The five September 17 actions as positioned rows, in the old order
  // (class priority, then id) — the order the page printed before.
  const vote = row({ class: 'vote', record: { action_text: 'Motion to proceed agreed to.', action_code: null, action_type: 'Floor', source_system: 'Senate', day_position: 1 } });
  const cloture = row({ record: { action_text: 'Cloture motion on the measure presented in Senate.', action_code: null, action_type: 'Floor', source_system: 'Senate', day_position: 4 } });
  const considered = row({ record: { action_text: 'Motion to proceed to measure considered in Senate.', action_code: null, action_type: 'Floor', source_system: 'Senate', day_position: 0 } });

  test('a day with no positions renders exactly as before', () => {
    const plain = [row({ class: 'vote' }), row({ record: { action_text: 'Two.', action_code: null, action_type: 'Floor', source_system: 'Senate' } })];
    const before = selectDayUpdates(plain, Infinity);
    expect(orderDayByRecord(before)).toEqual(before);
  });

  test("one bill's positioned rows render latest-listed first, whatever their class", () => {
    const before = selectDayUpdates([vote, cloture, considered], Infinity);
    expect(ids(before)[0]).toBe(vote.id); // the old order put the vote first
    expect(ids(orderDayByRecord(before))).toEqual([cloture.id, vote.id, considered.id]);
  });

  test('a mixed day: a row stored before positions existed keeps its place; positioned rows trade places only with each other', () => {
    const old = row({ record: { action_text: 'Measure laid before Senate by motion.', action_code: null, action_type: 'Floor', source_system: 'Senate' } });
    const before = selectDayUpdates([vote, old, cloture, considered], Infinity);
    const oldSlot = ids(before).indexOf(old.id);
    const after = orderDayByRecord(before);
    expect(ids(after).indexOf(old.id)).toBe(oldSlot);
    const positioned = ids(after).filter((id) => id !== old.id);
    expect(positioned).toEqual([cloture.id, vote.id, considered.id]);
  });

  test('a mixed day with one positioned row renders exactly as before', () => {
    const old = row({ class: 'vote', record: { action_text: 'An older vote row.', action_code: null, action_type: 'Floor', source_system: 'Senate' } });
    const before = selectDayUpdates([old, cloture], Infinity);
    expect(orderDayByRecord(before)).toEqual(before);
  });

  test('two bills on one day: which places belong to which bill stays as before; each bill is in record order within its own', () => {
    const other = (text: string, position: number, klass = 'floor_action') =>
      row({ class: klass, vehicle: 'hr-1-119', record: { action_text: text, action_code: null, action_type: 'Floor', source_system: 'House floor actions', day_position: position } });
    const a = other('Received in the House.', 0, 'vote');
    const b = other('Held at the desk.', 1);
    const before = selectDayUpdates([vote, cloture, considered, a, b], Infinity);
    const vehicleAt = before.map((u) => u.vehicle);
    const after = orderDayByRecord(before);
    expect(after.map((u) => u.vehicle)).toEqual(vehicleAt);
    expect(ids(after.filter((u) => u.vehicle === VEHICLE))).toEqual([cloture.id, vote.id, considered.id]);
    expect(ids(after.filter((u) => u.vehicle === 'hr-1-119'))).toEqual([b.id, a.id]);
  });

  test('two rows of one bill with the same position keep their old order', () => {
    const x = row({ record: { action_text: 'X.', action_code: null, action_type: 'Floor', source_system: 'Senate', day_position: 2 } });
    const y = row({ record: { action_text: 'Y.', action_code: null, action_type: 'Floor', source_system: 'Senate', day_position: 2 } });
    const before = selectDayUpdates([x, y], Infinity);
    expect(orderDayByRecord(before)).toEqual(before);
  });

  test('groupByDay: the cap still picks by class priority; only the order of what renders follows the record', () => {
    // Six rows on one day: the vote must render although the record lists it
    // below five floor actions.
    const floors = [0, 2, 3, 4, 5].map((p) =>
      row({ record: { action_text: `Floor action ${p}.`, action_code: null, action_type: 'Floor', source_system: 'Senate', day_position: p } }),
    );
    const v = row({ class: 'vote', record: { action_text: 'The vote.', action_code: null, action_type: 'Floor', source_system: 'Senate', day_position: 1 } });
    const [day] = groupByDay([...floors, v], 30, NOW).filter((d: Row) => d.day === '2026-09-17');
    expect(day.rendered).toHaveLength(RENDER_DAY_CAP);
    expect(ids(day.rendered)).toContain(v.id);
    expect(day.overflow).toBe(1);
    const shown = day.rendered.map((u: Row) => u.record.day_position);
    expect(shown).toContain(1);
    expect(shown).toEqual([...shown].sort((a, b) => b - a));
    // `updates` stays class-priority ordered: the overflow line reads it.
    expect(day.updates[0].id).toBe(v.id);
  });
});

test.describe('the CI gate and the pre-commit check', () => {
  const moments = readJson(join(process.cwd(), 'data/moments.json'));
  const bills: { full_identifier: string }[] = readJson(join(process.cwd(), 'data/bills.json'));
  const slugs = new Set(bills.map((b) => b.full_identifier));
  const file = (updates: Row[]) => ({
    _meta: { schema: 1, generated_at: '2026-09-30T12:00:00Z' },
    [MOMENT]: { updates, summary_revisions: [] },
  });
  const withPosition = (p: unknown, over: Row = {}) => row({ ...over, record: { action_text: 'Cloture motion on the measure presented in Senate.', action_code: null, action_type: 'Floor', source_system: 'Senate', day_position: p, ...(over.record ?? {}) } });
  const positionViolations = (u: Row) =>
    checkMomentUpdates(file([u]), moments, slugs, { now: NOW }).violations.filter((v: string) => v.includes('day_position'));

  test('accept a whole-number position on a row read from the actions list, and a row without one', () => {
    expect(positionViolations(withPosition(0))).toEqual([]);
    expect(positionViolations(withPosition(7))).toEqual([]);
    expect(positionViolations(row({}))).toEqual([]);
    expect(verifyMomentUpdates({ updates: file([withPosition(3), row({})]), now: NOW }).failures).toEqual([]);
  });

  for (const bad of [-1, 1.5, '2', null]) {
    test(`refuse a malformed position (${JSON.stringify(bad)})`, () => {
      expect(positionViolations(withPosition(bad))).toHaveLength(1);
      const { failures } = verifyMomentUpdates({ updates: file([withPosition(bad)]), now: NOW });
      expect(failures.join('\n')).toContain('malformed record position');
    });
  }

  test('refuse a position on a row the actions list never placed', () => {
    const fromStatusDiff = withPosition(0, { class: 'status_change', record: { action_type: 'latestAction', source_system: 'Congress.gov bill detail' } });
    const fromVoteRecord = withPosition(0, { class: 'vote', source: { kind: 'roll_call', refs: ['https://www.senate.gov/x.xml'] } });
    for (const u of [fromStatusDiff, fromVoteRecord]) {
      expect(dayPositionProblem(u)).toMatch(/only a row read from Congress\.gov's actions list/);
      expect(verifyMomentUpdates({ updates: file([u]), now: NOW }).failures.join('\n')).toContain('malformed record position');
    }
  });
});

/*
 * No test here reads data/moment-updates.json. One did until 2026-11-20: it
 * asserted that no stored row carried a position "yet", which was true only
 * until the collector stored its first one, and it turned main red on the hour
 * that happened. The committed file is held by its gates instead:
 * scripts/check-moment-updates.mjs in CI and verify-sync before the nightly
 * commit both refuse a malformed position (dayPositionProblem, pinned above on
 * fixtures), and the order on a day that mixes old and new rows is pinned above
 * on fixtures too.
 */
