import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import * as congressFetch from '../scripts/congress-fetch.mjs';
import {
  FLOOR_SETTLED,
  concurrentAdoptedBy,
  passageState,
  procedureIsTheSubject,
  statusBasisText,
} from '../lib/floor-text.mjs';
import { announcementAnswered, decisionState, docketRung, floorAnsweredChamber, isSettledFloor } from '../lib/docket.mjs';

/*
 * A POINT OF ORDER OR A MOTION IS NOT THE CHAMBER'S ANSWER ON THE MEASURE
 * (2026-09-29, S.J.Res. 98).
 *
 * lib/docket.mjs `floorAnsweredChamber` read every "agreed to in <chamber>" as
 * that chamber having answered. S.J.Res. 98's point of order and the Senate's
 * motion to proceed are both written that way, and in neither did the Senate
 * vote on the measure. The reading matters where a live announcement meets
 * the record (`announcementAnswered`): it retired the Senate's own program on
 * the day the Senate took the measure up, and the rung that fell out of it is
 * what the crown, the act-now pool and MCP `whats_moving` read.
 *
 * Every sentence below is VERBATIM from the committed corpus, with where it
 * was read, unless it says "constructed".
 */

/** data/bills.json, sjres-98-119, last action of 2026-01-14. */
const SJRES_98 =
  'Point of order that the measure is not entitled to expedited procedures under 50 U.S.C. 1546(a) raised against the measure agreed to in Senate by Yea-Nay Vote. 50 - 50. Record Vote Number: 9.';
/** data/moment-updates.json, hr-6500-119 on 2026-08-05. */
const MTP_AGREED_VOICE = 'Motion to proceed to consideration of measure agreed to in Senate by Voice Vote. (CR S4448)';
/** data/moment-updates.json, s-4668-119 on 2026-09-17. */
const MTP_AGREED_ROLL =
  'Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 77 - 22. Record Vote Number: 236.';

const PROCEDURAL_REAL = [SJRES_98, MTP_AGREED_VOICE, MTP_AGREED_ROLL];

/** Constructed, in the Senate's action vocabulary: procedural motions agreed to. */
const PROCEDURAL_CONSTRUCTED = [
  'Motion to discharge Senate Committee on Foreign Relations agreed to in Senate by Yea-Nay Vote. 51 - 47. Record Vote Number: 120.',
  'Motion to table the motion to discharge agreed to in Senate by Yea-Nay Vote. 52 - 47.',
  'Motion to waive all applicable budgetary discipline with respect to the measure agreed to in Senate by Yea-Nay Vote. 60 - 38.',
  'Motion by Senator Thune to table the motion to concur in the House amendment agreed to in Senate by Yea-Nay Vote. 51 - 49.',
  'Point of order raised against the measure not agreed to in Senate by Yea-Nay Vote. 47 - 53.',
];

/** Constructed: a procedural motion agreed to that also carries a settled word. */
const RECONSIDER_AGREED_CONSTRUCTED =
  'Motion to reconsider the vote by which cloture was not invoked agreed to in Senate by Unanimous Consent.';

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

test.describe('floorAnsweredChamber: a point of order or a motion agreed to is not the answer', () => {
  for (const text of [...PROCEDURAL_REAL, ...PROCEDURAL_CONSTRUCTED]) {
    test(text.slice(0, 80), () => {
      expect(procedureIsTheSubject(text)).toBe(true);
      expect(floorAnsweredChamber(text)).toBeNull();
    });
  }
});

test.describe('floorAnsweredChamber: what still answers is unchanged', () => {
  test('a chamber passing the measure', () => {
    for (const { text, chamber, where } of PASSAGES_REAL) {
      expect(procedureIsTheSubject(text), where).toBe(false);
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

test.describe('the ladder: a live Senate announcement survives the Senate taking the measure up', () => {
  // A Senate program covering the day of the vote, refreshed that morning.
  const NOW = Date.parse('2026-09-17T20:00:00Z');
  const program = {
    tier0: {
      source: 'daily-digest',
      chamber: 'senate',
      quote: 'Senate will vote on the motion to proceed.',
      url: 'https://www.congress.gov/congressional-record',
      published: '2026-09-16',
      covers: '2026-09-17',
      track: 'unspecified',
      certainty: 'scheduled_vote',
    },
    fetched_at: '2026-09-17T12:00:00Z',
  };
  const bill = (status: string, text: string) => ({
    bill_type: 's',
    status,
    last_action_text: text,
    last_action_date: '2026-09-17',
  });

  test('the motion to proceed agreed to leaves the announcement standing (S. 4668)', () => {
    // Both statuses: `passed_chamber` is how scripts/congress-fetch.mjs files
    // this sentence on main today, `floor_vote` is how it files it once PR
    // #363 lands. Neither may read as the Senate having answered.
    for (const status of ['passed_chamber', 'floor_vote']) {
      const b = bill(status, MTP_AGREED_ROLL);
      expect(announcementAnswered(b, program), status).toBe(false);
      expect(docketRung(b, program, { now: NOW }), status).toMatchObject({ tier: 't0', annotation: null });
    }
  });

  test('the point of order agreed to is not "the floor already answered" (S.J.Res. 98)', () => {
    const b = { ...bill('floor_vote', SJRES_98), bill_type: 'sjres' };
    expect(announcementAnswered(b, program)).toBe(false);
    expect(docketRung(b, program, { now: NOW }).annotation).not.toBe('just_decided');
    expect(docketRung(b, program, { now: NOW }).tier).toBe('t0');
  });

  test('controls: a real passage and a real defeat still retire the same announcement', () => {
    const passed = bill('passed_chamber', 'Passed Senate without amendment by Unanimous Consent. (consideration: CR S4882)');
    expect(announcementAnswered(passed, program)).toBe(true);
    expect(docketRung(passed, program, { now: NOW })).toMatchObject({ tier: 't3', annotation: 'just_passed' });
    const rejected = bill(
      'floor_vote',
      'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50. Record Vote Number: 111. (CR S2106)'
    );
    expect(announcementAnswered(rejected, program)).toBe(true);
    expect(docketRung(rejected, program, { now: NOW })).toMatchObject({ tier: 't4', annotation: 'just_decided' });
  });
});

test.describe('the sibling readers already refuse these sentences', () => {
  test('no passage, no adoption, no settled decision', () => {
    for (const text of PROCEDURAL_REAL) {
      // passageState and concurrentAdoptedBy read an anchored passage opening.
      expect(passageState({ bill_type: 'sjres', last_action_text: text }).passedBy, text).toBeNull();
      expect(concurrentAdoptedBy({ bill_type: 'sconres', status: 'passed_chamber', last_action_text: text }), text).toBeNull();
      for (const status of ['passed_chamber', 'floor_vote']) {
        const b = { bill_type: 'sjres', status, last_action_text: text };
        expect(isSettledFloor(b), `${status}: ${text}`).toBe(false);
        // The MCP envelope's decision_state: still open, no settled_reason.
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
        // The two readings that stay: the settled vocabulary, and the
        // post-vote reconsider notice.
        !FLOOR_SETTLED.test(t) &&
        !/motion to reconsider laid on the table/i.test(t)
    );
    expect(wrong).toEqual([]);
  });

  test('sjres-98-119, while its record still reads the point of order, is no answer and no settled decision', () => {
    const b = bills.find((x) => x.full_identifier === 'sjres-98-119');
    // The record can move on; the pin is on the sentence this change reads.
    test.skip(!b || statusBasisText(b as never) !== SJRES_98, 'sjres-98-119 has a newer last action');
    expect(floorAnsweredChamber(statusBasisText(b as never))).toBeNull();
    expect(decisionState(b as never).state).toBe('pending');
  });
});

/*
 * THE PIPELINE'S COPY. PR #363 adds `isProceduralAgreedTo` to
 * scripts/congress-fetch.mjs with the same two patterns, so mapStatus stops
 * filing these sentences as `passed_chamber`. Until it lands this test is
 * skipped and says why; once it lands, the two readers are pinned to agree on
 * every sentence here that carries "agreed to in <chamber>".
 */
test.describe('the pipeline reads the same sentences the same way', () => {
  test('isProceduralAgreedTo and procedureIsTheSubject agree', () => {
    const isProceduralAgreedTo = (congressFetch as unknown as Record<string, unknown>).isProceduralAgreedTo;
    test.skip(typeof isProceduralAgreedTo !== 'function', 'scripts/congress-fetch.mjs isProceduralAgreedTo arrives with PR #363');
    const read = isProceduralAgreedTo as (t: string) => boolean;
    const sentences = [
      ...PROCEDURAL_REAL,
      ...PROCEDURAL_CONSTRUCTED,
      RECONSIDER_AGREED_CONSTRUCTED,
      ...PASSAGES_REAL.map((p) => p.text),
      ...PASSAGE_MOTIONS_CONSTRUCTED.map((p) => p.text),
    ].filter((t) => /\bagreed to in (?:the )?(?:house|senate)\b/i.test(t));
    expect(sentences.length).toBeGreaterThan(0);
    for (const t of sentences) expect(read(t), t).toBe(procedureIsTheSubject(t));
  });
});
