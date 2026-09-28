import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import bills from '../data/bills.json';
import en from '../messages/en.json';
import es from '../messages/es.json';
import {
  CLOTURE_INVOKED_ON_MEASURE,
  FLOOR_PASSAGE_REJECTED,
  FLOOR_SETTLED,
  floorClotureInvokedChamber,
  floorPassageRejectedChamber,
  floorPendingChamber,
  floorSettledChamber,
  recordedTally,
  statusBasisText,
} from '../lib/floor-text.mjs';
import { decisionState, entersFloorWatch, isSettledFloor } from '../lib/docket.mjs';
import { billStatusLine } from '../lib/moment-status.mjs';
import { billFloorBand, deriveJourney, liveCallTarget } from '../lib/journey';
import { RECORD_ONLY_MODEL as PAGE_RECORD_ONLY_MODEL, isAiSummary } from '../lib/moment-updates';
import { RECORD_ONLY_MODEL } from '../scripts/moment-updates.mjs';

/*
 * THE SETTLED-STATE FAMILY (the 2026-09-27 audit, SY-01 / SY-03 / SY-05; owner
 * card a5). Every fixture sentence is copied verbatim from data/bills.json as
 * committed on 2026-09-27 — a matcher that drifts off the record's real
 * wording fails here, not on a bill page.
 */

/** H.Con.Res. 89, the Senate's 49–50 rejection (2026-09-24). */
const HCONRES_89 = 'Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.';
/** The House's own summary line for a defeated measure. */
const HOUSE_PASSAGE_FAILED = 'Failed of passage/not agreed to in House On passage Failed by the Yeas and Nays: 209 - 215 (Roll no. 19).';
const HOUSE_RESOLUTION_FAILED =
  'Failed of passage/not agreed to in House On agreeing to the resolution Failed by the Yeas and Nays: 212 - 219 (Roll no. 85).';
const HOUSE_TIE = 'Failed of passage/not agreed to in House On agreeing to the resolution Failed by the Yeas and Nays: 212 - 212 (Roll no. 170).';
const HOUSE_PRESENT = 'Failed of passage/not agreed to in House On agreeing to the resolution Failed by the Yeas and Nays: 213 - 214, 1 Present (Roll no. 114).';
const SENATE_PASSAGE_FAILED_CR = 'Failed of passage in Senate by Yea-Nay Vote. 47 - 52. Record Vote Number: 95. (consideration: CR S1364, S1367-1390)';

/** The failed-MOTION side, which must stay a failed motion. */
const MOTION_TO_PROCEED_REJECTED =
  'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50. Record Vote Number: 192. (CR S3194)';
const DISCHARGE_REJECTED = 'Motion to discharge Senate Committee on Foreign Relations rejected by Yea-Nay Vote. 47 - 48. Record Vote Number: 174.';
const CLOTURE_NOT_INVOKED = 'Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 52 - 46. Record Vote Number: 231.';
const SUSPENSION_FAILED = 'On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: (2/3 required): 264 - 133 (Roll no. 72).';
const RULE_FAILED = 'Rule H. Res. 1175 failed passage of House.';

/** S. 4668, 2026-09-24. */
const S4668_CLOTURE = 'Cloture on the measure, as amended, invoked in Senate by Yea-Nay Vote. 74 - 25. Record Vote Number: 243.';

const today = () => new Date().toISOString().slice(0, 10);

test.describe('SY-01 · a rejected passage vote is its own settled class', () => {
  test('H.Con.Res. 89, verbatim: settled, a passage defeat, in the Senate, 49–50', () => {
    expect(FLOOR_SETTLED.test(HCONRES_89)).toBe(true);
    expect(FLOOR_PASSAGE_REJECTED.test(HCONRES_89)).toBe(true);
    expect(floorPassageRejectedChamber(HCONRES_89)).toBe('senate');
    expect(floorSettledChamber(HCONRES_89)).toBe('senate');
    expect(recordedTally(HCONRES_89)).toEqual({ yeas: 49, nays: 50 });
  });

  test('the House forms read the same way, with the chamber and the tally from the sentence', () => {
    expect(floorPassageRejectedChamber(HOUSE_PASSAGE_FAILED)).toBe('house');
    expect(floorPassageRejectedChamber(HOUSE_RESOLUTION_FAILED)).toBe('house');
    expect(floorPassageRejectedChamber(SENATE_PASSAGE_FAILED_CR)).toBe('senate');
    expect(recordedTally(HOUSE_PASSAGE_FAILED)).toEqual({ yeas: 209, nays: 215 });
    expect(recordedTally(HOUSE_TIE)).toEqual({ yeas: 212, nays: 212 });
    expect(recordedTally(HOUSE_PRESENT)).toEqual({ yeas: 213, nays: 214 });
  });

  test('a failed MOTION is still a failed motion — never a passage defeat', () => {
    for (const text of [MOTION_TO_PROCEED_REJECTED, DISCHARGE_REJECTED, CLOTURE_NOT_INVOKED, SUSPENSION_FAILED]) {
      expect(floorSettledChamber(text), text).not.toBeNull();
      expect(floorPassageRejectedChamber(text), text).toBeNull();
    }
  });

  test('a RULE failing is not the measure failing, and a veto override is not a passage vote', () => {
    expect(floorPassageRejectedChamber(RULE_FAILED)).toBeNull();
    expect(FLOOR_PASSAGE_REJECTED.test('Failed of passage in Senate over veto by Yea-Nay Vote. 53 - 45.')).toBe(false);
  });

  test('the tally is read, never invented: a voice vote carries none', () => {
    expect(recordedTally('Motion to proceed to consideration of measure rejected in Senate by Voice Vote. (CR S2407)')).toBeNull();
    expect(recordedTally(SUSPENSION_FAILED)).toEqual({ yeas: 264, nays: 133 });
    expect(recordedTally(null)).toBeNull();
  });

  test('corpus: the passage class is a strict subset of the settled vocabulary, and splits nothing onto the pending side', () => {
    let passage = 0;
    for (const b of bills as Parameters<typeof statusBasisText>[0][]) {
      const text = statusBasisText(b);
      if (!text) continue;
      if (floorPassageRejectedChamber(text)) {
        passage++;
        expect(FLOOR_SETTLED.test(text), text).toBe(true);
        expect(floorPendingChamber(text), text).toBeNull();
        expect(floorSettledChamber(text), text).toBe(floorPassageRejectedChamber(text));
      }
    }
    // Not a count to keep — the corpus moves nightly — only proof the sweep
    // read the class at all (H.Con.Res. 89 and the House defeats, 2026-09-27).
    expect(passage).toBeGreaterThan(0);
  });
});

test.describe('SY-01 · a settled decision offers no live call — what follows from the class today', () => {
  const settled = { bill_type: 'hconres', status: 'floor_vote' as const, last_action_text: HCONRES_89, last_action_date: today() };

  test('the call rail gets no live target: no "your senators are the live call" over a dead resolution', () => {
    expect(liveCallTarget(settled)).toBeNull();
  });

  test('the crown and the band read no pending vote, and the ladder does not enter it into the floor watch', () => {
    expect(floorPendingChamber(HCONRES_89)).toBeNull();
    expect(entersFloorWatch(HCONRES_89)).toBe(false);
  });

  test('the act-now pool drops it (isSettledFloor is the pool predicate)', () => {
    expect(isSettledFloor(settled)).toBe(true);
  });

  test('the Big Questions vehicle card reads it as finished, so its button is "Read the bill", not "Read + call"', () => {
    const line = billStatusLine(settled);
    expect(line).toMatchObject({ key: 'failed', chamber: 'senate', terminal: true });
  });
});

test.describe('SY-03 · decisionState, the MCP envelope\'s decision_state', () => {
  test('H.Con.Res. 89: settled, and the reason is the record\'s own sentence', () => {
    expect(decisionState({ status: 'floor_vote', last_action_text: HCONRES_89 })).toEqual({ state: 'settled', reason: HCONRES_89 });
  });

  test('a defeat behind an ambiguous latest step is read from the stored basis', () => {
    const b = { status: 'floor_vote', last_action_text: 'Motion to reconsider laid on the table Agreed to without objection.', status_basis_text: HOUSE_RESOLUTION_FAILED };
    expect(decisionState(b)).toEqual({ state: 'settled', reason: HOUSE_RESOLUTION_FAILED });
  });

  test('a failed motion is settled too — the same predicate that keeps it out of the act-now pool', () => {
    expect(decisionState({ status: 'floor_vote', last_action_text: MOTION_TO_PROCEED_REJECTED }).state).toBe('settled');
  });

  test('a failed vote with a motion to reconsider ENTERED is pending — the Big Questions line and the API say the same thing', () => {
    // H.R. 3633's latest action on 2026-09-27, verbatim. The act-now pool
    // still leaves it out (isSettledFloor), but the record says the question
    // can come back, and "settled" would claim more than the record does.
    const reconsider =
      'Motion by Senator Tillis to reconsider the vote by which cloture on the motion to proceed to the measure was not invoked (Record Vote No. 234) entered in Senate.';
    const b = { bill_type: 'hr', status: 'floor_vote' as const, last_action_text: reconsider, last_action_date: today() };
    expect(isSettledFloor(b)).toBe(true);
    expect(billStatusLine(b)).toMatchObject({ key: 'failedReconsider', terminal: false });
    expect(decisionState(b)).toEqual({ state: 'pending', reason: null });
    // …and once the motion is disposed of, the failure stands again.
    const tabled = 'Motion to reconsider laid on the table Agreed to without objection.';
    expect(decisionState({ status: 'floor_vote', last_action_text: tabled, status_basis_text: CLOTURE_NOT_INVOKED })).toEqual({
      state: 'settled',
      reason: CLOTURE_NOT_INVOKED,
    });
  });

  test('a law is enacted; a veto is settled', () => {
    expect(decisionState({ status: 'signed', last_action_text: 'Became Public Law No: 119-103.' })).toEqual({
      state: 'enacted',
      reason: 'Became Public Law No: 119-103.',
    });
    expect(decisionState({ status: 'vetoed', last_action_text: 'Vetoed by President.' }).state).toBe('settled');
  });

  test('everything else is pending, with no reason — including a calendar placement and a live cloture vote', () => {
    for (const b of [
      { status: 'floor_vote', last_action_text: 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 501.' },
      { status: 'floor_vote', last_action_text: S4668_CLOTURE },
      { status: 'passed_chamber', last_action_text: 'Received in the Senate.' },
      { status: 'committee', last_action_text: RULE_FAILED },
      { status: 'committee', last_action_text: 'Referred to the House Committee on Foreign Affairs.' },
    ]) {
      expect(decisionState(b), b.last_action_text).toEqual({ state: 'pending', reason: null });
    }
  });
});

test.describe('SY-05 · cloture invoked on the measure is a Senate vote still ahead (card a5, the #304 question)', () => {
  test('S. 4668, verbatim: the Senate', () => {
    expect(CLOTURE_INVOKED_ON_MEASURE.test(S4668_CLOTURE)).toBe(true);
    expect(floorClotureInvokedChamber(S4668_CLOTURE)).toBe('senate');
    expect(floorClotureInvokedChamber('Cloture on the measure invoked in Senate by Yea-Nay Vote. 60 - 38.')).toBe('senate');
  });

  test('never a settled sentence, never cloture on the motion to proceed, never a reconsider motion', () => {
    for (const text of [
      'Cloture on the measure not invoked in Senate by Yea-Nay Vote. 49 - 50.',
      CLOTURE_NOT_INVOKED,
      'Cloture on the motion to proceed to the measure invoked in Senate by Yea-Nay Vote. 62 - 36.',
      'Motion by Senator Tillis to reconsider the vote by which cloture on the measure was invoked (Record Vote No. 234) entered in Senate.',
      'Cloture motion on the measure presented in Senate.',
      '',
      null,
    ]) {
      expect(floorClotureInvokedChamber(text), String(text)).toBeNull();
    }
  });

  test('the ladder already admitted it, so the T1 superset still holds', () => {
    expect(entersFloorWatch(S4668_CLOTURE)).toBe(true);
    expect(floorPendingChamber(S4668_CLOTURE)).toBe('senate');
  });
});

/*
 * THE STEPPER SENTENCES (owner-scope half: lib/journey.ts + messages/*.json +
 * components/BillJourney.tsx). Rendered through next-intl's own formatter
 * with the exact parameters components/BillJourney.tsx hands the catalog, in
 * both languages, so a template that names the wrong chamber, drops the
 * record's tally or invents one fails here.
 */
const stepperSentence = (catalog: typeof en | typeof es, state: ReturnType<typeof deriveJourney>) => {
  const t = createTranslator({ locale: catalog === en ? 'en' : 'es', messages: catalog, namespace: 'bill.journey' });
  const params = {
    chamber: state.nowChamber === 'house' ? 'House' : 'Senate',
    other: state.origin === 'house' ? 'Senate' : 'House',
    ...(state.tally ? { tally: 'yes', yeas: state.tally.yeas, nays: state.tally.nays } : { tally: 'none', yeas: 0, nays: 0 }),
  };
  return t(state.nowKey as never, params as never) as string;
};
/**
 * The facts a stepper sentence must carry, asserted without pinning its
 * wording (a copy edit in messages/* should not need a test edit): the
 * chamber the record names, and exactly the record's numbers — every digit
 * run in the rendered sentence, in order, so an invented or dropped number
 * fails.
 */
const CHAMBER_NAME = { en: { house: 'House', senate: 'Senate' }, es: { house: 'Cámara', senate: 'Senado' } } as const;
const numbersIn = (s: string) => s.match(/\d+/g) ?? [];
const expectSentenceFacts = (
  sentence: string,
  lang: 'en' | 'es',
  chamber: 'house' | 'senate',
  tally: { yeas: number; nays: number } | null,
) => {
  expect(sentence, sentence).toContain(CHAMBER_NAME[lang][chamber]);
  expect(sentence, sentence).not.toContain(CHAMBER_NAME[lang][chamber === 'house' ? 'senate' : 'house']);
  expect(numbersIn(sentence), sentence).toEqual(tally ? [String(tally.yeas), String(tally.nays)] : []);
};

test.describe('SY-01 · the stepper says a rejected passage vote was a rejected passage vote', () => {
  const hconres89 = { bill_type: 'hconres', status: 'floor_vote' as const, last_action_text: HCONRES_89, last_action_date: '2026-09-24' };

  test('H.Con.Res. 89, verbatim: its own key, the Senate, the record\'s tally, no trailer', () => {
    const j = deriveJourney(hconres89);
    expect(j).toMatchObject({ nowKey: 'nowFloorPassageRejected', nowChamber: 'senate', current: 'senate', step: 3, showTrailer: false });
    expect(j.tally).toEqual({ yeas: 49, nays: 50 });
  });

  test('rendered, in both languages: the Senate and the record\'s 49 and 50, nothing else', () => {
    const j = deriveJourney(hconres89);
    expectSentenceFacts(stepperSentence(en, j), 'en', 'senate', { yeas: 49, nays: 50 });
    expectSentenceFacts(stepperSentence(es, j), 'es', 'senate', { yeas: 49, nays: 50 });
    // Its own sentence, not the failed-motion one.
    expect(stepperSentence(en, j)).not.toBe(stepperSentence(en, { ...j, nowKey: 'nowFloorMotionFailed' }));
  });

  test('the House form names the House and its own numbers', () => {
    const j = deriveJourney({ bill_type: 'hr', status: 'floor_vote', last_action_text: HOUSE_PASSAGE_FAILED, last_action_date: '2026-09-24' });
    expect(j).toMatchObject({ nowKey: 'nowFloorPassageRejected', nowChamber: 'house', step: 2 });
    expectSentenceFacts(stepperSentence(en, j), 'en', 'house', { yeas: 209, nays: 215 });
    expectSentenceFacts(stepperSentence(es, j), 'es', 'house', { yeas: 209, nays: 215 });
  });

  test('no tally in the record, or one that would mislead, prints no numbers', () => {
    const voice = deriveJourney({ bill_type: 'hconres', status: 'floor_vote', last_action_text: 'Failed of passage in Senate by Voice Vote.', last_action_date: '2026-09-24' });
    expect(voice.tally).toBeNull();
    expectSentenceFacts(stepperSentence(en, voice), 'en', 'senate', null);
    expectSentenceFacts(stepperSentence(es, voice), 'es', 'senate', null);
    // A two-thirds vote can fail with a majority voting yes: "rejected it,
    // 290–140" would mislead, so the numbers stay on the "Latest action" line.
    const supermajority = deriveJourney({
      bill_type: 'hjres',
      status: 'floor_vote',
      last_action_text: 'Failed of passage/not agreed to in House On passage Failed by the Yeas and Nays: (2/3 required): 290 - 140 (Roll no. 400).',
      last_action_date: '2026-09-24',
    });
    expect(supermajority.nowKey).toBe('nowFloorPassageRejected');
    expect(supermajority.tally).toBeNull();
  });

  test('a failed MOTION keeps the failed-motion sentence, and its trailer', () => {
    const j = deriveJourney({ bill_type: 'sjres', status: 'floor_vote', last_action_text: MOTION_TO_PROCEED_REJECTED, last_action_date: '2026-09-24' });
    expect(j).toMatchObject({ nowKey: 'nowFloorMotionFailed', nowChamber: 'senate', showTrailer: true, tally: null });
    expect(deriveJourney({ bill_type: 's', status: 'floor_vote', last_action_text: SUSPENSION_FAILED, last_action_date: '2026-09-24' }).nowKey).toBe(
      'nowFloorMotionFailed',
    );
  });
});

test.describe('SY-05 · the stepper, the rail, the band and the Big Questions line agree on S. 4668 (card a5)', () => {
  const s4668 = (date: string) => ({
    bill_type: 's',
    status: 'floor_vote' as const,
    last_action_text: 'The committee substitute tabled by Voice Vote.',
    status_basis_text: S4668_CLOTURE,
    last_action_date: date,
  });

  test('fresh: its own sentence, with the record\'s 74–25, in both languages', () => {
    const j = deriveJourney(s4668(today()));
    expect(j).toMatchObject({ nowKey: 'nowFloorClotureInvoked', nowChamber: 'senate', step: 2 });
    expect(j.tally).toEqual({ yeas: 74, nays: 25 });
    expectSentenceFacts(stepperSentence(en, j), 'en', 'senate', { yeas: 74, nays: 25 });
    expectSentenceFacts(stepperSentence(es, j), 'es', 'senate', { yeas: 74, nays: 25 });
  });

  test('every reader says the same thing: the pending reader, the rail, the band, the status line', () => {
    const fresh = s4668(today());
    expect(floorPendingChamber(S4668_CLOTURE)).toBe('senate');
    expect(liveCallTarget(fresh)).toEqual({ chamber: 'senate', afterVote: false, soleChamber: false });
    expect(billFloorBand(fresh, null)).toMatchObject({ kind: 'pending', chamber: 'senate' });
    expect(billStatusLine(fresh)).toMatchObject({ key: 'onFloor', chamber: 'senate' });
  });

  test('aged: the dated past-tense floor sentence, no live route, no numbers', () => {
    const j = deriveJourney(s4668('2026-07-01'));
    expect(j.nowKey).toBe('nowFloorActivityStale');
    expect(j.tally).toBeNull();
    expect(liveCallTarget(s4668('2026-07-01'))).toBeNull();
  });
});

test.describe('SY-28 · the record-only sentence is not labeled AI, because no model wrote it', () => {
  test('one token on both sides, and only the two non-model tokens drop the chip', () => {
    expect(PAGE_RECORD_ONLY_MODEL).toBe(RECORD_ONLY_MODEL);
    expect(isAiSummary({ model: RECORD_ONLY_MODEL })).toBe(false);
    expect(isAiSummary({ model: 'hand-authored' })).toBe(false);
    expect(isAiSummary({ model: 'claude-sonnet-5' })).toBe(true);
    // The collector's model since 2026-09-28: its revisions keep the AI chip.
    expect(isAiSummary({ model: 'claude-sonnet-5-5' })).toBe(true);
    // A token nobody taught the page still reads as AI — the safe direction.
    expect(isAiSummary({ model: 'record-only-v2' })).toBe(true);
  });
});
