import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { isAiSentence } from '../components/system/Chip';

/*
 * THE AI LABEL'S TWO VOICES (UI audit fixes, 2026-11-22, finding F1).
 * `Chip tone="ai"` prints a short label in small tracked capitals, and a
 * whole sentence in normal case beside the AI mark. The long notes on
 * /bills, /questions and a question page's bill cards were sentences printed
 * as four to eight lines of capitals. This pins which side every AI label
 * the site prints lands on, in both languages.
 */

const LOCALES = [
  ['en', en],
  ['es', es],
] as const;

test.describe('which AI labels are sentences', () => {
  for (const [lang, m] of LOCALES) {
    test(`${lang}: the long notes read as sentences`, () => {
      for (const s of [m.bills.aiNote, m.moments.aiNote, m.moments.vehiclesAiNote, m.moments.updates.timelineAiChip]) {
        expect(isAiSentence(s), s).toBe(true);
      }
    });

    test(`${lang}: the short labels keep the capitals`, () => {
      for (const s of [
        m.bill.aiChip,
        m.bill.aiLabel,
        m.moments.updates.summaryAiChip,
        m.call.aiNote,
        m.rep.aiNote,
        m.rep.votesAiNote,
        m.today.aiHeadlines,
        m.today.aiNames,
      ]) {
        expect(isAiSentence(s), s).toBe(false);
      }
    });
  }

  test('only a plain string can be a sentence', () => {
    expect(isAiSentence(undefined)).toBe(false);
    expect(isAiSentence(null)).toBe(false);
    expect(isAiSentence('AI-decoded')).toBe(false);
    expect(isAiSentence('Written by AI from the record.')).toBe(true);
    expect(isAiSentence('one two three four five six seven eight nine ten eleven twelve thirteen')).toBe(true);
  });
});
