import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
// Pure, I/O-free functions (no CONGRESS_API_KEY needed).
import { isProceduralAgreedTo, mapStatus, statusFromActions } from '../scripts/congress-fetch.mjs';
import { procedureEndedConsideration } from '../lib/floor-text.mjs';
import { decisionState } from '../lib/docket.mjs';
import {
  deriveJourney,
  lastFailedVote,
  liveCallTarget,
  pointOfOrderUpheldChamber,
  settledDecision,
  statusBasisText,
} from '../lib/journey';

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

/* ------------------------------------------------------------------ *
 * THE STEPPER'S SENTENCE FOR IT (2026-09-29).
 *
 * At floor_vote, S.J.Res. 98 fell through to the chamber-free "it's moving
 * on the floor — the official record hasn't said yet which chamber acts
 * next", followed by "If the House changes it, it goes back to the Senate
 * before reaching the president." Nothing is moving, the record names the
 * chamber, and the House never received it. lib/journey.ts now reads an
 * upheld point of order against the measure (pointOfOrderUpheldChamber,
 * over lib/floor-text.mjs procedureEndedConsideration) and says so, with the
 * record's own tally and date, and no trailer.
 * ------------------------------------------------------------------ */

/** The record's other verbatim sentence of this shape: S.J.Res. 124's
 *  second-to-last action, 2026-04-28 (tests/procedural-answer.unit.spec.ts). */
const SJRES_124_POINT =
  'Point of order that the measure is not entitled to expedited procedures under 50 U.S.C. 1546a raised against the measure agreed to in Senate by Yea-Nay Vote. 51 - 47. Record Vote Number: 108.';
/** S.J.Res. 124's last action, verbatim (2026-04-28). */
const SJRES_124_FELL = 'The motion to discharge fell when the point of order was well taken.';

const floorBill = (
  last_action_text: string,
  last_action_date = '2026-01-14',
  basis: { status_basis_text?: string | null; status_basis_date?: string | null } = {}
) => ({ bill_type: 'sjres', status: 'floor_vote' as const, last_action_text, last_action_date, ...basis });

/** The date as components/BillJourney.tsx formats it: long month, UTC. */
const longDate = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(iso)
  );

/** The "Right now:" sentence, rendered from a journey the way the stepper renders it. */
function render(locale: 'en' | 'es', j: ReturnType<typeof deriveJourney>) {
  const t = createTranslator({ locale, messages: locale === 'en' ? en : es, namespace: 'bill.journey' });
  return t(j.nowKey, {
    chamber: j.nowChamber === 'house' ? 'House' : 'Senate',
    other: j.origin === 'house' ? 'Senate' : 'House',
    tally: j.tally ? 'yes' : 'none',
    yeas: j.tally?.yeas ?? 0,
    nays: j.tally?.nays ?? 0,
    hasDate: j.date ? 'yes' : 'none',
    date: j.date ? longDate(locale, j.date) : '',
  });
}

test.describe('the stepper reads an upheld point of order against the measure', () => {
  test('S.J.Res. 98: the Senate upheld it, 50–50, on the record date, with no trailer', () => {
    const j = deriveJourney(floorBill(SJRES_98));
    expect(j).toMatchObject({
      nowKey: 'nowPointOfOrderUpheld',
      nowChamber: 'senate',
      current: 'senate',
      step: 2, // the Senate vote step of a Senate joint resolution
      showTrailer: false,
      onCalendar: false,
      tally: { yeas: 50, nays: 50 },
      date: '2026-01-14',
    });
    expect(pointOfOrderUpheldChamber(SJRES_98)).toBe('senate');
  });

  test('the sentence, in both languages', () => {
    const j = deriveJourney(floorBill(SJRES_98));
    expect(render('en', j)).toBe(
      'the Senate upheld a point of order against it, 50–50, on January 14, 2026. The official record shows nothing new on it since.'
    );
    expect(render('es', j)).toBe(
      'el Senado aceptó una cuestión de orden en su contra, por 50 votos a favor y 50 en contra, el 14 de enero de 2026. El registro oficial no muestra nada nuevo desde entonces.'
    );
  });

  test('no tally, no date: each is left out, never borrowed', () => {
    // Constructed: the same shape, by voice vote (no tally in the sentence).
    const voice = deriveJourney(
      floorBill('Point of order that the measure is not entitled to expedited procedures raised against the measure agreed to in Senate by Voice Vote.')
    );
    expect(voice).toMatchObject({ nowKey: 'nowPointOfOrderUpheld', tally: null, date: '2026-01-14' });
    expect(render('en', voice)).toBe(
      'the Senate upheld a point of order against it, on January 14, 2026. The official record shows nothing new on it since.'
    );
    // Constructed: the point of order is the status BASIS (the latest step is
    // an ambiguous notice), and the basis carries no date. The latest step's
    // date is another action's, so the sentence prints none.
    const noDate = deriveJourney(
      floorBill('Motion to reconsider laid on the table Agreed to without objection.', '2026-01-15', {
        status_basis_text: SJRES_98,
        status_basis_date: null,
      })
    );
    expect(noDate).toMatchObject({ nowKey: 'nowPointOfOrderUpheld', tally: { yeas: 50, nays: 50 }, date: null });
    for (const locale of ['en', 'es'] as const) {
      const s = render(locale, noDate);
      expect(s).not.toMatch(/\{|\}|2026/);
    }
    expect(render('en', noDate)).toBe(
      'the Senate upheld a point of order against it, 50–50. The official record shows nothing new on it since.'
    );
  });

  test("the basis's own date, when the basis carries the sentence", () => {
    // Constructed, as above, with a basis date.
    const j = deriveJourney(
      floorBill('Motion to reconsider laid on the table Agreed to without objection.', '2026-01-15', {
        status_basis_text: SJRES_98,
        status_basis_date: '2026-01-14',
      })
    );
    expect(j).toMatchObject({ nowKey: 'nowPointOfOrderUpheld', date: '2026-01-14' });
  });

  test('not clocked: a fresh record reads the same sentence', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(deriveJourney(floorBill(SJRES_98, today))).toMatchObject({
      nowKey: 'nowPointOfOrderUpheld',
      date: today,
      showTrailer: false,
    });
  });

  test("the record's other sentence of this shape reads the same way (S.J.Res. 124's point of order, 51–47)", () => {
    const j = deriveJourney(floorBill(SJRES_124_POINT, '2026-04-28'));
    expect(j).toMatchObject({
      nowKey: 'nowPointOfOrderUpheld',
      nowChamber: 'senate',
      tally: { yeas: 51, nays: 47 },
      date: '2026-04-28',
      showTrailer: false,
    });
  });

  test('a House measure the Senate upheld one against stands at the Senate step', () => {
    // Constructed: the same sentence over an H.J.Res. in the Senate.
    const j = deriveJourney({ ...floorBill(SJRES_98), bill_type: 'hjres' });
    expect(j).toMatchObject({ nowKey: 'nowPointOfOrderUpheld', nowChamber: 'senate', current: 'senate', step: 3 });
  });

  test('pick (a): a point of order is procedural, so the call panel stays', () => {
    const b = floorBill(SJRES_98);
    // Only a law or a failed final vote counts as finished (owner, 2026-09-29).
    expect(settledDecision(b)).toBeNull();
    // It is not a failed motion either, so the panel prints no "last attempt" line.
    expect(lastFailedVote(b)).toBeNull();
    // The MCP envelope agrees: still open, act_url kept.
    expect(decisionState(b).state).toBe('pending');
    // And it is not a live floor call: nothing is ahead on the floor.
    expect(liveCallTarget(b)).toBeNull();
  });

  test('what it does NOT read keeps the sentence it had', () => {
    const notUpheld = [
      // Verbatim shapes from tests/procedural-answer.unit.spec.ts: raised with
      // no outcome (H.J.Res. 140), against an amendment (S.Con.Res. 7), about
      // the chamber's procedure (S.J.Res. 55).
      'Point of order that the measure is not entitled to expedited procedures under the Congressional Review Act raised in Senate. (CR S1780)',
      'Point of order that the amendment violates section 305(b)(2) of the CBA raised in Senate with respect to amendment SA 130.',
      'Point of order by Senator Thune: Shall points of order be in order under the Congressional Review Act? agreed to in Senate by Yea-Nay Vote. 51 - 46. Record Vote Number: 273.',
      // Constructed: a point of order the chamber did NOT uphold.
      'Point of order raised against the measure not agreed to in Senate by Yea-Nay Vote. 47 - 53.',
      'Point of order raised against the measure not sustained.',
    ];
    for (const text of notUpheld) {
      expect(pointOfOrderUpheldChamber(text), text).toBeNull();
      expect(deriveJourney(floorBill(text)).nowKey, text).not.toBe('nowPointOfOrderUpheld');
    }
  });

  test('never a guessed chamber: an upheld point that names none keeps the neutral sentence', () => {
    // Constructed (tests/procedural-answer.unit.spec.ts reads it as 'unknown').
    const t = 'Point of order raised against the measure well taken.';
    expect(procedureEndedConsideration(t)).toBe(true);
    expect(pointOfOrderUpheldChamber(t)).toBeNull();
    expect(deriveJourney(floorBill(t)).nowKey).toBe('nowFloorActivityNeutral');
  });

  test("S.J.Res. 124's last action is NOT this sentence: no chamber, no tally, no target named", () => {
    /*
     * "The motion to discharge fell when the point of order was well taken."
     * procedureEndedConsideration reads it (its second shape), but the sentence
     * names no chamber and no tally, and it does not say what the point of
     * order was raised against. The earlier action that does ("… raised
     * against the measure agreed to in Senate … 51 - 47 …", above) is not
     * stored with the bill. "The Senate upheld a point of order against it"
     * would take its chamber and its target from a sentence the page does not
     * hold, so it keeps the neutral sentence until it has one of its own.
     */
    expect(procedureEndedConsideration(SJRES_124_FELL)).toBe(true);
    expect(pointOfOrderUpheldChamber(SJRES_124_FELL)).toBeNull();
    expect(deriveJourney(floorBill(SJRES_124_FELL, '2026-04-28')).nowKey).toBe('nowFloorActivityNeutral');
  });
});

test.describe('the corpus: the stepper sentence', () => {
  const bills = JSON.parse(readFileSync('data/bills.json', 'utf8')) as Array<
    Parameters<typeof deriveJourney>[0] & { full_identifier: string; status_basis_date?: string | null }
  >;

  test('sjres-98-119 reads the upheld point of order, and the nightly sweep no longer files it as untensed', () => {
    const b = bills.find((x) => x.full_identifier === 'sjres-98-119');
    // The record can move on; the pin is on the sentence this change reads.
    test.skip(!b || b.last_action_text !== SJRES_98, 'S.J.Res. 98 has a newer action than 2026-01-14');
    const j = deriveJourney(b!);
    expect(j).toMatchObject({
      nowKey: 'nowPointOfOrderUpheld',
      nowChamber: 'senate',
      showTrailer: false,
      tally: { yeas: 50, nays: 50 },
      date: '2026-01-14',
    });
    expect(settledDecision(b!)).toBeNull();
    // scripts/check-journey-corpus.mjs's untensed sweep keeps a sentence only
    // while pointOfOrderUpheldChamber reads nothing from it.
    expect(pointOfOrderUpheldChamber(statusBasisText(b!))).toBe('senate');
    const sweep = readFileSync('scripts/check-journey-corpus.mjs', 'utf8');
    expect(sweep).toContain('pointOfOrderUpheldChamber(text(b)) === null');
  });

  test('every record the stepper reads this way names its chamber, keeps the call, and has no trailer', () => {
    for (const b of bills) {
      if (b.status !== 'floor_vote') continue;
      const j = deriveJourney(b);
      if (j.nowKey !== 'nowPointOfOrderUpheld') continue;
      const record = statusBasisText(b);
      expect(procedureEndedConsideration(record), b.full_identifier).toBe(true);
      expect(pointOfOrderUpheldChamber(record), b.full_identifier).toBe(j.nowChamber);
      expect(j.showTrailer, b.full_identifier).toBe(false);
      expect(settledDecision(b), b.full_identifier).toBeNull();
    }
  });
});
