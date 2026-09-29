import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import bills from '../data/bills.json';
import nominations from '../data/nominations.json';
import {
  CONCURRENT_TYPES,
  STATUS_LINE_KEYS,
  VEHICLE_GROUPS,
  billStatusLine,
  buildStatusSnapshot,
  diffStatusSnapshots,
  nominationStatusLine,
  pastReview,
  questionStatus,
  RECENCY_GAP_DAYS,
  statusFingerprint,
  vehicleGroup,
  type StatusLine,
} from '../lib/moment-status.mjs';
import {
  floorPendingChamber,
  floorReconsiderPendingChamber,
  floorSettledChamber,
  passageState as passageStateMjs,
} from '../lib/floor-text.mjs';
import { journeyEnding, lastFailedVote, passageState, settledDecision } from '../lib/journey';
import { decisionState } from '../lib/docket.mjs';
import { billCtaKey } from '../lib/moments-ui';
import { nominationSlug } from '../lib/core/nominations';
import { TERMINAL_NOMINATION_STATUSES } from '../lib/nomination-status.mjs';
import { renderStatusDigest, statusRun, storedNominationSlug } from '../scripts/moment-watch.mjs';

/*
 * THE BIG QUESTIONS STATUS LINE (lib/moment-status.mjs), pinned state by state
 * over VERBATIM record sentences — every fixture below is copied from
 * data/bills.json as committed on 2026-09-24, so a matcher that drifts off the
 * record's real wording fails here rather than on a question page.
 */

const NOW = Date.parse('2026-09-24T12:00:00Z');
const FRESH = '2026-09-22';
const OLD = '2026-07-27';

const bill = (bill_type: string, status: string, last_action_text: string | null, last_action_date: string | null = FRESH) => ({
  bill_type,
  status,
  last_action_text,
  last_action_date,
});

const TILLIS =
  'Motion by Senator Tillis to reconsider the vote by which cloture on the motion to proceed to the measure was not invoked (Record Vote No. 234) entered in Senate.';
const SCHUMER =
  'Motion by Senator Schumer to reconsider, under the order of 10/9/2025, not having voted on the prevailing side, the vote by which the third cloture motion on the motion to proceed to S. 2882 was not invoked (Record Vote No. 557) entered in Senate.';

test.describe('each vocabulary state, over the record’s own words', () => {
  const cases: [string, ReturnType<typeof bill>, Partial<StatusLine>][] = [
    ['signed, with the P.L. number', bill('hr', 'signed', 'Became Public Law No: 119-86.'), { key: 'signed', law: '119-86', terminal: true }],
    ['signed, without one', bill('hr', 'signed', 'Signed by President.'), { key: 'signed', law: null, terminal: true }],
    // Not terminal since 2026-09-29 (pick (a)): an override vote is still
    // possible, and the bill page keeps its call panel (decisionState: pending).
    ['vetoed', bill('hr', 'vetoed', 'Vetoed by President.'), { key: 'vetoed', terminal: false }],
    ['presented to the President', bill('hr', 'passed_chamber', 'Presented to President.'), { key: 'presented', terminal: false }],
    ['failed, reconsider pending (Tillis form)', bill('hr', 'floor_vote', TILLIS), { key: 'failedReconsider', chamber: 'senate', terminal: false }],
    ['failed, reconsider pending (Schumer form)', bill('s', 'floor_vote', SCHUMER), { key: 'failedReconsider', chamber: 'senate' }],
    // A failed PROCEDURAL vote reads `failed` and stays live (owner's pick
    // (a), 2026-09-29: "Procedural failures keep the call panel"). Only a
    // failed vote to pass it is terminal — H.Con.Res. 89 below.
    [
      'failed: motion to proceed rejected — live',
      bill('sjres', 'floor_vote', 'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50. Record Vote Number: 192. (CR S3194)'),
      { key: 'failed', chamber: 'senate', terminal: false },
    ],
    [
      'failed: discharge rejected — live',
      bill('sjres', 'floor_vote', 'Motion to discharge Senate Committee on Foreign Relations rejected by Yea-Nay Vote. 47 - 48. Record Vote Number: 174.'),
      { key: 'failed', chamber: 'senate', terminal: false },
    ],
    [
      'failed: cloture on the motion to proceed not invoked (S. 3386) — live',
      bill('s', 'floor_vote', 'Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 51 - 48. Record Vote Number: 643. (CR S8654)'),
      { key: 'failed', chamber: 'senate', terminal: false },
    ],
    [
      'failed: House suspension vote — live',
      bill('s', 'floor_vote', 'On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: (2/3 required): 264 - 133 (Roll no. 72).'),
      { key: 'failed', chamber: 'house', terminal: false },
    ],
    [
      'on the Senate calendar — aged placements still read, dated',
      bill('s', 'floor_vote', 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 501.', OLD),
      { key: 'onCalendar', chamber: 'senate' },
    ],
    ['on the Union Calendar', bill('hr', 'floor_vote', 'Placed on the Union Calendar, Calendar No. 412.'), { key: 'onCalendar', chamber: 'house' }],
    [
      'passed, then on the other chamber’s calendar',
      bill('hr', 'passed_chamber', 'Received in the Senate. Read twice. Placed on Senate Legislative Calendar under General Orders. Calendar No. 300.'),
      { key: 'passedOnCalendar', chamber: 'senate', passedBy: 'house' },
    ],
    [
      'cloture filed (fresh)',
      bill('s', 'floor_vote', 'Cloture motion on the motion to proceed to the measure presented in Senate. (CR S4200)'),
      { key: 'clotureFiled', chamber: 'senate' },
    ],
    ['considered by the Senate (fresh; #279’s reading, status lags the record)', bill('s', 'committee', 'Considered by Senate. (consideration: CR S4851)'), { key: 'onFloor', chamber: 'senate' }],
    ['motion to proceed made (fresh)', bill('s', 'floor_vote', 'Motion to proceed to consideration of measure made in Senate. (CR S4276)'), { key: 'onFloor', chamber: 'senate' }],
    [
      // Owner card a5 (2026-09-27), the #304 question: S. 4668's record,
      // verbatim. Debate is closing; the vote on the measure is still ahead.
      'cloture invoked on the measure (fresh; S. 4668)',
      bill('s', 'floor_vote', 'Cloture on the measure, as amended, invoked in Senate by Yea-Nay Vote. 74 - 25. Record Vote Number: 243.'),
      { key: 'onFloor', chamber: 'senate', terminal: false },
    ],
    [
      'failed of passage (H.Con.Res. 89, verbatim) — a failed vote, terminal',
      bill('hconres', 'floor_vote', 'Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.'),
      { key: 'failed', chamber: 'senate', terminal: true },
    ],
    [
      'postponed proceedings (fresh)',
      bill('hr', 'floor_vote', 'POSTPONED PROCEEDINGS - Pursuant to clause 8(c) of rule XIX, the Chair announced that the further proceedings on the motion would be postponed.'),
      { key: 'onFloor', chamber: 'house' },
    ],
    ['held at the (House) desk', bill('s', 'passed_chamber', 'Held at the desk.'), { key: 'heldAtDesk', chamber: 'house', passedBy: 'senate' }],
    ['received in the Senate', bill('hr', 'passed_chamber', 'Received in the Senate.'), { key: 'passedWaiting', chamber: 'senate', passedBy: 'house' }],
    [
      'received in the Senate and referred',
      bill('hconres', 'passed_chamber', 'Received in the Senate and referred to the Committee on Foreign Relations.'),
      { key: 'passedWaiting', chamber: 'senate', passedBy: 'house' },
    ],
    [
      'second chamber passed with changes',
      bill('hr', 'passed_chamber', 'Passed Senate with an amendment by Unanimous Consent.'),
      { key: 'passedBack', chamber: 'house', passedBy: 'senate' },
    ],
    [
      'both chambers, same text (a bill: not terminal, the President is next)',
      bill('hr', 'passed_chamber', 'Passed Senate without amendment by Unanimous Consent. (consideration: CR S1)'),
      { key: 'bothAgreed', terminal: false },
    ],
    [
      'both chambers, same text (a concurrent resolution: its path ends here)',
      bill('hconres', 'passed_chamber', 'Passed Senate without amendment by Yea-Nay Vote. 50 - 48.'),
      { key: 'bothAgreed', terminal: true },
    ],
    ['in committee: referred', bill('hr', 'committee', 'Referred to the House Committee on Foreign Affairs.'), { key: 'inCommittee' }],
    ['in committee: ordered reported (the committee’s own vote)', bill('hr', 'markup', 'Ordered to be Reported by the Yeas and Nays: 30 - 20.'), { key: 'inCommittee' }],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => {
      const line = billStatusLine(input, NOW);
      expect(line).toMatchObject(expected);
      expect(line.date).toBe(input.last_action_date);
    });
  }
});

/*
 * THE CARD FOLLOWS THE BILL PAGE (owner, 2026-09-29, pick (a) on artifact
 * 7BuRDMkWu9zigDE1u2XPLJ: "Only a law or a failed final vote counts as
 * finished. Procedural failures keep the call panel, with a line saying the
 * last attempt failed."). After #350 the bill pages of the four S.J.Res.
 * vehicles on /questions/iran-war-powers kept their call panel, while their
 * Big Question cards still said "Read the bill": this module marked every
 * failed floor vote terminal. `terminal` is now lib/docket.mjs
 * `decisionState`. Each record below is verbatim from data/bills.json as
 * committed on 2026-09-29.
 *
 * `cardKey` is the question page's own expression for a bill card
 * (app/[locale]/questions/[id]/page.tsx), minus the question-level `settled`
 * state (lib/moments.ts: every vehicle signed or vetoed), which the Iran
 * question is not.
 */
test.describe('the Big Question card follows the bill page (pick (a), 2026-09-29)', () => {
  type Rec = Parameters<typeof billStatusLine>[0] & { status_basis_text?: string };
  const rec = (bill_type: string, status: string, last_action_text: string, last_action_date: string, status_basis_text?: string): Rec => ({
    bill_type,
    status,
    last_action_text,
    last_action_date,
    ...(status_basis_text ? { status_basis_text } : {}),
  });
  const cardKey = (b: Rec) => billCtaKey(billStatusLine(b, NOW).terminal || settledDecision(b as never) !== null);

  const IRAN_PROCEDURAL: [string, Rec, FailedProcedure][] = [
    [
      'sjres-185-119',
      rec('sjres', 'floor_vote', 'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50. Record Vote Number: 192. (CR S3194)', '2026-06-24'),
      'proceed',
    ],
    [
      'sjres-180-119',
      rec('sjres', 'floor_vote', 'Motion to discharge Senate Committee on Foreign Relations rejected by Yea-Nay Vote. 47 - 49. Record Vote Number: 207.', '2026-07-23'),
      'discharge',
    ],
    [
      'sjres-181-119',
      rec('sjres', 'floor_vote', 'Motion to discharge Senate Committee on Foreign Relations rejected by Yea-Nay Vote. 49 - 50. Record Vote Number: 216. (consideration: CR S4357)', '2026-07-30'),
      'discharge',
    ],
    [
      'sjres-172-119',
      rec('sjres', 'floor_vote', 'Motion to discharge Senate Committee on Foreign Relations rejected by Yea-Nay Vote. 47 - 48. Record Vote Number: 174.', '2026-06-16'),
      'discharge',
    ],
  ];
  for (const [slug, b, procedure] of IRAN_PROCEDURAL) {
    test(`${slug}: a failed ${procedure} motion — the line says a Senate vote failed, and the card offers the call`, () => {
      const line = billStatusLine(b, NOW);
      expect(line).toMatchObject({ key: 'failed', chamber: 'senate', terminal: false });
      // The bill page keeps its call panel, with the last-attempt line…
      expect(settledDecision(b as never)).toBeNull();
      expect(lastFailedVote(b as never)).toMatchObject({ procedure, chamber: 'senate' });
      // …the MCP envelope agrees…
      expect(decisionState(b)).toEqual({ state: 'pending', reason: null });
      // …and so does the card.
      expect(cardKey(b)).toBe('moments.readCall');
    });
  }

  const FINISHED: [string, Rec, Partial<StatusLine>][] = [
    [
      'hconres-89-119, a failed vote to pass it (Senate, 49–50)',
      rec('hconres', 'floor_vote', 'Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.', '2026-09-24'),
      { key: 'failed', chamber: 'senate' },
    ],
    [
      'hconres-38-119, a failed vote to pass it (House, 212–219), read from the stored basis',
      rec(
        'hconres',
        'floor_vote',
        'Motion to reconsider laid on the table Agreed to without objection.',
        '2026-03-05',
        'Failed of passage/not agreed to in House On agreeing to the resolution Failed by the Yeas and Nays: 212 - 219 (Roll no. 85).',
      ),
      { key: 'failed', chamber: 'house' },
    ],
    ['hr-6500-119, a law', rec('hr', 'signed', 'Became Public Law No: 119-103.', '2026-09-02'), { key: 'signed', law: '119-103' }],
  ];
  for (const [name, b, expected] of FINISHED) {
    test(`${name} stays terminal, and its card reads "Read the bill"`, () => {
      expect(billStatusLine(b, NOW)).toMatchObject({ ...expected, terminal: true });
      expect(settledDecision(b as never)).not.toBeNull();
      expect(decisionState(b).state).not.toBe('pending');
      expect(cardKey(b)).toBe('moments.readBill');
    });
  }

  test('hconres-86-119, a concurrent resolution both chambers adopted (#360), stays terminal', () => {
    const b = rec(
      'hconres',
      'passed_chamber',
      'Message on Senate action sent to the House.',
      '2026-06-24',
      'Resolution agreed to in Senate without amendment by Yea-Nay Vote. 50 - 48. Record Vote Number: 184. (consideration: CR S3039-3040)',
    );
    expect(billStatusLine(b, NOW)).toMatchObject({ key: 'bothAgreed', terminal: true });
    expect(decisionState(b).state).toBe('settled');
    expect(cardKey(b)).toBe('moments.readBill');
  });

  test('the Iran question as a whole: still live, still led by the 49–50 rejection', () => {
    const lines = [
      billStatusLine(rec('hconres', 'passed_chamber', 'Received in the Senate and referred to the Committee on Foreign Relations.', '2026-09-16'), NOW),
      billStatusLine(FINISHED[0][1], NOW),
      ...IRAN_PROCEDURAL.map(([, b]) => billStatusLine(b, NOW)),
    ];
    const q = questionStatus(lines);
    expect(q.mode).toBe('live');
    expect(q.lead).toBe(lines[1]);
  });
});

type FailedProcedure = NonNullable<ReturnType<typeof lastFailedVote>>['procedure'];

test.describe('the verbatim fallback — what no matcher has read', () => {
  const verbatim: [string, ReturnType<typeof bill>][] = [
    // #279 reads "Considered by …" as pending; aged, the record speaks instead
    ['Considered by Senate, AGED (status lags the record)', bill('s', 'committee', 'Considered by Senate. (consideration: CR S4851)', OLD)],
    ['House routine closure under a committee status', bill('hconres', 'committee', 'Motion to reconsider laid on the table Agreed to without objection.', '2026-03-05')],
    ['House routine closure after passage: the chamber is unknowable', bill('s', 'passed_chamber', 'Motion to reconsider laid on the table Agreed to without objection.')],
    ['reported BY a committee has left it', bill('hr', 'committee', 'Reported (Amended) by the Committee on Natural Resources. H. Rept. 119-300.')],
    ['a withdrawn motion is settled but is not a failed vote', bill('s', 'floor_vote', 'Motion to proceed to consideration of measure withdrawn in Senate.')],
    ['an AGED floor motion does not claim a vote is ahead', bill('s', 'floor_vote', 'Motion to proceed to consideration of measure made in Senate. (CR S4276)', OLD)],
    ['an AGED cloture filing does not claim a vote within days', bill('s', 'floor_vote', 'Cloture motion on the measure presented in Senate.', OLD)],
    ['an AGED cloture-invoked sentence does not claim a vote is ahead', bill('s', 'floor_vote', 'Cloture on the measure, as amended, invoked in Senate by Yea-Nay Vote. 74 - 25.', OLD)],
    [
      'cloture on the MOTION TO PROCEED invoked is not read (a different next step, nobody has read it for this line)',
      bill('s', 'floor_vote', 'Cloture on the motion to proceed to the measure invoked in Senate by Yea-Nay Vote. 62 - 36.'),
    ],
    ['an empty record sentence', bill('hr', 'committee', '')],
  ];
  for (const [name, input] of verbatim) {
    test(name, () => {
      const line = billStatusLine(input, NOW);
      expect(line.key).toBe('recordStep');
      expect(line.text).toBe(input.last_action_text);
      expect(line.terminal).toBe(false);
    });
  }
});

test.describe('the reconsider matcher (lib/floor-text.mjs)', () => {
  test('reads both live corpus shapes', () => {
    expect(floorReconsiderPendingChamber(TILLIS)).toBe('senate');
    expect(floorReconsiderPendingChamber(SCHUMER)).toBe('senate');
  });
  test('D4 is untouched: the crown’s reader still settles it, and never calls it pending', () => {
    for (const text of [TILLIS, SCHUMER]) {
      expect(floorPendingChamber(text)).toBeNull();
      expect(floorSettledChamber(text)).toBe('senate');
    }
  });
  test('fails closed on everything that is not a still-entered motion aimed at a failed vote', () => {
    for (const text of [
      'Motion to reconsider laid on the table Agreed to without objection.',
      'Motion by Senator Tillis to reconsider the vote by which cloture on the motion to proceed to the measure was invoked (Record Vote No. 234) entered in Senate.',
      'Motion by Senator Tillis to reconsider the vote by which cloture on the motion to proceed to the measure was not invoked (Record Vote No. 234) withdrawn in Senate.',
      'Motion by Senator Tillis to reconsider the vote by which cloture on the motion to proceed to the measure was not invoked (Record Vote No. 234) tabled in Senate.',
      'Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 49 - 50.',
      '',
      null,
    ]) {
      expect(floorReconsiderPendingChamber(text), String(text)).toBeNull();
    }
  });
});

test.describe('question level: enacted leads, then rank — unless a newer floor event disagrees by days', () => {
  const failed = billStatusLine(bill('sjres', 'floor_vote', 'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50.', '2026-06-24'), NOW);
  const waiting = billStatusLine(bill('hconres', 'passed_chamber', 'Received in the Senate and referred to the Committee on Foreign Relations.', '2026-07-23'), NOW);
  const committee = billStatusLine(bill('hr', 'committee', 'Referred to the House Committee on Foreign Affairs.', '2026-09-01'), NOW);
  const signed = billStatusLine(bill('hr', 'signed', 'Became Public Law No: 119-103.', '2026-09-02'), NOW);
  const rejected = billStatusLine(bill('hconres', 'floor_vote', 'Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.', '2026-06-24'), NOW);

  test('leads with the most advanced LIVE vehicle, even over a newer COMMITTEE line (a referral is not news)', () => {
    expect(questionStatus([failed, committee, waiting])).toEqual({ mode: 'live', lead: waiting });
  });
  test('every vehicle terminal → explainer mode, led by the most recent', () => {
    expect(questionStatus([rejected, signed])).toEqual({ mode: 'explainer', lead: signed });
  });
  test('a failed MOTION keeps the question live: its vehicle can still come to a vote (pick (a), 2026-09-29)', () => {
    expect(failed.terminal).toBe(false);
    expect(questionStatus([failed, signed])).toEqual({ mode: 'live', lead: signed });
    expect(questionStatus([failed, rejected])).toEqual({ mode: 'live', lead: failed });
  });
  test('no resolved vehicle → no line at all', () => {
    expect(questionStatus([])).toEqual({ mode: 'live', lead: null });
  });

  /*
   * The 2026-09-27 audit, SY-05 (owner card a5). Each case is the live index
   * line that read wrong that morning, from data/bills.json at 3be584d.
   */
  test('AN ENACTED VEHICLE LEADS (the funding question: H.R. 6500 signed Sep 2, H.R. 9770 still "waiting on the Senate")', () => {
    const hr9770 = billStatusLine(bill('hr', 'passed_chamber', 'Received in the Senate.', '2026-07-22'), NOW);
    const hr6500 = billStatusLine(bill('hr', 'signed', 'Became Public Law No: 119-103.', '2026-09-02'), NOW);
    expect(questionStatus([hr6500, hr9770])).toEqual({ mode: 'live', lead: hr6500 });
    expect(questionStatus([signed, committee])).toEqual({ mode: 'live', lead: signed });
    // …in explainer mode too, even when a failure is newer than the law.
    const newerFailure = billStatusLine(bill('hconres', 'floor_vote', 'Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.', '2026-09-20'), NOW);
    expect(questionStatus([newerFailure, signed])).toEqual({ mode: 'explainer', lead: signed });
    // A newer failed MOTION leaves the question live, and the law still leads.
    const newerMotion = billStatusLine(bill('sjres', 'floor_vote', 'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50.', '2026-09-20'), NOW);
    expect(questionStatus([newerMotion, signed])).toEqual({ mode: 'live', lead: signed });
  });

  test('RECENCY BEATS RANK by more than RECENCY_GAP_DAYS (Iran: the 49–50 rejection, 8 days after "waiting on the Senate")', () => {
    const hconres93 = billStatusLine(bill('hconres', 'passed_chamber', 'Received in the Senate and referred to the Committee on Foreign Relations.', '2026-09-16'), NOW);
    const hconres89 = billStatusLine(bill('hconres', 'floor_vote', 'Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.', '2026-09-24'), NOW);
    const sjres211 = billStatusLine(bill('sjres', 'committee', 'Read twice and referred to the Committee on Foreign Relations.', '2026-08-06'), NOW);
    const q = questionStatus([hconres93, hconres89, sjres211]);
    expect(q.mode).toBe('live'); // H.Con.Res. 93 is still live: the cards keep their calls
    expect(q.lead).toBe(hconres89);
    expect(RECENCY_GAP_DAYS).toBe(3);
  });

  test('inside the gap, rank still decides', () => {
    const hconres93 = billStatusLine(bill('hconres', 'passed_chamber', 'Received in the Senate.', '2026-09-21'), NOW);
    const hconres89 = billStatusLine(bill('hconres', 'floor_vote', 'Failed of passage in Senate by Yea-Nay Vote. 49 - 50.', '2026-09-24'), NOW);
    expect(questionStatus([hconres93, hconres89]).lead).toBe(hconres93);
  });

  test('the record\'s raw procedural sentence never heads the question while any line is readable', () => {
    const unread = billStatusLine(bill('hconres', 'passed_chamber', 'Message on Senate action sent to the House.', '2026-06-24'), NOW);
    expect(unread.key).toBe('recordStep');
    const onFloor = billStatusLine(bill('s', 'floor_vote', 'Motion to proceed to consideration of measure made in Senate. (CR S4276)', '2026-09-20'), NOW);
    expect(unread.rank).toBeGreaterThan(onFloor.rank);
    expect(questionStatus([unread, onFloor]).lead).toBe(onFloor);
    // Only when nothing else is readable does the record speak for itself.
    expect(questionStatus([unread]).lead).toBe(unread);
  });

  test('college sports: S. 4668 no longer heads its question with "The committee substitute tabled by Voice Vote."', () => {
    const s4668 = billStatusLine(
      {
        bill_type: 's',
        status: 'floor_vote',
        last_action_text: 'The committee substitute tabled by Voice Vote.',
        // status_basis_text: the sentence the status was read from (#286).
        ...{ status_basis_text: 'Cloture on the measure, as amended, invoked in Senate by Yea-Nay Vote. 74 - 25. Record Vote Number: 243.' },
        last_action_date: FRESH,
      } as Parameters<typeof billStatusLine>[0],
      NOW,
    );
    expect(s4668).toMatchObject({ key: 'onFloor', chamber: 'senate' });
    expect(questionStatus([s4668]).lead).toBe(s4668);
  });
});

test.describe('chamber grouping', () => {
  test('House, Senate, then Enacted — by the chamber a bill STARTED in', () => {
    expect(VEHICLE_GROUPS).toEqual(['house', 'senate', 'enacted']);
    expect(vehicleGroup({ kind: 'bill', bill_type: 'hconres', status: 'passed_chamber' })).toBe('house');
    expect(vehicleGroup({ kind: 'bill', bill_type: 'sjres', status: 'floor_vote' })).toBe('senate');
    expect(vehicleGroup({ kind: 'bill', bill_type: 'hr', status: 'signed' })).toBe('enacted');
    expect(vehicleGroup({ kind: 'nomination' })).toBe('senate');
  });
});

test.describe('pins against the TypeScript originals', () => {
  test('CONCURRENT_TYPES is exactly journeyEnding’s bothChambers set', () => {
    for (const type of ['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres', 'hres', 'sres']) {
      expect(CONCURRENT_TYPES.has(type), type).toBe(journeyEnding(type) === 'bothChambers');
    }
  });
  test('passageState moved, unchanged: the TS door and the .mjs body agree corpus-wide', () => {
    for (const b of bills as { bill_type: string; last_action_text: string | null }[]) {
      expect(passageState(b)).toEqual(passageStateMjs(b));
    }
  });
  test('the watcher’s nomination slug equals lib/core/nominations.ts nominationSlug', () => {
    for (const n of nominations as Parameters<typeof nominationSlug>[0][]) {
      expect(storedNominationSlug(n)).toBe(nominationSlug(n));
    }
  });
});

test.describe('the corpus sweep', () => {
  test('every committed bill maps to a key in the closed vocabulary, and no clocked claim is aged', () => {
    const counts: Record<string, number> = {};
    for (const b of bills as Parameters<typeof billStatusLine>[0][]) {
      const line = billStatusLine(b, NOW);
      expect(STATUS_LINE_KEYS).toContain(line.key);
      counts[line.key] = (counts[line.key] ?? 0) + 1;
      if (line.key === 'clotureFiled' || line.key === 'onFloor') {
        const age = (NOW - Date.parse(`${line.date}T00:00:00Z`)) / 86_400_000;
        expect(age, `${line.key} over a ${age}-day-old action`).toBeLessThanOrEqual(15);
      }
    }
    // The fallback stays the exception, never the rule (66 of ~3,190 on
    // 2026-09-24). A ceiling, not a count: the corpus moves nightly.
    expect(counts.recordStep ?? 0).toBeLessThan((bills as unknown[]).length * 0.1);
  });

  test('terminal IS decisionState on every committed bill, and every record the bill page settles is terminal', () => {
    let procedural = 0;
    for (const b of bills as (Parameters<typeof billStatusLine>[0] & { full_identifier: string })[]) {
      const line = billStatusLine(b, NOW);
      expect(line.terminal, b.full_identifier).toBe(decisionState(b).state !== 'pending');
      // One direction only: a card never offers a call its page does not have.
      if (settledDecision(b as never) !== null) expect(line.terminal, b.full_identifier).toBe(true);
      if (line.key === 'failed' && !line.terminal) procedural++;
    }
    // Not a count to keep — the corpus moves nightly — only proof the sweep
    // reached failed procedural votes at all (26 on 2026-09-29).
    expect(procedural).toBeGreaterThan(0);
  });

  test('nominations: verbatim, Senate, terminal by the nomination set', () => {
    const n = { status: 'confirmed', last_action_text: 'Confirmed by the Senate by Voice Vote.', last_action_date: '2026-09-01' };
    expect(nominationStatusLine(n, TERMINAL_NOMINATION_STATUSES)).toMatchObject({ key: 'recordStep', chamber: 'senate', terminal: true });
    expect(nominationStatusLine({ ...n, status: 'exec_calendar' }, TERMINAL_NOMINATION_STATUSES).terminal).toBe(false);
  });
});

test.describe('copy: every key renders in both languages', () => {
  for (const [lang, messages] of [['en', en], ['es', es]] as const) {
    test(lang, () => {
      const t = createTranslator({ locale: lang, messages, namespace: 'moments.status' });
      for (const key of STATUS_LINE_KEYS) {
        if (key === 'recordStep') continue; // rendered from recordStepLabel + the record's own text
        for (const chamber of ['house', 'senate']) {
          const out = t(`line.${key}` as never, { chamber, law: key === 'signed' ? '119-86' : 'none' } as never) as string;
          expect(out, `${lang} line.${key}`).not.toMatch(/[{}]|line\./);
          expect(out.length).toBeGreaterThan(5);
        }
      }
      expect(t('line.signed' as never, { chamber: 'house', law: 'none' } as never)).not.toContain('none');
      // The chamber select must actually switch: House and Senate lines differ
      // wherever the English sentence names a chamber.
      expect(t('line.onCalendar' as never, { chamber: 'house', law: 'none' } as never)).not.toBe(
        t('line.onCalendar' as never, { chamber: 'senate', law: 'none' } as never),
      );
    });
  }
});

test.describe('the nightly refresh (scripts/moment-watch.mjs --mode=status)', () => {
  const moments = {
    q: {
      status: 'live',
      review_by: '2026-10-30',
      vehicles: [{ slug: 'hr-1-119' }, { slug: 's-2-119' }],
    },
    old: { status: 'live', review_by: '2026-08-22', vehicles: [{ slug: 's-2-119' }] },
    gone: { status: 'retired', review_by: '2026-08-22', vehicles: [{ slug: 'hr-1-119' }] },
  };
  const billsA = [
    { full_identifier: 'hr-1-119', ...bill('hr', 'committee', 'Referred to the House Committee on Rules.', '2026-09-01') },
    { full_identifier: 's-2-119', ...bill('s', 'floor_vote', 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 9.', '2026-09-10') },
  ];
  const billsB = [
    { full_identifier: 'hr-1-119', ...bill('hr', 'committee', 'Referred to the House Committee on Rules.', '2026-09-01') },
    { full_identifier: 's-2-119', ...bill('s', 'floor_vote', 'Cloture motion on the measure presented in Senate.', '2026-09-23') },
  ];

  test('first run: no diff, every past-review question flagged once', () => {
    const run = statusRun({ moments, bills: billsA, nominations: [], prev: null, now: NOW });
    expect(run.changes).toEqual([]);
    expect(run.past.map((p) => p.id)).toEqual(['old']);
    expect(run.body).toContain('`old`');
    expect(Object.keys(run.snapshot)).toEqual(['q', 'old']); // retired is not watched
  });

  test('a quiet night posts nothing', () => {
    const first = statusRun({ moments, bills: billsA, nominations: [], prev: null, now: NOW });
    const prev = { questions: first.snapshot, pastReview: first.past.map((p) => p.id) };
    const again = statusRun({ moments, bills: billsA, nominations: [], prev, now: NOW });
    expect(again.body).toBe('');
  });

  test('a moved line is flagged under every question that holds the vehicle, with the record’s words', () => {
    const first = statusRun({ moments, bills: billsA, nominations: [], prev: null, now: NOW });
    const prev = { questions: first.snapshot, pastReview: first.past.map((p) => p.id) };
    const next = statusRun({ moments, bills: billsB, nominations: [], prev, now: NOW });
    expect(next.changes.map((c) => `${c.id}/${c.slug}`)).toEqual(['old/s-2-119', 'q/s-2-119']);
    expect(next.changes[0].from).toBe('onCalendar|senate||2026-09-10');
    expect(next.changes[0].to).toBe('clotureFiled|senate||2026-09-23');
    expect(next.body).toContain('Cloture motion on the measure presented in Senate.');
  });

  test('a vehicle added by a content PR is movement too', () => {
    const snapA = buildStatusSnapshot({ moments: { q: moments.q }, lineFor: () => billStatusLine(billsA[0], NOW) });
    const withMore = { q: { ...moments.q, vehicles: [...moments.q.vehicles, { slug: 'hjres-3-119' }] } };
    const snapB = buildStatusSnapshot({ moments: withMore, lineFor: () => billStatusLine(billsA[0], NOW) });
    expect(diffStatusSnapshots(snapA, snapB)).toEqual([
      { id: 'q', slug: 'hjres-3-119', from: null, to: statusFingerprint(billStatusLine(billsA[0], NOW)), text: billsA[0].last_action_text },
    ]);
  });

  test('past review starts the day AFTER review_by, like computeMomentState', () => {
    const snap = { a: { review_by: '2026-09-24', vehicles: {} }, b: { review_by: '2026-09-23', vehicles: {} } };
    expect(pastReview(snap, NOW).map((p) => p.id)).toEqual(['b']);
  });

  test('the digest is empty when there is nothing to flag', () => {
    expect(renderStatusDigest({ changes: [], past: [{ id: 'x', review_by: '2026-01-01', daysPast: 5 }], newlyPast: [], now: NOW })).toBe('');
  });
});
