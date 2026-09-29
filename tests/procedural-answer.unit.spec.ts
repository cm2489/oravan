import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import * as congressFetch from '../scripts/congress-fetch.mjs';
import {
  FLOOR_SETTLED,
  concurrentAdoptedBy,
  passageState,
  procedureEndedConsideration,
  procedureIsTheSubject,
  statusBasisText,
} from '../lib/floor-text.mjs';
import { announcementAnswered, decisionState, docketRung, floorAnsweredChamber, isSettledFloor } from '../lib/docket.mjs';

/*
 * A POINT OF ORDER OR A MOTION IS NEVER A PASSAGE, AND ONLY SOME OF THEM ARE
 * THE CHAMBER'S ANSWER (2026-09-29, S.J.Res. 98).
 *
 * lib/docket.mjs `floorAnsweredChamber` used to read every "agreed to in
 * <chamber>" as that chamber having answered. The Senate's motion to proceed
 * is written that way, and there the Senate has only agreed to START debate.
 * The reading matters where a live announcement meets the record
 * (`announcementAnswered`): it retired the Senate's own program on the day the
 * Senate took the measure up, and the rung that fell out of it is what the
 * crown, the act-now pool and MCP `whats_moving` read.
 *
 * Refined the same day: a point of order against the MEASURE, sustained, IS
 * the chamber answering (S.J.Res. 98 lost its expedited track 50 - 50), and so
 * is the measure's own motion to discharge falling on such a point (S.J.Res.
 * 124) or being tabled (H.J.Res. 117). Those read as the chamber; they are
 * still never a passage.
 *
 * Every sentence below is VERBATIM from the record, with the record and date
 * it was read on, unless it says "constructed". "data/…" means the committed
 * corpus; every other record is a Congress.gov bill-status action.
 */

type Row = [where: string, text: string];

/*
 * THE 42 SENTENCES THE FIRST VERSION OF THIS CHANGE RE-READ, 'senate' → null
 * (the independent verification's sweep of 2026-09-29, over data/*.json and
 * the Congress.gov bill-status files saved from earlier fact-checks). Split by
 * what the chamber actually did to the measure. 40 of them stay null; the two
 * points of order against the measure go back to 'senate'.
 */

/** 34: the Senate agreed to START debating the measure. */
const MOTION_TO_PROCEED_AGREED: Row[] = [
  ['hconres-14-119, 2025-04-03', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 52 - 48. Record Vote Number: 169.'],
  ['hjres-104-119, 2025-10-07', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 50 - 47. Record Vote Number: 548.'],
  ['hjres-105-119, 2025-10-08', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 51 - 47. Record Vote Number: 553.'],
  ['hjres-106-119, 2025-10-09', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 50 - 47. Record Vote Number: 559. (CR S7052)'],
  ['hjres-140-119, 2026-04-15', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 51 - 49. Record Vote Number: 83. (CR S1790)'],
  ['hjres-142-119, 2026-02-11', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 51 - 46. Record Vote Number: 36. (CR S571)'],
  ['hjres-20-119, 2025-04-09', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 52 - 42. Record Vote Number: 206.'],
  ['hjres-24-119, 2025-04-02', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 51 - 46. Record Vote Number: 161. (CR S2137-2138)'],
  ['hjres-25-119, 2025-03-26', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 70 - 28. Record Vote Number: 150.'],
  ['hjres-42-119, 2025-04-29', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 52 - 46. Record Vote Number: 222. (CR S2644)'],
  ['hjres-60-119, 2025-05-06', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 53 - 47. Record Vote Number: 236.'],
  ['hjres-61-119, 2025-05-05', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 51 - 43. Record Vote Number: 231.'],
  ['hjres-75-119, 2025-04-30', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 52 - 46. Record Vote Number: 224.'],
  ['hjres-87-119, 2025-05-22', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 51 - 46. Record Vote Number: 278.'],
  ['hjres-88-119, 2025-05-21', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 51 - 46. Record Vote Number: 276.'],
  ['hjres-89-119, 2025-05-22', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 51 - 46. Record Vote Number: 280.'],
  ['hr-6500-119, 2026-08-05 (data/moment-updates.json)', 'Motion to proceed to consideration of measure agreed to in Senate by Voice Vote. (CR S4448)'],
  ['s-4668-119, 2026-09-17 (data/moment-updates.json)', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 77 - 22. Record Vote Number: 236.'],
  ['s-4668-119, 2026-09-17', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 77 - 22. Record Vote Number: 236. (CR S4773-4774)'],
  ['sconres-33-119, 2026-04-21', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 52 - 46. Record Vote Number: 87.'],
  ['sconres-7-119, 2025-02-18', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 50 - 47. Record Vote Number: 58. (CR S1006)'],
  ['sjres-11-119, 2025-02-25', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 54 - 42. Record Vote Number: 91. (CR S1322)'],
  ['sjres-12-119, 2025-02-26', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 52 - 47. Record Vote Number: 96. (CR S1391)'],
  ['sjres-13-119, 2025-05-06', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 53 - 46. Record Vote Number: 233.'],
  ['sjres-18-119, 2025-03-26', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 52 - 47. Record Vote Number: 152.'],
  ['sjres-28-119, 2025-03-04', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 50 - 47. Record Vote Number: 103. (CR S1489)'],
  ['sjres-3-119, 2025-03-04', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 70 - 28. Record Vote Number: 101. (CR S1470-1471)'],
  ['sjres-31-119, 2025-04-30', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 52 - 40. Record Vote Number: 227.'],
  ['sjres-55-119, 2025-05-21', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 53 - 46. Record Vote Number: 264.'],
  ['sjres-7-119, 2025-05-06', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 53 - 47. Record Vote Number: 235.'],
  ['sjres-80-119, 2025-10-29', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 54 - 46. Record Vote Number: 595.'],
  ['sjres-82-119, 2025-12-10', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 50 - 49. Record Vote Number: 641. (CR S8591)'],
  ['sjres-89-119, 2025-11-19', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 51 - 47. Record Vote Number: 621.'],
  ['sjres-91-119, 2025-12-03', 'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 49 - 47. Record Vote Number: 630.'],
];

/** 2: points of order about the Senate's Congressional Review Act PROCEDURE, not against the measure. Both kept the review track open. */
const PROCEDURE_POINTS_AGREED: Row[] = [
  [
    'sjres-55-119, 2025-05-21',
    'Point of order by Senator Thune: Shall Joint Resolutions that meet all the requirements of Section 802 of the Congressional Review Act or are disapproving of agency actions which have been determined to be rules subject to the Congressional Review Act by a legal decision from the Government Accountability Office, be entitled to expedited procedures under the Congressional Review Act? agreed to in Senate by Yea-Nay Vote. 51 - 46. Record Vote Number: 274.',
  ],
  [
    'sjres-55-119, 2025-05-21',
    'Point of order by Senator Thune: Shall points of order be in order under the Congressional Review Act? agreed to in Senate by Yea-Nay Vote. 51 - 46. Record Vote Number: 273.',
  ],
];

/** 4: agreed motions to table something aimed AT the measure. The measure stayed alive (H.J.Res. 140 became law) or was not the subject. */
const TABLED_NOT_THE_MEASURE: Row[] = [
  [
    'hjres-140-119, 2026-04-15',
    'Motion to table the point of order that the measure is not entitled to expedited procedures under the Congressional Review Act agreed to in Senate by Yea-Nay Vote. 51 - 48. Record Vote Number: 82.',
  ],
  [
    'sjres-55-119, 2025-05-21',
    'Motion to table the appeal that two points of order are not in order at the same time agreed to in Senate by Yea-Nay Vote. 51 - 46. Record Vote Number: 266.',
  ],
  ['s-4668-119, 2026-09-24 (amendment action)', 'Motion to table amendment SA 6779 agreed to in Senate by Voice Vote.'],
  ['s-4668-119, 2026-09-24 (amendment action)', 'Motion to table amendment SA 6777 agreed to in Senate by Voice Vote.'],
];

/** data/bills.json, sjres-98-119, last action of 2026-01-14. */
const SJRES_98 =
  'Point of order that the measure is not entitled to expedited procedures under 50 U.S.C. 1546(a) raised against the measure agreed to in Senate by Yea-Nay Vote. 50 - 50. Record Vote Number: 9.';
/** sjres-124-119, 2026-04-28, the action before its last. */
const SJRES_124_POINT =
  'Point of order that the measure is not entitled to expedited procedures under 50 U.S.C. 1546a raised against the measure agreed to in Senate by Yea-Nay Vote. 51 - 47. Record Vote Number: 108.';
/** data/bills.json, sjres-124-119, last action of 2026-04-28. */
const SJRES_124_FELL = 'The motion to discharge fell when the point of order was well taken.';

/** 2: points of order against the measure, sustained. The Senate took the question up and the answer was no. */
const POINT_SUSTAINED_AGAINST_MEASURE: Row[] = [
  ['sjres-98-119, 2026-01-14 (data/bills.json)', SJRES_98],
  ['sjres-124-119, 2026-04-28', SJRES_124_POINT],
];

/** hjres-117-119, 2025-09-15: the House tabled the privileged motion to discharge, then recorded it. */
const HJRES_117_TABLE = 'Table Motion to Discharge Agreed to by the Yeas and Nays: 200 - 198 (Roll no. 265).';
const HJRES_117_TABLED = 'Motion to discharge tabled.';

/** data/moment-updates.json, s-4668-119 on 2026-09-17 (one of the 34 above); the ladder test below uses it. */
const MTP_AGREED_ROLL =
  'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 77 - 22. Record Vote Number: 236.';

test.describe("the 42 re-read sentences, by what the chamber did to the measure", () => {
  test('the list is the 42 the verification measured, each once', () => {
    const all = [...MOTION_TO_PROCEED_AGREED, ...PROCEDURE_POINTS_AGREED, ...TABLED_NOT_THE_MEASURE, ...POINT_SUSTAINED_AGAINST_MEASURE];
    expect(all).toHaveLength(42);
    expect(new Set(all.map(([, t]) => t)).size).toBe(42);
    expect(MOTION_TO_PROCEED_AGREED).toHaveLength(34);
    expect(MOTION_TO_PROCEED_AGREED.map(([, t]) => t)).toContain(MTP_AGREED_ROLL);
  });

  test('40 are no answer: a motion to proceed agreed to, a procedure point, a tabled point, appeal or amendment', () => {
    for (const [where, text] of [...MOTION_TO_PROCEED_AGREED, ...PROCEDURE_POINTS_AGREED, ...TABLED_NOT_THE_MEASURE]) {
      expect(procedureIsTheSubject(text), where).toBe(true);
      expect(procedureEndedConsideration(text), where).toBe(false);
      expect(floorAnsweredChamber(text), `${where}: ${text}`).toBeNull();
    }
  });

  test('2 are the Senate answering: a point of order against the measure, agreed to', () => {
    for (const [where, text] of POINT_SUSTAINED_AGAINST_MEASURE) {
      // Still procedure, so its "agreed to in Senate" is never a passage...
      expect(procedureIsTheSubject(text), where).toBe(true);
      // ...but the procedure ended the measure's consideration.
      expect(procedureEndedConsideration(text), where).toBe(true);
      expect(floorAnsweredChamber(text), where).toBe('senate');
    }
  });
});

test.describe('the other procedural endings in the record', () => {
  test("sjres-124-119: the motion to discharge fell when the point of order was well taken (no chamber named: 'unknown')", () => {
    expect(procedureEndedConsideration(SJRES_124_FELL)).toBe(true);
    expect(floorAnsweredChamber(SJRES_124_FELL)).toBe('unknown');
  });

  test("hjres-117-119: the House tabled the motion to discharge (no chamber named: 'unknown')", () => {
    for (const text of [HJRES_117_TABLE, HJRES_117_TABLED]) {
      expect(procedureEndedConsideration(text), text).toBe(true);
      expect(floorAnsweredChamber(text), text).toBe('unknown');
    }
  });

  test('constructed: the same endings in the words the record has not printed yet', () => {
    const cases: Array<[string, 'house' | 'senate' | 'unknown']> = [
      ['Point of order that the measure is not entitled to expedited procedures raised against the measure sustained in Senate.', 'senate'],
      ['Point of order raised against the measure well taken.', 'unknown'],
      ['The motion to proceed fell when the point of order was sustained.', 'unknown'],
      ['Motion to table the motion to discharge agreed to in Senate by Yea-Nay Vote. 52 - 47.', 'senate'],
      ['Motion by Senator Thune to table the motion to proceed agreed to in Senate by Yea-Nay Vote. 51 - 49.', 'senate'],
    ];
    for (const [text, answer] of cases) {
      expect(procedureEndedConsideration(text), text).toBe(true);
      expect(floorAnsweredChamber(text), text).toBe(answer);
    }
  });
});

test.describe('what is still no answer', () => {
  test('verbatim: a point raised with no outcome, a point against an amendment, a ruling on procedure, a motion made, a motion that fell to cloture', () => {
    const rows: Row[] = [
      ['hjres-140-119, 2026-04-15', 'Point of order that the measure is not entitled to expedited procedures under the Congressional Review Act raised in Senate. (CR S1780)'],
      ['sconres-7-119', 'Point of order that the amendment violates section 305(b)(2) of the CBA raised in Senate with respect to amendment SA 130.'],
      ['sjres-55-119, 2025-05-21', 'Ruling of the Chair that the point of order raised by Senator Thune that points of order be in order under the Congressional Review Act sustained.'],
      ['hjres-117-119, 2025-09-15', 'Mr. Mast moved to table the motion to discharge'],
      ['sjres-124-119, 2026-04-28', 'Motion to discharge Senate Committee on Foreign Relations made. (Pursuant to 50 U.S.C. 1546a, Department of State Authorization Act). (consideration: CR S2070-2071)'],
      [
        'hr-6500-119 (data/moment-updates.json)',
        'Motion by Senator Thune to commit to Senate Committee on Appropriations with instructions to report back forthwith with the following amendment SA 6740 fell when cloture on amendment SA 6732 was invoked in Senate.',
      ],
    ];
    for (const [where, text] of rows) {
      expect(procedureEndedConsideration(text), where).toBe(false);
      expect(floorAnsweredChamber(text), `${where}: ${text}`).toBeNull();
    }
  });

  test('constructed: a point NOT sustained, a motion to table NOT agreed to, an advancing motion agreed to', () => {
    for (const text of [
      'Point of order raised against the measure not agreed to in Senate by Yea-Nay Vote. 47 - 53.',
      'Point of order raised against the measure not sustained.',
      'Point of order raised against the measure not well taken.',
      'Table Motion to Discharge Not Agreed to by the Yeas and Nays: 198 - 200 (Roll no. 265).',
      'Motion to discharge Senate Committee on Foreign Relations agreed to in Senate by Yea-Nay Vote. 51 - 47. Record Vote Number: 120.',
      'Motion to waive all applicable budgetary discipline with respect to the measure agreed to in Senate by Yea-Nay Vote. 60 - 38.',
      'Motion by Senator Thune to table the motion to concur in the House amendment agreed to in Senate by Yea-Nay Vote. 51 - 49.',
    ]) {
      expect(procedureEndedConsideration(text), text).toBe(false);
      expect(floorAnsweredChamber(text), text).toBeNull();
    }
  });
});

/** Verbatim passages, each with where it was read in data/bills.json. */
const PASSAGES_REAL: Array<{ text: string; chamber: 'house' | 'senate'; where: string }> = [
  { text: 'Passed Senate without amendment by Unanimous Consent. (consideration: CR S4882)', chamber: 'senate', where: 'hr-4467-119' },
  {
    text: 'Passed/agreed to in House: On motion to suspend the rules and pass the bill Agreed to by the Yeas and Nays: (2/3 required): 401 - 14 (Roll no. 314).',
    chamber: 'house',
    where: 's-2403-119',
  },
  {
    text: 'Resolution agreed to in Senate without amendment by Yea-Nay Vote. 50 - 48. Record Vote Number: 184. (consideration: CR S3039-3040)',
    chamber: 'senate',
    where: 'hconres-86-119',
  },
];

/** Constructed: the motions whose carrying IS the chamber agreeing to the text. */
const PASSAGE_MOTIONS_CONSTRUCTED: Array<{ text: string; chamber: 'house' | 'senate' }> = [
  { text: 'Motion to concur in the House amendment agreed to in Senate by Yea-Nay Vote. 68 - 30.', chamber: 'senate' },
  {
    text: 'Motion by Senator Thune to concur in the House amendment to S. 5 agreed to in Senate by Yea-Nay Vote. 60 - 38.',
    chamber: 'senate',
  },
  { text: 'Motion to recede and concur agreed to in House by voice vote.', chamber: 'house' },
];

/** Constructed: a procedural motion agreed to that also carries a settled word. */
const RECONSIDER_AGREED_CONSTRUCTED =
  'Motion to reconsider the vote by which cloture was not invoked agreed to in Senate by Unanimous Consent.';

test.describe('floorAnsweredChamber: what answered before still answers', () => {
  test('a chamber passing the measure', () => {
    for (const { text, chamber, where } of PASSAGES_REAL) {
      expect(procedureIsTheSubject(text), where).toBe(false);
      expect(procedureEndedConsideration(text), where).toBe(false);
      expect(floorAnsweredChamber(text), where).toBe(chamber);
    }
  });

  test('a motion whose carrying IS agreement to the text (constructed)', () => {
    for (const { text, chamber } of PASSAGE_MOTIONS_CONSTRUCTED) {
      expect(procedureIsTheSubject(text), text).toBe(false);
      expect(floorAnsweredChamber(text), text).toBe(chamber);
    }
  });

  test('a defeated motion, the reconsider motion on a failed vote, and the post-vote notice', () => {
    // data/bills.json, verbatim. Each opens with "Motion", and each is read
    // exactly as before: the guard is on the passage words only.
    const cases: Array<[string, string, 'house' | 'senate' | 'unknown']> = [
      ['sjres-99-119', 'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50. Record Vote Number: 111. (CR S2106)', 'senate'],
      ['sjres-172-119', 'Motion to discharge Senate Committee on Foreign Relations rejected by Yea-Nay Vote. 47 - 48. Record Vote Number: 174.', 'senate'],
      [
        'hr-3633-119',
        'Motion by Senator Tillis to reconsider the vote by which cloture on the motion to proceed to the measure was not invoked (Record Vote No. 234) entered in Senate.',
        'senate',
      ],
      ['hr-1919-119', 'Motion to reconsider laid on the table Agreed to without objection.', 'unknown'],
    ];
    for (const [where, text, answer] of cases) {
      expect(procedureEndedConsideration(text), where).toBe(false);
      expect(floorAnsweredChamber(text), where).toBe(answer);
    }
    // Constructed. The motion is procedural (the passage words no longer
    // speak), but its "not invoked" is FLOOR_SETTLED's, which reads that
    // clause wherever it appears, exactly as it reads hr-3633-119's real
    // sentence above. This change does not touch the settled vocabulary.
    expect(procedureIsTheSubject(RECONSIDER_AGREED_CONSTRUCTED)).toBe(true);
    expect(floorAnsweredChamber(RECONSIDER_AGREED_CONSTRUCTED)).toBe('senate');
    // s-4784-119: a motion MADE is no outcome at all, before and after.
    expect(floorAnsweredChamber('Motion to proceed to consideration of measure made in Senate. (CR S4276)')).toBeNull();
  });
});

test.describe('the ladder under a live Senate announcement', () => {
  // A Senate program covering the day of the vote, refreshed that morning.
  function program(day: string) {
    return {
      tier0: {
        source: 'daily-digest',
        chamber: 'senate',
        quote: 'Senate will vote on the motion to proceed.',
        url: 'https://www.congress.gov/congressional-record',
        published: day,
        covers: day,
        track: 'unspecified',
        certainty: 'scheduled_vote',
      },
      fetched_at: `${day}T12:00:00Z`,
    };
  }
  const bill = (billType: string, status: string, text: string, day: string) => ({
    bill_type: billType,
    status,
    last_action_text: text,
    last_action_date: day,
  });

  test('the motion to proceed agreed to leaves the announcement standing (S. 4668)', () => {
    // Both statuses: `passed_chamber` is how scripts/congress-fetch.mjs files
    // this sentence on main today, `floor_vote` is how it files it once PR
    // #363 lands. Neither may read as the Senate having answered.
    const now = Date.parse('2026-09-17T20:00:00Z');
    for (const status of ['passed_chamber', 'floor_vote']) {
      const b = bill('s', status, MTP_AGREED_ROLL, '2026-09-17');
      expect(announcementAnswered(b, program('2026-09-17')), status).toBe(false);
      expect(docketRung(b, program('2026-09-17'), { now }), status).toMatchObject({ tier: 't0', annotation: null });
    }
  });

  test('S.J.Res. 98: the point of order agreed to is "The floor already answered", not "Deciding now"', () => {
    // At `floor_vote`, the status PR #363 re-derives for it. (At main's
    // `passed_chamber` the STATUS puts it on T3 "Just passed a chamber", which
    // is false and is #363's to fix; this reader only retires the crown.)
    const b = bill('sjres', 'floor_vote', SJRES_98, '2026-01-14');
    const now = Date.parse('2026-01-14T20:00:00Z');
    expect(announcementAnswered(b, program('2026-01-14'))).toBe(true);
    expect(docketRung(b, program('2026-01-14'), { now })).toMatchObject({ tier: 't4', annotation: 'just_decided' });
    // The day after, while the program would otherwise still be live.
    const dayAfter = Date.parse('2026-01-15T20:00:00Z');
    expect(docketRung(b, program('2026-01-14'), { now: dayAfter })).toMatchObject({ tier: 't4', annotation: 'just_decided' });
  });

  test('S.J.Res. 124: the discharge motion that fell on the point of order retires it too', () => {
    const b = bill('sjres', 'floor_vote', SJRES_124_FELL, '2026-04-28');
    const now = Date.parse('2026-04-28T20:00:00Z');
    expect(announcementAnswered(b, program('2026-04-28'))).toBe(true);
    expect(docketRung(b, program('2026-04-28'), { now })).toMatchObject({ tier: 't4', annotation: 'just_decided' });
  });

  test('controls: a real passage and a real defeat still retire the same announcement', () => {
    const now = Date.parse('2026-09-17T20:00:00Z');
    const passed = bill('s', 'passed_chamber', 'Passed Senate without amendment by Unanimous Consent. (consideration: CR S4882)', '2026-09-17');
    expect(announcementAnswered(passed, program('2026-09-17'))).toBe(true);
    expect(docketRung(passed, program('2026-09-17'), { now })).toMatchObject({ tier: 't3', annotation: 'just_passed' });
    const rejected = bill(
      's',
      'floor_vote',
      'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50. Record Vote Number: 111. (CR S2106)',
      '2026-09-17'
    );
    expect(announcementAnswered(rejected, program('2026-09-17'))).toBe(true);
    expect(docketRung(rejected, program('2026-09-17'), { now })).toMatchObject({ tier: 't4', annotation: 'just_decided' });
  });
});

test.describe('an answer, never a passage', () => {
  const ENDED = [SJRES_98, SJRES_124_POINT, SJRES_124_FELL, HJRES_117_TABLE, HJRES_117_TABLED];
  const PROCEDURAL = [...MOTION_TO_PROCEED_AGREED, ...PROCEDURE_POINTS_AGREED, ...TABLED_NOT_THE_MEASURE].map(([, t]) => t);

  test('no passage, no adoption, no settled decision on any of them', () => {
    for (const text of [...ENDED, ...PROCEDURAL]) {
      // passageState and concurrentAdoptedBy read an anchored passage opening.
      expect(passageState({ bill_type: 'sjres', last_action_text: text }).passedBy, text).toBeNull();
      expect(concurrentAdoptedBy({ bill_type: 'sconres', status: 'passed_chamber', last_action_text: text }), text).toBeNull();
      for (const status of ['passed_chamber', 'floor_vote']) {
        const b = { bill_type: 'sjres', status, last_action_text: text };
        expect(isSettledFloor(b), `${status}: ${text}`).toBe(false);
        // The MCP envelope's decision_state: still open, no settled_reason.
        // A procedural "no" is not a failed FINAL vote (owner pick (a),
        // 2026-09-29), so it stays pending here as everywhere else.
        expect(decisionState(b), `${status}: ${text}`).toEqual({ state: 'pending', reason: null });
      }
    }
  });
});

test.describe('the corpus', () => {
  const bills = JSON.parse(readFileSync('data/bills.json', 'utf8')) as Array<Record<string, unknown>>;
  const updates = JSON.parse(readFileSync('data/moment-updates.json', 'utf8')) as Record<string, unknown>;

  /** Every action sentence the corpus stores: the bills' own, and the Big Questions updates'. */
  function corpusSentences(): string[] {
    const out = new Set<string>();
    for (const b of bills) {
      const basis = statusBasisText(b as never);
      if (basis) out.add(basis);
      if (typeof b.last_action_text === 'string') out.add(b.last_action_text);
    }
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const rec = v as Record<string, unknown>;
        if (typeof rec.action_text === 'string') out.add(rec.action_text);
        Object.values(rec).forEach(walk);
      }
    };
    walk(updates);
    return [...out];
  }

  test('no sentence whose subject is a point of order or a motion answers through its passage words', () => {
    const procedural = corpusSentences().filter((t) => procedureIsTheSubject(t));
    // Non-vacuity: the corpus holds two dozen of these today.
    expect(procedural.length).toBeGreaterThan(0);
    const wrong = procedural.filter(
      (t) =>
        floorAnsweredChamber(t) !== null &&
        // The readings that stay: a procedure that ended the measure's
        // consideration, the settled vocabulary, and the post-vote notice.
        !procedureEndedConsideration(t) &&
        !FLOOR_SETTLED.test(t) &&
        !/motion to reconsider laid on the table/i.test(t)
    );
    expect(wrong).toEqual([]);
  });

  test('every corpus sentence read as a procedural ending is an answer and never a passage', () => {
    for (const t of corpusSentences().filter((x) => procedureEndedConsideration(x))) {
      expect(floorAnsweredChamber(t), t).not.toBeNull();
      expect(passageState({ bill_type: 'sjres', last_action_text: t }).passedBy, t).toBeNull();
      expect(decisionState({ bill_type: 'sjres', status: 'floor_vote', last_action_text: t }).state, t).toBe('pending');
    }
  });

  for (const [id, sentence, answer] of [
    ['sjres-98-119', SJRES_98, 'senate'],
    ['sjres-124-119', SJRES_124_FELL, 'unknown'],
  ] as const) {
    test(`${id}, while its record still reads that sentence, is the chamber answering and no settled decision`, () => {
      const b = bills.find((x) => x.full_identifier === id);
      // The record can move on; the pin is on the sentence this change reads.
      test.skip(!b || statusBasisText(b as never) !== sentence, `${id} has a newer last action`);
      expect(floorAnsweredChamber(statusBasisText(b as never))).toBe(answer);
      expect(decisionState(b as never).state).toBe('pending');
    });
  }
});

/*
 * THE PIPELINE'S COPY. PR #363 adds `isProceduralAgreedTo` to
 * scripts/congress-fetch.mjs with the same two patterns as
 * procedureIsTheSubject, so mapStatus stops filing these sentences as
 * `passed_chamber`. Until it lands this test is skipped and says why; once it
 * lands, the two readers are pinned to agree on every sentence here that
 * carries "agreed to in <chamber>". procedureEndedConsideration does not
 * change that agreement: a procedural ending is still no passage.
 */
test.describe('the pipeline reads the same sentences the same way', () => {
  test('isProceduralAgreedTo and procedureIsTheSubject agree', () => {
    const isProceduralAgreedTo = (congressFetch as unknown as Record<string, unknown>).isProceduralAgreedTo;
    test.skip(typeof isProceduralAgreedTo !== 'function', 'scripts/congress-fetch.mjs isProceduralAgreedTo arrives with PR #363');
    const read = isProceduralAgreedTo as (t: string) => boolean;
    const sentences = [
      ...MOTION_TO_PROCEED_AGREED.map(([, t]) => t),
      ...PROCEDURE_POINTS_AGREED.map(([, t]) => t),
      ...TABLED_NOT_THE_MEASURE.map(([, t]) => t),
      ...POINT_SUSTAINED_AGAINST_MEASURE.map(([, t]) => t),
      'Motion to table the motion to discharge agreed to in Senate by Yea-Nay Vote. 52 - 47.',
      'Point of order raised against the measure not agreed to in Senate by Yea-Nay Vote. 47 - 53.',
      RECONSIDER_AGREED_CONSTRUCTED,
      ...PASSAGES_REAL.map((p) => p.text),
      ...PASSAGE_MOTIONS_CONSTRUCTED.map((p) => p.text),
    ].filter((t) => /\bagreed to in (?:the )?(?:house|senate)\b/i.test(t));
    expect(sentences.length).toBeGreaterThan(0);
    for (const t of sentences) expect(read(t), t).toBe(procedureIsTheSubject(t));
  });
});
