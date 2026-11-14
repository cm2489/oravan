import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { ENDED_CONGRESSES } from '../lib/congress.mjs';

/*
 * TRIPWIRE: THE ENDED NOTE NAMES ONE CONGRESS (2026-11-14).
 *
 * The note an unfinished bill of an ended Congress shows is written for the
 * 119th Congress only, date included, in both languages:
 *   messages/en.json  bill.ended.note  "This bill ended with the 119th Congress on January 3, 2027, ..."
 *   messages/es.json  bill.ended.note  "Este proyecto de ley terminó con el Congreso 119 el 3 de enero de 2027, ..."
 * and tests/ended-state.unit.spec.ts pins that wording word for word (the
 * owner approved it). That is right in January 2027, when the 119th is the
 * only ended Congress. From January 2029, when the 120th ends too, an
 * unfinished 120th bill would say it "ended with the 119th Congress on
 * January 3, 2027". Nothing is wrong today.
 *
 * So this test fails, with the message below, the moment lib/congress.mjs's
 * ENDED_CONGRESSES holds any Congress other than the 119th. The fix is not to
 * edit this test: before a second Congress ends, the note must take the
 * Congress and its end date as values ({congress}, {date}) in both files, and
 * the page must pass the bill's own Congress. Its three sibling keys
 * (bill.ended.statusLong, bill.ended.lawLine, bill.ended.presented) name the
 * 119th the same way and move with it. docs/runbooks/new-congress-switch.md
 * says the same under "Before a second Congress ends".
 */

test('the ended note is written for the 119th Congress only: no other Congress may be on the ended list yet', () => {
  const others = ENDED_CONGRESSES.map((c: { number: number }) => c.number).filter((n: number) => n !== 119);
  expect(
    others,
    `lib/congress.mjs lists Congress ${others.join(', ')} as ended, but the ended note in messages/en.json ` +
      '(bill.ended.note) and messages/es.json (bill.ended.note) names the 119th Congress and January 3, 2027 ' +
      'word for word, so a bill of that Congress would be told it ended with the 119th. Before a second Congress ' +
      'ends, the note must take the Congress and its end date as values ({congress}, {date}) in both files ' +
      '(bill.ended.statusLong, bill.ended.lawLine and bill.ended.presented name the 119th too), and ' +
      'tests/ended-state.unit.spec.ts must pin the new wording. See docs/runbooks/new-congress-switch.md, ' +
      '"Before a second Congress ends".',
  ).toEqual([]);
});

test('the tripwire is aimed at the text it guards: the note still names the 119th and its end date', () => {
  // If the note already takes values, this tripwire has done its job and
  // should be removed with that change; until then it must still be true.
  expect(en.bill.ended.note).toContain('119th Congress on January 3, 2027');
  expect(es.bill.ended.note).toContain('Congreso 119 el 3 de enero de 2027');
});
