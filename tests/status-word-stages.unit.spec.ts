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
import {
  agreedToOtherChamberAmendment,
  amendmentExchange,
  amendmentExchangeContinues,
  amendmentExchangeFailed,
  amendmentExchangeMotionMade,
  presentedToPresident,
  recordStatus,
} from '../lib/floor-text.mjs';
import { announcementAnswered, decisionState, docketRung, floorAnsweredChamber } from '../lib/docket.mjs';
import { withSitePolicyForTest } from '../lib/ended-state.mjs';
import { lowercaseLead } from '../lib/lead-lowercase';
import { buildScriptPrompt, passedBackChamber, passedBothReading, stanceLine } from '../lib/scriptprompt';
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
 *
 * NOT THE 119TH CONGRESS (re-check of #523, round 3). Every fixture carries
 * TEST_CONGRESS, a number no Congress list will ever hold, so the January
 * switch that puts 119 on the ended list (lib/congress.mjs ENDED_CONGRESSES)
 * cannot turn these readings into "Ended". The one test about an ended
 * Congress sets its own policy (withSitePolicyForTest).
 */
const TEST_CONGRESS = 9_119;

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
    const j = deriveJourney(b);
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
    expect(deriveJourney(b).nowKey).toMatch(/^nowPassedBack/);
    expect(liveCallTarget(b)).toEqual({ chamber: 'house', afterVote: true, soleChamber: false });
    // Not the "goes to the president" ask: the House still settles the changes.
    expect(passedBothReading({ ...b, title: b.title ?? 'A bill.' })).toBeNull();
  });

  /*
   * THE CALL SCRIPT FOR H.R. 5349 (re-check of #523, round 3). One script is
   * read to the caller's Representative's office and to both Senators'
   * offices. The Senate has already voted on H.R. 5349, so the script asks
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
      expect(line).toContain('the Senate has already voted on it');
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

  test('a Senate bill back with the Senate: the House is the chamber that already voted', () => {
    const s = { ...bill({ bill_type: 's', status: 'passed_chamber', last_action_text: 'Passed House with an amendment by voice vote.' }), title: 'A bill.' };
    expect(passedBackChamber(s)).toBe('senate');
    const line = stanceLine(s, 'support');
    expect(line).toContain('it is back with the Senate to settle the changes.');
    expect(line).toContain('the House has already voted on it');
    expect(line).toContain('while the Senate settles the changes.');
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
    { text: 'On motion that the House agree with an amendment to the Senate amendment Agreed to without objection.', type: 'hr', map: 'floor_vote', answered: 'house', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'the House’s usual wording for agreeing WITH an amendment: it sends it back, only the House has answered (main: "In committee")' },
    { text: 'On motion that the House recede from its disagreement to the amendment of the Senate and concur therein Agreed to without objection.', type: 'hr', map: 'passed_chamber', answered: 'both', stage: 'both', key: 'passed_both', nowKey: 'nowPassedBoth', why: '"recede … and concur therein" with no amendment is final agreement (main: "In committee")' },
    { text: 'On motion that the House recede from its disagreement to the amendment of the Senate and concur therein with an amendment Agreed to without objection.', type: 'hr', map: 'floor_vote', answered: 'house', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'the same with an amendment: back to the Senate (main: "In committee")' },
    { text: 'On motion that the House insist upon its amendment and request a conference Agreed to without objection.', type: 'hr', map: 'floor_vote', answered: 'house', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'insisting keeps the exchange going on the floor (main: "In committee")' },
    { text: 'House insisted upon its amendment and asked for a conference.', type: 'hr', map: 'floor_vote', answered: 'house', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'the chamber’s own sentence for insisting (main: "In committee")' },
    { text: 'Senate disagreed to the House amendment, requested a conference with the House on the disagreeing votes of the two Houses, and appointed conferees by Unanimous Consent.', type: 's', map: 'floor_vote', answered: 'senate', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'the Senate disagreed: a floor act, the exchange goes on (main: "In committee")' },
    { text: 'Motion by Senator Thune to concur in the House amendment to S. 1234 made in Senate.', type: 's', map: 'floor_vote', answered: null, stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'a motion that is only MADE is not an agreement, and nobody has answered (main: "In committee")' },
    { text: 'Motion by Senator Thune to concur in the House amendment to S. 1234 agreed to in Senate by Yea-Nay Vote. 60 - 38. Record Vote Number: 310.', type: 's', map: 'passed_chamber', answered: 'both', stage: 'both', key: 'passed_both', nowKey: 'nowPassedBoth', why: 'the Senate’s motion to concur, agreed to with no amendment: final (main: "Passed one chamber")' },
    { text: 'Motion by Senator Thune to concur in the House amendment to S. 1234 with an amendment (SA 2600) agreed to in Senate by Voice Vote.', type: 's', map: 'floor_vote', answered: 'senate', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'agreed WITH an amendment: back to the House' },
    { text: 'Motion by Senator Thune to concur in the House amendment to S. 1234 not agreed to in Senate by Yea-Nay Vote. 45 - 53.', type: 's', map: 'floor_vote', answered: 'senate', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'voted down: never an agreement' },
    { text: 'On motion that the House agree to Senate amendment No. 2 Agreed to without objection.', type: 'hr', map: 'floor_vote', answered: 'house', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'one numbered amendment of several: an exchange step, not a final agreement (round 4)' },
    { text: 'On motion that the House concur in Senate amendment numbered 3 Agreed to by voice vote.', type: 'hr', map: 'floor_vote', answered: 'house', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'the same with "numbered"' },
    { text: 'Senate agreed to House amendment No. 2 by Unanimous Consent.', type: 's', map: 'floor_vote', answered: 'senate', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'the Senate’s own sentence for one numbered amendment' },
    { text: 'Senate concurred in the House amendments numbered 1 and 2 by Voice Vote.', type: 's', map: 'floor_vote', answered: 'senate', stage: 'first', key: 'floor_activity', nowKey: 'nowFloorActivityNeutral', why: 'a list of numbers does not say every amendment is resolved' },
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

test.describe('the readers’ anchors (mutants the re-check found)', () => {
  test('the Senate’s own sentence form is read only at the start of the action', () => {
    const t = 'Motion to reconsider the vote by which the Senate concurred in the House amendment to S. 1234 entered in Senate.';
    expect(amendmentExchange(t)).toBeNull();
    expect(agreedToOtherChamberAmendment(t)).toBeNull();
  });
  test('a motion to TABLE the motion to concur is never agreement, however short the senator’s name', () => {
    for (const text of [
      'Motion by Senator Lee to table motion to concur in the House amendment agreed to in Senate by Yea-Nay Vote. 51 - 49.',
      'Motion by Senator Thune to table the motion to concur in the House amendment agreed to in Senate by Yea-Nay Vote. 51 - 49.',
      'Motion to table the motion to concur in the House amendment agreed to in Senate.',
    ]) {
      expect(amendmentExchange(text), text).toBeNull();
      expect(amendmentExchangeMotionMade(text), text).toBe(false);
    }
    expect(amendmentExchange('Motion to recede and concur agreed to in House by voice vote.')).toEqual({ chamber: 'house', final: true });
    expect(amendmentExchange('Motion to concur in the House amendment agreed to in Senate by Yea-Nay Vote. 68 - 30.')).toEqual({ chamber: 'senate', final: true });
    expect(amendmentExchangeMotionMade('Motion by Senator Thune to concur in the House amendment to S. 1234 made in Senate.')).toBe(true);
    expect(amendmentExchangeMotionMade('Motion by Senator Thune to concur in the House amendment to S. 1234 withdrawn in Senate.')).toBe(false);
    // A motion to table one, only made, is not a motion to concur that was made.
    expect(amendmentExchangeMotionMade('Motion by Senator Lee to table motion to concur in the House amendment made in Senate.')).toBe(false);
  });

  test('the chamber’s own "disagreed" sentence is read only at the start of the action', () => {
    const t = 'Motion to reconsider the vote by which the Senate disagreed to the House amendment entered in Senate.';
    expect(amendmentExchangeContinues(t)).toBeNull();
    expect(amendmentExchangeContinues('Senate disagreed to the House amendment, requested a conference.')).toBe('senate');
  });

  test('"Presented to President" counts only as the opening of the action', () => {
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

  test('the "failed" refusal, on its own', () => {
    const t = 'On motion that the House suspend the rules and concur in the Senate amendment failed. Motion to reconsider laid on the table Agreed to without objection.';
    expect(amendmentExchange(t)).toBeNull();
    expect(amendmentExchangeContinues(t)).toBeNull();
    expect(amendmentExchangeFailed(t)).toBe('house');
  });

  test('senators’ names of more than one word', () => {
    expect(amendmentExchange('Motion by Senator Van Hollen to concur in the House amendment to S. 1234 agreed to in Senate by Voice Vote.')).toEqual({ chamber: 'senate', final: true });
    expect(amendmentExchangeMotionMade('Motion by Senator Cortez Masto to concur in the House amendment to S. 1234 made in Senate.')).toBe(true);
    expect(amendmentExchange('Motion by Senator Cortez Masto to concur in the House amendment to S. 1234 with an amendment (SA 2601) agreed to in Senate by Voice Vote.')).toEqual({ chamber: 'senate', final: false });
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

/*
 * THE SENTENCE TABLE (re-check of #523, round 5). One row per record
 * sentence: the reading the amendment-exchange readers give it.
 *   "final"          both chambers hold one text (agreedToOtherChamberAmendment)
 *   "step:<chamber>" that chamber answered and the exchange goes on, or its
 *                    motion failed (amendmentExchange not final,
 *                    amendmentExchangeContinues, amendmentExchangeFailed)
 *   "none"           no reading: not an exchange this reader knows, and so
 *                    NEVER final.
 * The first 59 rows are the re-check's own sentences (recheck4-523,
 * sentences.txt), read one by one; the rest are this round's forms. To add a
 * shape, add a row; a doubtful shape belongs on "step" or "none", never on
 * "final".
 */
const READING_TABLE: [string, string][] = [
  ["final", "On motion that the House concur in the Senate amendment Agreed to by the Yeas and Nays: 310 - 105 (Roll no. 412)."],
  ["final", "On motion that the House agree to the Senate amendments Agreed to by voice vote."],
  ["final", "On motion that the House suspend the rules and concur in the Senate amendments Agreed to by the Yeas and Nays: (2/3 required): 380 - 30 (Roll no. 420)."],
  ["step:house", "On motion that the House concur in the Senate amendment with an amendment Agreed to by voice vote."],
  ["step:house", "On motion that the House concur in the Senate amendment with amendment numbered 1 Agreed to without objection."],
  ["step:house", "On motion that the House concur in Senate amendments numbered 1, 2 and 3 Agreed to by voice vote."],
  ["final", "On motion that the House concur in the Senate amendment in the nature of a substitute Agreed to by voice vote."],
  ["step:house", "On motion that the House concur in the Senate amendment in the nature of a substitute with an amendment Agreed to by voice vote."],
  ["step:house", "On motion that the House disagree to the Senate amendment and request a conference Agreed to without objection."],
  ["step:house", "On motion that the House insist on its disagreement to the Senate amendment Agreed to without objection."],
  ["final", "On motion that the House recede from its disagreement and concur in the Senate amendment Agreed to by voice vote."],
  ["none", "On motion that the House recede from its amendment Agreed to without objection."],
  ["step:house", "On motion that the House concur in the Senate amendment Not agreed to by the Yeas and Nays: 200 - 215 (Roll no. 430)."],
  ["step:house", "On motion that the House concur in the Senate amendment Failed by voice vote."],
  ["none", "Motion to table the motion to concur in the Senate amendment Agreed to by the Yeas and Nays: 216 - 210 (Roll no. 431)."],
  ["none", "On motion to table the motion to concur in the Senate amendment Agreed to by voice vote."],
  ["none", "Ms. Smith moved that the House concur in the Senate amendment."],
  ["none", "Considered as unfinished business. (consideration: CR H5000)"],
  ["none", "POSTPONED PROCEEDINGS - At the conclusion of debate on the motion to concur in the Senate amendment, the Chair put the question on the motion and by voice vote, announced that the ayes had prevailed. Mr. Jones demanded the yeas and nays and the Chair postponed further proceedings on the question until a time to be announced."],
  ["none", "Further proceedings on the motion to concur in the Senate amendment were postponed."],
  ["final", "On motion that the House concur in the Senate amendment Agreed to by voice vote. Motion to reconsider the vote laid on the table."],
  ["none", "Mr. Jones moved to reconsider the vote on the motion to concur in the Senate amendment."],
  ["none", "The vote on the motion to concur in the Senate amendment was vacated by unanimous consent."],
  ["none", "Motion to concur in the Senate amendment withdrawn."],
  ["none", "Senate agreed to conference report by Yea-Nay Vote. 68 - 31. Record Vote Number: 250."],
  ["none", "Conference report H. Rept. 119-500 filed."],
  ["none", "On agreeing to the conference report Agreed to by recorded vote: 230 - 190 (Roll no. 440)."],
  ["none", "Conferees agreed to file conference report."],
  ["none", "Senate insists on its amendment, asks for a conference, appoints conferees Crapo; Wyden."],
  ["none", "Senate receded from its amendment by Unanimous Consent."],
  ["none", "Presented to President."],
  ["none", "Became Public Law No: 119-250."],
  ["none", "Signed by President."],
  ["none", "Vetoed by President."],
  ["none", "Veto message received in House."],
  ["none", "On passage, the objections of the President to the contrary notwithstanding Agreed to by the Yeas and Nays: (2/3 required): 300 - 120 (Roll no. 450)."],
  ["none", "Passed House over veto by the Yeas and Nays: (2/3 required): 300 - 120 (Roll no. 450)."],
  ["none", "Became Public Law without Signature No: 119-251."],
  ["none", "Pocket vetoed by President."],
  ["none", "Enrolled bill signed by the Speaker and the President pro tempore. Presented to President."],
  ["none", "Cleared for White House."],
  ["final", "Senate concurred in the House amendment by Unanimous Consent."],
  ["step:senate", "Senate concurred in the House amendment with an amendment (SA 4000) by Unanimous Consent."],
  ["step:senate", "Senate concurred in House amendment No. 1 by Voice Vote."],
  ["none", "Motion by Senator Cortez Masto to concur in the House amendment made in Senate."],
  ["final", "Motion by Senator Van Hollen to concur in the House amendment agreed to in Senate by Yea-Nay Vote. 55 - 44. Record Vote Number: 300."],
  ["none", "Motion by Senator Thune to table the motion to concur in the House amendment agreed to in Senate by Voice Vote."],
  ["none", "Motion to concur in the House amendment withdrawn in Senate."],
  ["none", "Cloture motion on the motion to concur in the House amendment presented in Senate."],
  ["none", "Cloture on the motion to concur in the House amendment invoked in Senate by Yea-Nay Vote. 61 - 38."],
  ["none", "Cloture on the motion to concur in the House amendment not invoked in Senate by Yea-Nay Vote. 52 - 47."],
  ["none", "Motion to concur in the House amendment with an amendment No. 3000 made in Senate."],
  ["step:senate", "Senate disagreed to the House amendment by Unanimous Consent."],
  ["step:senate", "Resolving differences -- Senate actions: Senate agreed to the House amendment with an amendment by Unanimous Consent."],
  ["final", "Resolving differences -- House actions: On motion that the House agree to the Senate amendment Agreed to without objection."],
  ["final", "Senate concurred in the House amendment by Unanimous Consent."],
  ["final", "On motion that the House agree to the Senate amendment Agreed to by voice vote."],
  ["step:house", "On motion that the House concur in the Senate amendment to the title Agreed to without objection."],
  ["none", "Senate amendment to the House amendment to the Senate amendment agreed to by the House."],
  // Round 5: every form of "with … amendment" after concur / agree / recede and concur, and the title.
  ["step:house", "On motion that the House concur in the Senate amendment with the amendment printed in House Report 119-600 Agreed to by voice vote."],
  ["step:house", "On motion that the House agree to the Senate amendment with a further amendment Agreed to without objection."],
  ["step:house", "On motion that the House concur in the Senate amendment with House amendment No. 2 Agreed to without objection."],
  ["step:house", "On motion that the House concur in the Senate amendment with an amendment in the nature of a substitute Agreed to by voice vote."],
  ["step:house", "On motion that the House agree to the Senate amendment with amendments Agreed to without objection."],
  ["step:house", "On motion that the House recede and concur in the Senate amendment with an amendment Agreed to without objection."],
  ["step:house", "On motion that the House recede from its disagreement to the amendment of the Senate and concur therein with the amendment printed in the Congressional Record Agreed to by voice vote."],
  ["step:senate", "Senate concurred in the House amendment with a further amendment (SA 4100) by Unanimous Consent."],
  ["step:senate", "Motion by Senator Thune to concur in the House amendment with a further amendment (SA 4200) agreed to in Senate by Voice Vote."],
  ["step:senate", "Senate concurred in the House amendment to the title by Unanimous Consent."],
  ["final", "On motion that the House concur in the Senate amendments to the text and title Agreed to by voice vote."],
  ["step:senate", "Senate concurred in the House amendment with Senate amendment SA 4300 by Unanimous Consent."],
  ["final", "On motion that the House concur in the Senate amendment to the text and the Senate amendment to the title Agreed to by voice vote."],
];

function reading(text: string): string {
  if (agreedToOtherChamberAmendment(text)) return 'final';
  const ex = amendmentExchange(text);
  const chamber = ex?.chamber ?? amendmentExchangeContinues(text) ?? amendmentExchangeFailed(text);
  return chamber ? `step:${chamber}` : 'none';
}

test.describe('the sentence table', () => {
  test(`has at least 40 rows (${READING_TABLE.length})`, () => {
    expect(READING_TABLE.length).toBeGreaterThanOrEqual(40);
  });
  for (const [i, [expected, text]] of READING_TABLE.entries()) {
    test(`#${i + 1} ${expected}: ${text}`, () => {
      expect(reading(text)).toBe(expected);
    });
  }
});

/*
 * THE PROPERTY: final only when a known-final shape carries no not-final
 * marker. Every "final" row of the table, with any marker put into it, is no
 * longer final; every row the table reads "none" stays never final; and a
 * failed or rejected outcome is never final.
 */
test.describe('the property: no not-final marker is ever read as final', () => {
  const MARKERS = [
    'with an amendment',
    'with amendments',
    'with amendment numbered 1',
    'with the amendment printed in House Report 119-600',
    'with a further amendment',
    'with further amendments',
    'with House amendment No. 2',
    'with an amendment in the nature of a substitute',
    'numbered 2',
    'No. 3',
    'to the title',
  ];
  // Unique by text: two table rows may share a sentence across bill types.
  const finals = [...new Set(READING_TABLE.filter(([e]) => e === 'final').map(([, t]) => t))];
  test(`there are final rows to test (${finals.length})`, () => expect(finals.length).toBeGreaterThan(5));
  for (const text of finals) {
    // "to the title" marks an amendment to the title ALONE; a sentence that
    // already names the text and the title is not title-only by definition.
    for (const marker of MARKERS.filter((m) => !(m === 'to the title' && /\btext and title\b/i.test(text)))) {
      test(`"${marker}" in: ${text.slice(0, 70)}`, () => {
        const marked = text.replace(/\b(amendments?)\b/i, `$1 ${marker}`);
        expect(marked).not.toBe(text);
        expect(agreedToOtherChamberAmendment(marked), marked).toBeNull();
      });
    }
    for (const outcome of ['Failed by voice vote.', 'Not agreed to by voice vote.', 'failed of passage in Senate by Yea-Nay Vote. 45 - 53.']) {
      test(`"${outcome}" in: ${text.slice(0, 70)}`, () => {
        const failed = text.replace(/\b(?:Agreed to|agreed to in (?:House|Senate)|by (?:Unanimous Consent|Voice Vote)).*$/i, outcome);
        expect(failed).not.toBe(text);
        expect(agreedToOtherChamberAmendment(failed), failed).toBeNull();
      });
    }
  }
  test('every row read "none" is never final, and neither is any unrecognised sentence', () => {
    for (const [e, t] of READING_TABLE) if (e === 'none') expect(agreedToOtherChamberAmendment(t), t).toBeNull();
    for (const t of ['', 'Agreed to.', 'Senate amendment agreed to.', 'House agreed.', 'The amendment was agreed to by voice vote.', 'Senate amendment to the House amendment to the Senate amendment agreed to by the House.']) {
      expect(agreedToOtherChamberAmendment(t), t).toBeNull();
    }
  });
});

