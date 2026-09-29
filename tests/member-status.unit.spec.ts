import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { billSlug, getAllBills, getAllLegislators } from '../lib/core';
import { concurrentAdoptedBy } from '../lib/floor-text.mjs';
import { lastFailedVote, settledDecision, statusKeyFor } from '../lib/journey';
import { lawRecord } from '../lib/law-record';
import { STATUS_WORDS, statusWord, type StatusWord } from '../lib/status-word';
import type { Bill } from '../lib/types';
import { allRollCalls, memberVotesByBill, votingMember } from '../lib/votes';

/*
 * THE MEMBER PAGE'S ONE WORD PER BILL (wireframes v2, member.html,
 * 2026-09-29, Claude's ruling 11): every card under "How they voted" carries
 * exactly one word from a CLOSED set of five — Open, Law, Agreed to,
 * Rejected, Vetoed — read from the bill's own record by lib/status-word.ts,
 * never from its type alone.
 *
 * Pinned over EVERY bill any member's record names (every bill a stored roll
 * call is about, reached through lib/votes.ts memberVotesByBill for every
 * member the vote file lists), not over a sample: a word the set cannot give,
 * or two words for one bill, fails here the night the record produces it.
 *
 * And the words must agree with the readers the bill page already runs, so
 * the member page can never call a bill finished that its own page still
 * calls open, or the reverse:
 *   Law       ⇔ statusKeyFor 'signed' ⇔ settledDecision 'law'
 *   Agreed to ⇔ concurrentAdoptedBy    ⇔ statusKeyFor 'adopted'
 *   Rejected  ⇔ settledDecision 'rejected'
 *   Vetoed    ⇔ statusKeyFor 'vetoed'
 *   Open      ⇔ none of the above; and every failed MOTION (the call panel's
 *               "last attempt failed" line, lastFailedVote) is Open.
 */

const bySlug = new Map<string, Bill>(getAllBills().map((b) => [billSlug(b), b]));

/** Every bill in every member's record: each member the vote file lists,
 *  through the member page's own grouping. */
const memberBills = (() => {
  const ids = new Set<string>();
  for (const r of allRollCalls()) {
    for (const list of Object.values(r.votes)) for (const id of list) ids.add(id);
  }
  const bills = new Set<string>();
  for (const id of ids) for (const g of memberVotesByBill(id)) bills.add(g.bill);
  return [...bills].sort();
})();

test('the member records name bills, and every one is in the corpus', () => {
  expect(memberBills.length).toBeGreaterThan(0);
  const missing = memberBills.filter((id) => !bySlug.has(id));
  expect(missing, 'a voted bill the member page could not print a word for').toEqual([]);
});

test('every bill in the member records maps to exactly one word of the closed set', () => {
  const counts = Object.fromEntries(STATUS_WORDS.map((w) => [w, 0])) as Record<StatusWord, number>;
  for (const id of memberBills) {
    const word = statusWord(bySlug.get(id)!);
    // Exactly one: `statusWord` returns a single value, and the value must be
    // one of the five. A sixth word would fail here, not on a page.
    expect(STATUS_WORDS, `${id} → ${word}`).toContain(word);
    expect(
      STATUS_WORDS.filter((w) => w === word),
      id
    ).toHaveLength(1);
    counts[word]++;
  }
  // The set is not decorative: the record gives at least these three today
  // (H.R. 6500 law, H.Con.Res. 89 rejected, H.Con.Res. 86 agreed to).
  expect(counts.law).toBeGreaterThan(0);
  expect(counts.rejected).toBeGreaterThan(0);
  expect(counts.agreed).toBeGreaterThan(0);
  expect(counts.open).toBeGreaterThan(0);
  expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(memberBills.length);
});

test('the words agree with the bill page\'s own readers (statusKeyFor, settledDecision, concurrentAdoptedBy)', () => {
  const now = Date.now();
  for (const id of memberBills) {
    const b = bySlug.get(id)!;
    const word = statusWord(b);
    const key = statusKeyFor(b, now);
    const settled = settledDecision(b);
    expect(word === 'law', `${id}: Law ⇔ signed`).toBe(key === 'signed');
    expect(word === 'law', `${id}: Law ⇔ settledDecision law`).toBe(settled?.kind === 'law');
    expect(word === 'agreed', `${id}: Agreed to ⇔ concurrentAdoptedBy`).toBe(concurrentAdoptedBy(b) !== null);
    expect(word === 'agreed', `${id}: Agreed to ⇔ adopted`).toBe(key === 'adopted');
    expect(word === 'rejected', `${id}: Rejected ⇔ settledDecision rejected`).toBe(settled?.kind === 'rejected');
    expect(word === 'vetoed', `${id}: Vetoed ⇔ vetoed`).toBe(key === 'vetoed');
    // A failed motion to take the measure up, discharge it or end debate
    // leaves the measure pending: Open, the same answer as the call panel.
    if (lastFailedVote(b)) expect(word, `${id}: a failed motion stays Open`).toBe('open');
  }
});

test('the settled measures the wireframe names read as it says', () => {
  const cases: Array<[string, StatusWord]> = [
    ['hconres-86-119', 'agreed'], // House 215–208 Jun 3, Senate "without amendment" 50–48 Jun 23
    ['hconres-89-119', 'rejected'], // "Failed of passage in Senate … 49 - 50", Sep 24
    ['hr-6500-119', 'law'], // "Became Public Law No: 119-103.", Sep 2
  ];
  for (const [id, word] of cases) {
    const b = bySlug.get(id);
    test.skip(!b, `${id} left the corpus`);
    expect(statusWord(b!), id).toBe(word);
  }
});

test('the set reads only the bill types the member records hold (no simple resolution yet)', () => {
  // lib/status-word.ts states the gap: a simple resolution agreed to in its
  // chamber would be "Agreed to", and no reader recognises that ending yet.
  // This fails the day a stored roll call names an H.Res. or S.Res., so the
  // gap is closed on purpose rather than printed as "Open".
  const types = new Set(memberBills.map((id) => bySlug.get(id)!.bill_type.toLowerCase()));
  for (const type of types) expect(['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres']).toContain(type);
});

test('"Became law …": the record\'s own date and Public Law number, on laws only', () => {
  for (const id of memberBills) {
    const b = bySlug.get(id)!;
    const law = lawRecord(b);
    if (statusWord(b) !== 'law') {
      expect(law, id).toBeNull();
      continue;
    }
    expect(law, id).not.toBeNull();
    expect(law!.date, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    if (law!.number !== null) expect(law!.number, id).toMatch(/^\d+-\d+$/);
  }
  const cr = bySlug.get('hr-6500-119');
  test.skip(!cr, 'hr-6500-119 left the corpus');
  expect(lawRecord(cr!)).toEqual({ date: '2026-09-02', number: '119-103' });
});

test('each word has a label in both languages, and the set is exactly five', () => {
  for (const w of STATUS_WORDS) {
    expect(en.bills.statusWord[w], w).toBeTruthy();
    expect(es.bills.statusWord[w], w).toBeTruthy();
  }
  expect(en.bills.statusWord.agreed).toBe('Agreed to');
  expect(Object.keys(en.bills.statusWord).sort()).toEqual([...STATUS_WORDS].sort());
  expect(Object.keys(es.bills.statusWord).sort()).toEqual([...STATUS_WORDS].sort());
});

test('a senator\'s record and a House member\'s record are both covered', () => {
  // The two member kinds the page serves, so neither chamber's bills can fall
  // out of the sweep above unnoticed.
  const senator = getAllLegislators().find((l) => l.type === 'sen' && memberVotesByBill(l.bioguide).length > 0);
  const house = getAllLegislators().find((l) => l.type === 'rep' && memberVotesByBill(l.bioguide).length > 0);
  expect(senator && votingMember(senator.bioguide)?.chamber).toBe('senate');
  expect(house && votingMember(house.bioguide)?.chamber).toBe('house');
});
