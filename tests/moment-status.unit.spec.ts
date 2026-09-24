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
import { journeyEnding, passageState } from '../lib/journey';
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
    ['vetoed', bill('hr', 'vetoed', 'Vetoed by President.'), { key: 'vetoed', terminal: true }],
    ['presented to the President', bill('hr', 'passed_chamber', 'Presented to President.'), { key: 'presented', terminal: false }],
    ['failed, reconsider pending (Tillis form)', bill('hr', 'floor_vote', TILLIS), { key: 'failedReconsider', chamber: 'senate', terminal: false }],
    ['failed, reconsider pending (Schumer form)', bill('s', 'floor_vote', SCHUMER), { key: 'failedReconsider', chamber: 'senate' }],
    [
      'failed: motion to proceed rejected',
      bill('sjres', 'floor_vote', 'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50. Record Vote Number: 192. (CR S3194)'),
      { key: 'failed', chamber: 'senate', terminal: true },
    ],
    [
      'failed: discharge rejected',
      bill('sjres', 'floor_vote', 'Motion to discharge Senate Committee on Foreign Relations rejected by Yea-Nay Vote. 47 - 48. Record Vote Number: 174.'),
      { key: 'failed', chamber: 'senate', terminal: true },
    ],
    [
      'failed: House suspension vote',
      bill('s', 'floor_vote', 'On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: (2/3 required): 264 - 133 (Roll no. 72).'),
      { key: 'failed', chamber: 'house', terminal: true },
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

test.describe('question level: most advanced live vehicle, else explainer mode', () => {
  const failed = billStatusLine(bill('sjres', 'floor_vote', 'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50.', '2026-06-24'), NOW);
  const waiting = billStatusLine(bill('hconres', 'passed_chamber', 'Received in the Senate and referred to the Committee on Foreign Relations.', '2026-07-23'), NOW);
  const committee = billStatusLine(bill('hr', 'committee', 'Referred to the House Committee on Foreign Affairs.', '2026-09-01'), NOW);
  const signed = billStatusLine(bill('hr', 'signed', 'Became Public Law No: 119-103.', '2026-09-02'), NOW);

  test('leads with the most advanced LIVE vehicle, even over a newer, less advanced one', () => {
    expect(questionStatus([failed, committee, waiting])).toEqual({ mode: 'live', lead: waiting });
  });
  test('a terminal vehicle never leads while any vehicle is live', () => {
    expect(questionStatus([signed, committee]).lead).toBe(committee);
  });
  test('every vehicle terminal → explainer mode, led by the most recent', () => {
    expect(questionStatus([failed, signed])).toEqual({ mode: 'explainer', lead: signed });
  });
  test('no resolved vehicle → no line at all', () => {
    expect(questionStatus([])).toEqual({ mode: 'live', lead: null });
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
