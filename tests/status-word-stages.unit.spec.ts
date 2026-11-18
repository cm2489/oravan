import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveJourney,
  liveCallTarget,
  passageState,
  settledDecision,
  statusKeyFor,
} from '../lib/journey';
import { agreedToOtherChamberAmendment, amendmentExchangeContinues, amendmentExchangeFailed, recordStatus } from '../lib/floor-text.mjs';
import { announcementAnswered, decisionState, floorAnsweredChamber } from '../lib/docket.mjs';
import { passedBothReading } from '../lib/scriptprompt';
import { isStatusReading } from '../lib/moment-updates-gate.mjs';
import { mapStatus } from '../scripts/congress-fetch.mjs';
import { statusKeyFor as statusKeyForMjs } from '../scripts/moment-candidates.mjs';
import type { Bill, BillStatus } from '../lib/types';

/*
 * THE STATUS WORD FOR EVERY STAGE THE RECORD HOLDS (2026-11-18).
 *
 * The stale-AI-text audit found six bills whose status word was false on the
 * bill page: "Passed one chamber" on four bills presented to the President
 * and on one both chambers had passed in different versions, and "In
 * committee" on H.R. 2400 after the House agreed to the Senate's amendment.
 * Every fixture below is a record's own sentence, copied from data/bills.json
 * on 2026-11-18; nothing here reads data/ or the real clock, so no fixture can
 * go stale when those bills move on.
 */

const NOW = Date.parse('2026-11-18T18:00:00Z');
const EN = JSON.parse(readFileSync(join(process.cwd(), 'messages/en.json'), 'utf8'));
const ES = JSON.parse(readFileSync(join(process.cwd(), 'messages/es.json'), 'utf8'));

type Fixture = Pick<Bill, 'bill_type' | 'status' | 'last_action_text' | 'last_action_date'> & {
  status_basis_text?: string | null;
  congress_number: number;
  title?: string | null;
};
const bill = (f: Partial<Fixture> & Pick<Fixture, 'bill_type' | 'status' | 'last_action_text'>): Fixture => ({
  last_action_date: '2026-11-12',
  congress_number: 119,
  status_basis_text: null,
  title: 'A bill.',
  ...f,
});
const keyMjs = (b: Fixture) => statusKeyForMjs(b.status, b.last_action_text, b.last_action_date, NOW, b);

/** The six records, as stored on 2026-11-18. */
const SIX = {
  'hr-10167-119': bill({ bill_type: 'hr', status: 'passed_chamber', last_action_text: 'Presented to President.' }),
  'hr-1550-119': bill({ bill_type: 'hr', status: 'passed_chamber', last_action_text: 'Presented to President.' }),
  'hr-5284-119': bill({ bill_type: 'hr', status: 'passed_chamber', last_action_text: 'Presented to President.' }),
  'hr-8352-119': bill({ bill_type: 'hr', status: 'passed_chamber', last_action_text: 'Presented to President.' }),
  'hr-5349-119': bill({
    bill_type: 'hr',
    status: 'passed_chamber',
    last_action_date: '2026-09-30',
    last_action_text: 'Passed Senate with an amendment and an amendment to the Title by Unanimous Consent.',
  }),
  'hr-2400-119': bill({
    bill_type: 'hr',
    status: 'committee',
    last_action_date: '2026-11-17',
    last_action_text: 'Motion to reconsider laid on the table Agreed to without objection.',
    status_basis_text: 'On motion that the House suspend the rules and agree to the Senate amendment Agreed to by voice vote.',
  }),
} as const;

test.describe('the six bills the audit found', () => {
  for (const [slug, b] of Object.entries(SIX)) {
    test(`${slug} reads "Passed both chambers" in both languages, from both copies of the gate`, () => {
      expect(statusKeyFor(b, NOW)).toBe('passed_both');
      expect(keyMjs(b)).toBe('passed_both');
      expect(EN.bills.status[statusKeyFor(b, NOW)]).toBe('Passed both chambers');
      expect(ES.bills.status[statusKeyFor(b, NOW)]).toBe('Aprobado por ambas cámaras');
    });
  }

  test('presented: the stepper stands it at the President’s desk and routes no live call', () => {
    const b = SIX['hr-10167-119'];
    expect(passageState(b)).toEqual({ stage: 'both', passedBy: null, next: null });
    const j = deriveJourney(b);
    expect(j.step).toBe(4);
    expect(j.nowKey).toBe('nowPassedBoth');
    // It used to route to the Senate "after the House voted", which the record
    // does not say: both chambers are done.
    expect(liveCallTarget(b)).toBeNull();
    expect(passedBothReading({ ...b, title: b.title ?? 'A bill.' })).toBe('to_president');
  });

  test('passed in different versions: the stepper and the call routing are unchanged', () => {
    const b = SIX['hr-5349-119'];
    expect(passageState(b)).toEqual({ stage: 'back', passedBy: 'senate', next: 'house' });
    expect(deriveJourney(b).nowKey).toMatch(/^nowPassedBack/);
    expect(liveCallTarget(b)).toEqual({ chamber: 'house', afterVote: true, soleChamber: false });
    // The House still votes on the changes, so the script keeps the ordinary
    // ask (a vote), as it did when the word was "Passed one chamber".
    expect(passedBothReading({ ...b, title: b.title ?? 'A bill.' })).toBeNull();
  });

  test('H.R. 2400: the record’s own sentence outranks the stored "committee"', () => {
    const b = SIX['hr-2400-119'];
    expect(recordStatus(b)).toBe('passed_chamber');
    expect(passageState(b)).toEqual({ stage: 'both', passedBy: 'house', next: null });
    const j = deriveJourney(b);
    expect(j.step).toBe(4);
    expect(j.nowKey).toBe('nowPassedBoth');
    expect(liveCallTarget(b)).toBeNull();
    // The summary-refresh gate accepts the reading the page prints.
    expect(isStatusReading('committee', 'passed_both')).toBe(true);
  });

  test('H.R. 2400: the House’s Nov 16 week-list no longer counts as live once the House agreed', () => {
    // The House weekly schedule that named it (published Nov 11, for Nov 16).
    const signal = { tier0: { chamber: 'house', published: '2026-11-11', covers: '2026-11-16' } };
    expect(floorAnsweredChamber(SIX['hr-2400-119'].status_basis_text)).toBe('both');
    expect(announcementAnswered(SIX['hr-2400-119'], signal)).toBe(true);
    // A House sentence that sent it back with an amendment answers the House's
    // announcement too, but only the House's: not a Senate one.
    const back = { ...SIX['hr-2400-119'], status_basis_text: 'On motion that the House agree to the Senate amendment with an amendment Agreed to without objection.' };
    expect(announcementAnswered(back, signal)).toBe(true);
    expect(announcementAnswered(back, { tier0: { ...signal.tier0, chamber: 'senate' } })).toBe(false);
  });

  test('presented: the stepper flags presentment, and only there', () => {
    expect(deriveJourney(SIX['hr-10167-119']).presented).toBe(true);
    expect(deriveJourney(SIX['hr-2400-119']).presented).toBe(false);
    expect(deriveJourney(bill({ bill_type: 'hr', status: 'passed_chamber', last_action_text: 'Passed Senate without amendment by Unanimous Consent.' })).presented).toBe(false);
    // The sentence it prints is the Big Questions status line's existing one.
    expect(EN.moments.status.line.presented).toBe('Both chambers passed it, and it has been sent to the president.');
    expect(ES.moments.status.line.presented).toBe('Ambas cámaras lo aprobaron y se envió al presidente.');
  });
});

test.describe('the nightly mapping reads agreement to the other chamber’s amendment', () => {
  test('H.R. 2400’s exact sentence maps to passed_chamber (it mapped to committee)', () => {
    expect(
      mapStatus('On motion that the House suspend the rules and agree to the Senate amendment Agreed to by voice vote.')
    ).toBe('passed_chamber');
  });
  /*
   * EVERY SHAPE OF THE AMENDMENT EXCHANGE, AND ITS NEAR MISSES (re-check of
   * #523, 2026-11-18). For each sentence, stored the way the nightly now
   * stores it (mapStatus) on a bill of the chamber that did NOT act: what it
   * maps to, which chamber the floor-schedule gate reads as having answered
   * (floorAnsweredChamber), the passage stage, the status word, the stepper's
   * sentence, and why that is true. On origin/main every one of the first 12
   * and the 'disagree' one mapped to `committee` ("In committee").
   */
  const EXCHANGE: {
    text: string;
    type: 'hr' | 's';
    map: string;
    answered: string | null;
    stage: string;
    key: string;
    /** A RegExp where the stepper's sentence is clocked (fresh vs stale). */
    nowKey: string | RegExp;
    why: string;
  }[] = [
    { text: 'On motion that the House suspend the rules and agree to the Senate amendment Agreed to by voice vote.', type: 'hr', map: 'passed_chamber', answered: 'both', stage: 'both', key: 'passed_both', nowKey: 'nowPassedBoth', why: 'H.R. 2400’s sentence: the House accepted the Senate’s text, so both hold one text and the President is next' },
    { text: 'On motion that the House agree to the Senate amendment Agreed to without objection.', type: 'hr', map: 'passed_chamber', answered: 'both', stage: 'both', key: 'passed_both', nowKey: 'nowPassedBoth', why: 'same agreement, without the suspension track' },
    { text: 'On motion that the House suspend the rules and concur in the Senate amendment Agreed to by the Yeas and Nays: 400 - 10 (Roll no. 300).', type: 'hr', map: 'passed_chamber', answered: 'both', stage: 'both', key: 'passed_both', nowKey: 'nowPassedBoth', why: '"concur in" is the same agreement' },
    { text: 'On motion that the House recede and concur in the Senate amendment Agreed to without objection.', type: 'hr', map: 'passed_chamber', answered: 'both', stage: 'both', key: 'passed_both', nowKey: 'nowPassedBoth', why: 'receding from its disagreement and concurring, with no amendment, ends the exchange' },
    { text: 'On motion that the House agree to the Senate amendment to H.R. 2400 Agreed to by voice vote.', type: 'hr', map: 'passed_chamber', answered: 'both', stage: 'both', key: 'passed_both', nowKey: 'nowPassedBoth', why: 'read deliberately: the periods in a bill number do not end the action' },
    { text: 'Resolving differences -- Senate actions: Senate agreed to the House amendment by Unanimous Consent.', type: 's', map: 'passed_chamber', answered: 'both', stage: 'both', key: 'passed_both', nowKey: 'nowPassedBoth', why: 'the Senate’s own sentence for accepting the House’s text' },
    { text: 'Senate concurred in the House amendment to S. 1234 by Unanimous Consent.', type: 's', map: 'passed_chamber', answered: 'both', stage: 'both', key: 'passed_both', nowKey: 'nowPassedBoth', why: 'the same, naming the bill (its period does not stop the reading)' },
    { text: 'On motion that the House concur in the Senate amendments with amendments Agreed to by voice vote.', type: 'hr', map: 'floor_vote', answered: 'house', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'the House sent it back with changes: only the House answered, the Senate still acts, so no "both" and no President' },
    { text: 'On motion that the House concur in the Senate amendment to the House amendment with an amendment Agreed to without objection.', type: 'hr', map: 'floor_vote', answered: 'house', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'a further amendment: the exchange goes on' },
    { text: 'Senate concurred in the House amendment to S. 1234 with an amendment (SA 2587) by Unanimous Consent.', type: 's', map: 'floor_vote', answered: 'senate', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'the "with an amendment" comes after the bill number: the whole sentence is read' },
    { text: 'Senate concurred in the House amendment to the Senate amendment with an amendment (SA 3001) by Yea-Nay Vote. 51 - 47. Record Vote Number: 300.', type: 's', map: 'floor_vote', answered: 'senate', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'a recorded vote, still sending it back' },
    { text: 'On motion that the House agree to the Senate amendment with an amendment Agreed to without objection.', type: 'hr', map: 'floor_vote', answered: 'house', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'the guard’s first shape' },
    { text: 'On motion that the House disagree to the Senate amendment Agreed to without objection.', type: 'hr', map: 'floor_vote', answered: 'house', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'disagreeing is a floor act that keeps the exchange going; nothing is in committee' },
    { text: 'Motion to concur in the House amendment to S. 1234 failed of passage in Senate by Yea-Nay Vote. 45 - 53.', type: 's', map: 'floor_vote', answered: 'senate', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorMotionFailed', why: 'a failed motion is never agreement; the Senate answered no' },
    { text: 'On motion that the House suspend the rules and agree to the Senate amendment Failed by the Yeas and Nays: (2/3 required): 250 - 170 (Roll no. 301).', type: 'hr', map: 'floor_vote', answered: 'house', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorMotionFailed', why: 'the same, on the House’s suspension track' },
    { text: 'On motion that the House agree to the Senate amendment Not agreed to by voice vote.', type: 'hr', map: 'floor_vote', answered: 'house', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: '"Not agreed to" contains "agreed to": a defeat is never read as agreement; the House answered no' },
    { text: 'On motion that the House disagree to the Senate amendment Not agreed to by voice vote.', type: 'hr', map: 'floor_vote', answered: 'house', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'a failed motion to disagree is still the House answering on its floor' },
    { text: 'POSTPONED PROCEEDINGS - At the conclusion of debate on the motion that the House suspend the rules and agree to the Senate amendment to H.R. 2400, the Chair put the question on the motion and by voice vote, announced that the ayes had prevailed. Mr. Westerman demanded the yeas and nays and the Chair postponed further proceedings on the motion until a time designated by the Speaker.', type: 'hr', map: 'floor_vote', answered: null, stage: 'first', key: 'floor_activity', nowKey: /^nowFloorActivity(Stale)?$/, why: 'the vote is postponed: no "Agreed to", so no agreement and no answer yet' },
    { text: 'Conference report agreed to in Senate by Yea-Nay Vote. 70 - 28.', type: 's', map: 'conference', answered: 'senate', stage: 'first', key: 'conference', nowKey: 'nowConference', why: 'conference-report language is the conference stage, not this reader' },
    { text: 'On agreeing to the conference report Agreed to by the Yeas and Nays: 300 - 120 (Roll no. 310).', type: 'hr', map: 'conference', answered: null, stage: 'first', key: 'conference', nowKey: 'nowConference', why: 'the same; it names no chamber, so no chamber is read as having answered' },
    { text: 'Motion to reconsider laid on the table Agreed to without objection.', type: 'hr', map: 'passed_chamber', answered: 'unknown', stage: 'first', key: 'passed_chamber', nowKey: /^nowPassed(Stale)?$/, why: 'unchanged: the post-vote motion is only a default, and every write path reads the action before it (resolveAmbiguousStatus)' },
  ];
  for (const x of EXCHANGE) {
    test(`exchange: ${x.text}`, () => {
      const b = bill({ bill_type: x.type, status: mapStatus(x.text) as BillStatus, last_action_text: x.text });
      expect(b.status, x.why).toBe(x.map);
      expect(floorAnsweredChamber(x.text), x.why).toBe(x.answered);
      expect(passageState(b).stage, x.why).toBe(x.stage);
      expect(statusKeyFor(b, NOW), x.why).toBe(x.key);
      expect(keyMjs(b), x.why).toBe(x.key);
      if (x.nowKey instanceof RegExp) expect(deriveJourney(b).nowKey, x.why).toMatch(x.nowKey);
      else expect(deriveJourney(b).nowKey, x.why).toBe(x.nowKey);
      // A final agreement and a continuing exchange are never both read.
      expect(agreedToOtherChamberAmendment(x.text) !== null && amendmentExchangeContinues(x.text) !== null).toBe(false);
      // Open or settled: every one of them is still open.
      expect(decisionState(b).state, x.why).toBe('pending');
    });
  }
  test('a defeated motion is a failed exchange vote, never agreement and never a continuing exchange', () => {
    for (const text of [
      'On motion that the House agree to the Senate amendment Not agreed to by voice vote.',
      'On motion that the House disagree to the Senate amendment Not agreed to by voice vote.',
    ]) {
      expect(agreedToOtherChamberAmendment(text), text).toBeNull();
      expect(amendmentExchangeContinues(text), text).toBeNull();
      expect(amendmentExchangeFailed(text), text).toBe('house');
    }
    expect(amendmentExchangeFailed('On motion that the House agree to the Senate amendment Agreed to by voice vote.')).toBeNull();
  });
  test('a record stored at committee over a continuing exchange reads floor activity, as the mapping now stores it', () => {
    const basis = 'On motion that the House agree to the Senate amendment with an amendment Agreed to without objection.';
    expect(recordStatus({ status: 'committee', last_action_text: 'x', status_basis_text: basis })).toBe('floor_vote');
    expect(recordStatus({ status: 'markup', last_action_text: 'x', status_basis_text: basis })).toBe('floor_vote');
    expect(isStatusReading('committee', 'floor_activity')).toBe(true);
  });
  test('the failed motion stays a floor vote', () => {
    expect(
      mapStatus('On motion that the House suspend the rules and agree to the Senate amendment Failed by the Yeas and Nays: (2/3 required): 250 - 170 (Roll no. 301).')
    ).toBe('floor_vote');
  });
  test('recordStatus never moves a record backwards or past what it says', () => {
    const basis = 'On motion that the House suspend the rules and agree to the Senate amendment Agreed to by voice vote.';
    for (const status of ['signed', 'vetoed', 'conference', 'floor_vote', 'passed_chamber'] as BillStatus[]) {
      expect(recordStatus({ status, last_action_text: 'x', status_basis_text: basis })).toBe(status);
    }
    expect(recordStatus({ status: 'committee', last_action_text: 'Referred to the House Committee on Rules.' })).toBe('committee');
    // Both pre-passage statuses the nightly could have stored over it read the same.
    expect(recordStatus({ status: 'committee', last_action_text: 'x', status_basis_text: basis })).toBe('passed_chamber');
    expect(recordStatus({ status: 'markup', last_action_text: 'x', status_basis_text: basis })).toBe('passed_chamber');
    expect(statusKeyFor(bill({ bill_type: 'hr', status: 'markup', last_action_text: 'x', status_basis_text: basis }), NOW)).toBe('passed_both');
  });
  test('a concurrent resolution is never read as presented, and agreement leaves it at "second"', () => {
    const c = bill({ bill_type: 'hconres', status: 'passed_chamber', last_action_text: 'Presented to President.' });
    expect(passageState(c).stage).toBe('first');
    const agreed = bill({
      bill_type: 'sconres',
      status: 'passed_chamber',
      last_action_text: 'Senate concurred in the House amendment by Unanimous Consent.',
    });
    expect(passageState(agreed).stage).toBe('second');
  });
});

/*
 * OPEN OR SETTLED, FOR EVERY STAGE — unchanged by this work. One fixture per
 * stage the record holds or the code derives; `decision` is decisionState
 * (the call panel's gate, lib/docket.mjs) and `settled` is settledDecision
 * (the record-only block, lib/journey.ts). The expected values were read from
 * origin/main 3c7a9bf1 before this change and are pinned here so a later
 * change to the status word cannot move them.
 */
const STAGES: { name: string; b: Fixture; key: string; decision: string; settled: string | null }[] = [
  { name: 'introduced', b: bill({ bill_type: 'hr', status: 'introduced', last_action_text: 'Introduced in House' }), key: 'introduced', decision: 'pending', settled: null },
  { name: 'committee', b: bill({ bill_type: 'hr', status: 'committee', last_action_text: 'Referred to the House Committee on Ways and Means.' }), key: 'committee', decision: 'pending', settled: null },
  { name: 'markup', b: bill({ bill_type: 'hr', status: 'markup', last_action_text: 'Ordered to be Reported by Voice Vote.' }), key: 'markup', decision: 'pending', settled: null },
  { name: 'calendar, fresh', b: bill({ bill_type: 'hr', status: 'floor_vote', last_action_date: '2026-11-17', last_action_text: 'Placed on the Union Calendar, Calendar No. 765.' }), key: 'floor_vote', decision: 'pending', settled: null },
  { name: 'failed motion', b: bill({ bill_type: 'sjres', status: 'floor_vote', last_action_text: 'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50. Record Vote Number: 111.' }), key: 'floor_activity', decision: 'pending', settled: null },
  { name: 'rejected on passage', b: bill({ bill_type: 'sjres', status: 'floor_vote', last_action_text: 'Failed of passage in Senate by Yea-Nay Vote. 47 - 51. Record Vote Number: 554.' }), key: 'rejected', decision: 'settled', settled: 'rejected' },
  { name: 'passed one chamber', b: bill({ bill_type: 'hr', status: 'passed_chamber', last_action_text: 'Received in the Senate and Read twice and referred to the Committee on Finance.' }), key: 'passed_chamber', decision: 'pending', settled: null },
  { name: 'passed both, different versions', b: SIX['hr-5349-119'], key: 'passed_both', decision: 'pending', settled: null },
  { name: 'passed both, same text', b: bill({ bill_type: 'hr', status: 'passed_chamber', last_action_text: 'Passed Senate without amendment by Unanimous Consent.' }), key: 'passed_both', decision: 'pending', settled: null },
  { name: 'both acted, record silent on versions', b: bill({ bill_type: 'hr', status: 'passed_chamber', last_action_text: 'Message on Senate action sent to the House.', status_basis_text: 'Passed Senate.' }), key: 'passed_both', decision: 'pending', settled: null },
  { name: 'agreed to the other chamber’s amendment', b: SIX['hr-2400-119'], key: 'passed_both', decision: 'pending', settled: null },
  { name: 'presented to the President', b: SIX['hr-10167-119'], key: 'passed_both', decision: 'pending', settled: null },
  { name: 'concurrent resolution adopted', b: bill({ bill_type: 'hconres', status: 'passed_chamber', last_action_text: 'Message on Senate action sent to the House.', status_basis_text: 'Resolution agreed to in Senate without amendment by Yea-Nay Vote. 50 - 48. Record Vote Number: 184.' }), key: 'adopted', decision: 'settled', settled: 'adopted' },
  { name: 'conference', b: bill({ bill_type: 'hr', status: 'conference', last_action_text: 'Conference report filed.' }), key: 'conference', decision: 'pending', settled: null },
  { name: 'vetoed', b: bill({ bill_type: 'hr', status: 'vetoed', last_action_text: 'Vetoed by President.' }), key: 'vetoed', decision: 'pending', settled: null },
  { name: 'law', b: bill({ bill_type: 'hr', status: 'signed', last_action_text: 'Became Public Law No: 119-139.' }), key: 'signed', decision: 'enacted', settled: 'law' },
];

test.describe('every stage: the word, and open or settled', () => {
  for (const s of STAGES) {
    test(s.name, () => {
      expect(statusKeyFor(s.b, NOW)).toBe(s.key);
      expect(keyMjs(s.b)).toBe(s.key);
      expect(typeof EN.bills.status[s.key]).toBe('string');
      expect(typeof ES.bills.status[s.key]).toBe('string');
      expect(decisionState(s.b).state).toBe(s.decision);
      expect(settledDecision(s.b)?.kind ?? null).toBe(s.settled);
    });
  }
});
