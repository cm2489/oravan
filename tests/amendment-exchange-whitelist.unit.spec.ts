import { expect, test } from '@playwright/test';
import { deriveJourney, passageState, statusKeyFor } from '../lib/journey';
import {
  FINAL_AGREEMENT,
  agreedToOtherChamberAmendment,
  normaliseAction,
  presentedToPresident,
  recordStatus,
  stripActionFrame,
} from '../lib/floor-text.mjs';
import { decisionState, floorAnsweredChamber } from '../lib/docket.mjs';
import { mapStatus } from '../scripts/congress-fetch.mjs';
import type { BillStatus } from '../lib/types';
import { SENTENCES, type Reading, type Sentence } from './amendment-exchange-sentences';
import { fixClock } from './fixed-clock';

/*
 * FINAL BY WHOLE-SENTENCE WHITELIST ONLY (re-check of #523, round 6).
 *
 * A record sentence is read as a final agreement to the other chamber's
 * amendment — both chambers hold one text, the President is next — only when,
 * normalised and with its one known label and one citation taken off, it is
 * one of the complete sentences in lib/floor-text.mjs FINAL_AGREEMENT, each
 * of which the record has actually held. Everything else reads exactly as
 * origin/main reads it. Four parts:
 *   (a) every whitelisted shape, with its real example: final;
 *   (b) every sentence the re-checks used (tests/amendment-exchange-sentences.ts):
 *       the reading the branch must give;
 *   (c) a generator: each real example, edited at least 25 ways, is never
 *       final unless the edit only changed what normalising removes;
 *   (d) main parity: no sentence reads worse than on main.
 */

const NOW = Date.parse('2026-11-18T18:00:00Z');
const TEST_CONGRESS = 9_119;
// Every reading here is taken at NOW, never at today (round 7): the
// functions that take a clock are handed NOW, and the clock is fixed for the
// rest.
fixClock(NOW);

/** The record a sentence stands in, exactly as the main readings were taken.
 *  `number` is the bill's own number (a sentence that names its bill must
 *  name this one); 1 where the sentence names none. */
const asBill = (type: string, text: string, number: number = 1) => ({
  bill_type: type,
  bill_number: number,
  status: mapStatus(text) as BillStatus,
  last_action_text: text,
  status_basis_text: null,
  last_action_date: '2026-11-17',
  congress_number: TEST_CONGRESS,
  title: 'A bill.',
});

/** The same seven readings tests/amendment-exchange-sentences.ts holds for main. */
function readingOf(type: string, text: string, number: number = 1): Reading {
  const b = asBill(type, text, number);
  const p = passageState(b);
  return [
    b.status,
    statusKeyFor(b, NOW),
    `${p.stage}/${p.passedBy}/${p.next}`,
    floorAnsweredChamber(text, b),
    deriveJourney(b, NOW).nowKey,
    decisionState(b).state,
    statusKeyFor({ ...b, status: 'committee' as BillStatus }, NOW),
  ];
}

/* ------------------------------------------------------------------ *
 * (a) THE WHITELIST, EACH SHAPE WITH THE REAL RECORD IT CAME FROM.
 * Copied from data/bills.json and its git history; the commit is the
 * first data commit that holds the sentence.
 * ------------------------------------------------------------------ */
const REAL: { text: string; type: string; number: number; chamber: 'house' | 'senate'; record: string }[] = [
  {
    text: 'On motion that the House suspend the rules and agree to the Senate amendment Agreed to by voice vote.',
    type: 'hr',
    number: 2400,
    chamber: 'house',
    record: 'H.R. 2400 (119th), status basis of 2026-11-17, data commit e0777202 (2026-11-18)',
  },
  {
    text: 'On motion that the House suspend the rules and agree to the Senate amendment Agreed to by voice vote. (text: CR H6247-6248)',
    type: 'hr',
    number: 2400,
    chamber: 'house',
    record: 'H.R. 2400 (119th), data commit 2b2d1d2c (2026-11-18)',
  },
  {
    text: 'Senate agreed to the House amendment to S. 240 by Unanimous Consent.',
    type: 's',
    number: 240,
    chamber: 'senate',
    record: 'S. 240 (119th), last action of 2026-09-24, data commit bb7dd84b (2026-09-25)',
  },
  {
    text: 'Senate agreed to the House amendment to S. 240 by Unanimous Consent. (consideration: CR S5020)',
    type: 's',
    number: 240,
    chamber: 'senate',
    record: 'S. 240 (119th), data commit 5e446a64 (2026-09-26)',
  },
  {
    text: 'Senate agreed to the House amendment to S. 283 by Unanimous Consent. (consideration: CR S5020)',
    type: 's',
    number: 283,
    chamber: 'senate',
    record: 'S. 283 (119th), last action of 2026-09-24, data commit 5e446a64 (2026-09-26)',
  },
];
const PRESENTED_REAL = 'Presented to President.'; // H.R. 10167, H.R. 1550, H.R. 5284, H.R. 8352 (2026-11-12)

test.describe('(a) the whitelist: every shape has a real example, and it reads final', () => {
  test('the whitelist holds exactly the shapes the real examples show', () => {
    expect(FINAL_AGREEMENT.map((s) => s.chamber)).toEqual(['house', 'senate']);
    for (const shape of FINAL_AGREEMENT) {
      const examples = REAL.filter((r) => shape.shape.test(stripActionFrame(r.text).body));
      expect(examples.length, `${shape.record}: a real example`).toBeGreaterThan(0);
      // Anchored at both ends and case-sensitive.
      expect(shape.shape.source.startsWith('^') && shape.shape.source.endsWith('$')).toBe(true);
      expect(shape.shape.flags).toBe('');
    }
  });
  for (const r of REAL) {
    test(`${r.record}: ${r.text}`, () => {
      const b = asBill(r.type, r.text, r.number);
      expect(agreedToOtherChamberAmendment(r.text, b)).toBe(r.chamber);
      // The nightly mapping reads action text alone. The House sentence names
      // no bill, so it maps to passed_chamber; the Senate one names its bill
      // and the mapping has none to check it against, so it stays at main's
      // `committee` and recordStatus, which has the bill, reads it at display.
      expect(b.status).toBe(r.chamber === 'house' ? 'passed_chamber' : 'committee');
      expect(recordStatus(b)).toBe('passed_chamber');
      expect(statusKeyFor(b, NOW)).toBe('passed_both');
      expect(passageState(b)).toEqual({ stage: 'both', passedBy: r.chamber, next: null });
      expect(floorAnsweredChamber(r.text, b)).toBe('both');
      expect(deriveJourney(b, NOW).nowKey).toBe('nowPassedBoth');
      // Stored at `committee` before the fix (H.R. 2400), it reads the same.
      expect(recordStatus({ ...b, status: 'committee' })).toBe('passed_chamber');
    });
  }
  test('presentment: the whole normalised sentence is "Presented to President."', () => {
    const b = asBill('hr', PRESENTED_REAL);
    expect(presentedToPresident(b)).toBe(true);
    expect(passageState(b)).toEqual({ stage: 'both', passedBy: null, next: null });
    expect(presentedToPresident(asBill('hconres', PRESENTED_REAL))).toBe(false);
    // Either sentence the record keeps can say it: the latest action, or the
    // status basis read under a later notice.
    expect(
      presentedToPresident({ bill_type: 'hr', last_action_text: PRESENTED_REAL, status_basis_text: 'Passed Senate without amendment by Unanimous Consent.' })
    ).toBe(true);
    expect(
      presentedToPresident({ bill_type: 'hr', last_action_text: 'Motion to reconsider laid on the table Agreed to without objection.', status_basis_text: PRESENTED_REAL })
    ).toBe(true);
    expect(presentedToPresident({ bill_type: 'hr', last_action_text: '', status_basis_text: null })).toBe(false);
    expect(agreedToOtherChamberAmendment('')).toBeNull();
    expect(agreedToOtherChamberAmendment(null)).toBeNull();
  });
  test('the leading label counts only when it names the chamber that acted', () => {
    const s240 = { bill_type: 's', bill_number: 240 };
    expect(agreedToOtherChamberAmendment(`Resolving differences -- House actions: ${REAL[0].text}`)).toBe('house');
    expect(agreedToOtherChamberAmendment(`Resolving differences -- Senate actions: ${REAL[2].text}`, s240)).toBe('senate');
    expect(agreedToOtherChamberAmendment(`Resolving differences -- Senate actions: ${REAL[0].text}`)).toBeNull();
    expect(agreedToOtherChamberAmendment(`Resolving differences -- House actions: ${REAL[2].text}`, s240)).toBeNull();
  });
  test('a sentence that names its bill reads final only on that bill (round 7)', () => {
    const t = REAL[2].text; // "… to S. 240 …"
    expect(agreedToOtherChamberAmendment(t, { bill_type: 's', bill_number: 240 })).toBe('senate');
    expect(agreedToOtherChamberAmendment(t, { bill_type: 's', bill_number: '240' })).toBe('senate');
    // The same number, another type.
    for (const type of ['hr', 'sjres', 'sres', 'sconres', 'hjres']) {
      expect(agreedToOtherChamberAmendment(t, { bill_type: type, bill_number: 240 }), type).toBeNull();
    }
    // The right type, another number.
    for (const n of [241, 24, 2400, 1240, 0]) {
      expect(agreedToOtherChamberAmendment(t, { bill_type: 's', bill_number: n }), String(n)).toBeNull();
    }
    // No bill to check it against: never final.
    expect(agreedToOtherChamberAmendment(t)).toBeNull();
    expect(agreedToOtherChamberAmendment(t, null)).toBeNull();
    expect(agreedToOtherChamberAmendment(t, { bill_type: 's' })).toBeNull();
    // Through every reader that has the bill.
    for (const [type, number] of [['hr', 240], ['s', 241]] as const) {
      const b = asBill(type, t, number);
      expect(recordStatus(b), `${type} ${number}`).toBe('committee');
      expect(passageState(b).stage, `${type} ${number}`).not.toBe('both');
      expect(statusKeyFor(b, NOW), `${type} ${number}`).not.toBe('passed_both');
      expect(floorAnsweredChamber(t, b), `${type} ${number}`).not.toBe('both');
    }
    // The House sentence names no bill, so it needs none.
    expect(agreedToOtherChamberAmendment(REAL[0].text)).toBe('house');
  });
});

/* ------------------------------------------------------------------ *
 * (b) EVERY SENTENCE OF THE RE-CHECKS: THE READING THE BRANCH GIVES.
 * A sentence the whitelist holds (after normalising) reads final; an exact
 * "Presented to President." reads presented; every other sentence reads
 * exactly what origin/main read.
 * ------------------------------------------------------------------ */
const whitelisted = (s: Sentence) =>
  REAL.some((r) => stripActionFrame(r.text).body === stripActionFrame(s.text).body && agreedToOtherChamberAmendment(s.text, asBill(s.type, s.text, s.number ?? 1)) !== null);
const presentedExact = (s: Sentence) => normaliseAction(s.text) === PRESENTED_REAL && !/conres$/.test(s.type);

test.describe('(b) every sentence of the re-checks, with the reading it must give', () => {
  test(`the table is complete: re-check 5's 91, re-check 4's 60, and the rest (${SENTENCES.length})`, () => {
    expect(SENTENCES.filter((s) => s.src === 'check5')).toHaveLength(91);
    // Re-check 4's 60: 51 are its own, 9 it shares with re-check 5.
    expect(SENTENCES.filter((s) => s.src === 'check4')).toHaveLength(51);
    expect(SENTENCES.length).toBeGreaterThanOrEqual(220);
  });
  for (const s of SENTENCES) {
    const expected = whitelisted(s) ? 'final' : presentedExact(s) ? 'presented' : 'as on main';
    test(`${s.id} [${s.type}] ${expected}: ${JSON.stringify(s.text).slice(1, 100)}`, () => {
      const r = readingOf(s.type, s.text, s.number ?? 1);
      if (expected === 'final') {
        expect(r[1]).toBe('passed_both');
        expect(r[2]).toMatch(/^both\//);
        expect(r[3]).toBe('both');
      } else if (expected === 'presented') {
        expect(r[1]).toBe('passed_both');
        expect(r[2]).toBe('both/null/null');
      } else {
        expect(agreedToOtherChamberAmendment(s.text, asBill(s.type, s.text, s.number ?? 1))).toBeNull();
        expect(r).toEqual(s.main);
      }
    });
  }
  test('which sentences read differently from main: the five real ones and the exact presentment, nothing else', () => {
    const changed = SENTENCES.filter((s) => JSON.stringify(readingOf(s.type, s.text, s.number ?? 1)) !== JSON.stringify(s.main)).map((s) => s.id);
    expect(changed).toEqual(SENTENCES.filter((s) => whitelisted(s) || presentedExact(s)).map((s) => s.id));
    expect(changed.length).toBe(7);
  });
  test('the Rules Committee sentence reads "Floor activity" again, as on main', () => {
    const s = SENTENCES.find((x) => x.id === 'a33')!;
    expect(s.text).toContain('Rule provides that the motion that the House concur in the Senate amendment shall be considered as agreed to.');
    expect(readingOf(s.type, s.text)[1]).toBe('floor_activity');
  });
});

/* ------------------------------------------------------------------ *
 * (c) THE GENERATOR. Each real example, edited. An edit that only changes
 * what normalising removes (whitespace kind and runs, NFKC forms, the ends)
 * keeps it final; every other edit makes it not final.
 * ------------------------------------------------------------------ */
type Edit = { name: string; keeps: boolean; apply: (t: string) => string[] };
const words = (t: string) => t.split(' ');
const atEachSpace = (t: string, sep: string) => words(t).slice(1).map((_, i) => {
  const w = words(t);
  return [...w.slice(0, i + 1)].join(' ') + sep + w.slice(i + 1).join(' ');
});
const atEachGap = (t: string, word: string) => {
  const w = words(t);
  return Array.from({ length: w.length + 1 }, (_, i) => [...w.slice(0, i), word, ...w.slice(i)].join(' '));
};
const FULLWIDTH = (s: string) => s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
const EDITS: Edit[] = [
  // Only what normalising removes: still final.
  { name: 'a doubled space, at each space', keeps: true, apply: (t) => atEachSpace(t, '  ') },
  { name: 'a line break, at each space', keeps: true, apply: (t) => atEachSpace(t, '\n') },
  { name: 'a no-break space, at each space', keeps: true, apply: (t) => atEachSpace(t, ' ') },
  { name: 'a tab, at each space', keeps: true, apply: (t) => atEachSpace(t, '\t') },
  { name: 'whitespace at both ends', keeps: true, apply: (t) => [` ${t}`, `${t} `, `\n${t}\n`, ` ${t}`] },
  { name: 'full-width letters (NFKC folds them)', keeps: true, apply: (t) => [FULLWIDTH(t), t.replace('Senate', FULLWIDTH('Senate'))] },
  // Everything else: never final.
  { name: 'a word inserted at every position', keeps: false, apply: (t) => ['not', 'also', 'the', 'further', 'en bloc', 'amended'].flatMap((w) => atEachGap(t, w)) },
  { name: 'a word removed, each word', keeps: false, apply: (t) => words(t).map((_, i) => words(t).filter((__, j) => j !== i).join(' ')) },
  { name: 'a second sentence appended', keeps: false, apply: (t) => [`${t} Motion to reconsider laid on the table Agreed to without objection.`, `${t} ${t}`, `${t} Signed by President.`] },
  { name: 'an outer motion prepended', keeps: false, apply: (t) => [`On motion to table the motion that ${t}`, `On motion to table ${t}`, `Motion to table: ${t}`, `On motion to reconsider the vote on ${t}`] },
  { name: '"with …" added', keeps: false, apply: (t) => [t.replace(/(amendment)/, '$1 with an amendment'), t.replace(/(amendment)/, '$1 with  an amendment'), t.replace(/(amendment)/, '$1 with\nan amendment'), t.replace(/(amendment)/, '$1 with a House amendment')] },
  { name: '"numbered" / "No." added', keeps: false, apply: (t) => [t.replace(/(amendment)/, '$1 numbered 2'), t.replace(/(amendment)/, '$1 No. 3')] },
  { name: '"to the title" added', keeps: false, apply: (t) => [t.replace(/(amendment)/, '$1 to the title')] },
  { name: '", amended," added', keeps: false, apply: (t) => [t.replace(/(amendment)/, '$1, amended,')] },
  { name: '"shall be considered as agreed to"', keeps: false, apply: (t) => [t.replace(/Agreed to|agreed to/, 'shall be considered as agreed to'), `Rule provides that ${t}`] },
  { name: 'failure', keeps: false, apply: (t) => [t.replace(/Agreed to|agreed to/, 'Not agreed to'), t.replace(/Agreed to|agreed to/, 'Failed')] },
  { name: 'upper case', keeps: false, apply: (t) => [t.toUpperCase()] },
  { name: 'lower case', keeps: false, apply: (t) => [t.toLowerCase()] },
  { name: 'case of one letter changed', keeps: false, apply: (t) => [t[0].toLowerCase() + t.slice(1), t.replace('Senate', 'senate'), t.replace('House', 'house')] },
  { name: 'final period dropped or changed', keeps: false, apply: (t) => [t.replace(/\.(\s*\([^)]*\))?$/, '$1'), t.replace(/\.(\s*\([^)]*\))?$/, ';$1'), t.replace(/\.(\s*\([^)]*\))?$/, '..$1')] },
  { name: 'another vote method', keeps: false, apply: (t) => [t.replace('by voice vote', 'by recorded vote: 300 - 100 (Roll no. 5)'), t.replace('by Unanimous Consent', 'by Voice Vote'), t.replace('by voice vote', 'by unanimous consent')].filter((x) => x !== t) },
  { name: 'a zero-width space (NFKC keeps it)', keeps: false, apply: (t) => atEachSpace(t, ' ​') },
  { name: 'a look-alike letter', keeps: false, apply: (t) => [t.replace('a', 'а'), t.replace('e', 'е')] },
  { name: 'the other chamber’s label', keeps: false, apply: (t) => [`Resolving differences -- ${/^Senate/.test(t) ? 'House' : 'Senate'} actions: ${t}`] },
  { name: 'two labels', keeps: false, apply: (t) => [`Resolving differences -- House actions: Resolving differences -- House actions: ${t}`, `Resolving differences -- Senate actions: Resolving differences -- Senate actions: ${t}`] },
  { name: 'a second or misplaced citation', keeps: false, apply: (t) => [`${t} (text: CR H1) (text: CR H2)`, /\)$/.test(t) ? `${t} (consideration: CR S1)` : `${t} (text: CR H1)`.replace(/\.( \(text: CR H1\))$/, '$1.'), t.replace(' Agreed', ' (text: CR H1) Agreed').replace(' by Unanimous', ' (consideration: CR S1) by Unanimous')].filter((x) => x !== t) },
  // A citation that is not one of the record's own forms is not stripped, so
  // the sentence is not whitelisted (round 7: "CR [HS][^)]*" would have
  // stripped the first three).
  { name: 'a malformed citation', keeps: false, apply: (t) => ['(text: CR X1)', '(see: CR H1)', '(text: CR H1-2; motion later vacated)', '(consideration: CR S5020; vacated)', '(text: CR H6247-6248 and H6250)'].map((c) => `${normaliseAction(t).replace(/ \([^)]*\)$/, '')} ${c}`) },
  { name: 'the bill number mangled', keeps: false, apply: (t) => (/S\. \d+/.test(t) ? [t.replace(/S\. (\d+)/, 'S. 0$1'), t.replace(/S\. (\d+)/, 'S. $1a'), t.replace(/S\. (\d+)/, 'S.$1'), t.replace(/S\. (\d+)/, 'H.R. $1')] : [t.replace('the Senate amendment', 'the Senate amendment to H.R. 2400')]) },
  { name: 'the object made plural or bare', keeps: false, apply: (t) => [t.replace('amendment', 'amendments'), t.replace('the Senate amendment', 'Senate amendment'), t.replace('the House amendment', 'House amendment')].filter((x) => x !== t) },
];

const VARIANTS = REAL.reduce((n, r) => n + EDITS.reduce((m, e) => m + e.apply(r.text).filter((v) => v !== r.text).length, 0), 0);

test.describe('(c) the generator: an edited real example is never final unless only whitespace or NFKC changed', () => {
  test(`at least 25 kinds of edit (${EDITS.length} kinds, ${VARIANTS} edited sentences)`, () => {
    expect(EDITS.length).toBeGreaterThanOrEqual(25);
  });
  for (const r of REAL) {
    for (const e of EDITS) {
      test(`${e.name} — ${JSON.stringify(r.text)}`, () => {
        const variants = e.apply(r.text).filter((v) => v !== r.text);
        expect(variants.length, 'the edit produced something').toBeGreaterThan(0);
        for (const v of variants) {
          const sameAfterNormalising = stripActionFrame(v).body === stripActionFrame(r.text).body && stripActionFrame(v).label === null;
          expect(sameAfterNormalising, `edit kind says keeps=${e.keeps}: ${JSON.stringify(v)}`).toBe(e.keeps);
          // Read on the real example's own bill, so a sentence that names its
          // bill is checked against the right one.
          const b = asBill(r.type, v, r.number);
          expect(agreedToOtherChamberAmendment(v, b), JSON.stringify(v)).toBe(e.keeps ? r.chamber : null);
          // The passage reading and the status word agree with the reader.
          if (!e.keeps) {
            expect(passageState(b).stage, JSON.stringify(v)).not.toBe('both');
            expect(statusKeyFor(b, NOW), JSON.stringify(v)).not.toBe('passed_both');
          } else {
            expect(statusKeyFor(b, NOW)).toBe('passed_both');
          }
        }
      });
    }
  }
  test('presentment: the same edits never read presented unless only whitespace or NFKC changed', () => {
    for (const e of EDITS) {
      for (const v of e.apply(PRESENTED_REAL).filter((x) => x !== PRESENTED_REAL)) {
        const keeps = normaliseAction(v) === PRESENTED_REAL;
        expect(presentedToPresident({ bill_type: 'hr', last_action_text: v }), `${e.name}: ${JSON.stringify(v)}`).toBe(keeps);
      }
    }
    for (const v of ['Presented to President', 'presented to president.', 'Presented to President on 11/12/2026.', 'Enrolled bill signed. Presented to President.', 'Presented to President. Signed by President.']) {
      expect(presentedToPresident({ bill_type: 'hr', last_action_text: v }), v).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * (d) MAIN PARITY. "Worse" means: main gave the right final-or-not reading
 * and the branch does not; or the branch claims both chambers are done (or
 * the bill presented) where the sentence does not say so and main did not
 * claim it. "Claims both done" is the status word "Passed both chambers" or
 * the passage stage 'both'.
 * ------------------------------------------------------------------ */
const claimsBoth = (r: Reading) => r[1] === 'passed_both' || r[2].startsWith('both/');
const states = (s: Sentence) => s.truth === 'F' || s.truth === 'P';
const correct = (r: Reading, s: Sentence) => claimsBoth(r) === states(s);

test.describe('(d) no sentence reads worse than on main', () => {
  for (const s of SENTENCES) {
    test(`${s.id}: ${JSON.stringify(s.text).slice(1, 90)}`, () => {
      const b = readingOf(s.type, s.text, s.number ?? 1);
      const mainRightBranchWrong = correct(s.main, s) && !correct(b, s);
      const newUnstatedClaim = claimsBoth(b) && !claimsBoth(s.main) && !states(s);
      expect(mainRightBranchWrong, `main ${JSON.stringify(s.main)} / branch ${JSON.stringify(b)}`).toBe(false);
      expect(newUnstatedClaim, `branch ${JSON.stringify(b)}`).toBe(false);
      // No new claim from the two readers this work added, where the sentence does not state it.
      if (!states(s)) {
        expect(agreedToOtherChamberAmendment(s.text, asBill(s.type, s.text, s.number ?? 1))).toBeNull();
        expect(presentedToPresident({ bill_type: s.type, last_action_text: s.text })).toBe(false);
      }
    });
  }
});
