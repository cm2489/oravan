import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import type { RollCall } from '../lib/types';
import type { StatusLine } from '../lib/moment-status.mjs';
import type { QuestionVehicle } from '../lib/moments-ui';
import { getBill } from '../lib/core/bills';
import { siteBillStatusLine } from '../lib/floor-session';
import {
  floorActionDate,
  ifItPasses,
  isPassageVote,
  noChamberHasPassed,
  passageRow,
  pickLeadBill,
  questionGlance,
  votesSoFar,
  type LeadCandidate,
} from '../lib/question-glance';

/*
 * "AT A GLANCE" (components/QuestionGlance.tsx, lib/question-glance.ts).
 * The lead-bill rule and every row's omit rule, on frozen records; then the
 * settled case and the page wiring. Only the last block reads data/, and only
 * to build a settled question out of records that are settled by the record
 * itself, so it cannot turn red as the calendar moves.
 */

/* ---- the lead-bill rule ------------------------------------------------- */

const cand = (slug: string, c: Partial<LeadCandidate> = {}): LeadCandidate => ({
  slug,
  floorDate: null,
  floorActionDate: null,
  actionDate: null,
  ...c,
});

test.describe('pickLeadBill', () => {
  test('a bill on a chamber’s own schedule leads, the nearest date first', () => {
    const lead = pickLeadBill(
      [
        cand('a', { floorActionDate: '2026-11-20', actionDate: '2026-11-21' }),
        cand('b', { floorDate: '2026-11-30' }),
        cand('c', { floorDate: '2026-11-24' }),
      ],
      '2026-11-22'
    );
    expect(lead?.slug).toBe('c');
  });

  test('without a schedule, the newest floor action leads, over a newer committee action', () => {
    const lead = pickLeadBill(
      [
        cand('a', { floorActionDate: '2026-07-30', actionDate: '2026-07-30' }),
        cand('b', { floorActionDate: '2026-09-15', actionDate: '2026-09-15' }),
        cand('c', { actionDate: '2026-11-01' }),
      ],
      '2026-11-22'
    );
    expect(lead?.slug).toBe('b');
  });

  test('with no floor action anywhere, the newest action leads', () => {
    const lead = pickLeadBill(
      [cand('a', { actionDate: '2026-03-01' }), cand('b', { actionDate: '2026-05-01' })],
      '2026-11-22'
    );
    expect(lead?.slug).toBe('b');
  });

  test('ties keep the question’s own order; nothing to go on keeps the first; none is null', () => {
    expect(pickLeadBill([cand('a', { actionDate: '2026-05-01' }), cand('b', { actionDate: '2026-05-01' })], '2026-11-22')?.slug).toBe('a');
    expect(pickLeadBill([cand('a'), cand('b')], '2026-11-22')?.slug).toBe('a');
    expect(pickLeadBill([], '2026-11-22')).toBeNull();
  });

  test('a malformed date is never read as a date', () => {
    const lead = pickLeadBill([cand('a', { floorDate: 'soon' }), cand('b', { floorActionDate: '2026-01-02' })], '2026-11-22');
    expect(lead?.slug).toBe('b');
  });
});

/* ---- frozen records ------------------------------------------------------ */

const roll = (r: Partial<RollCall> & Pick<RollCall, 'chamber' | 'date' | 'question' | 'result'>): RollCall => ({
  id: `${r.chamber[0]}-119-2-${Math.floor(Math.random() * 1e6)}`,
  congress: 119,
  session: 2,
  roll: 1,
  bill: 'x',
  totals: { yea: 60, nay: 40, present: 0, notVoting: 0 },
  source: 'https://example.invalid',
  votes: { yea: [], nay: [], present: [], notVoting: [] },
  ...r,
});

const line = (key: StatusLine['key'], chamber: StatusLine['chamber'] = null): StatusLine => ({
  key,
  chamber,
  passedBy: null,
  law: null,
  date: '2026-09-01',
  text: null,
  terminal: false,
  rank: 1,
});

type GlanceBill = Parameters<typeof ifItPasses>[0];
const bill = (b: Partial<GlanceBill>): GlanceBill => ({
  bill_type: 's',
  status: 'committee',
  last_action_text: 'Read twice and referred to the Committee on Finance.',
  last_action_date: '2026-03-01',
  title: 'A bill to do a thing.',
  ...b,
});

/* ---- Votes so far ---------------------------------------------------------- */

test.describe('Votes so far', () => {
  test('no stored roll call: the row is omitted', () => {
    expect(votesSoFar([])).toBeNull();
  });

  test('counts by chamber, and the newest (the list is newest first) as recorded', () => {
    const v = votesSoFar([
      roll({ chamber: 'senate', date: '2026-09-28', question: 'On Passage of the Bill S. 4668', result: 'Bill Passed', totals: { yea: 77, nay: 22, present: 0, notVoting: 1 } }),
      roll({ chamber: 'senate', date: '2026-09-24', question: 'On the Cloture Motion S. 4668', result: 'Cloture Motion Agreed to' }),
      roll({ chamber: 'house', date: '2026-07-01', question: 'On Passage', result: 'Passed' }),
    ]);
    expect(v).toEqual({
      house: 1,
      senate: 2,
      newest: { chamber: 'senate', date: '2026-09-28', result: 'Bill Passed', yeas: 77, nays: 22 },
    });
  });
});

/* ---- Vote on passage ------------------------------------------------------- */

test.describe('Vote on passage', () => {
  test('reads every passage question shape the roll-call file holds, and nothing procedural', () => {
    for (const q of [
      'On Passage',
      'On Motion to Suspend the Rules and Pass',
      'On Motion to Suspend the Rules and Pass, as Amended',
      'On Agreeing to the Resolution',
      'On Passage of the Bill S. 4668',
      'On the Joint Resolution S.J.Res. 185',
      'On the Concurrent Resolution H.Con.Res. 89',
    ]) {
      expect(isPassageVote({ question: q }), q).toBe(true);
    }
    for (const q of [
      'On Cloture on the Motion to Proceed H.R. 3633',
      'On the Motion to Proceed S.J.Res. 185',
      'On the Cloture Motion S. 4668',
      'On Motion to Recommit',
      'On Motion to Concur in the Senate Amendment',
      'On the Motion to Discharge S.J.Res. 181',
      'On the Amendment S.Amdt. 23 to S. 5',
    ]) {
      expect(isPassageVote({ question: q }), q).toBe(false);
    }
  });

  test('recorded: the newest passage roll call in each chamber, House first', () => {
    const row = passageRow(bill({ bill_type: 'hr', status: 'floor_vote' }), line('failedReconsider', 'senate'), [
      roll({ chamber: 'senate', date: '2026-09-15', question: 'On Cloture on the Motion to Proceed H.R. 3633', result: 'Cloture on the Motion to Proceed Rejected' }),
      roll({ chamber: 'house', date: '2025-07-17', question: 'On Passage', result: 'Passed', totals: { yea: 294, nay: 134, present: 0, notVoting: 0 } }),
    ]);
    expect(row).toEqual({
      kind: 'recorded',
      votes: [{ chamber: 'house', date: '2025-07-17', result: 'Passed', yeas: 294, nays: 134 }],
    });
  });

  test('"Not yet" only when nothing on the record says a chamber passed it', () => {
    expect(passageRow(bill({}), line('inCommittee'), [])).toEqual({ kind: 'notYet' });
    expect(
      passageRow(
        bill({ status: 'floor_vote', last_action_text: 'Motion to discharge Senate Committee on Foreign Relations rejected by Yea-Nay Vote. 49 - 50.' }),
        line('failed', 'senate'),
        [roll({ chamber: 'senate', date: '2026-07-30', question: 'On the Motion to Discharge S.J.Res. 181', result: 'Motion to Discharge Rejected' })]
      )
    ).toEqual({ kind: 'notYet' });
  });

  test('omitted: a passage the roll-call file does not hold (a voice vote, unanimous consent)', () => {
    // Passed by unanimous consent, then held at the other chamber's desk.
    expect(passageRow(bill({ status: 'passed_chamber', last_action_text: 'Held at the desk.' }), line('heldAtDesk', 'house'), [])).toBeNull();
    // The status bucket lags, but the sentence says it passed.
    expect(
      passageRow(bill({ status: 'floor_vote', last_action_text: 'Passed Senate without amendment by Voice Vote.' }), line('recordStep'), [])
    ).toBeNull();
    // The line reports a passage even where the bucket and the words do not.
    expect(passageRow(bill({ status: 'floor_vote' }), line('passedWaiting', 'house'), [])).toBeNull();
  });

  test('a failed passage vote is not a passage', () => {
    const rolls = [roll({ chamber: 'house', date: '2026-02-24', question: 'On Motion to Suspend the Rules and Pass', result: 'Failed' })];
    expect(noChamberHasPassed(bill({ bill_type: 'hr', status: 'floor_vote' }), line('failed', 'house'), rolls)).toBe(true);
    expect(passageRow(bill({ bill_type: 'hr', status: 'floor_vote' }), line('failed', 'house'), rolls)).toEqual({
      kind: 'recorded',
      votes: [{ chamber: 'house', date: '2026-02-24', result: 'Failed', yeas: 60, nays: 40 }],
    });
  });
});

/* ---- If it passes ---------------------------------------------------------- */

test.describe('If it passes', () => {
  test('not yet passed: its own chamber passes it, and it goes to the other', () => {
    expect(ifItPasses(bill({ bill_type: 's', status: 'floor_vote' }), line('onCalendar', 'senate'), [])).toEqual({
      chamber: 'senate',
      step: 'pass',
      then: 'otherChamber',
    });
    expect(ifItPasses(bill({ bill_type: 'hr' }), line('inCommittee'), [])).toEqual({
      chamber: 'house',
      step: 'pass',
      then: 'otherChamber',
    });
  });

  test('passed one chamber: the other, in the same form, then the president — or no president', () => {
    expect(ifItPasses(bill({ bill_type: 's', status: 'passed_chamber', last_action_text: 'Held at the desk.' }), line('heldAtDesk', 'house'), [])).toEqual({
      chamber: 'house',
      step: 'sameForm',
      then: 'president',
    });
    expect(
      ifItPasses(bill({ bill_type: 'hconres', status: 'passed_chamber', last_action_text: 'Received in the Senate.' }), line('passedWaiting', 'senate'), [])
    ).toEqual({ chamber: 'senate', step: 'sameForm', then: 'adopted' });
    expect(
      ifItPasses(
        bill({
          bill_type: 'hjres',
          status: 'passed_chamber',
          last_action_text: 'Received in the Senate.',
          title: 'Proposing an amendment to the Constitution of the United States relative to a thing.',
        }),
        line('passedWaiting', 'senate'),
        []
      )
    ).toEqual({ chamber: 'senate', step: 'sameForm', then: 'states' });
  });

  test('the originating chamber’s passage as a stored roll call, the bucket still on the floor', () => {
    expect(
      ifItPasses(bill({ bill_type: 'hr', status: 'floor_vote', last_action_text: 'Motion by Senator Tillis to reconsider …' }), line('failedReconsider', 'senate'), [
        roll({ chamber: 'house', date: '2025-07-17', question: 'On Passage', result: 'Passed' }),
      ])
    ).toEqual({ chamber: 'senate', step: 'sameForm', then: 'president' });
  });

  test('back with its own chamber: agreeing to the changes is the last step before the president', () => {
    expect(ifItPasses(bill({ bill_type: 'hr', status: 'passed_chamber', last_action_text: 'Passed Senate with an amendment by Voice Vote.' }), line('passedBack', 'house'), [])).toEqual({
      chamber: 'house',
      step: 'concur',
      then: 'president',
    });
  });

  test('omitted wherever the next step does not follow from the type and the stage', () => {
    // A simple resolution has no second chamber.
    expect(ifItPasses(bill({ bill_type: 'hres' }), line('inCommittee'), [])).toBeNull();
    // A line that names a chamber the rule would not.
    expect(ifItPasses(bill({ bill_type: 'hr', status: 'floor_vote' }), line('onCalendar', 'senate'), [])).toBeNull();
    // Both chambers done, or sent to the president, or vetoed.
    expect(ifItPasses(bill({ status: 'passed_chamber', last_action_text: 'Presented to President.' }), line('presented'), [])).toBeNull();
    expect(ifItPasses(bill({ status: 'passed_chamber', last_action_text: 'Message on House action sent to the Senate.' }), line('bothAgreed'), [])).toBeNull();
    expect(ifItPasses(bill({ status: 'vetoed', last_action_text: 'Vetoed by President.' }), line('vetoed'), [])).toBeNull();
    // A passage the record does not place: the record's own words.
    expect(ifItPasses(bill({ status: 'passed_chamber', last_action_text: 'Motion to reconsider laid on the table.' }), line('recordStep'), [])).toBeNull();
    // A law.
    expect(ifItPasses(bill({ status: 'signed', last_action_text: 'Became Public Law No: 119-1.' }), line('signed'), [])).toBeNull();
  });
});

/* ---- floor action ---------------------------------------------------------- */

test('floorActionDate: the newest roll call, or the last action when it is a floor action', () => {
  expect(floorActionDate({ status: 'committee', last_action_date: '2026-05-01' }, line('inCommittee'), [])).toBeNull();
  expect(floorActionDate({ status: 'floor_vote', last_action_date: '2026-05-01' }, line('recordStep'), [])).toBe('2026-05-01');
  expect(
    floorActionDate({ status: 'passed_chamber', last_action_date: '2026-08-10' }, line('heldAtDesk', 'house'), [{ date: '2026-08-01' }])
  ).toBe('2026-08-01');
  expect(floorActionDate({ status: 'passed_chamber', last_action_date: '2026-08-10' }, line('passedOnCalendar', 'house'), [{ date: '2026-08-01' }])).toBe(
    '2026-08-10'
  );
});

/* ---- the strings, both languages ------------------------------------------- */

test('every glance string exists in both languages and formats', () => {
  for (const messages of [en, es]) {
    const t = createTranslator({ locale: messages === en ? 'en' : 'es', messages });
    for (const chamber of ['house', 'senate', 'other']) expect(t('moments.glance.call', { chamber })).not.toMatch(/\{/);
    for (const step of ['pass', 'sameForm', 'concur'] as const) {
      for (const then of ['otherChamber', 'president', 'adopted', 'states']) {
        for (const chamber of ['house', 'senate']) {
          expect(t(`moments.glance.next.${step}`, { chamber, then })).not.toMatch(/\{/);
        }
      }
    }
    expect(t('moments.glance.more', { count: 6 })).toMatch(/6/);
  }
  expect(Object.keys(en.moments.glance).sort()).toEqual(Object.keys(es.moments.glance).sort());
  expect(Object.keys(en.moments.glance.next).sort()).toEqual(Object.keys(es.moments.glance.next).sort());
  // "president" is lowercase (docs/copy-style.md §1) and nothing is forecast.
  expect(JSON.stringify(en.moments.glance)).not.toMatch(/President|expected|likely|will pass/);
});

/* ---- the whole box: settled, and the page wiring --------------------------- */

const vehicle = (slug: string, open: boolean): QuestionVehicle => {
  const b = getBill(slug)!;
  return {
    vehicle: { slug } as QuestionVehicle['vehicle'],
    line: siteBillStatusLine(b),
    group: 'house',
    kind: 'bill',
    ctaKey: open ? 'moments.readCall' : 'moments.readBill',
    open,
  };
};

test.describe('the settled box', () => {
  // H.Con.Res. 89 (rejected by the Senate, 49–50) and H.Con.Res. 86 (adopted
  // by both chambers): each settled by the record itself, so no clock moves it.
  test('every bill finished: the record’s outcome, no "If it passes", no call', () => {
    const vs = [vehicle('hconres-89-119', false), vehicle('hconres-86-119', false)];
    const g = questionGlance(vs, vs[0].line)!;
    expect(g).not.toBeNull();
    expect(g.settled).toBe(true);
    expect(g.slug).toBe('hconres-89-119');
    expect(g.next).toBeNull();
    expect(g.otherBills).toBe(1);
  });

  test('the component draws the call only off a live box (rule 6)', () => {
    const src = readFileSync('components/QuestionGlance.tsx', 'utf8');
    expect(src).toMatch(/const panel = glance\.settled \? null : billCallPanelProps/);
    expect(src).toMatch(/\{panel &&/);
    // The question page's own tests count call panels by this hook; the box
    // must never wear it.
    expect(src).not.toMatch(/data-call-cta/);
  });

  test('an open bill always leads over a finished one', () => {
    const vs = [vehicle('hconres-89-119', false), vehicle('s-4668-119', true)];
    const g = questionGlance(vs, vs[0].line)!;
    expect(g.settled).toBe(false);
    expect(g.slug).toBe('s-4668-119');
  });
});

test('the question page renders the box and lets it stand in for a status line that says the same', () => {
  const src = readFileSync('app/[locale]/questions/[id]/page.tsx', 'utf8');
  expect(src).toMatch(/const glance = questionGlance\(vehicles, lead\)/);
  expect(src).toMatch(/\{lead && glance\?\.line !== lead && \(/);
  expect(src).toMatch(/<QuestionGlance/);
});
