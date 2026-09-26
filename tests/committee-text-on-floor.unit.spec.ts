import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AMBIGUOUS_WITHOUT_CONTEXT,
  isAmbiguousAction,
  mapStatus,
  refreshBillFields,
  resolveAmbiguousStatus,
  statusBasisProblems,
  statusFromActions,
  unresolvedAmbiguousStatus,
  urgencyScore,
} from '../scripts/congress-fetch.mjs';
import { applyRederive, planRederive } from '../scripts/rederive-status.mjs';
import { redecodeCandidates } from '../scripts/floor-signals-parse.mjs';
import { statusUnsupported } from '../scripts/moment-updates.mjs';
import {
  COMMITTEE_TEXT_ON_FLOOR,
  FLOOR_SETTLED,
  floorPendingChamber,
  floorSettledChamber,
  statusBasisText,
} from '../lib/floor-text.mjs';
import { announcementAnswered, docketRung, entersFloorWatch, floorAnsweredChamber, isSettledFloor } from '../lib/docket.mjs';
import { billStatusLine } from '../lib/moment-status.mjs';
import { deriveJourney, liveCallTarget, statusKeyFor } from '../lib/journey';

/*
 * A CHAMBER DISPOSING OF A COMMITTEE'S TEXT ON ITS OWN FLOOR (2026-09-25).
 *
 * S. 4668 (the college-athletes Big Question's vehicle) read `committee` on
 * the live site the day after the Senate invoked cloture on it 74-25, because
 * its last action — "The committee substitute withdrawn by Voice Vote." —
 * matched no mapStatus rule and fell through to the `committee` default. The
 * sentence is the Senate acting on its floor; Congress.gov types it "Floor".
 *
 * Every sentence below is VERBATIM from Congress.gov's /actions endpoint,
 * read 2026-09-25 (tests/fixtures/congress-actions-s4668.json is S. 4668's
 * whole list as returned that day). The pins: the sentence is never read as
 * the committee stage, it is resolved from the action before it like the
 * other ambiguous notices (#285/#286), no reader takes its "withdrawn" for
 * the floor having answered, and the nightly re-derivation corrects the
 * stored record.
 */

type Action = { actionDate?: string; actionTime?: string; text?: string; type?: string };

const S4668_ACTIONS: Action[] = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'congress-actions-s4668.json'), 'utf8')
).actions;

/** The six shapes read in the record, each with where it was read. */
const SHAPES: Array<{ text: string; where: string }> = [
  { text: 'The committee substitute withdrawn by Voice Vote.', where: 's-4668-119 2026-09-24' },
  { text: 'The committee substitute withdrawn by Unanimous Consent.', where: 's-1199-119 2026-04-29' },
  { text: 'The committee substitute agreed to by Unanimous Consent.', where: 's-331-119 2025-03-14' },
  {
    text: 'The committee substitute as amended agreed to by Unanimous Consent. (text of amendment in the nature of a substitute: CR S7-10)',
    where: 's-320-119 2026-01-05',
  },
  { text: 'The committee amendment withdrawn by Unanimous Consent.', where: 's-688-119 2026-03-22' },
  {
    text: 'The committee amendment as amended agreed to by Unanimous Consent. (text of amendment in the nature of a substitute: CR S13-16)',
    where: 's-1626-119 2026-01-05',
  },
];

const WITHDRAWN = 'The committee substitute withdrawn by Voice Vote.';
const CLOTURE = 'Cloture on the measure, as amended, invoked in Senate by Yea-Nay Vote. 74 - 25. Record Vote Number: 243.';

/** data/bills.json's s-4668-119 as committed on 2026-09-25 (the live bug), frozen. */
const S4668_STORED = () => ({
  full_identifier: 's-4668-119',
  congress_number: 119,
  bill_type: 's',
  bill_number: 4668,
  title: 'Protect College Sports Act of 2026',
  last_action_date: '2026-09-24',
  last_action_text: WITHDRAWN,
  status: 'committee',
  urgency_score: 0.55,
});

/** The same record after tonight's re-derivation, as planRederive + applyRederive write it. */
const S4668_CORRECTED = () => ({
  ...S4668_STORED(),
  status: 'floor_vote',
  status_basis_text: CLOTURE,
  status_basis_date: '2026-09-24',
});

const resolveFromRecord = (b: Record<string, unknown>) =>
  resolveAmbiguousStatus(b as never, {
    fetchActions: async (x: Record<string, unknown>) => (x.bill_number === 4668 ? (S4668_ACTIONS as never) : null),
  });

test.describe('the sentence is read as the floor, never the committee stage', () => {
  test('every shape in the record: floor_vote by default, and ambiguous without the action before it', () => {
    expect(AMBIGUOUS_WITHOUT_CONTEXT).toContain(COMMITTEE_TEXT_ON_FLOOR);
    for (const { text, where } of SHAPES) {
      expect(COMMITTEE_TEXT_ON_FLOOR.test(text), where).toBe(true);
      expect(mapStatus(text), where).toBe('floor_vote');
      expect(isAmbiguousAction(text), where).toBe(true);
    }
  });

  test('the fixture is the real record: the sentence is the latest action and Congress.gov types it "Floor"', () => {
    expect(S4668_ACTIONS[0]).toMatchObject({ actionDate: '2026-09-24', text: WITHDRAWN, type: 'Floor' });
    expect(S4668_ACTIONS[1]).toMatchObject({ actionDate: '2026-09-24', text: CLOTURE, type: 'Floor' });
  });

  test("the committee's OWN sentences are untouched — reporting, ordering reported, referral", () => {
    // S. 4668's own committee stage, verbatim from the same fixture.
    const reported =
      'Committee on Commerce, Science, and Transportation. Reported by Senator Cruz with an amendment in the nature of a substitute. Without written report.';
    const ordered =
      'Committee on Commerce, Science, and Transportation. Ordered to be reported with an amendment in the nature of a substitute favorably.';
    const referred = 'Read twice and referred to the Committee on Commerce, Science, and Transportation.';
    for (const t of [reported, ordered, referred]) {
      expect(S4668_ACTIONS.some((a) => a.text === t), t).toBe(true);
      expect(COMMITTEE_TEXT_ON_FLOOR.test(t), t).toBe(false);
      expect(isAmbiguousAction(t), t).toBe(false);
    }
    expect(mapStatus(reported)).toBe('markup');
    expect(mapStatus(ordered)).toBe('markup');
    expect(mapStatus(referred)).toBe('committee');
  });

  test('the subject is an amendment, so no passage or defeat word in it is the measure\'s', () => {
    // Runs before the passage and defeat branches: a hypothetical "agreed to in
    // Senate" or "not agreed to in Senate" about the committee's text is still
    // the floor stage, never a passage and never a defeat of the bill.
    expect(mapStatus('The committee amendments agreed to in Senate by Unanimous Consent.')).toBe('floor_vote');
    expect(mapStatus('The committee substitute not agreed to in Senate by Voice Vote.')).toBe('floor_vote');
  });
});

test.describe('resolved from the action before it', () => {
  test("S. 4668's real list: the cloture vote on the bill, dated, is the basis", () => {
    expect(statusFromActions(S4668_ACTIONS as never)).toEqual({ status: 'floor_vote', basis: CLOTURE, basisDate: '2026-09-24' });
  });

  test('the usual shape — directly before a same-day passage — resolves to the passage once it is on the record', () => {
    // s-1199-119, 2026-04-29, newest first, verbatim.
    const DAY: Action[] = [
      { actionDate: '2026-04-29', text: 'Passed Senate with an amendment by Unanimous Consent. (text of amendment in the nature of a substitute: CR S2108)' },
      { actionDate: '2026-04-29', text: 'Passed/agreed to in Senate: Passed Senate with an amendment by Unanimous Consent.' },
      { actionDate: '2026-04-29', text: 'The committee substitute withdrawn by Unanimous Consent.' },
      { actionDate: '2026-04-29', text: 'Measure laid before Senate by unanimous consent. (consideration: CR S2107-2108)' },
    ];
    expect(statusFromActions(DAY as never)).toMatchObject({ status: 'passed_chamber' });
    // Caught mid-sequence — the withdrawal is the newest action and the
    // passage is not on the record yet — it reads the floor, never committee.
    expect(statusFromActions(DAY.slice(2) as never)).toEqual({
      status: 'floor_vote',
      basis: 'Measure laid before Senate by unanimous consent. (consideration: CR S2107-2108)',
      basisDate: '2026-04-29',
    });
  });

  test('refreshBillFields — the hot-bill refresh that flipped S. 4668 to committee now stores floor_vote and its basis', async () => {
    // The record as the 2026-09-24 nightly left it, then the refresh's payload.
    const bill: Record<string, unknown> = {
      ...S4668_STORED(),
      status: 'floor_vote',
      last_action_date: '2026-09-23',
      last_action_text: 'Considered by Senate. (consideration: CR S4885)',
    };
    const detail = { latestAction: { actionDate: '2026-09-24', text: WITHDRAWN }, policyArea: { name: 'Sports and Recreation' } };
    expect(await refreshBillFields(bill as never, detail, { resolve: resolveFromRecord })).toBe('refreshed');
    expect(bill).toMatchObject({
      status: 'floor_vote',
      last_action_text: WITHDRAWN,
      last_action_date: '2026-09-24',
      status_basis_text: CLOTURE,
      status_basis_date: '2026-09-24',
    });
  });

  test('refreshBillFields — lookup failed: the floor status stands on the previous readable step, never committee', async () => {
    const bill: Record<string, unknown> = {
      ...S4668_STORED(),
      status: 'floor_vote',
      last_action_date: '2026-09-23',
      last_action_text: 'Considered by Senate. (consideration: CR S4885)',
    };
    await refreshBillFields(bill as never, { latestAction: { actionDate: '2026-09-24', text: WITHDRAWN } }, { resolve: async () => null });
    expect(bill).toMatchObject({
      status: 'floor_vote',
      last_action_text: WITHDRAWN,
      status_basis_text: 'Considered by Senate. (consideration: CR S4885)',
      status_basis_date: '2026-09-23',
    });
  });

  test('a NEW bill whose lookup failed enters at the floor for this sentence, and at committee for a passage-shaped one (#285)', () => {
    for (const { text, where } of SHAPES) expect(unresolvedAmbiguousStatus(text), where).toBe('floor_vote');
    expect(unresolvedAmbiguousStatus('Motion to reconsider laid on the table Agreed to without objection.')).toBe('committee');
    expect(unresolvedAmbiguousStatus('Message on Senate action sent to the House.')).toBe('committee');
  });
});

test.describe("tonight's re-derivation corrects the stored record", () => {
  test('planRederive: committee -> floor_vote on the cloture basis; applyRederive writes it through the one writer', async () => {
    const stored = S4668_STORED();
    const corpus = [stored];
    const { changes, warnings } = await planRederive(corpus as never, { resolve: resolveFromRecord });
    expect(warnings).toEqual([]);
    expect(changes).toEqual([
      {
        slug: 's-4668-119',
        from: 'committee',
        to: 'floor_vote',
        basis: { text: CLOTURE, date: '2026-09-24' },
        basisChanged: true,
      },
    ]);
    applyRederive(corpus as never, {}, changes as never);
    expect(stored).toEqual({ ...S4668_CORRECTED(), urgency_score: urgencyScore('floor_vote', '2026-09-24') });
    expect(statusBasisProblems(corpus as never)).toEqual([]);
    // And a second night is a no-op.
    expect((await planRederive(corpus as never, { resolve: resolveFromRecord })).changes).toEqual([]);
  });

  test('with no API the stored record is kept as it is and named in a warning (the pre-existing no-key behaviour)', async () => {
    const { changes, warnings } = await planRederive([S4668_STORED()] as never, { resolve: async () => null });
    expect(changes).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('s-4668-119');
  });

  test('the misread status can no longer buy a Big Questions rewrite; the corrected one can', () => {
    // moment-updates' flap guard: a status its own status sentence does not
    // support is not a trigger. The live 2026-09-25 "Where it stands" revision
    // (s_960aec36, "is in committee, after a run of Senate floor action") was
    // bought by exactly this misread.
    expect(statusUnsupported(S4668_STORED())).toBe(true);
    expect(statusUnsupported(S4668_CORRECTED())).toBe(false);
  });
});

test.describe('no reader takes the withdrawal for the floor having answered', () => {
  test('FLOOR_SETTLED refuses every committee-text shape, and still reads the real settled "withdrawn" sentences', () => {
    for (const { text, where } of SHAPES) {
      expect(FLOOR_SETTLED.test(text), where).toBe(false);
      expect(floorAnsweredChamber(text), where).toBeNull();
      expect(floorSettledChamber(text), where).toBeNull();
    }
    // Verbatim settled sentences from the same 2026-09-25 record sample.
    for (const t of [
      'Motion to proceed to consideration of measure withdrawn in Senate.', // hr-7147-119 2026-03-24
      'Cloture motion on the motion to proceed to the measure withdrawn by unanimous consent in Senate. (CR S1768)', // hr-1968-119 2025-03-14
      'Motion by Senator Thune to concur in the House amendment to S. 1071 with an amendment (SA 3961) withdrawn in Senate.', // s-1071-119 2025-12-17
      'Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 52 - 46.',
    ]) {
      expect(FLOOR_SETTLED.test(t), t).toBe(true);
    }
    // The capture group the other readers never used is still the word.
    expect(FLOOR_SETTLED.exec('Motion to proceed to consideration of measure withdrawn in Senate.')?.[1]).toBe('withdrawn');
  });

  test('THE FALLBACK STATE — the sentence with no basis stored — is never "just decided" and never retires an announcement', () => {
    const bare = { ...S4668_STORED(), status: 'floor_vote' };
    expect(isSettledFloor(bare)).toBe(false);
    expect(deriveJourney(bare as never).nowKey).not.toBe('nowFloorMotionFailed');
    expect(billStatusLine(bare as never, Date.parse('2026-09-25T20:00:00Z')).key).not.toBe('failed');
    // An announcement covering the day of the withdrawal: before this change
    // floorAnsweredChamber said 'unknown' and the crown was retired.
    const signal = {
      tier0: { source: 'daily-digest', chamber: 'senate', published: '2026-09-23', covers: '2026-09-24' },
      fetched_at: '2026-09-24T12:00:00Z',
    };
    expect(announcementAnswered(bare, signal)).toBe(false);
    expect(announcementAnswered(S4668_STORED(), signal)).toBe(false);
  });
});

test.describe('the readers agree on the corrected record', () => {
  const NOW = Date.parse('2026-09-25T20:00:00Z');
  const before = S4668_STORED();
  const after = S4668_CORRECTED();

  test('every reader reasons from the cloture vote, not the withdrawal', () => {
    expect(statusBasisText(after)).toBe(CLOTURE);
    expect(entersFloorWatch(statusBasisText(after))).toBe(true);
    expect(isSettledFloor(after)).toBe(false);
    expect(floorAnsweredChamber(statusBasisText(after))).toBeNull();
  });

  test('the stepper: from "a Senate committee is reviewing it" to the floor step', () => {
    expect(deriveJourney(before as never)).toMatchObject({ step: 1, nowKey: 'nowCommittee' });
    const j = deriveJourney(after as never);
    expect(j.step).toBe(2);
    // Today no pending rule reads "Cloture on the measure … invoked", so the
    // stepper says the chamber-free "it's moving on the floor". If
    // floorPendingChamber ever learns the sentence, the Senate-named keys
    // (live or aged) are the only other answers allowed here.
    expect(['nowFloorActivityNeutral', 'nowFloorActivity', 'nowFloorActivityStale']).toContain(j.nowKey);
    expect(floorPendingChamber(CLOTURE) === null).toBe(j.nowKey === 'nowFloorActivityNeutral');
  });

  test('the status label: "In committee" becomes "Floor activity" on every surface that reads statusKeyFor', () => {
    expect(statusKeyFor(before.status as never, before.last_action_text, before.last_action_date, NOW)).toBe('committee');
    expect(statusKeyFor(after.status as never, after.last_action_text, after.last_action_date, NOW)).toBe('floor_activity');
  });

  test('the ladder: the live Senate announcement still holds T0; without it the record alone is T1, not the radar', () => {
    const live = {
      tier0: { source: 'daily-digest', chamber: 'senate', published: '2026-09-24', covers: '2026-09-28' },
      fetched_at: '2026-09-25T19:37:09.548Z',
      stale: false,
    };
    expect(docketRung(after, live, { now: NOW }).tier).toBe('t0');
    expect(docketRung(before, null, { now: NOW }).tier).toBe('t4');
    expect(docketRung(after, null, { now: NOW }).tier).toBe('t1');
  });

  test('the Big Questions status line is no longer entitled to "In committee."', () => {
    expect(billStatusLine(after as never, NOW).key).not.toBe('inCommittee');
    expect(billStatusLine(after as never, NOW).text).toBe(WITHDRAWN); // the record's latest step, verbatim
  });

  test('the rail makes no chamber claim the record does not (quiet path), and the re-decode queue matches the T1 rung', () => {
    expect(liveCallTarget(after as never)).toBeNull();
    const queue = redecodeCandidates({ signals: {}, bills: [after], now: NOW });
    expect(queue).toEqual([{ slug: 's-4668-119', tier: 't1', lastActionDate: '2026-09-24' }]);
    expect(redecodeCandidates({ signals: {}, bills: [before], now: NOW })).toEqual([]);
  });
});
