import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import {
  briefDays,
  briefWindow,
  buildBrief,
  dayCountParts,
  dayHasRecord,
  latestRecordDay,
  shiftDate,
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
