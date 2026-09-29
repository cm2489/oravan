import { expect, test } from '@playwright/test';
import bills from '../data/bills.json';
import { concurrentAdoptedBy, passageState as passageStateMjs } from '../lib/floor-text.mjs';
import { decisionState, docketRung } from '../lib/docket.mjs';
import { billStatusLine } from '../lib/moment-status.mjs';
import { deriveJourney, journeyEnding, liveCallTarget } from '../lib/journey';

/*
 * A CONCURRENT RESOLUTION BOTH CHAMBERS AGREED TO IN ONE FORM — the end of its
 * path (2026-09-28, H.Con.Res. 86; lib/floor-text.mjs `concurrentAdoptedBy`).
 *
 * The record, read on Congress.gov 2026-09-28: the House agreed to H.Con.Res.
 * 86 215–208 on 2026-06-03 (Roll no. 199); the Senate "agreed to [it] without
 * amendment" 50–48 on 2026-06-23 (Record Vote 184); on 2026-06-24 Congress
 * wrote "Message on Senate action sent to the House." over that. A concurrent
 * resolution goes to no President, so nothing is left to decide.
 *
 * And the shape it must NOT swallow: a bill or joint resolution passed by the
 * second chamber without amendment is finished in Congress but goes to the
 * President next, which is a different state.
 *
 * Every fixture sentence is verbatim from data/bills.json as committed on
 * 2026-09-28 unless its comment says otherwise.
 */

const SENATE_AGREED =
  'Resolution agreed to in Senate without amendment by Yea-Nay Vote. 50 - 48. Record Vote Number: 184. (consideration: CR S3039-3040)';
const MESSAGE = 'Message on Senate action sent to the House.';
/** The corpus record as committed, minus the decode. */
const HCONRES_86 = {
  bill_type: 'hconres',
  status: 'passed_chamber' as const,
  last_action_date: '2026-06-24',
  last_action_text: MESSAGE,
  status_basis_text: SENATE_AGREED,
  status_basis_date: '2026-06-23',
  title:
    'Directing the President, pursuant to section 5(c) of the War Powers Resolution, to remove United States Armed Forces from hostilities with Iran.',
};

/** H.R. 2388: the Senate's own passage, the latest step. */
const HR_SENATE_PASSED = 'Passed Senate without amendment by Unanimous Consent. (consideration: CR S5020)';

const today = () => new Date().toISOString().slice(0, 10);

test.describe('H.Con.Res. 86 · agreed to by both chambers, so its path has ended', () => {
  test('the reader names the chamber whose agreement completed it', () => {
    expect(concurrentAdoptedBy(HCONRES_86)).toBe('senate');
  });

  test('the Big Questions line says both chambers agreed, and it is terminal (so its card offers no call)', () => {
    expect(billStatusLine(HCONRES_86)).toMatchObject({ key: 'bothAgreed', terminal: true });
  });

  test('the MCP envelope calls it settled and quotes the Senate\'s own sentence (so get_bill carries no act_url)', () => {
    expect(decisionState(HCONRES_86)).toEqual({ state: 'settled', reason: SENATE_AGREED });
  });

  test('the ladder treats it as finished even the day after — never "Just passed a chamber" in Moving', () => {
    const fresh = { ...HCONRES_86, last_action_date: today() };
    expect(docketRung(fresh, null)).toMatchObject({ tier: 't4', terminal: true, annotation: null });
    expect(docketRung(HCONRES_86, null)).toMatchObject({ tier: 't4', terminal: true });
  });

  test('no chamber is routed as the live call, and the stepper still names no next step', () => {
    expect(passageStateMjs(HCONRES_86)).toEqual({ stage: 'second', passedBy: 'senate', next: null });
    expect(liveCallTarget(HCONRES_86)).toBeNull();
    // The stepper's ending is the one a concurrent resolution has.
    expect(journeyEnding('hconres')).toBe('bothChambers');
    expect(deriveJourney(HCONRES_86).showTrailer).toBe(false);
  });

  /*
   * THE DAY BEFORE THE MESSAGE. With the Senate's own sentence as the latest
   * step (H.Con.Res. 86's, 2026-06-23), passageState did not read it and fell
   * to the 'first' default: "it passed the House and now goes to the Senate",
   * with the call routed to the senators who had just voted.
   */
  test('the Senate\'s own sentence as the LATEST step reads the same way — no call routed to the Senate', () => {
    const dayOf = { bill_type: 'hconres', status: 'passed_chamber' as const, last_action_text: SENATE_AGREED, last_action_date: today() };
    expect(passageStateMjs(dayOf)).toEqual({ stage: 'second', passedBy: 'senate', next: null });
    expect(liveCallTarget(dayOf)).toBeNull();
    expect(concurrentAdoptedBy(dayOf)).toBe('senate');
    expect(billStatusLine(dayOf)).toMatchObject({ key: 'bothAgreed', terminal: true });
    expect(decisionState(dayOf).state).toBe('settled');
  });

  test('the "Passed Senate …" form of the same agreement reads the same way (not in the corpus; the mjs line it replaced read it)', () => {
    const b = { bill_type: 'hconres', status: 'passed_chamber' as const, last_action_text: 'Passed Senate without amendment by Yea-Nay Vote. 50 - 48.' };
    expect(concurrentAdoptedBy(b)).toBe('senate');
    expect(billStatusLine(b)).toMatchObject({ key: 'bothAgreed', terminal: true });
  });
});

test.describe('a bill passed by the second chamber without amendment still goes to the President', () => {
  const hr = { bill_type: 'hr', status: 'passed_chamber' as const, last_action_text: HR_SENATE_PASSED, last_action_date: '2026-09-24' };
  /** H.R. 4467 as committed: the message over the Senate's passage. */
  const hrMessaged = {
    bill_type: 'hr',
    status: 'passed_chamber' as const,
    last_action_date: '2026-09-24',
    last_action_text: MESSAGE,
    status_basis_text: 'Passed Senate without amendment by Unanimous Consent. (consideration: CR S4882)',
    status_basis_date: '2026-09-24',
  };

  for (const [name, b] of [
    ['the Senate\'s passage as the latest step (H.R. 2388)', hr],
    ['the message over it, read from the stored basis (H.R. 4467)', hrMessaged],
  ] as const) {
    test(name, () => {
      expect(concurrentAdoptedBy(b)).toBeNull();
      expect(passageStateMjs(b)).toEqual({ stage: 'both', passedBy: 'senate', next: null });
      const j = deriveJourney(b);
      expect(j).toMatchObject({ step: 4, ending: 'president', nowKey: 'nowPassedBoth', showTrailer: false });
      // A signature is still ahead: not settled, and the Big Questions line is
      // not terminal.
      expect(decisionState(b)).toEqual({ state: 'pending', reason: null });
      expect(billStatusLine(b)).toMatchObject({ key: 'bothAgreed', terminal: false });
      expect(docketRung({ ...b, last_action_date: today() }, null)).toMatchObject({ tier: 't3', terminal: false });
    });
  }

  test('a joint resolution the same way — the President, never the end of the path', () => {
    const sjres = { bill_type: 'sjres', status: 'passed_chamber' as const, last_action_text: 'Passed House without amendment by Voice Vote.' };
    const hjres = { bill_type: 'hjres', status: 'passed_chamber' as const, last_action_text: 'Passed Senate without amendment by Yea-Nay Vote. 51 - 47.' };
    for (const b of [sjres, hjres]) {
      expect(concurrentAdoptedBy(b)).toBeNull();
      expect(passageStateMjs(b).stage).toBe('both');
      expect(decisionState(b).state).toBe('pending');
    }
  });

  test('the Senate\'s "Resolution agreed to in …" sentence never turns a bill into a finished resolution', () => {
    expect(concurrentAdoptedBy({ bill_type: 'hr', status: 'passed_chamber', last_action_text: SENATE_AGREED })).toBeNull();
    expect(concurrentAdoptedBy({ bill_type: 'hjres', status: 'passed_chamber', last_action_text: SENATE_AGREED })).toBeNull();
  });
});

test.describe('FAIL-CLOSED · a concurrent resolution the record does not show agreed in one form', () => {
  test('the originating chamber\'s own agreement is only the first half', () => {
    const b = { bill_type: 'sconres', status: 'passed_chamber' as const, last_action_text: 'Resolution agreed to in Senate without amendment by Unanimous Consent.' };
    expect(concurrentAdoptedBy(b)).toBeNull();
    expect(passageStateMjs(b)).toEqual({ stage: 'first', passedBy: 'senate', next: 'house' });
    expect(decisionState(b).state).toBe('pending');
  });

  test('agreed to WITH an amendment goes back to the originating chamber', () => {
    const b = { bill_type: 'hconres', status: 'passed_chamber' as const, last_action_text: 'Resolution agreed to in Senate with an amendment by Unanimous Consent.' };
    expect(concurrentAdoptedBy(b)).toBeNull();
    expect(passageStateMjs(b)).toEqual({ stage: 'back', passedBy: 'senate', next: 'house' });
    expect(decisionState(b).state).toBe('pending');
  });

  test('S.Con.Res. 29: the House\'s sentence names no amendment clause at all, so it is not read (stated gap)', () => {
    const sconres29 = {
      bill_type: 'sconres',
      status: 'passed_chamber' as const,
      last_action_date: '2026-04-20',
      last_action_text: 'Motion to reconsider laid on the table Agreed to without objection.',
      status_basis_text: 'Passed/agreed to in House: On agreeing to the resolution Agreed to without objection. (text: CR H2982)',
    };
    expect(concurrentAdoptedBy(sconres29)).toBeNull();
    expect(passageStateMjs(sconres29)).toEqual({ stage: 'second', passedBy: 'house', next: null });
    expect(decisionState(sconres29).state).toBe('pending');
  });

  test('the bare message, with no stored basis, says nothing about amendment', () => {
    const b = { bill_type: 'hconres', status: 'passed_chamber' as const, last_action_text: MESSAGE };
    expect(concurrentAdoptedBy(b)).toBeNull();
    expect(billStatusLine(b).key).toBe('recordStep');
  });

  test('a defeat is not an agreement, and a status the passage branch never sees is not read', () => {
    expect(
      concurrentAdoptedBy({ bill_type: 'hconres', status: 'floor_vote', last_action_text: 'Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.' })
    ).toBeNull();
    expect(concurrentAdoptedBy({ ...HCONRES_86, status: 'committee' })).toBeNull();
    expect(concurrentAdoptedBy({ ...HCONRES_86, bill_type: undefined })).toBeNull();
    expect(concurrentAdoptedBy(null)).toBeNull();
  });
});

test.describe('corpus · the reader never contradicts the stepper, the rail or the other readers', () => {
  type Rec = {
    bill_type: string;
    bill_number: number;
    congress_number: number;
    status: string;
    last_action_text: string | null;
    last_action_date: string | null;
    status_basis_text?: string | null;
  };
  const corpus = bills as unknown as Rec[];
  const adopted = corpus.filter((b) => concurrentAdoptedBy(b));

  test('every record it reads is a concurrent resolution the stepper already calls past both chambers, with no call routed', () => {
    for (const b of adopted) {
      const slug = `${b.bill_type}-${b.bill_number}-${b.congress_number}`;
      expect(['hconres', 'sconres'], slug).toContain(b.bill_type);
      const ps = passageStateMjs(b as never);
      expect(ps, slug).toEqual({ stage: 'second', passedBy: concurrentAdoptedBy(b), next: null });
      expect(liveCallTarget(b as never), slug).toBeNull();
      expect(decisionState(b).state, slug).toBe('settled');
      expect(billStatusLine(b as never), slug).toMatchObject({ key: 'bothAgreed', terminal: true });
      expect(docketRung(b, null), slug).toMatchObject({ terminal: true });
    }
  });

  test('H.Con.Res. 86 is read while it is in the corpus', () => {
    const rec = corpus.find((b) => b.bill_type === 'hconres' && b.bill_number === 86 && b.congress_number === 119);
    test.skip(!rec, 'hconres-86-119 is no longer in the corpus');
    expect(concurrentAdoptedBy(rec)).toBe('senate');
  });

  test('no bill or joint resolution the second chamber passed without amendment is read as finished', () => {
    for (const b of corpus.filter((x) => x.status === 'passed_chamber' && !/conres$/.test(x.bill_type))) {
      expect(concurrentAdoptedBy(b), `${b.bill_type}-${b.bill_number}`).toBeNull();
    }
  });
});
