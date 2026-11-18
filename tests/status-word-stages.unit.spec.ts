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
import { agreedToOtherChamberAmendment, recordStatus } from '../lib/floor-text.mjs';
import { decisionState } from '../lib/docket.mjs';
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
});

test.describe('the nightly mapping reads agreement to the other chamber’s amendment', () => {
  test('H.R. 2400’s exact sentence maps to passed_chamber (it mapped to committee)', () => {
    expect(
      mapStatus('On motion that the House suspend the rules and agree to the Senate amendment Agreed to by voice vote.')
    ).toBe('passed_chamber');
  });
  for (const text of [
    'On motion that the House agree to the Senate amendment Agreed to without objection.',
    'On motion that the House suspend the rules and concur in the Senate amendment Agreed to by the Yeas and Nays: 400 - 10 (Roll no. 300).',
    'Resolving differences -- Senate actions: Senate agreed to the House amendment by Unanimous Consent.',
    'Senate concurred in the House amendment by Voice Vote.',
  ]) {
    test(`reads as agreement: ${text}`, () => {
      expect(agreedToOtherChamberAmendment(text)).not.toBeNull();
      expect(mapStatus(text)).toBe('passed_chamber');
    });
  }
  for (const text of [
    // Sends it back again: not the end of the exchange.
    'On motion that the House agree to the Senate amendment with an amendment Agreed to without objection.',
    'Senate concurred in the House amendment with an amendment by Unanimous Consent.',
    // A failed motion is never agreement.
    'On motion that the House suspend the rules and agree to the Senate amendment Failed by the Yeas and Nays: (2/3 required): 250 - 170 (Roll no. 301).',
    // Ordinary passage and referral sentences are not this shape.
    'Passed Senate with an amendment by Unanimous Consent.',
    'Referred to the House Committee on Natural Resources.',
  ]) {
    test(`does not read as agreement: ${text}`, () => {
      expect(agreedToOtherChamberAmendment(text)).toBeNull();
    });
  }
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
