import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Pure, I/O-free functions (no CONGRESS_API_KEY needed).
import { isProceduralAgreedTo, mapStatus, statusFromActions } from '../scripts/congress-fetch.mjs';

/*
 * A POINT OF ORDER OR A PROCEDURAL MOTION THE CHAMBER AGREED TO IS NOT THE
 * MEASURE PASSING (2026-09-29).
 *
 * S.J.Res. 98 was filed `passed_chamber` from 2026-01-14 on because its last
 * action, a point of order the Senate agreed to 50-50, contains "agreed to
 * in". The Senate never voted on the resolution. The motion to proceed has the
 * same shape. See isProceduralAgreedTo in scripts/congress-fetch.mjs.
 *
 * Every sentence below is verbatim from the record unless it says
 * "constructed".
 */

const SJRES_98 =
  'Point of order that the measure is not entitled to expedited procedures under 50 U.S.C. 1546(a) raised against the measure agreed to in Senate by Yea-Nay Vote. 50 - 50. Record Vote Number: 9.';

test.describe('a point of order or a procedural motion, agreed to, is floor_vote and never a passage', () => {
  const procedural = [
    SJRES_98,
    // data/moment-updates.json, H.R. 6500 (2026-08-05) and S. 4668 (2026-09-17).
    'Motion to proceed to consideration of measure agreed to in Senate by Voice Vote. (CR S4448)',
    'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 77 - 22. Record Vote Number: 236.',
    // Constructed, in the Senate's action vocabulary.
    'Motion to discharge Senate Committee on Foreign Relations agreed to in Senate by Yea-Nay Vote. 51 - 47. Record Vote Number: 120.',
    'Motion to table the motion to discharge agreed to in Senate by Yea-Nay Vote. 52 - 47.',
    'Motion to waive all applicable budgetary discipline with respect to the measure agreed to in Senate by Yea-Nay Vote. 60 - 38.',
    'Motion to reconsider the vote by which cloture was not invoked agreed to in Senate by Unanimous Consent.',
    'Motion by Senator Thune to table the motion to concur in the House amendment agreed to in Senate by Yea-Nay Vote. 51 - 49.',
  ];
  for (const text of procedural) {
    test(text.slice(0, 70), () => {
      expect(isProceduralAgreedTo(text)).toBe(true);
      expect(mapStatus(text)).toBe('floor_vote');
    });
  }
});

test.describe('passages keep reading as passages', () => {
  const passages = [
    'Passed/agreed to in House: On motion to suspend the rules and pass the bill Agreed to by voice vote.',
    'Passed/agreed to in House: On agreeing to the resolution Agreed to without objection. (text: CR H1234)',
    'Resolution agreed to in Senate without amendment by Yea-Nay Vote. 50 - 48. Record Vote Number: 540. (consideration: CR S7043-7044)',
    'Passed Senate without amendment by Unanimous Consent.',
    // Constructed: the motions whose carrying IS agreement to the text.
    'Motion to concur in the House amendment agreed to in Senate by Yea-Nay Vote. 68 - 30.',
    'Motion by Senator Thune to concur in the House amendment to S. 5 agreed to in Senate by Yea-Nay Vote. 60 - 38.',
    'Motion to recede and concur agreed to in House by voice vote.',
  ];
  for (const text of passages) {
    test(text.slice(0, 70), () => {
      expect(isProceduralAgreedTo(text)).toBe(false);
      expect(mapStatus(text)).toBe('passed_chamber');
    });
  }

  test('the post-passage motion keeps its passage DEFAULT (resolved from context elsewhere)', () => {
    const t = 'Motion to reconsider laid on the table Agreed to without objection.';
    expect(isProceduralAgreedTo(t)).toBe(false);
    expect(mapStatus(t)).toBe('passed_chamber');
  });

  test('a point of order NOT agreed to is still the defeat branch', () => {
    const t = 'Point of order raised against the measure not agreed to in Senate by Yea-Nay Vote. 47 - 53.';
    expect(mapStatus(t)).toBe('floor_vote');
  });
});

test.describe('statusFromActions no longer takes a procedural sentence for the passage in a vote group', () => {
  test('a same-day group whose only "agreed to in" is a motion to proceed is floor_vote', () => {
    const r = statusFromActions([
      { text: 'Motion to reconsider laid on the table Agreed to without objection.', actionDate: '2026-09-17' },
      {
        text: 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 77 - 22. Record Vote Number: 236.',
        actionDate: '2026-09-17',
      },
    ]);
    expect(r?.status).toBe('floor_vote');
  });
});

test.describe('the corpus', () => {
  const bills = JSON.parse(readFileSync('data/bills.json', 'utf8')) as Array<Record<string, unknown>>;

  test('sjres-98-119 is stored at floor_vote, not passed_chamber', () => {
    const b = bills.find((x) => x.full_identifier === 'sjres-98-119');
    // The record can move on; the pin is on the sentence this change reads.
    if (b && b.last_action_text === SJRES_98) expect(b.status).toBe('floor_vote');
  });

  test('no stored status reads a procedural sentence as a passage', () => {
    const wrong = bills
      .filter((b) => b.status === 'passed_chamber')
      .filter((b) => isProceduralAgreedTo(b.last_action_text as string) || isProceduralAgreedTo(b.status_basis_text as string))
      .map((b) => b.full_identifier);
    expect(wrong).toEqual([]);
  });
});
