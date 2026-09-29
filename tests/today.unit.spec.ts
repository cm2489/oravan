import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { getBill, getTeasers, teaserFor } from '../lib/core/bills';
import {
  briefDays,
  briefWindow,
  buildBrief,
  dayCountParts,
  dayHasRecord,
  floorTagFor,
  latestRecordDay,
  shiftDate,
  yellowTagFirst,
  type BriefDaySummary,
} from '../lib/today';

/*
 * /today's DAY LIST AND QUIET LINE (wireframes v2, today.html, 2026-09-29).
 *
 * "Other days" prints each dated permalink with its counts, and a brief whose
 * two days are both empty links to the latest day with record. Both are
 * derived in lib/today.ts; these tests pin that every count is the length of
 * a block the linked day's own page prints — never more, never less — and
 * that the quiet line's way out always lands on a day that has something.
 * Where they read the committed data they derive from it, so they track the
 * data rather than pin a day that will scroll out of the window.
 */

const s = (date: string, votes: number, bills: number, questions = 0): BriefDaySummary => ({
  date,
  votes,
  bills,
  questions,
});

test.describe('dayCountParts: what a row prints', () => {
  test('votes, then bills, each only when there is one', () => {
    expect(dayCountParts(s('2026-09-24', 3, 18))).toEqual([
      { key: 'dayCountVotes', count: 3 },
      { key: 'dayCountBills', count: 18 },
    ]);
    expect(dayCountParts(s('2026-09-25', 0, 6))).toEqual([{ key: 'dayCountBills', count: 6 }]);
    expect(dayCountParts(s('2026-09-28', 6, 0))).toEqual([{ key: 'dayCountVotes', count: 6 }]);
  });

  test('a day with nothing prints no parts, so the row says it has no record', () => {
    expect(dayCountParts(s('2026-09-27', 0, 0))).toEqual([]);
    expect(dayHasRecord(s('2026-09-27', 0, 0))).toBe(false);
  });

  test('a Big Question moved with no bill on file is still counted, never "no record"', () => {
    // Only a nomination vehicle can do this; the row must not call that day empty.
    expect(dayCountParts(s('2026-09-21', 0, 0, 1))).toEqual([{ key: 'dayCountQuestions', count: 1 }]);
    expect(dayHasRecord(s('2026-09-21', 0, 0, 1))).toBe(true);
    // With votes or bills on the row, those are the counts it prints.
    expect(dayCountParts(s('2026-09-24', 3, 0, 2))).toEqual([{ key: 'dayCountVotes', count: 3 }]);
  });
});

test.describe('the row words, in both languages', () => {
  for (const [locale, messages, expected] of [
    ['en', en, { v1: '1 vote', v3: '3 votes', b1: '1 bill', b18: '18 bills', q1: '1 Big Question', none: 'no record' }],
    ['es', es, { v1: '1 votación', v3: '3 votaciones', b1: '1 proyecto', b18: '18 proyectos', q1: '1 Gran pregunta', none: 'sin registro' }],
  ] as const) {
    test(`${locale}: plural forms and the empty word`, () => {
      const t = createTranslator({ locale, messages, namespace: 'today' });
      expect(t('dayCountVotes', { count: 1 })).toBe(expected.v1);
      expect(t('dayCountVotes', { count: 3 })).toBe(expected.v3);
      expect(t('dayCountBills', { count: 1 })).toBe(expected.b1);
      expect(t('dayCountBills', { count: 18 })).toBe(expected.b18);
      expect(t('dayCountQuestions', { count: 1 })).toBe(expected.q1);
      expect(t('dayNoRecord')).toBe(expected.none);
    });
  }
});

test.describe('latestRecordDay: the quiet line never dead-ends', () => {
  const days = [
    s('2026-09-28', 0, 0),
    s('2026-09-27', 0, 0),
    s('2026-09-26', 0, 0),
    s('2026-09-25', 0, 6),
    s('2026-09-24', 3, 18),
  ];

  test('on today, the newest older day with record (Monday Sep 28 → Friday Sep 25)', () => {
    expect(latestRecordDay(days, ['2026-09-28', '2026-09-27'])).toBe('2026-09-25');
  });

  test('on a past page, the newest day in the whole window, even when newer than the page', () => {
    const withNewer = [s('2026-09-29', 0, 0), s('2026-09-28', 6, 0), ...days.slice(1)];
    expect(latestRecordDay(withNewer, ['2026-09-27', '2026-09-26'])).toBe('2026-09-28');
  });

  test('null when no other day in the window has any record', () => {
    expect(latestRecordDay(days.slice(0, 3), ['2026-09-28', '2026-09-27'])).toBeNull();
  });
});

test.describe('the decided order, in the renderer', () => {
  // tests/today.spec.ts checks the order on the rendered page, but the floor
  // schedule block only renders while an announcement is still ahead, which
  // the committed data often does not hold. This pins the order of the
  // renderer's own sibling blocks, which is the order the page prints them in.
  test('chambers, then the floor schedule, then the record, then the Big Questions; the day list and stamps last', () => {
    const src = readFileSync(join(process.cwd(), 'components/TodayBrief.tsx'), 'utf8');
    const at = (needle: string) => {
      const i = src.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      'aria-labelledby="today-chambers"',
      'aria-labelledby="today-schedule"',
      'data-day={d.date}',
      'data-record-empty=""',
      'aria-labelledby="today-questions"',
      'aria-labelledby="today-days"',
      'data-stamps',
    ].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

test.describe('against the committed data', () => {
  const window = briefWindow();
  const summaries = briefDays();

  test('one summary per permalink, newest first', () => {
    expect(summaries.map((x) => x.date)).toEqual(window);
  });

  test("each row's counts are the lengths of the blocks that day's page prints", () => {
    for (const summary of summaries) {
      const day = buildBrief(summary.date).days[0];
      expect(day.date).toBe(summary.date);
      expect(summary.votes, `${summary.date} votes`).toBe(day.rollCalls.length);
      expect(summary.bills, `${summary.date} bills`).toBe(day.moved.length + day.movedMore);
    }
  });

  test('every brief carries the whole window, and a quiet brief points at a day with record', () => {
    for (const date of window) {
      const brief = buildBrief(date);
      expect(brief.window).toEqual(summaries);
      const own = [date, shiftDate(date, -1)];
      if (brief.latestRecord === null) {
        // Nothing else in the window has a record at all.
        expect(summaries.filter((x) => !own.includes(x.date)).some(dayHasRecord), date).toBe(false);
        continue;
      }
      expect(own, date).not.toContain(brief.latestRecord);
      const target = summaries.find((x) => x.date === brief.latestRecord)!;
      expect(dayHasRecord(target), `${date} → ${brief.latestRecord}`).toBe(true);
      // The newest such day: nothing newer outside the brief's own two days has a record.
      const newer = summaries.filter((x) => x.date > target.date && !own.includes(x.date));
      expect(newer.some(dayHasRecord), `${date}: a newer day has a record`).toBe(false);
    }
  });
});

/*
 * THE FLOOR-NOTICE TAG (owner, 2026-09-29: "if there is a vote this week
 * scheduled it needs to have a yellow tag or something that explicitly draws
 * attention to it"). Yellow names the chamber's notice and a date, never a
 * vote (page 1, rule 6), and fails closed: the "will vote on" verb, a covers
 * date and a chamber in session, or ink.
 */
test.describe('floorTagFor: which notice wears which tag', () => {
  const COVERS = '2026-09-29';
  const cases = [
    // certainty × chamber/source × covers → expected
    { certainty: 'scheduled_vote', chamber: 'senate', source: 'daily-digest', covers: COVERS, tone: 'urgent', key: 'bill.floor.announcedSenate', dateIso: COVERS, week: false },
    { certainty: 'scheduled_vote', chamber: 'senate', source: 'daily-digest', covers: null, tone: 'status', key: 'bill.floor.announcedSenate', dateIso: null, week: false },
    // The House weekly schedule never uses the verb; if a writer ever stored it, the week still reads in ink.
    { certainty: 'scheduled_vote', chamber: 'house', source: 'billsthisweek', covers: COVERS, tone: 'status', key: 'bill.floor.announcedHouse', dateIso: COVERS, week: true },
    { certainty: 'scheduled_vote', chamber: 'house', source: 'billsthisweek', covers: null, tone: 'status', key: 'bill.floor.announcedHouse', dateIso: null, week: false },
    { certainty: 'consideration', chamber: 'senate', source: 'daily-digest', covers: COVERS, tone: 'status', key: 'bill.floor.announcedSenate', dateIso: COVERS, week: false },
    { certainty: 'consideration', chamber: 'senate', source: 'daily-digest', covers: null, tone: 'status', key: 'bill.floor.announcedSenate', dateIso: null, week: false },
    { certainty: 'consideration', chamber: 'house', source: 'billsthisweek', covers: COVERS, tone: 'status', key: 'bill.floor.announcedHouse', dateIso: COVERS, week: true },
    { certainty: 'consideration', chamber: 'house', source: 'billsthisweek', covers: null, tone: 'status', key: 'bill.floor.announcedHouse', dateIso: null, week: false },
    { certainty: 'conditional', chamber: 'senate', source: 'daily-digest', covers: COVERS, tone: 'status', key: 'today.tagConditional', dateIso: null, week: false },
    { certainty: 'conditional', chamber: 'senate', source: 'daily-digest', covers: null, tone: 'status', key: 'today.tagConditional', dateIso: null, week: false },
    { certainty: 'conditional', chamber: 'house', source: 'billsthisweek', covers: COVERS, tone: 'status', key: 'today.tagConditional', dateIso: null, week: false },
    { certainty: 'conditional', chamber: 'house', source: 'billsthisweek', covers: null, tone: 'status', key: 'today.tagConditional', dateIso: null, week: false },
  ] as const;

  for (const c of cases) {
    test(`${c.certainty} · ${c.chamber} · ${c.covers ? 'with' : 'without'} covers → ${c.tone}`, () => {
      expect(
        floorTagFor({ certainty: c.certainty, chamber: c.chamber, source: c.source, covers: c.covers, session: 'in_session' })
      ).toEqual({ tone: c.tone, key: c.key, dateIso: c.dateIso, week: c.week });
    });
  }

  test('yellow only while the chamber is in session (rule 6: live only while it is meeting)', () => {
    for (const session of ['out_of_session', 'unknown'] as const) {
      const tag = floorTagFor({ certainty: 'scheduled_vote', chamber: 'senate', source: 'daily-digest', covers: COVERS, session });
      expect(tag?.tone, session).toBe('status');
      expect(tag?.dateIso, session).toBe(COVERS);
    }
  });

  test('a malformed covers date prints no date and no yellow', () => {
    const tag = floorTagFor({ certainty: 'scheduled_vote', chamber: 'senate', source: 'daily-digest', covers: 'Tuesday', session: 'in_session' });
    expect(tag).toEqual({ tone: 'status', key: 'bill.floor.announcedSenate', dateIso: null, week: false });
  });

  test('every tag key exists in both languages', () => {
    const get = (m: unknown, key: string) =>
      key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], m);
    for (const c of cases) {
      expect(typeof get(en, c.key), `en ${c.key}`).toBe('string');
      expect(typeof get(es, c.key), `es ${c.key}`).toBe('string');
    }
  });

  test('the committed schedule: each item carries the tag its own fields produce, and none on a past brief', () => {
    const window = briefWindow();
    const brief = buildBrief(window[0]);
    for (const item of brief.schedule) {
      const session = brief.chamber!.chambers.find((c) => c.chamber === item.chamber)!.session;
      expect(item.tag, item.citation).toEqual(
        floorTagFor({ certainty: item.certainty, chamber: item.chamber, source: item.source, covers: item.covers, session })
      );
    }
    for (const date of window.slice(1)) expect(buildBrief(date).schedule, date).toEqual([]);
  });
});

/*
 * THE YELLOW NOTICE LEADS THE BAND (independent check, 2026-09-29: on a phone
 * the yellow tag sat on the third floor card, about two screens down). The
 * tags below come from `floorTagFor` itself, so the order follows the one
 * test that decides yellow.
 */
test.describe('yellowTagFirst: the notice with the yellow tag comes first', () => {
  const COVERS = '2026-09-30';
  const notice = (
    citation: string,
    certainty: 'scheduled_vote' | 'consideration' | 'conditional',
    chamber: 'house' | 'senate' = 'senate'
  ) => ({
    citation,
    tag: floorTagFor({
      certainty,
      chamber,
      source: chamber === 'house' ? 'billsthisweek' : 'daily-digest',
      covers: COVERS,
      session: 'in_session',
    }),
  });
  const order = (items: { citation: string }[]) => items.map((i) => i.citation);

  test('four notices, one yellow in third place: the yellow one first, the rest in their old order', () => {
    const items = [
      notice('H.R. 2709', 'consideration', 'house'),
      notice('S. 3000', 'conditional'),
      notice('S. 3988', 'scheduled_vote'),
      notice('S.J.Res. 197', 'conditional'),
    ];
    expect(items[2].tag?.tone).toBe('urgent');
    expect(items.filter((i) => i.tag?.tone === 'urgent')).toHaveLength(1);
    expect(order(yellowTagFirst(items))).toEqual(['S. 3988', 'H.R. 2709', 'S. 3000', 'S.J.Res. 197']);
  });

  test('no yellow notice: the order is unchanged', () => {
    const items = [
      notice('H.R. 2709', 'consideration', 'house'),
      notice('S. 3000', 'conditional'),
      notice('S. 3988', 'consideration'),
      { citation: 'S. 12', tag: null },
    ];
    expect(items.some((i) => i.tag?.tone === 'urgent')).toBe(false);
    expect(order(yellowTagFirst(items))).toEqual(order(items));
  });

  test('two yellow notices keep their relative order, ahead of the rest', () => {
    const items = [
      notice('H.R. 2709', 'consideration', 'house'),
      notice('S. 3988', 'scheduled_vote'),
      notice('S. 3000', 'conditional'),
      notice('S. 4100', 'scheduled_vote'),
    ];
    expect(order(yellowTagFirst(items))).toEqual(['S. 3988', 'S. 4100', 'H.R. 2709', 'S. 3000']);
  });

  test('the committed schedule is already in this order', () => {
    const schedule = buildBrief(briefWindow()[0]).schedule;
    expect(order(yellowTagFirst(schedule))).toEqual(order(schedule));
  });
});

test.describe('teaserFor: a /today card is the /bills card', () => {
  for (const locale of ['en', 'es']) {
    test(`${locale}: every bill the window's briefs print gets exactly getTeasers' teaser`, () => {
      const all = new Map(getTeasers(locale).map((x) => [x.slug, x]));
      const slugs = new Set<string>();
      for (const date of briefWindow()) {
        const brief = buildBrief(date, locale);
        for (const d of brief.days) {
          for (const r of d.rollCalls) {
            slugs.add(r.bill.slug);
            expect(r.teaser, r.bill.slug).toEqual(all.get(r.bill.slug));
          }
          for (const b of d.moved) {
            slugs.add(b.slug);
            expect(b.teaser, b.slug).toEqual(all.get(b.slug));
          }
        }
        for (const item of brief.schedule.filter((i) => i.kind === 'bill')) {
          const slug = item.href.replace('/bills/', '');
          slugs.add(slug);
          expect(item.teaser, slug).toEqual(all.get(slug));
        }
      }
      expect(slugs.size).toBeGreaterThan(0);
      for (const slug of slugs) expect(teaserFor(getBill(slug)!, locale), slug).toEqual(all.get(slug));
    });
  }
});
