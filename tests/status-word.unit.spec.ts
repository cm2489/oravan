import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import bills from '../data/bills.json';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { decisionState } from '../lib/docket.mjs';
import { getBill } from '../lib/core/bills';
import { settledDecision } from '../lib/journey';
import { settledDecisionDate } from '../lib/settled-votes';
import { STATUS_WORDS, settledOutcomeSentence, statusWord } from '../lib/status-word';
import type { Bill } from '../lib/types';

/*
 * THE FIVE STATUS WORDS (wireframes v2, 2026-09-29, Claude's ruling 11: Open,
 * Law, Agreed to, Rejected, Vetoed), read from the record through the bill
 * page's own reader (lib/journey.ts settledDecision) and the MCP envelope's
 * (lib/docket.mjs decisionState), so a word can never disagree with the panel
 * beside it. And the settled rows' outcome sentence, which must read exactly
 * as the bill page's settled box reads it.
 */

type Rec = Pick<Bill, 'bill_type' | 'status' | 'last_action_text' | 'last_action_date'>;
const rec = (bill_type: string, status: string, text: string | null, date = '2026-09-24'): Rec =>
  ({ bill_type, status, last_action_text: text, last_action_date: date }) as Rec;

test.describe('the closed set', () => {
  test('is exactly five words, each in both languages, never empty', () => {
    expect([...STATUS_WORDS]).toEqual(['open', 'law', 'agreed', 'rejected', 'vetoed']);
    expect(Object.keys(en.bills.statusWord).sort()).toEqual([...STATUS_WORDS].sort());
    expect(Object.keys(es.bills.statusWord).sort()).toEqual([...STATUS_WORDS].sort());
    for (const w of STATUS_WORDS) {
      expect(en.bills.statusWord[w].trim()).not.toBe('');
      expect(es.bills.statusWord[w].trim()).not.toBe('');
    }
  });

  test('the wireframe’s English words, verbatim', () => {
    expect(en.bills.statusWord).toEqual({
      open: 'Open',
      law: 'Law',
      agreed: 'Agreed to',
      rejected: 'Rejected',
      vetoed: 'Vetoed',
    });
  });
});

test.describe('one word per record', () => {
  test('a signed bill is law', () => {
    expect(statusWord(rec('hr', 'signed', 'Became Public Law No: 119-103.'))).toBe('law');
  });

  test('a veto stands as vetoed (an override is still possible, so the call stays)', () => {
    const vetoed = rec('hr', 'vetoed', 'Vetoed by President.');
    expect(settledDecision(vetoed)).toBeNull();
    expect(statusWord(vetoed)).toBe('vetoed');
  });

  test('a failed vote on the measure itself is rejected', () => {
    expect(
      // The stored status is the pipeline's (`floor_vote`), not the label key.
      statusWord(rec('hconres', 'floor_vote', 'Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.'))
    ).toBe('rejected');
  });

  test('a failed MOTION about it stays open (the owner’s pick (a), Claude’s ruling 10)', () => {
    for (const text of [
      'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50. Record Vote Number: 192. (CR S3194)',
      'Motion to discharge Senate Committee on Foreign Relations rejected by Yea-Nay Vote. 47 - 48. Record Vote Number: 174.',
    ]) {
      expect(statusWord(rec('sjres', 'floor_vote', text)), text).toBe('open');
    }
  });

  test('committee, calendar and one-chamber passage are open', () => {
    expect(statusWord(rec('s', 'committee', 'Read twice and referred to the Committee on Foreign Relations.'))).toBe('open');
    expect(statusWord(rec('hr', 'passed_chamber', 'Received in the Senate.'))).toBe('open');
  });

  test('the committed corpus: H.Con.Res. 86 agreed to, 89 and 38 rejected, H.R. 6500 law, S.J.Res. 185 open', () => {
    const expectations: Record<string, string> = {
      'hconres-86-119': 'agreed',
      'hconres-89-119': 'rejected',
      'hconres-38-119': 'rejected',
      'hr-6500-119': 'law',
      'sjres-185-119': 'open',
    };
    for (const [slug, word] of Object.entries(expectations)) {
      const b = getBill(slug);
      test.skip(!b, `${slug} is not in the corpus`);
      expect(statusWord(b!), slug).toBe(word);
    }
  });

  test('over the whole corpus, the word agrees with both readers', () => {
    const all = bills as unknown as Bill[];
    expect(all.length).toBeGreaterThan(1000);
    for (const b of all) {
      const word = statusWord(b);
      expect(STATUS_WORDS).toContain(word);
      const settled = settledDecision(b);
      // Whatever the bill page settles carries a settled word…
      if (settled) expect(['law', 'agreed', 'rejected'], `${b.bill_type} ${b.bill_number}`).toContain(word);
      // …and a word says "still possible" exactly when the MCP envelope reads
      // the decision as pending.
      const pending = decisionState(b).state === 'pending';
      expect(pending, `${b.bill_type} ${b.bill_number}: ${word}`).toBe(word === 'open' || word === 'vetoed');
    }
  });
});

test.describe('the settled rows’ outcome sentence reads as the settled box does', () => {
  const tEn = createTranslator({ locale: 'en', messages: en });
  const tEs = createTranslator({ locale: 'es', messages: es });
  const t = (tr: typeof tEn) => (key: string, values?: Record<string, string | number>) =>
    (tr as unknown as (k: string, v?: Record<string, string | number>) => string)(key, values);

  test('rejected: the chamber, the record’s tally and its date, first', () => {
    const settled = { kind: 'rejected' as const, chamber: 'senate' as const, tally: { yeas: 49, nays: 50 } };
    expect(settledOutcomeSentence(t(tEn), settled, 'September 24, 2026')).toBe(
      'The Senate rejected it, 49–50, on September 24, 2026.'
    );
    expect(settledOutcomeSentence(t(tEs), settled, '24 de septiembre de 2026')).toBe(
      'El Senado lo rechazó, por 49 votos a favor y 50 en contra, el 24 de septiembre de 2026.'
    );
    // No date on the record: none is borrowed.
    expect(settledOutcomeSentence(t(tEn), settled, null)).toBe('The Senate rejected it, 49–50.');
  });

  test('adopted and law', () => {
    expect(settledOutcomeSentence(t(tEn), { kind: 'adopted', chamber: 'senate' }, 'June 23, 2026')).toBe(
      'Both chambers agreed to it in the same form, the second on June 23, 2026.'
    );
    expect(settledOutcomeSentence(t(tEn), { kind: 'law' }, null)).toBe(en.bill.settled.law);
  });

  test('H.Con.Res. 89 from the committed record', () => {
    const b = getBill('hconres-89-119');
    test.skip(!b, 'H.Con.Res. 89 is not in the corpus');
    const settled = settledDecision(b!);
    expect(settled?.kind).toBe('rejected');
    const date = settledDecisionDate(b!);
    expect(date).toBe('2026-09-24');
    expect(settledOutcomeSentence(t(tEn), settled!, 'September 24, 2026')).toBe(
      'The Senate rejected it, 49–50, on September 24, 2026.'
    );
  });
});
