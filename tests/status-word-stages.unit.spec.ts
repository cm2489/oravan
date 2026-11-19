import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveJourney,
  endedDecision,
  liveCallTarget,
  passageState,
  settledDecision,
  statusKeyFor,
} from '../lib/journey';
import { agreedToOtherChamberAmendment, presentedToPresident, recordStatus } from '../lib/floor-text.mjs';
import { announcementAnswered, decisionState, docketRung, floorAnsweredChamber } from '../lib/docket.mjs';
import { withSitePolicyForTest } from '../lib/ended-state.mjs';
import { lowercaseLead } from '../lib/lead-lowercase';
import { buildScriptPrompt, passedBackChamber, passedBothReading, stanceLine } from '../lib/scriptprompt';
import { isStatusReading } from '../lib/moment-updates-gate.mjs';
import { mapStatus } from '../scripts/congress-fetch.mjs';
import { statusKeyFor as statusKeyForMjs } from '../scripts/moment-candidates.mjs';
import type { Bill, BillStatus } from '../lib/types';
import { fixClock } from './fixed-clock';

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
 *
 * NOT THE 119TH CONGRESS (re-check of #523, round 3). Every fixture carries
 * TEST_CONGRESS, a number no Congress list will ever hold, so the January
 * switch that puts 119 on the ended list (lib/congress.mjs ENDED_CONGRESSES)
 * cannot turn these readings into "Ended". The one test about an ended
 * Congress sets its own policy (withSitePolicyForTest).
 */
const TEST_CONGRESS = 9_119;

const NOW = Date.parse('2026-11-18T18:00:00Z');
// Never today (round 7): the functions that take a clock are handed NOW, and
// the clock is fixed at NOW for the ones that cannot take one
// (liveCallTarget, settledDecision, the script prompt's status word).
fixClock(NOW);
const EN = JSON.parse(readFileSync(join(process.cwd(), 'messages/en.json'), 'utf8'));
const ES = JSON.parse(readFileSync(join(process.cwd(), 'messages/es.json'), 'utf8'));

type Fixture = Pick<Bill, 'bill_type' | 'status' | 'last_action_text' | 'last_action_date'> & {
  status_basis_text?: string | null;
  congress_number: number;
  title?: string | null;
};
const bill = (f: Partial<Fixture> & Pick<Fixture, 'bill_type' | 'status' | 'last_action_text'>): Fixture => ({
  last_action_date: '2026-11-12',
  congress_number: TEST_CONGRESS,
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
    if (slug === 'hr-5349-119') continue;
    test(`${slug} reads "Passed both chambers" in both languages, from both copies of the gate`, () => {
      expect(statusKeyFor(b, NOW)).toBe('passed_both');
      expect(keyMjs(b)).toBe('passed_both');
      expect(EN.bills.status[statusKeyFor(b, NOW)]).toBe('Passed both chambers');
      expect(ES.bills.status[statusKeyFor(b, NOW)]).toBe('Aprobado por ambas cámaras');
    });
  }

  test('hr-5349-119 reads "Back in the House to settle the changes", the home rows’ own words, in both languages', () => {
    const b = SIX['hr-5349-119'];
    expect(statusKeyFor(b, NOW)).toBe('passed_back_house');
    expect(keyMjs(b)).toBe('passed_back_house');
    expect(EN.bills.status.passed_back_house).toBe('Back in the House to settle the changes');
    expect(ES.bills.status.passed_back_house).toBe('De vuelta en la Cámara para resolver los cambios');
    expect(EN.bills.status.passed_back_senate).toBe('Back in the Senate to settle the changes');
    expect(ES.bills.status.passed_back_senate).toBe('De vuelta en el Senado para resolver los cambios');
    // Exactly the words the home rows already print for the same record.
    for (const [cat, ch] of [[EN, 'house'], [EN, 'senate'], [ES, 'house'], [ES, 'senate']] as const) {
      const icu: string = cat.homeLine.passedBack;
      const words = new RegExp(`${ch === 'house' ? 'house' : 'other'} \\{([^}]*)\\}`).exec(icu)![1];
      expect(cat.bills.status[`passed_back_${ch}`]).toBe(words);
    }
    // A Senate bill the House amended is back with the Senate.
    const s = bill({ bill_type: 's', status: 'passed_chamber', last_action_text: 'Passed House with an amendment by voice vote.' });
    expect(passageState(s).stage).toBe('back');
    expect(statusKeyFor(s, NOW)).toBe('passed_back_senate');
    expect(keyMjs(s)).toBe('passed_back_senate');
    expect(isStatusReading('passed_chamber', 'passed_back_house')).toBe(true);
    expect(isStatusReading('passed_chamber', 'passed_back_senate')).toBe(true);
  });

  test('presented: the stepper stands it at the President’s desk and routes no live call', () => {
    const b = SIX['hr-10167-119'];
    expect(passageState(b)).toEqual({ stage: 'both', passedBy: null, next: null });
    const j = deriveJourney(b, NOW);
    expect(j.step).toBe(4);
    expect(j.nowKey).toBe('nowPassedBoth');
    // It used to route to the Senate "after the House voted", which the record
    // does not say: both chambers are done.
    expect(liveCallTarget(b)).toBeNull();
    // Round 4: the script is told the stepper's tense, not "goes to the president next".
    expect(passedBothReading({ ...b, title: b.title ?? 'A bill.' })).toBe('presented');
    const line = stanceLine({ ...b, title: 'A bill.' }, 'support');
    expect(line).toContain('Where the bill stands: Both chambers passed it, and it has been sent to the president.');
    expect(line).not.toContain('goes to the president next');
    expect(line).toContain('before the president acts on it');
  });

  test('passed in different versions: the stepper and the call routing are unchanged', () => {
    const b = SIX['hr-5349-119'];
    expect(passageState(b)).toEqual({ stage: 'back', passedBy: 'senate', next: 'house' });
    expect(deriveJourney(b, NOW).nowKey).toMatch(/^nowPassedBack/);
    expect(liveCallTarget(b)).toEqual({ chamber: 'house', afterVote: true, soleChamber: false });
    // Not the "goes to the president" ask: the House still settles the changes.
    expect(passedBothReading({ ...b, title: b.title ?? 'A bill.' })).toBeNull();
  });

  /*
   * THE CALL SCRIPT FOR H.R. 5349 (re-check of #523, round 3). One script is
   * read to the caller's Representative's office and to both Senators'
   * offices. The Senate has already passed H.R. 5349, so the script asks
   * every office for a public stand while the House settles the changes, and
   * never asks the member to vote: a representative is asked to publicly back
   * (or oppose) it while the House settles the changes, and so is a senator,
   * in the same words. It names the House only to say where the bill stands.
   */
  test('hr-5349-119 call script: what it asks a representative and a senator', () => {
    const b = { ...SIX['hr-5349-119'], title: 'A bill.', bill_number: 5349, short_title: null, ai_summary: 'A summary.' };
    expect(passedBackChamber(b)).toBe('house');
    const support = stanceLine(b, 'support');
    const oppose = stanceLine(b, 'oppose');
    const undecided = stanceLine(b, 'undecided');
    expect(support).toContain('urges the member to publicly back it while the House settles the changes.');
    expect(oppose).toContain('urges the member to publicly oppose it while the House settles the changes.');
    expect(undecided).toContain('state a public position on the bill while the House settles the changes');
    for (const line of [support, oppose, undecided]) {
      expect(line).toContain('Where the bill stands: Both chambers passed it in different versions; it is back with the House to settle the changes.');
      expect(line).toContain('NEVER ask the member to vote for or against this bill');
      // Round 6: the Senate passed it by unanimous consent, with no recorded
      // vote, so the prompt says "passed", never "voted on".
      expect(line).toContain('the Senate has already passed it');
      expect(line).not.toContain('voted on it');
      expect(line).not.toContain('urges the member to vote');
    }
    // The prompt is the same text for the representative's office and each
    // senator's office (buildScriptPrompt says so), in both languages.
    for (const lang of ['en', 'es'] as const) {
      const prompt = buildScriptPrompt({ bill: b, stance: 'support', lang });
      expect(prompt).toContain('Current status: Back in the House to settle the changes');
      expect(prompt).toContain('read verbatim to the caller\'s U.S. Representative\'s office and, separately, to both of the caller\'s U.S. Senators\' offices');
      expect(prompt).toContain('urges the member to publicly back it while the House settles the changes.');
      expect(prompt).not.toContain('urges the member to vote for it');
    }
  });

  test('a Senate bill back with the Senate: the House is the chamber that already passed it', () => {
    const s = { ...bill({ bill_type: 's', status: 'passed_chamber', last_action_text: 'Passed House with an amendment by voice vote.' }), title: 'A bill.' };
    expect(passedBackChamber(s)).toBe('senate');
    const line = stanceLine(s, 'support');
    expect(line).toContain('it is back with the Senate to settle the changes.');
    expect(line).toContain('the House has already passed it');
    expect(line).not.toContain('voted on it');
    expect(line).toContain('while the Senate settles the changes.');
  });

  test('H.R. 2400: the record’s own sentence outranks the stored "committee"', () => {
    const b = SIX['hr-2400-119'];
    expect(recordStatus(b)).toBe('passed_chamber');
    expect(passageState(b)).toEqual({ stage: 'both', passedBy: 'house', next: null });
    const j = deriveJourney(b, NOW);
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
    // Every other sentence about the exchange reads as origin/main reads it
    // (round 6): tests/amendment-exchange-whitelist.unit.spec.ts.
  });

  test('presented: the stepper flags presentment, and only there', () => {
    expect(deriveJourney(SIX['hr-10167-119'], NOW).presented).toBe(true);
    expect(deriveJourney(SIX['hr-2400-119'], NOW).presented).toBe(false);
    expect(deriveJourney(bill({ bill_type: 'hr', status: 'passed_chamber', last_action_text: 'Passed Senate without amendment by Unanimous Consent.' }), NOW).presented).toBe(false);
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
      bill_type: 'hconres',
      status: 'passed_chamber',
      last_action_text: 'On motion that the House suspend the rules and agree to the Senate amendment Agreed to by voice vote.',
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
  { name: 'passed both, different versions', b: SIX['hr-5349-119'], key: 'passed_back_house', decision: 'pending', settled: null },
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

/* ------------------------------------------------------------------ *
 * Round 3 of the re-check of #523.
 * ------------------------------------------------------------------ */

test.describe('the card note "Just passed a chamber" (lib/docket.mjs)', () => {
  const FRESH = new Date(NOW - 2 * 86_400_000).toISOString().slice(0, 10);
  const rung = (b: Fixture) => docketRung({ ...b, last_action_date: FRESH }, null, { now: NOW });
  test('kept on a first passage', () => {
    const b = bill({ bill_type: 'hr', status: 'passed_chamber', last_action_text: 'Received in the Senate.' });
    expect(rung(b).annotation).toBe('just_passed');
  });
  test('left out where the word is "Passed both chambers" or "Back in the … to settle the changes"', () => {
    for (const b of [
      SIX['hr-10167-119'],
      SIX['hr-5349-119'],
      bill({ bill_type: 'hr', status: 'passed_chamber', last_action_text: 'Passed Senate without amendment by Unanimous Consent.' }),
      bill({ bill_type: 'hr', status: 'passed_chamber', last_action_text: 'Message on Senate action sent to the House.', status_basis_text: 'Passed Senate.' }),
    ]) {
      expect(['passed_both', 'passed_back_house'], b.last_action_text ?? '').toContain(statusKeyFor(b, NOW));
      expect(rung(b).tier, b.last_action_text ?? '').toBe('t3');
      expect(rung(b).annotation, b.last_action_text ?? '').toBeNull();
    }
  });
});

test.describe('lowercaseLead (the stepper’s reused sentence after "Right now:")', () => {
  test('the presented sentence, in both languages', () => {
    expect(lowercaseLead(EN.moments.status.line.presented, 'en')).toBe('both chambers passed it, and it has been sent to the president.');
    expect(lowercaseLead(ES.moments.status.line.presented, 'es')).toBe('ambas cámaras lo aprobaron y se envió al presidente.');
  });
  test('leaves proper nouns, bill numbers and acronyms alone', () => {
    // Round 4: only words on the allow-list are lowercased; names, titles,
    // places, programmes, groups, chambers, bill numbers and acronyms never are.
    for (const s of ['Senate passed it.', 'House passed it.', 'Congress acted.', 'H.R. 2400 passed.', 'HHS must report.', 'November 12.', 'S. 1234 passed.',
      'Thune moved to proceed.', 'Texas would gain land.', 'Medicare would pay.', 'Republicans and Democrats agreed.', 'Mr. Smith moved.', 'Él lo firmó.']) {
      expect(lowercaseLead(s, 'en'), s).toBe(s);
    }
    for (const s of ['Cámara aprobó.', 'Senado aprobó.', 'Thune presentó la moción.', 'Texas recibiría tierras.', 'Medicare pagaría.', 'Republicanos y demócratas acordaron.', 'Sr. Smith presentó.', 'Los republicanos votaron.', 'Él lo firmó.']) {
      expect(lowercaseLead(s, 'es'), s).toBe(s);
    }
    // The allowed words, one per language, and nothing past the first letter.
    expect(lowercaseLead('Both chambers passed it.', 'en')).toBe('both chambers passed it.');
    expect(lowercaseLead('Ambas cámaras lo aprobaron.', 'es')).toBe('ambas cámaras lo aprobaron.');
    // A word allowed in one language is not lowercased in the other.
    expect(lowercaseLead('Both chambers passed it.', 'es')).toBe('Both chambers passed it.');
    expect(lowercaseLead('Ambas cámaras lo aprobaron.', 'en')).toBe('Ambas cámaras lo aprobaron.');
    expect(lowercaseLead('', 'en')).toBe('');
  });
});

test.describe('an ended Congress (lib/journey.ts endedDecision reads recordStatus)', () => {
  const POLICY = { tracked: TEST_CONGRESS + 1, ended: [{ number: TEST_CONGRESS, ended: '2027-01-03' }] };
  test('a bill stored at committee whose record holds a final agreement ended as presented, and keeps "Passed both chambers"', () => {
    withSitePolicyForTest(POLICY, () => {
      const b = SIX['hr-2400-119'];
      expect(endedDecision(b)?.kind).toBe('presented');
      expect(statusKeyFor(b, NOW)).toBe('passed_both');
    });
  });
  test('a bill passed in different versions reads "Ended" once its Congress ends', () => {
    withSitePolicyForTest(POLICY, () => {
      expect(statusKeyFor(SIX['hr-5349-119'], NOW)).toBe('ended');
      expect(endedDecision(SIX['hr-5349-119'])?.kind).toBe('ended');
    });
  });
});

test.describe('deriveJourney reads the clock it is handed, not today (round 7)', () => {
  // Two instants far from any day this test could run on: the same record is
  // fresh at the first and stale at the second, so a reading that ignored
  // `now` and read today could not give both.
  const NEAR = Date.parse('2026-11-18T18:00:00Z');
  const FAR = Date.parse('2031-06-01T12:00:00Z');
  test('a floor action: "is deciding" while fresh, the dated stale sentence after', () => {
    const b = bill({ bill_type: 'sjres', status: 'floor_vote', last_action_date: '2026-11-17', last_action_text: 'Motion to proceed to consideration of measure made in Senate.' });
    const near = deriveJourney(b, NEAR).nowKey;
    const far = deriveJourney(b, FAR).nowKey;
    expect(near).not.toBe(far);
    expect(far).toMatch(/Stale$/);
  });
  test('a first passage: "now goes to the other chamber" while fresh, the stale sentence after', () => {
    const b = bill({ bill_type: 'hr', status: 'passed_chamber', last_action_date: '2026-11-17', last_action_text: 'Received in the Senate.' });
    expect(deriveJourney(b, NEAR).nowKey).toBe('nowPassed');
    expect(deriveJourney(b, FAR).nowKey).toBe('nowPassedStale');
  });
});

test.describe('the readers’ anchors (mutants the re-check found)', () => {
  test('the Senate’s own sentence form is read only as the whole action', () => {
    const t = 'Motion to reconsider the vote by which the Senate agreed to the House amendment to S. 240 by Unanimous Consent.';
    const s240 = { bill_type: 's', bill_number: 240 };
    expect(agreedToOtherChamberAmendment(t, s240)).toBeNull();
    expect(agreedToOtherChamberAmendment('Senate agreed to the House amendment to S. 240 by Unanimous Consent.', s240)).toBe('senate');
  });
  test('"Presented to President." counts only as the whole action', () => {
    const b = bill({
      bill_type: 'hr',
      status: 'passed_chamber',
      last_action_text: 'Pursuant to the provisions of H. Con. Res. 30, enrolled bill to be Presented to President after the adjournment.',
    });
    expect(presentedToPresident(b)).toBe(false);
    expect(passageState(b).stage).toBe('first');
    expect(presentedToPresident(SIX['hr-10167-119'])).toBe(true);
  });
});

test.describe('round 4 of the re-check of #523', () => {
  test('the listing rung reads recordStatus: a record stored at committee over a final agreement is a passage, not "Already decided on the floor"', () => {
    const FRESH = new Date(NOW - 2 * 86_400_000).toISOString().slice(0, 10);
    const b = { ...SIX['hr-2400-119'], last_action_date: FRESH };
    const r = docketRung(b, null, { now: NOW });
    expect(r.tier).toBe('t3');
    expect(r.annotation).toBeNull();
    // A House week-list naming it is answered by the House's agreement.
    const signal = { tier0: { chamber: 'house', published: FRESH, covers: FRESH, source: 'billsthisweek', quote: 'x', url: 'https://example.invalid' } };
    expect(announcementAnswered(b, signal)).toBe(true);
  });

  test('the script for a bill passed in different versions: the opening, the stance line and the rule agree', () => {
    const back = { ...SIX['hr-5349-119'], title: 'A bill.', bill_number: 5349, short_title: null, ai_summary: 'A summary.' };
    const p = buildScriptPrompt({ bill: back, stance: 'support', lang: 'en' });
    expect(p).toContain('so it must never assume, name, or imply a single chamber, except in the one sentence that says where the bill stands, which names the House exactly as the stance line below gives it.');
    expect(p).toContain('naming a chamber or title is not, except the one sentence that says where the bill stands, which names the House as the stance line above gives it.');
    expect(p).toContain('The script must say so plainly, naming the House in that one sentence; never address or describe the recipient by chamber or title.');
    expect(p).not.toContain('one exception to the chamber-neutral rule');
    // What the script asks is unchanged from round 3.
    expect(p).toContain('urges the member to publicly back it while the House settles the changes.');
    expect(p).toContain('NEVER ask the member to vote for or against this bill');
    // Every other bill's prompt keeps its sentences exactly.
    const other = { ...bill({ bill_type: 'hr', status: 'committee', last_action_text: 'Referred to the House Committee on Rules.' }), title: 'A bill.', bill_number: 1, short_title: null, ai_summary: 'A summary.' };
    const q = buildScriptPrompt({ bill: other, stance: 'support', lang: 'en' });
    expect(q).toContain('so it must never assume, name, or imply a single chamber.\n');
    expect(q).toContain('naming a chamber or title is not.\n');
    expect(q).not.toContain('except in the one sentence');
  });
});
