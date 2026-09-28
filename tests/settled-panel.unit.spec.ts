import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import bills from '../data/bills.json';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { decisionState } from '../lib/docket.mjs';
import { deriveJourney, settledDecision } from '../lib/journey';
import type { Bill } from '../lib/types';

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
 */

type Rec = Pick<Bill, 'bill_type' | 'status' | 'last_action_text' | 'last_action_date'>;
const rec = (bill_type: string, status: string, text: string | null, date = '2026-09-24'): Rec =>
  ({ bill_type, status, last_action_text: text, last_action_date: date }) as Rec;

/** H.Con.Res. 89. */
const HCONRES_89 = 'Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.';
/** S.J.Res. 99. */
const MOTION_TO_PROCEED_REJECTED =
  'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50. Record Vote Number: 192. (CR S3194)';
/** H.J.Res. 1: a two-thirds vote that failed with a majority voting yes. */
const SUSPENSION_FAILED =
  'On motion to suspend the rules and pass Failed by the Yeas and Nays: (2/3 required): 212 - 206 (Roll no. 293).';
/** H.R. 3633: the failed vote, with a motion to reconsider it entered. */
const RECONSIDER_ENTERED =
  'Motion by Senator Tillis to reconsider the vote by which cloture on the motion to proceed to the measure was not invoked (Record Vote No. 234) entered in Senate.';

test.describe('settledDecision — which pages show the record, not the call', () => {
  test('a law', () => {
    expect(settledDecision(rec('hr', 'signed', 'Became Public Law No: 119-105.'))).toEqual({ kind: 'law' });
  });

  test('a veto', () => {
    expect(settledDecision(rec('hr', 'vetoed', 'Vetoed by President.'))).toEqual({ kind: 'vetoed' });
  });

  test('a rejected passage vote carries the chamber and the record\'s tally', () => {
    expect(settledDecision(rec('hconres', 'floor_vote', HCONRES_89))).toEqual({
      kind: 'rejected',
      chamber: 'senate',
      tally: { yeas: 49, nays: 50 },
    });
  });

  test('a failed motion to take it up is not called a rejection', () => {
    expect(settledDecision(rec('sjres', 'floor_vote', MOTION_TO_PROCEED_REJECTED))).toEqual({
      kind: 'motionFailed',
      chamber: 'senate',
    });
    // A majority voted yes here; "rejected, 212–206" would mislead, and the
    // motion kind prints no tally at all.
    expect(settledDecision(rec('hjres', 'floor_vote', SUSPENSION_FAILED))).toEqual({
      kind: 'motionFailed',
      chamber: 'house',
    });
  });

  test('a failed vote with a motion to reconsider entered keeps the call — the question can come back', () => {
    expect(settledDecision(rec('hr', 'floor_vote', RECONSIDER_ENTERED))).toBeNull();
    // The stepper still says the motion failed; only the panel stays open.
    expect(deriveJourney(rec('hr', 'floor_vote', RECONSIDER_ENTERED)).nowKey).toBe('nowFloorMotionFailed');
    expect(decisionState(rec('hr', 'floor_vote', RECONSIDER_ENTERED)).state).toBe('pending');
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
      expect(deriveJourney(b).nowKey, `${b.bill_type} ${b.last_action_text}`).toBe('nowFloorActivityNeutral');
    }
  });

  test('the corpus really holds settled bills of the kinds the panel prints', () => {
    const kinds = new Set(corpus.map((b) => settledDecision(b)?.kind).filter(Boolean));
    expect(kinds.has('law'), 'no signed law in the corpus').toBe(true);
    expect(kinds.has('rejected') || kinds.has('motionFailed'), 'no settled floor vote in the corpus').toBe(true);
  });
});

test.describe('the panel\'s words, in both languages', () => {
  const tEn = createTranslator({ locale: 'en', messages: en });
  const tEs = createTranslator({ locale: 'es', messages: es });

  test('a rejection prints the record\'s tally when there is one, and none when there is not', () => {
    const withTally = { chamber: 'Senate', tally: 'yes', yeas: 49, nays: 50 };
    const noTally = { chamber: 'House', tally: 'none', yeas: 0, nays: 0 };
    expect(tEn('bill.settled.rejected', withTally)).toBe('This was rejected in the Senate, 49–50.');
    expect(tEs('bill.settled.rejected', withTally)).toBe(
      'El Senado lo rechazó, por 49 votos a favor y 50 en contra.'
    );
    expect(tEn('bill.settled.rejected', noTally)).toBe('This was rejected in the House.');
    expect(tEs('bill.settled.rejected', noTally)).toBe('La Cámara lo rechazó.');
  });

  test('a failed motion names the chamber and no tally', () => {
    expect(tEn('bill.settled.motionFailed', { chamber: 'House' })).toBe(
      'The House has not agreed to take this up — the last motion to do so failed.'
    );
    expect(tEs('bill.settled.motionFailed', { chamber: 'Senate' })).toMatch(/^El Senado no ha aceptado/);
  });

  test('every new string exists in both languages and the Spanish is not an English copy', () => {
    for (const key of ['title', 'law', 'vetoed', 'rejected', 'motionFailed', 'needZip'] as const) {
      expect(typeof en.bill.settled[key], `en.bill.settled.${key}`).toBe('string');
      expect(es.bill.settled[key], `es.bill.settled.${key}`).not.toBe(en.bill.settled[key]);
    }
    expect(es.bill.alsoYours).not.toBe(en.bill.alsoYours);
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
