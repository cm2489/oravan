import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { billRail } from '../lib/bill-rail';
import { congressTerm } from '../lib/congress.mjs';
import { getAllBills } from '../lib/core';
import { withSitePolicyForTest } from '../lib/ended-state.mjs';
import { billFloorBand, deriveJourney, statusKeyFor, type Chamber } from '../lib/journey';
import { billStatusLine } from '../lib/moment-status.mjs';
import { sharedNamePagesFrom, sharedNameStanding, type SharedNameStanding } from '../lib/shared-names';
import { encodeNameTables, NAME_ADDRESS_RESERVED, SHORT_ADDRESS_CONGRESS, type ShortTitleFile } from '../lib/short-address';
import { gateNameTables } from '../lib/short-address-build';
import type { ChamberSession } from '../lib/docket';
import type { Bill } from '../lib/types';

/*
 * A LIST ROW NEVER SAYS MORE, OR OTHER, THAN THE BILL'S OWN PAGE (the
 * independent check of #510, Nov 19, 2026; page 1, rule 6).
 *
 * For every bill of the corpus (a superset of every bill any list page can
 * show), and again for every bill on every list page a full fill would build
 * from today's titles, the row (lib/shared-names.ts sharedNameStanding) is
 * checked against the bill page's own readers:
 *   - the status label: lib/journey.ts statusKeyFor (every card, the bill page);
 *   - the "Right now:" sentence: lib/journey.ts deriveJourney's `nowKey`;
 *   - the rail: lib/bill-rail.ts billRail (`ended`), the ended panel;
 *   - the floor tag: lib/journey.ts billFloorBand, the bill page's own gate.
 * Under four states: today's sessions (meeting), both chambers out, the 119th
 * Congress ended (the repo's test switch, withSitePolicyForTest), and the 12
 * bills whose words changed in #523 under each.
 *
 * The data is the committed corpus; the clock is pinned. The property holds
 * for any corpus, so a nightly cannot make it lie; the counts are printed as
 * annotations, not pinned.
 */

const NOW = Date.parse('2026-11-19T15:00:00Z');
const SITTING = { tracked: 119, ended: [] };
const ENDED_119 = { tracked: 119, ended: [{ number: 119, ended: congressTerm(119).end }] };
const MEETING = (): ChamberSession => 'in_session';
const OUT = (): ChamberSession => 'out_of_session';
const slugOf = (b: { bill_type: string; bill_number: number; congress_number: number }) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`;
const BILLS = getAllBills() as Bill[];
const BY_SLUG = new Map(BILLS.map((b) => [slugOf(b), b]));

/** The 12 bills whose status words changed in #523 (the independent check's list). */
const CHANGED_IN_523 = [10167, 1550, 5284, 8352, 4930, 8552, 2400, 5349, 5254, 7834, 8454, 2302].map((n) => `hr-${n}-119`);

/*
 * THE TABLES, written out here and NOT imported from lib/shared-names.ts, so a
 * change there has to be argued against this file. A row's reading must be one
 * the bill page's "Right now:" sentence bears out, and one its status label
 * bears out. `recordStep` (the record's own words) is always true.
 */
const NOW_KEYS: Record<string, string[]> = {
  signed: ['nowSigned'],
  vetoed: ['nowVetoed'],
  presented: ['nowPassedBoth'],
  bothAgreed: ['nowPassedBoth', 'nowAdoptedBoth'],
  passedBack: ['nowPassedBack', 'nowPassedBackStale'],
  passedOnCalendar: ['nowPassed', 'nowPassedStale'],
  heldAtDesk: ['nowPassed', 'nowPassedStale'],
  passedWaiting: ['nowPassed', 'nowPassedStale'],
  onCalendar: ['nowFloor', 'nowFloorStale'],
  onFloor: ['nowFloorActivity', 'nowFloorClotureInvoked'],
  clotureFiled: ['nowFloorActivity', 'nowFloorClotureInvoked'],
  failed: ['nowFloorPassageRejected', 'nowFloorMotionFailed', 'nowFloorSuspensionFailed'],
  failedReconsider: ['nowFloorMotionFailed'],
  inCommittee: ['nowCommittee'],
};
const LABELS: Record<string, string[]> = {
  signed: ['signed'],
  vetoed: ['vetoed'],
  presented: ['passed_both'],
  bothAgreed: ['passed_both', 'adopted'],
  passedBack: ['passed_back_house', 'passed_back_senate'],
  passedOnCalendar: ['passed_chamber'],
  heldAtDesk: ['passed_chamber'],
  passedWaiting: ['passed_chamber'],
  onCalendar: ['floor_vote', 'floor_vote_stale'],
  onFloor: ['floor_activity', 'floor_vote'],
  clotureFiled: ['floor_activity', 'floor_vote'],
  failed: ['rejected', 'floor_activity'],
  failedReconsider: ['floor_activity'],
  inCommittee: ['committee', 'markup'],
};

/** Oravan's own words in an ended row (the label and the line's lead-in), never a present-tense stage. */
const PRESENT_TENSE = /waiting|wait\b|calendar|called up|in session|a vote ahead|moving|esperando|espera\b|calendario|en sesi[oó]n|puede/i;
const TR = { en: createTranslator({ locale: 'en', messages: en }), es: createTranslator({ locale: 'es', messages: es }) };

function oravanWords(row: SharedNameStanding, locale: 'en' | 'es', showsLabel: boolean): string {
  const t = TR[locale];
  const line =
    row.line.key === 'recordStep'
      ? t('moments.status.recordStepLabel')
      : t(`moments.status.line.${row.line.key}` as never, { chamber: row.line.chamber ?? 'other', law: row.line.law ?? 'none' } as never);
  return [line, showsLabel ? t(`bills.status.${row.statusKey}` as never) : ''].join(' ');
}

type Tally = { rows: number; ended: number; recordWords: number; tags: number; beforeLive: number };

/** Every check, for one bill under the policy in force. Returns what it saw. */
function agrees(bill: Bill, sessionOf: (c: Chamber) => ChamberSession, tally: Tally) {
  const row = sharedNameStanding(bill, null, { now: NOW, sessionOf });
  const where = `${slugOf(bill)}: ${row.line.key} / ${row.statusKey}`;
  tally.rows++;
  // The status label is the card's and the bill page's (statusKeyFor), and the ended reading is the rail's.
  expect(row.statusKey, where).toBe(statusKeyFor(bill, NOW));
  expect(row.ended, where).toEqual(billRail(bill).ended);
  // The tag, when there is one, is the bill page's own live band.
  if (row.floor) {
    tally.tags++;
    const band = billFloorBand(bill, null, NOW, sessionOf);
    expect(band && !band.suspended, where).toBe(true);
    expect({ kind: row.floor.kind, chamber: row.floor.chamber, date: row.floor.date }, where).toEqual({ kind: band!.kind, chamber: band!.chamber, date: band!.date });
  }
  if (row.ended) {
    tally.ended++;
    // Ended: the record's own words with their date, no tag; the card prints its label ("Ended" or the outcome).
    expect(row.line.key, where).toBe('recordStep');
    expect(row.line.text ?? null, where).toBe(bill.last_action_text ?? null);
    expect(row.line.date ?? null, where).toBe(bill.last_action_date ?? null);
    expect(row.floor, where).toBeNull();
    const ungated = billStatusLine(bill, NOW).key;
    if (['onCalendar', 'passedWaiting', 'passedOnCalendar', 'heldAtDesk', 'passedBack', 'onFloor', 'clotureFiled', 'inCommittee'].includes(ungated)) tally.beforeLive++;
    for (const locale of ['en', 'es'] as const) expect(oravanWords(row, locale, true), `${where} (${locale})`).not.toMatch(PRESENT_TENSE);
    return;
  }
  if (row.line.key === 'recordStep') {
    tally.recordWords++;
    return;
  }
  expect(NOW_KEYS[row.line.key], `${where}: a reading the table does not know`).toBeDefined();
  expect(NOW_KEYS[row.line.key], `${where} vs Right now: ${deriveJourney(bill, NOW).nowKey}`).toContain(deriveJourney(bill, NOW).nowKey);
  expect(LABELS[row.line.key], `${where} vs the card's label`).toContain(row.statusKey);
}

const fresh = (): Tally => ({ rows: 0, ended: 0, recordWords: 0, tags: 0, beforeLive: 0 });
const note = (label: string, t: Tally) => test.info().annotations.push({ type: label, description: JSON.stringify(t) });

/** The list pages a full fill would build from today's titles: every unread bill tried, then the fill gate, as the build runs it. */
function simulatedPages() {
  const titles = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/short-titles.json'), 'utf8')) as ShortTitleFile;
  const retry: Record<string, unknown> = {};
  for (const b of BILLS) if (!titles[slugOf(b)]) retry[slugOf(b)] = { failures: 1 };
  const order = [SHORT_ADDRESS_CONGRESS];
  const reserved = new Set(NAME_ADDRESS_RESERVED);
  const gated = gateNameTables(encodeNameTables(BILLS, titles, order, reserved), BILLS, titles, retry, order, reserved);
  return sharedNamePagesFrom(BILLS, titles, order, reserved, gated.encoded);
}

test('every bill of the corpus, today (both chambers meeting): the row says nothing the bill page does not', () =>
  withSitePolicyForTest(SITTING, () => {
    const t = fresh();
    for (const b of BILLS) agrees(b, MEETING, t);
    expect(t.rows).toBe(BILLS.length);
    expect(t.ended).toBe(0);
    note('today', t);
  }));

test('every bill of the corpus, both chambers out: the row says nothing the bill page does not, and no tag', () =>
  withSitePolicyForTest(SITTING, () => {
    const t = fresh();
    for (const b of BILLS) agrees(b, OUT, t);
    expect(t.tags).toBe(0);
    note('both chambers out', t);
  }));

test('every bill of the corpus, 119th Congress ended (the test switch): "Ended" or the outcome, with the record’s own dated words; never a present-tense stage', () =>
  withSitePolicyForTest(ENDED_119, () => {
    const t = fresh();
    for (const b of BILLS) agrees(b, MEETING, t);
    for (const b of BILLS) agrees(b, OUT, t);
    expect(t.ended).toBe(t.rows); // every bill of the corpus is the 119th's
    expect(t.beforeLive).toBeGreaterThan(100); // the rows that, before this fix, read as still moving
    note('119 ended', t);
  }));

test('the 12 bills whose words changed in #523, in all three states', () => {
  const found = CHANGED_IN_523.map((s) => BY_SLUG.get(s)).filter((b): b is Bill => !!b);
  expect(found.length).toBeGreaterThanOrEqual(10);
  const t = fresh();
  withSitePolicyForTest(SITTING, () => {
    for (const b of found) agrees(b, MEETING, t);
    for (const b of found) agrees(b, OUT, t);
  });
  withSitePolicyForTest(ENDED_119, () => {
    for (const b of found) agrees(b, MEETING, t);
  });
  note('#523 bills', { ...t, found: found.length } as Tally);
});

test('every bill on every list page a full fill would build from today’s titles, in all three states', () => {
  const pages = simulatedPages();
  expect(pages.length).toBeGreaterThan(10);
  const listed = pages.flatMap((p) => p.bills.map((b) => BY_SLUG.get(b.slug)!));
  expect(listed.every(Boolean)).toBe(true);
  const t = fresh();
  withSitePolicyForTest(SITTING, () => {
    for (const b of listed) agrees(b, MEETING, t);
    for (const b of listed) agrees(b, OUT, t);
  });
  withSitePolicyForTest(ENDED_119, () => {
    for (const b of listed) agrees(b, MEETING, t);
  });
  note('list pages', { ...t, pages: pages.length, listed: listed.length } as Tally);
});

test('the one disagreement of Nov 19, 2026 (H.R. 8035, a RULE failed): the row prints the record’s own words, as the bill page does not say a vote on it failed', () =>
  withSitePolicyForTest(SITTING, () => {
    const hr8035 = {
      bill_type: 'hr',
      bill_number: 8035,
      congress_number: 119,
      status: 'committee',
      last_action_text: 'Rule H. Res. 1175 failed passage of House.',
      last_action_date: '2026-04-17',
    } as unknown as Bill;
    expect(billStatusLine(hr8035, NOW).key).toBe('failed');
    expect(deriveJourney(hr8035, NOW).nowKey).toBe('nowCommittee');
    const row = sharedNameStanding(hr8035, null, { now: NOW, sessionOf: MEETING });
    expect(row.line).toMatchObject({ key: 'recordStep', text: 'Rule H. Res. 1175 failed passage of House.', date: '2026-04-17' });
  }));

test('the page shows the card’s label exactly for an ended bill, and prints the row’s line for every bill', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'app/[locale]/names/[congress]/[name]/page.tsx'), 'utf8');
  expect(page).toContain('<BillCard bill={teaser} showStatus={standing.ended !== null} />');
  expect(page).toContain('<MomentStatusLine line={standing.line} className="mb-3" />');
  // The card's label is statusKeyFor's, the same the row carries.
  const core = fs.readFileSync(path.join(process.cwd(), 'lib/core/bills.ts'), 'utf8');
  expect(core).toMatch(/export function teaserFor[\s\S]{0,2500}statusKey: statusKeyFor\(b\)/);
});
