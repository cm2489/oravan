import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import bills from '../data/bills.json';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { decisionState } from '../lib/docket.mjs';
import { FLOOR_PASSAGE_REJECTED, concurrentAdoptedBy, statusBasisText } from '../lib/floor-text.mjs';
import { deriveJourney, lastFailedVote, settledDecision } from '../lib/journey';
import { recordedRollNumber, settledDecisionDate, settledVoteGroups } from '../lib/settled-votes';
import type { Bill, RollCall } from '../lib/types';
import { votesCoverage, votesForBill } from '../lib/votes';

/*
 * THE RECORD-ONLY PANEL'S READER (owner, 2026-09-28, UX question Q9 answered
 * "a": "A record-only block with no numbers: 'This is law' or 'This was
 * rejected, 49–50', and how your members voted. No stance, no script.").
 *
 * `settledDecision` (lib/journey.ts) decides which bill pages drop the call
 * panel. It reads the stepper's own derivation, so the panel and "Where does it
 * stand?" agree, and it must never call a decision over that the MCP envelope
 * (lib/docket.mjs `decisionState`) still calls pending. Fixture sentences are
 * verbatim from data/bills.json as committed on 2026-09-28.
 *
 * WHICH RECORDS COUNT AS FINISHED (owner, 2026-09-29, pick (a) on artifact
 * 7BuRDMkWu9zigDE1u2XPLJ: "Only a law or a failed final vote counts as
 * finished. Procedural failures keep the call panel, with a line saying the
 * last attempt failed." — "we need to update the MCP server too if
 * possible"). So `settledDecision` returns a law or a rejected passage vote
 * and nothing else; a failed motion, a failed two-thirds suspension vote and
 * a veto keep the call, `lastFailedVote` supplies the line, and
 * `decisionState` answers the same way for the MCP envelope. Since
 * 2026-09-29 it also returns `adopted` for a concurrent resolution both
 * chambers agreed to in one form (H.Con.Res. 86), which goes to no president
 * and is that vehicle's own ending — never printed as law.
 */

type Rec = Pick<Bill, 'bill_type' | 'status' | 'last_action_text' | 'last_action_date'>;
const rec = (bill_type: string, status: string, text: string | null, date = '2026-09-24'): Rec =>
  ({ bill_type, status, last_action_text: text, last_action_date: date }) as Rec;

/** H.Con.Res. 89. */
const HCONRES_89 = 'Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.';
/** S.J.Res. 99. */
const MOTION_TO_PROCEED_REJECTED =
  'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50. Record Vote Number: 192. (CR S3194)';
/**
 * The three failed two-thirds votes in the corpus on 2026-09-28, each a vote
 * to PASS the measure under suspension of the rules, and each with a majority
 * voting yes. Verbatim, with the bill each belongs to.
 */
const SUSPENSION_FAILED = [
  {
    bill: 'H.J.Res. 1',
    bill_type: 'hjres',
    text: 'On motion to suspend the rules and pass Failed by the Yeas and Nays: (2/3 required): 212 - 206 (Roll no. 293).',
    tally: { yeas: 212, nays: 206 },
  },
  {
    bill: 'H.J.Res. 139',
    bill_type: 'hjres',
    text: 'On motion to suspend the rules and pass the resolution Failed by the Yeas and Nays: (2/3 required): 211 - 207 (Roll no. 95).',
    tally: { yeas: 211, nays: 207 },
  },
  {
    // A Senate bill, voted on in the House: the procedure names the chamber.
    bill: 'S. 2503',
    bill_type: 's',
    text: 'On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: (2/3 required): 264 - 133 (Roll no. 72).',
    tally: { yeas: 264, nays: 133 },
  },
] as const;
/** S.J.Res. 172, verbatim. */
const DISCHARGE_REJECTED =
  'Motion to discharge Senate Committee on Foreign Relations rejected by Yea-Nay Vote. 47 - 48. Record Vote Number: 174.';
/** S. 3386, verbatim. */
const CLOTURE_ON_PROCEED_NOT_INVOKED =
  'Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 51 - 48. Record Vote Number: 643. (CR S8654)';
/** S. 1318, verbatim. */
const PROCEED_TO_MESSAGE_REJECTED =
  'Motion to proceed to consideration of the House message to accompany S. 1318 rejected in Senate by Yea-Nay Vote. 47 - 52. Record Vote Number: 164.';
/** H.R. 3633: the failed vote, with a motion to reconsider it entered. */
const RECONSIDER_ENTERED =
  'Motion by Senator Tillis to reconsider the vote by which cloture on the motion to proceed to the measure was not invoked (Record Vote No. 234) entered in Senate.';

test.describe('settledDecision — which pages show the record, not the call', () => {
  test('a law', () => {
    expect(settledDecision(rec('hr', 'signed', 'Became Public Law No: 119-105.'))).toEqual({ kind: 'law' });
  });

  test('a veto keeps the call — Congress can still vote to override it', () => {
    // Pick (a): a veto is neither a law nor a failed final vote, so there is
    // no record-only panel for it.
    const vetoed = rec('hr', 'vetoed', 'Vetoed by President.');
    expect(settledDecision(vetoed)).toBeNull();
    // The stepper's sentence is the one that says the override is possible.
    expect(deriveJourney(vetoed).nowKey).toBe('nowVetoed');
    expect(en.bill.journey.nowVetoed).toMatch(/override/);
    expect(es.bill.journey.nowVetoed).toMatch(/anular el veto/);
    // The MCP envelope agrees since pick (a) (it called a veto settled before).
    expect(decisionState(vetoed)).toEqual({ state: 'pending', reason: null });
    // No failed vote either: the call panel prints no "last attempt" line.
    expect(lastFailedVote(vetoed)).toBeNull();
    // And the panel keeps no veto sentence of its own to print.
    expect(Object.keys(en.bill.settled)).not.toContain('vetoed');
    expect(Object.keys(es.bill.settled)).not.toContain('vetoed');
  });

  test('a rejected passage vote carries the chamber and the record\'s tally — settled on the page and in the MCP envelope', () => {
    const r = rec('hconres', 'floor_vote', HCONRES_89);
    expect(settledDecision(r)).toEqual({
      kind: 'rejected',
      chamber: 'senate',
      tally: { yeas: 49, nays: 50 },
    });
    expect(decisionState(r)).toEqual({ state: 'settled', reason: HCONRES_89 });
    // A settled page has no call panel, so no "last attempt" line either.
    expect(lastFailedVote(r)).toBeNull();
  });

  test('a failed motion to take it up is not finished: the call stays, with the failed vote named (pick (a))', () => {
    // S.J.Res. 185, verbatim.
    const r = rec('sjres', 'floor_vote', MOTION_TO_PROCEED_REJECTED);
    expect(settledDecision(r)).toBeNull();
    expect(decisionState(r)).toEqual({ state: 'pending', reason: null });
    expect(lastFailedVote(r)).toEqual({ procedure: 'proceed', chamber: 'senate', tally: { yeas: 47, nays: 50 } });
    // The stepper keeps its failed-motion sentence.
    expect(deriveJourney(r).nowKey).toBe('nowFloorMotionFailed');
  });

  test('every read procedural failure keeps the call and names its procedure', () => {
    for (const [text, procedure, tally] of [
      [DISCHARGE_REJECTED, 'discharge', { yeas: 47, nays: 48 }],
      [CLOTURE_ON_PROCEED_NOT_INVOKED, 'clotureProceed', { yeas: 51, nays: 48 }],
      [PROCEED_TO_MESSAGE_REJECTED, 'proceed', { yeas: 47, nays: 52 }],
      [
        'Cloture on the measure not invoked in Senate by Yea-Nay Vote. 55 - 44. Record Vote Number: 300.',
        'clotureMeasure',
        { yeas: 55, nays: 44 },
      ],
      ['Motion to proceed to consideration of measure rejected in Senate by Voice Vote. (CR S2407)', 'proceed', null],
    ] as const) {
      const r = rec('sjres', 'floor_vote', text);
      expect(settledDecision(r), text).toBeNull();
      expect(decisionState(r).state, text).toBe('pending');
      expect(lastFailedVote(r), text).toEqual({ procedure, chamber: 'senate', tally });
    }
  });

  test('a failed two-thirds vote is not finished: its own stepper sentence, the call stays, the line names it (pick (a))', () => {
    for (const s of SUSPENSION_FAILED) {
      const r = rec(s.bill_type, 'floor_vote', s.text);
      expect(settledDecision(r), s.bill).toBeNull();
      expect(decisionState(r), s.bill).toEqual({ state: 'pending', reason: null });
      expect(lastFailedVote(r), s.bill).toEqual({ procedure: 'suspension', chamber: 'house', tally: s.tally });
      // The stepper says what the vote was — never "has not agreed to take it
      // up" — with the record's own tally, even though a majority voted yes.
      expect(deriveJourney(r), s.bill).toMatchObject({ nowKey: 'nowFloorSuspensionFailed', nowChamber: 'house', tally: s.tally });
    }
  });

  test('a failed vote with a motion to reconsider entered keeps the call — the question can come back', () => {
    expect(settledDecision(rec('hr', 'floor_vote', RECONSIDER_ENTERED))).toBeNull();
    // The stepper still says the motion failed; only the panel stays open.
    expect(deriveJourney(rec('hr', 'floor_vote', RECONSIDER_ENTERED)).nowKey).toBe('nowFloorMotionFailed');
    expect(decisionState(rec('hr', 'floor_vote', RECONSIDER_ENTERED)).state).toBe('pending');
    // The sentence is the reconsider motion, not the vote: no line is read off
    // it (its date is the motion's, and it carries no tally).
    expect(lastFailedVote(rec('hr', 'floor_vote', RECONSIDER_ENTERED))).toBeNull();
  });

  test('a withdrawn or unread floor sentence prints no "last attempt" line', () => {
    for (const text of [
      'Motion to proceed to consideration of measure withdrawn in Senate.',
      'Motion to table the motion to proceed failed in Senate by Voice Vote.',
    ]) {
      expect(lastFailedVote(rec('sjres', 'floor_vote', text)), text).toBeNull();
    }
  });

  /*
   * A CONCURRENT RESOLUTION BOTH CHAMBERS AGREED TO IN ONE FORM (2026-09-29):
   * H.Con.Res. 86, as committed. The House agreed 215–208 on 2026-06-03; the
   * Senate agreed "without amendment" 50–48 on 2026-06-23; "Message on Senate
   * action sent to the House." was written over that the next day. It goes to
   * no president, so it is finished — and it is not a law.
   */
  const HCONRES_86_SENATE =
    'Resolution agreed to in Senate without amendment by Yea-Nay Vote. 50 - 48. Record Vote Number: 184. (consideration: CR S3039-3040)';
  const hconres86 = {
    ...rec('hconres', 'passed_chamber', 'Message on Senate action sent to the House.', '2026-06-24'),
    status_basis_text: HCONRES_86_SENATE,
    status_basis_date: '2026-06-23',
  };

  test('an adopted concurrent resolution is finished: the record-only panel, never as law, settled in the MCP envelope too', () => {
    expect(settledDecision(hconres86)).toEqual({ kind: 'adopted', chamber: 'senate' });
    expect(decisionState(hconres86)).toEqual({ state: 'settled', reason: HCONRES_86_SENATE });
    // The stepper says its path ends here, at the ending this vehicle has.
    expect(deriveJourney(hconres86)).toMatchObject({
      step: 4,
      ending: 'bothChambers',
      nowKey: 'nowAdoptedBoth',
      nowChamber: 'senate',
      isLaw: false,
      showTrailer: false,
    });
    // No call panel, so no "last attempt" line either.
    expect(lastFailedVote(hconres86)).toBeNull();
    // The outcome's date is the Senate's agreement, not the message's.
    expect(settledDecisionDate(hconres86)).toBe('2026-06-23');
  });

  test('a bill both chambers passed still goes to the president: the call stays, and the stepper keeps the president\'s step', () => {
    // H.R. 4467 as committed: the Senate passed it without amendment.
    const hr4467 = {
      ...rec('hr', 'passed_chamber', 'Message on Senate action sent to the House.', '2026-09-24'),
      status_basis_text: 'Passed Senate without amendment by Unanimous Consent. (consideration: CR S4882)',
      status_basis_date: '2026-09-22',
    };
    expect(settledDecision(hr4467)).toBeNull();
    expect(decisionState(hr4467)).toEqual({ state: 'pending', reason: null });
    expect(deriveJourney(hr4467)).toMatchObject({ step: 4, ending: 'president', nowKey: 'nowPassedBoth', isLaw: false });
  });

  test('a concurrent resolution only ONE chamber agreed to keeps the call', () => {
    const firstOnly = rec('hconres', 'passed_chamber', 'Received in the Senate and referred to the Committee on Foreign Relations.');
    expect(settledDecision(firstOnly)).toBeNull();
    // Agreed WITH an amendment: back to the House, not finished. Dated
    // today so the live wording holds; a fixed date ages past the 14-day
    // signal window and flips it to nowPassedBackStale (CI red 2026-10-08).
    const today = new Date().toISOString().slice(0, 10);
    const amended = rec('hconres', 'passed_chamber', 'Resolution agreed to in Senate with an amendment by Unanimous Consent.', today);
    expect(settledDecision(amended)).toBeNull();
    expect(deriveJourney(amended).nowKey).toBe('nowPassedBack');
    // The aged twin keeps the call too; only the wording drops its imminence.
    const agedAmended = rec('hconres', 'passed_chamber', 'Resolution agreed to in Senate with an amendment by Unanimous Consent.', '2026-01-02');
    expect(settledDecision(agedAmended)).toBeNull();
    expect(deriveJourney(agedAmended).nowKey).toBe('nowPassedBackStale');
  });

  test('every open stage keeps the call', () => {
    expect(settledDecision(rec('hr', 'committee', 'Referred to the House Committee on Ways and Means.'))).toBeNull();
    expect(settledDecision(rec('hr', 'introduced', 'Introduced in House'))).toBeNull();
    expect(
      settledDecision(rec('hr', 'floor_vote', 'Placed on the Union Calendar, Calendar No. 412.'))
    ).toBeNull();
    expect(settledDecision(rec('hr', 'passed_chamber', 'Received in the Senate.'))).toBeNull();
    expect(
      settledDecision(rec('hr', 'passed_chamber', 'Passed Senate without amendment by Unanimous Consent.'))
    ).toBeNull();
    expect(settledDecision(rec('hr', 'conference', 'Conference held.'))).toBeNull();
  });
});

test.describe('settledDecision against the committed corpus', () => {
  const corpus = bills as unknown as Rec[];

  test('never wider than the MCP envelope: settled here is settled or enacted there', () => {
    for (const b of corpus) {
      if (settledDecision(b) === null) continue;
      expect(decisionState(b).state, `${b.bill_type} ${b.last_action_text}`).not.toBe('pending');
    }
  });

  test('the one stated gap: MCP settled but the page keeps the call only where the stepper names no chamber', () => {
    for (const b of corpus) {
      if (decisionState(b).state === 'pending' || settledDecision(b) !== null) continue;
      // The second gap, an adopted concurrent resolution (#360), closed on
      // 2026-09-29: the page reads it as 'adopted' (below), so it never
      // reaches this line.
      expect(concurrentAdoptedBy(b), `${b.bill_type} ${b.last_action_text}`).toBeNull();
      expect(deriveJourney(b).nowKey, `${b.bill_type} ${b.last_action_text}`).toBe('nowFloorActivityNeutral');
    }
  });

  test('an adopted concurrent resolution is finished on the page exactly where the MCP envelope says so', () => {
    for (const b of corpus) {
      const by = concurrentAdoptedBy(b);
      const decision = settledDecision(b);
      if (by) {
        expect(decision, `${b.bill_type} ${statusBasisText(b)}`).toEqual({ kind: 'adopted', chamber: by });
        expect(decisionState(b).state).toBe('settled');
      } else {
        expect(decision?.kind, `${b.bill_type} ${statusBasisText(b)}`).not.toBe('adopted');
      }
    }
  });

  test('pick (a) over the whole corpus: settled means a law or a failed vote to pass it, and nothing else', () => {
    for (const b of corpus) {
      const label = `${b.bill_type} ${statusBasisText(b)}`;
      const decision = settledDecision(b);
      const state = decisionState(b).state;
      // The page: a law, or a rejected passage vote read off its own sentence.
      if (decision?.kind === 'law') expect(b.status, label).toBe('signed');
      if (decision?.kind === 'rejected') expect(FLOOR_PASSAGE_REJECTED.test(statusBasisText(b) ?? ''), label).toBe(true);
      // …or a concurrent resolution's own ending, never a bill's.
      if (decision?.kind === 'adopted') {
        expect(['hconres', 'sconres'], label).toContain(b.bill_type);
        expect(concurrentAdoptedBy(b), label).toBe(decision.chamber);
      }
      // The MCP envelope, the same rule: nothing but a law is enacted, and
      // nothing but a failed passage vote is settled — plus a concurrent
      // resolution both chambers adopted (#360), that vehicle's own ending.
      if (state === 'enacted') expect(b.status, label).toBe('signed');
      if (state === 'settled' && !concurrentAdoptedBy(b)) {
        expect(b.status, label).toBe('floor_vote');
        expect(FLOOR_PASSAGE_REJECTED.test(statusBasisText(b) ?? ''), label).toBe(true);
      }
      // Every failed procedural vote keeps the call on both surfaces.
      const nowKey = deriveJourney(b).nowKey;
      if (nowKey === 'nowFloorMotionFailed' || nowKey === 'nowFloorSuspensionFailed') {
        expect(decision, label).toBeNull();
        expect(state, label).toBe('pending');
      }
      // The "last attempt" line only ever stands on a page with a call panel.
      if (lastFailedVote(b) !== null) expect(decision, label).toBeNull();
    }
  });

  test('every failed two-thirds vote to pass reads as one: its own stepper sentence and the suspension line', () => {
    const SUSPENSION = /\bmotion to suspend the rules and (?:pass|agree to)\b[\s\S]*?\bfailed\b/i;
    for (const b of corpus) {
      if (b.status !== 'floor_vote') continue;
      const record = statusBasisText(b) ?? '';
      if (!SUSPENSION.test(record)) continue;
      const label = `${b.bill_type} ${record}`;
      expect(deriveJourney(b).nowKey, label).toBe('nowFloorSuspensionFailed');
      expect(lastFailedVote(b)?.procedure, label).toBe('suspension');
    }
  });

  test('the corpus really holds settled bills of the kinds the panel prints, and failed procedural votes the call panel names', () => {
    const kinds = new Set(corpus.map((b) => settledDecision(b)?.kind).filter(Boolean));
    expect(kinds.has('law'), 'no signed law in the corpus').toBe(true);
    expect(kinds.has('rejected'), 'no rejected passage vote in the corpus').toBe(true);
    expect(corpus.some((b) => lastFailedVote(b) !== null), 'no failed procedural vote in the corpus').toBe(true);
  });
});

/*
 * HOW YOUR MEMBERS VOTED, ONE VOTE AT A TIME (owner, 2026-09-28, reviewing
 * /bills/hconres-89-119: "It's talking about the Senate but in the 'no call to
 * make' box it talks about the House vote and then says the senators
 * underneath this. That doesn't make sense and is confusing.").
 *
 * The roll calls below carry the record's own ids, dates, rolls, questions,
 * results and totals from data/votes.json as committed on 2026-09-28; the
 * member ids in `votes` are placeholders (the panel's join is by id, so any id
 * shows the shape).
 */
test.describe('settledVoteGroups — the deciding vote first, one chamber per group', () => {
  const FLOOR = '2026-05-27';
  const noVotes = { yea: [], nay: [], present: [], notVoting: [] };
  const HCONRES_89_HOUSE: RollCall = {
    id: 'h-119-2-282',
    chamber: 'house',
    congress: 119,
    session: 2,
    roll: 282,
    date: '2026-07-23',
    question: 'On Agreeing to the Resolution',
    result: 'Passed',
    bill: 'hconres-89-119',
    totals: { yea: 214, nay: 208, present: 0, notVoting: 9 },
    source: 'https://clerk.house.gov/evs/2026/roll282.xml',
    votes: { ...noVotes, yea: ['REP_A'] },
  };
  const HCONRES_89_SENATE: RollCall = {
    id: 's-119-2-244',
    chamber: 'senate',
    congress: 119,
    session: 2,
    roll: 244,
    date: '2026-09-24',
    question: 'On the Concurrent Resolution H.Con.Res. 89',
    result: 'Concurrent Resolution Rejected',
    bill: 'hconres-89-119',
    totals: { yea: 49, nay: 50, present: 0, notVoting: 1 },
    source: 'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00244.xml',
    votes: { ...noVotes, yea: ['SEN_A'], nay: ['SEN_B'] },
  };
  const hconres89 = rec('hconres', 'floor_vote', HCONRES_89, '2026-09-24');

  test('H.Con.Res. 89: the Senate vote that decided it, then the House vote, each with its own date and tally', () => {
    const settled = settledDecision(hconres89)!;
    // votesForBill order: newest first.
    const groups = settledVoteGroups(hconres89, settled, [HCONRES_89_SENATE, HCONRES_89_HOUSE], FLOOR);
    expect(groups.map((g) => g.chamber)).toEqual(['senate', 'house']);
    expect(groups[0]).toEqual({
      chamber: 'senate',
      date: '2026-09-24',
      tally: { yeas: 49, nays: 50 },
      source: 'rollCall',
      positions: { SEN_A: 'yea', SEN_B: 'nay' },
      deciding: true,
    });
    expect(groups[1]).toEqual({
      chamber: 'house',
      date: '2026-07-23',
      tally: { yeas: 214, nays: 208 },
      source: 'rollCall',
      positions: { REP_A: 'yea' },
      deciding: false,
    });
    // Never two chambers in one group: a senator is never in the House
    // group's positions, and the reverse.
    expect(Object.keys(groups[0].positions!)).not.toContain('REP_A');
    expect(Object.keys(groups[1].positions!)).not.toContain('SEN_A');
  });

  test('the deciding vote is the roll number the record names, not another roll call that day', () => {
    const tabled: RollCall = { ...HCONRES_89_SENATE, id: 's-119-2-245', roll: 245, question: 'On the Motion to Table' };
    const groups = settledVoteGroups(hconres89, settledDecision(hconres89)!, [tabled, HCONRES_89_SENATE, HCONRES_89_HOUSE], FLOOR);
    expect(groups[0].deciding).toBe(true);
    expect(groups[0].tally).toEqual({ yeas: 49, nays: 50 });
    expect(recordedRollNumber(HCONRES_89, 'senate')).toBe(244);
  });

  test('H.R. 2262: the House vote only, from the record, saying the roll-call file begins after it', () => {
    // The rejection sits behind the House's routine reconsider-tabled step, so
    // the record's own date is the status basis's (2026-01-13).
    const hr2262 = {
      ...rec('hr', 'floor_vote', 'Motion to reconsider laid on the table Agreed to without objection.', '2026-01-13'),
      status_basis_text:
        'Failed of passage/not agreed to in House On passage Failed by the Yeas and Nays: 209 - 215 (Roll no. 19).',
      status_basis_date: '2026-01-13',
    };
    const settled = settledDecision(hr2262)!;
    expect(settled).toEqual({ kind: 'rejected', chamber: 'house', tally: { yeas: 209, nays: 215 } });
    expect(recordedRollNumber(hr2262.status_basis_text, 'house')).toBe(19);
    // No roll call on the bill in the file: the record's own date and tally.
    expect(settledVoteGroups(hr2262, settled, [], FLOOR)).toEqual([
      {
        chamber: 'house',
        date: '2026-01-13',
        tally: { yeas: 209, nays: 215 },
        source: 'beforeFile',
        positions: null,
        deciding: true,
      },
    ]);
  });

  test('a voice vote records no positions, and says so rather than "not in the file"', () => {
    const voice = rec('hconres', 'floor_vote', 'Failed of passage in Senate by Voice Vote.', '2026-06-20');
    const [g] = settledVoteGroups(voice, settledDecision(voice)!, [], FLOOR);
    expect(g).toMatchObject({ chamber: 'senate', date: '2026-06-20', tally: null, source: 'voice', deciding: true });
  });

  test('the decision date is the status basis\'s own date, and never another action\'s', () => {
    const basis = {
      ...rec('hr', 'floor_vote', 'Motion to reconsider laid on the table Agreed to without objection.', '2026-01-14'),
      status_basis_text:
        'Failed of passage/not agreed to in House On passage Failed by the Yeas and Nays: 209 - 215 (Roll no. 19).',
      status_basis_date: '2026-01-13',
    };
    expect(settledDecisionDate(basis)).toBe('2026-01-13');
    expect(settledDecisionDate({ ...basis, status_basis_date: null })).toBeNull();
    expect(settledDecisionDate(hconres89)).toBe('2026-09-24');
  });

  test('H.Con.Res. 86 (adopted): the Senate agreement that completed it, then the House vote, each with its own date and tally', () => {
    const HCONRES_86_HOUSE: RollCall = {
      ...HCONRES_89_HOUSE,
      id: 'h-119-2-199',
      roll: 199,
      date: '2026-06-03',
      bill: 'hconres-86-119',
      totals: { yea: 215, nay: 208, present: 0, notVoting: 7 },
      source: 'https://clerk.house.gov/evs/2026/roll199.xml',
    };
    const HCONRES_86_SENATE: RollCall = {
      ...HCONRES_89_SENATE,
      id: 's-119-2-184',
      roll: 184,
      date: '2026-06-23',
      question: 'On the Concurrent Resolution H.Con.Res. 86',
      result: 'Concurrent Resolution Agreed to',
      bill: 'hconres-86-119',
      totals: { yea: 50, nay: 48, present: 0, notVoting: 2 },
    };
    const hconres86 = {
      ...rec('hconres', 'passed_chamber', 'Message on Senate action sent to the House.', '2026-06-24'),
      status_basis_text:
        'Resolution agreed to in Senate without amendment by Yea-Nay Vote. 50 - 48. Record Vote Number: 184. (consideration: CR S3039-3040)',
      status_basis_date: '2026-06-23',
    };
    const settled = settledDecision(hconres86)!;
    expect(settled).toEqual({ kind: 'adopted', chamber: 'senate' });
    const groups = settledVoteGroups(hconres86, settled, [HCONRES_86_SENATE, HCONRES_86_HOUSE], FLOOR);
    expect(groups.map((g) => [g.chamber, g.date, g.tally, g.source, g.deciding])).toEqual([
      ['senate', '2026-06-23', { yeas: 50, nays: 48 }, 'rollCall', true],
      ['house', '2026-06-03', { yeas: 215, nays: 208 }, 'rollCall', false],
    ]);
    // Matched by the roll number the Senate's sentence carries.
    expect(recordedRollNumber(hconres86.status_basis_text, 'senate')).toBe(184);
    // Never two chambers in one group.
    expect(Object.keys(groups[0].positions!)).not.toContain('REP_A');
    expect(Object.keys(groups[1].positions!)).not.toContain('SEN_A');
  });

  test('a law: each chamber\'s newest roll call, newest first, none marked deciding', () => {
    const law = rec('hconres', 'signed', 'Became Public Law No: 119-105.');
    const olderSenate: RollCall = { ...HCONRES_89_SENATE, id: 's-119-2-200', roll: 200, date: '2026-07-01' };
    const groups = settledVoteGroups(law, { kind: 'law' }, [HCONRES_89_SENATE, HCONRES_89_HOUSE, olderSenate], FLOOR);
    expect(groups.map((g) => [g.chamber, g.date, g.deciding])).toEqual([
      ['senate', '2026-09-24', false],
      ['house', '2026-07-23', false],
    ]);
    expect(settledVoteGroups(law, { kind: 'law' }, [], FLOOR)).toEqual([]);
  });

  test('over the committed corpus: the deciding vote leads, no chamber twice, and a file roll call keeps its own numbers', () => {
    const floor = votesCoverage().floor;
    for (const b of bills as unknown as (Rec & { full_identifier: string })[]) {
      const settled = settledDecision(b);
      if (!settled) continue;
      const rolls = votesForBill(b.full_identifier);
      const groups = settledVoteGroups(b, settled, rolls, floor);
      const chambers = groups.map((g) => g.chamber);
      expect(new Set(chambers).size, b.full_identifier).toBe(chambers.length);
      if (settled.kind !== 'law') {
        expect(groups[0].deciding, b.full_identifier).toBe(true);
        expect(groups[0].chamber, b.full_identifier).toBe(settled.chamber);
        expect(groups.slice(1).every((g) => !g.deciding), b.full_identifier).toBe(true);
      }
      for (const g of groups) {
        if (g.source !== 'rollCall') {
          expect(g.positions, b.full_identifier).toBeNull();
          continue;
        }
        const own = rolls.some(
          (x) =>
            x.chamber === g.chamber &&
            x.date === g.date &&
            x.totals.yea === g.tally?.yeas &&
            x.totals.nay === g.tally?.nays
        );
        expect(own, `${b.full_identifier} ${g.chamber} ${g.date}`).toBe(true);
      }
    }
  });

  test('the two pages the owner reviewed, as committed', () => {
    const find = (slug: string) =>
      (bills as unknown as (Rec & { full_identifier: string })[]).find((b) => b.full_identifier === slug);
    const floor = votesCoverage().floor;

    const h = find('hconres-89-119');
    test.skip(!h || h.last_action_text !== HCONRES_89, 'H.Con.Res. 89 has a newer action than 2026-09-24');
    const hGroups = settledVoteGroups(h!, settledDecision(h!)!, votesForBill('hconres-89-119'), floor);
    expect(hGroups.map((g) => [g.chamber, g.date, g.tally, g.deciding])).toEqual([
      ['senate', '2026-09-24', { yeas: 49, nays: 50 }, true],
      ['house', '2026-07-23', { yeas: 214, nays: 208 }, false],
    ]);

    // H.Con.Res. 89 is still settled under pick (a), in the MCP envelope too.
    expect(settledDecision(h!)?.kind).toBe('rejected');
    expect(decisionState(h!).state).toBe('settled');

    // S. 2503 LEFT the settled set on 2026-09-29 (pick (a)): a failed
    // two-thirds vote keeps the call, with the line naming the vote.
    const s = find('s-2503-119');
    test.skip(!s || s.last_action_text !== SUSPENSION_FAILED[2].text, 'S. 2503 has a newer action than 2026-02-24');
    expect(settledDecision(s!)).toBeNull();
    expect(decisionState(s!)).toEqual({ state: 'pending', reason: null });
    expect(lastFailedVote(s!)).toEqual({ procedure: 'suspension', chamber: 'house', tally: { yeas: 264, nays: 133 } });
    expect(settledDecisionDate(s!)).toBe('2026-02-24');
  });

  test('H.Con.Res. 86 as committed: adopted by both chambers, the Senate agreement first, settled in the MCP envelope', () => {
    const b = (bills as unknown as (Rec & { full_identifier: string; status_basis_text?: string })[]).find(
      (x) => x.full_identifier === 'hconres-86-119'
    );
    test.skip(
      !b || !b.status_basis_text?.startsWith('Resolution agreed to in Senate without amendment by Yea-Nay Vote. 50 - 48.'),
      'H.Con.Res. 86 has a newer basis than 2026-06-23'
    );
    expect(settledDecision(b!)).toEqual({ kind: 'adopted', chamber: 'senate' });
    expect(decisionState(b!).state).toBe('settled');
    expect(settledDecisionDate(b!)).toBe('2026-06-23');
    const groups = settledVoteGroups(b!, settledDecision(b!)!, votesForBill('hconres-86-119'), votesCoverage().floor);
    expect(groups.map((g) => [g.chamber, g.date, g.tally, g.deciding])).toEqual([
      ['senate', '2026-06-23', { yeas: 50, nays: 48 }, true],
      ['house', '2026-06-03', { yeas: 215, nays: 208 }, false],
    ]);
  });

  test('H.Con.Res. 89 as committed stays a rejection, not an adoption', () => {
    const h = (bills as unknown as (Rec & { full_identifier: string })[]).find((x) => x.full_identifier === 'hconres-89-119');
    test.skip(!h || h.last_action_text !== HCONRES_89, 'H.Con.Res. 89 has a newer action than 2026-09-24');
    expect(settledDecision(h!)).toEqual({ kind: 'rejected', chamber: 'senate', tally: { yeas: 49, nays: 50 } });
    expect(concurrentAdoptedBy(h!)).toBeNull();
    expect(deriveJourney(h!).nowKey).toBe('nowFloorPassageRejected');
  });

  test('S.J.Res. 185 as committed: a failed motion to proceed, not settled, the call and the line (pick (a))', () => {
    const b = (bills as unknown as (Rec & { full_identifier: string })[]).find((x) => x.full_identifier === 'sjres-185-119');
    test.skip(!b || b.last_action_text !== MOTION_TO_PROCEED_REJECTED, 'S.J.Res. 185 has a newer action than 2026-06-24');
    expect(settledDecision(b!)).toBeNull();
    expect(decisionState(b!)).toEqual({ state: 'pending', reason: null });
    expect(lastFailedVote(b!)).toEqual({ procedure: 'proceed', chamber: 'senate', tally: { yeas: 47, nays: 50 } });
    expect(settledDecisionDate(b!)).toBe('2026-06-24');
  });
});

test.describe('the panel\'s words, in both languages', () => {
  const tEn = createTranslator({ locale: 'en', messages: en });
  const tEs = createTranslator({ locale: 'es', messages: es });

  // The record's dates, formatted the way the page formats them (month long).
  const SEP_24_EN = 'September 24, 2026';
  const SEP_24_ES = '24 de septiembre de 2026';
  const noDate = { hasDate: 'none', date: '' };

  test('a rejection is one sentence naming the deciding chamber, the record\'s tally and its date', () => {
    // H.Con.Res. 89, the page the owner reviewed on 2026-09-28.
    const withTally = { chamber: 'Senate', tally: 'yes', yeas: 49, nays: 50 };
    expect(tEn('bill.settled.rejected', { ...withTally, hasDate: 'yes', date: SEP_24_EN })).toBe(
      'The Senate rejected it, 49–50, on September 24, 2026.'
    );
    expect(tEs('bill.settled.rejected', { ...withTally, hasDate: 'yes', date: SEP_24_ES })).toBe(
      'El Senado lo rechazó, por 49 votos a favor y 50 en contra, el 24 de septiembre de 2026.'
    );
    // No tally kept, a date held: no stray comma.
    const noTally = { chamber: 'House', tally: 'none', yeas: 0, nays: 0 };
    expect(tEn('bill.settled.rejected', { ...noTally, hasDate: 'yes', date: 'January 13, 2026' })).toBe(
      'The House rejected it on January 13, 2026.'
    );
    expect(tEs('bill.settled.rejected', { ...noTally, hasDate: 'yes', date: '13 de enero de 2026' })).toBe(
      'La Cámara lo rechazó el 13 de enero de 2026.'
    );
    // A record with no date for the action prints none — never another one.
    expect(tEn('bill.settled.rejected', { ...withTally, ...noDate })).toBe('The Senate rejected it, 49–50.');
    expect(tEn('bill.settled.rejected', { ...noTally, ...noDate })).toBe('The House rejected it.');
    expect(tEs('bill.settled.rejected', { ...noTally, ...noDate })).toBe('La Cámara lo rechazó.');
  });

  /*
   * THE "LAST ATTEMPT FAILED" LINE (owner, 2026-09-29, pick (a): "Procedural
   * failures keep the call panel, with a line saying the last attempt
   * failed."). It lives in the call panel, not this one, so its key is
   * `bill.lastAttempt`. One sentence: what failed, the record's tally and the
   * record's date — and never a claim about what comes next.
   */
  const jun24 = { hasDate: 'yes', date: 'June 24, 2026' };
  const jun24Es = { hasDate: 'yes', date: '24 de junio de 2026' };

  test('the last-attempt line names the procedure, the chamber, the record\'s tally and date', () => {
    // S.J.Res. 185 (a failed motion to proceed), the page the owner reviews.
    const senate = { chamber: 'Senate', tally: 'yes', yeas: 47, nays: 50 };
    expect(tEn('bill.lastAttempt', { procedure: 'proceed', ...senate, ...jun24 })).toBe(
      'The last attempt failed: the Senate voted against taking it up, 47–50, on June 24, 2026.'
    );
    expect(tEs('bill.lastAttempt', { procedure: 'proceed', ...senate, ...jun24Es })).toBe(
      'El último intento fracasó: el Senado votó en contra de considerarlo, con 47 votos a favor y 50 en contra, el 24 de junio de 2026.'
    );
    // S. 2503 (a failed two-thirds suspension vote), the other.
    const house = { chamber: 'House', tally: 'yes', yeas: 264, nays: 133 };
    expect(tEn('bill.lastAttempt', { procedure: 'suspension', ...house, hasDate: 'yes', date: 'February 24, 2026' })).toBe(
      'The last attempt failed: a House vote to pass it fell short of the two-thirds this fast-track vote needs, 264–133, on February 24, 2026.'
    );
    expect(tEs('bill.lastAttempt', { procedure: 'suspension', ...house, hasDate: 'yes', date: '24 de febrero de 2026' })).toBe(
      'El último intento fracasó: una votación de la Cámara para aprobarlo por la vía rápida no alcanzó los dos tercios que ese procedimiento exige, con 264 votos a favor y 133 en contra, el 24 de febrero de 2026.'
    );
    // The other three read procedures.
    expect(tEn('bill.lastAttempt', { procedure: 'clotureProceed', chamber: 'Senate', tally: 'yes', yeas: 51, nays: 48, ...noDate })).toBe(
      'The last attempt failed: a Senate vote to end debate on taking it up fell short, 51–48.'
    );
    expect(tEn('bill.lastAttempt', { procedure: 'clotureMeasure', chamber: 'Senate', tally: 'none', yeas: 0, nays: 0, ...noDate })).toBe(
      'The last attempt failed: a Senate vote to end debate on it fell short.'
    );
    expect(tEn('bill.lastAttempt', { procedure: 'discharge', chamber: 'Senate', tally: 'yes', yeas: 47, nays: 48, ...jun24 })).toBe(
      'The last attempt failed: the Senate voted against bringing it out of committee, 47–48, on June 24, 2026.'
    );
    expect(tEs('bill.lastAttempt', { procedure: 'discharge', chamber: 'Senate', tally: 'yes', yeas: 47, nays: 48, ...jun24Es })).toBe(
      'El último intento fracasó: el Senado votó en contra de sacarlo del comité, con 47 votos a favor y 48 en contra, el 24 de junio de 2026.'
    );
    // A voice vote: no numbers, and no stray comma.
    expect(tEn('bill.lastAttempt', { procedure: 'proceed', chamber: 'Senate', tally: 'none', yeas: 0, nays: 0, ...noDate })).toBe(
      'The last attempt failed: the Senate voted against taking it up.'
    );
    expect(tEs('bill.lastAttempt', { procedure: 'proceed', chamber: 'Senate', tally: 'none', yeas: 0, nays: 0, ...noDate })).toBe(
      'El último intento fracasó: el Senado votó en contra de considerarlo.'
    );
  });

  test('the last-attempt line never says what comes next — in either language, for any procedure', () => {
    for (const procedure of ['proceed', 'clotureProceed', 'clotureMeasure', 'discharge', 'suspension', 'unread']) {
      for (const chamber of ['House', 'Senate']) {
        const args = { procedure, chamber, tally: 'yes', yeas: 1, nays: 2, ...noDate };
        expect(tEn('bill.lastAttempt', args)).not.toMatch(/\b(?:again|come back|return|still|next|will|can|could)\b/i);
        expect(tEs('bill.lastAttempt', args)).not.toMatch(/\b(?:otra vez|de nuevo|volver|todav[ií]a|pr[oó]xim|podr[aá]|puede)\b/i);
        expect(tEn('bill.lastAttempt', args)).not.toMatch(/\(\d{3}\)|\d{3}-\d{4}/);
      }
    }
  });

  test('the stepper\'s failed two-thirds sentence says what the vote was — never "take it up"', () => {
    const house = { chamber: 'House', other: 'Senate', tally: 'yes', yeas: 264, nays: 133 };
    expect(tEn('bill.journey.nowFloorSuspensionFailed', house)).toBe(
      'a House vote to pass it fell short of the two-thirds this fast-track vote needs, 264–133.'
    );
    expect(tEs('bill.journey.nowFloorSuspensionFailed', house)).toBe(
      'una votación de la Cámara para aprobarlo por la vía rápida no alcanzó los dos tercios que ese procedimiento exige, con 264 votos a favor y 133 en contra.'
    );
    expect(tEn('bill.journey.nowFloorSuspensionFailed', house)).not.toMatch(/take it up|motion/i);
    expect(tEs('bill.journey.nowFloorSuspensionFailed', house)).not.toMatch(/considerarlo|moción/i);
  });

  test('an adopted concurrent resolution is one sentence: both chambers and the second one\'s date — never law', () => {
    // "A concurrent resolution does not go to the president" moved out of
    // this sentence on 2026-09-29, into the explainer printed right under it
    // (bill.concurrent.general, components/ConcurrentExplainer.tsx), which
    // says it with the term glossed; tests/concurrent-explainer.unit.spec.ts
    // pins that sentence.
    const jun23 = { hasDate: 'yes', date: 'June 23, 2026' };
    const jun23Es = { hasDate: 'yes', date: '23 de junio de 2026' };
    expect(tEn('bill.settled.adopted', jun23)).toBe('Both chambers agreed to it in the same form, the second on June 23, 2026.');
    expect(tEs('bill.settled.adopted', jun23Es)).toBe(
      'Ambas cámaras lo aprobaron con el mismo texto, la segunda el 23 de junio de 2026.'
    );
    // No date held: none printed, and no stray comma.
    expect(tEn('bill.settled.adopted', noDate)).toBe('Both chambers agreed to it in the same form.');
    expect(tEs('bill.settled.adopted', noDate)).toBe('Ambas cámaras lo aprobaron con el mismo texto.');
    // Never the law sentence, in either language.
    for (const [m, t, when] of [
      [en, tEn, jun23],
      [es, tEs, jun23Es],
    ] as const) {
      expect(t('bill.settled.adopted', when)).not.toContain(m.bill.settled.law.replace(/\.$/, ''));
      expect(t('bill.settled.adopted', when)).not.toMatch(/\blaw\b|\bley\b/i);
    }
  });

  test('the stepper\'s adopted sentence says the path ends, with "the president" lowercase', () => {
    expect(tEn('bill.journey.nowAdoptedBoth')).toBe(
      'both chambers have agreed to it in the same form. This kind of resolution does not go to the president, so its path ends here.'
    );
    expect(tEs('bill.journey.nowAdoptedBoth')).toBe(
      'ambas cámaras lo han aprobado con el mismo texto. Este tipo de resolución no pasa al presidente, así que su trámite termina aquí.'
    );
    // The owner's style rule, 2026-09-29: "It's 'the president'".
    for (const text of [
      en.bill.journey.nowAdoptedBoth,
      es.bill.journey.nowAdoptedBoth,
      en.bill.settled.adopted,
      es.bill.settled.adopted,
      en.bills.status.adopted,
      es.bills.status.adopted,
      en.bills.status.passed_both,
      es.bills.status.passed_both,
    ]) {
      expect(text).not.toMatch(/President|Presidente/);
    }
  });

  test('the retired settled sentences are gone from both languages', () => {
    for (const key of ['motionFailed', 'suspensionFailed', 'vetoed']) {
      expect(Object.keys(en.bill.settled)).not.toContain(key);
      expect(Object.keys(es.bill.settled)).not.toContain(key);
    }
  });

  test('each vote group is headed by its own chamber, in both languages', () => {
    expect(tEn('bill.settled.voteIn', { chamber: 'senate' })).toBe('Senate vote');
    expect(tEn('bill.settled.voteIn', { chamber: 'house' })).toBe('House vote');
    expect(tEs('bill.settled.voteIn', { chamber: 'senate' })).toBe('Votación del Senado');
    expect(tEs('bill.settled.voteIn', { chamber: 'house' })).toBe('Votación de la Cámara');
    expect(tEn('bill.settled.membersHeading')).toBe('How your members voted');
  });

  test('every new string exists in both languages and the Spanish is not an English copy', () => {
    for (const key of [
      'title',
      'law',
      'rejected',
      'adopted',
      'needZip',
      'membersHeading',
      'voteIn',
      'noRecordedVote',
      'positionNotShown',
      'beforeFileNote',
      'notInFileNote',
      'voiceNote',
      'noMember',
      'multiDistrict',
      'noRollCalls',
    ] as const) {
      expect(typeof en.bill.settled[key], `en.bill.settled.${key}`).toBe('string');
      expect(es.bill.settled[key], `es.bill.settled.${key}`).not.toBe(en.bill.settled[key]);
    }
    expect(es.bill.alsoYours).not.toBe(en.bill.alsoYours);
    expect(es.bill.lastAttempt).not.toBe(en.bill.lastAttempt);
    expect(es.bill.journey.nowFloorSuspensionFailed).not.toBe(en.bill.journey.nowFloorSuspensionFailed);
    expect(es.bill.journey.nowAdoptedBoth).not.toBe(en.bill.journey.nowAdoptedBoth);
    expect(es.bills.status.adopted).not.toBe(en.bills.status.adopted);
    expect(es.bills.status.passed_both).not.toBe(en.bills.status.passed_both);
    expect(es.moments.vehiclesLedeSomeSettled).not.toBe(en.moments.vehiclesLedeSomeSettled);
  });

  test('no phone number and no ask in the record-only panel\'s words', () => {
    for (const messages of [en, es]) {
      for (const text of Object.values(messages.bill.settled)) {
        expect(text).not.toMatch(/\(\d{3}\)|\d{3}-\d{4}/);
        expect(text).not.toMatch(/\bcall your\b|\bllama a\b/i);
      }
    }
  });
});
