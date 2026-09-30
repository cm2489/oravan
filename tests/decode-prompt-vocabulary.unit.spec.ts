import { expect, test } from '@playwright/test';
import { VOCABULARY_RULE, buildStructurePrompt, buildSummaryPrompt, textFingerprint } from '../scripts/bill-decode.mjs';
import { FORBIDDEN } from '../lib/moments-gate.mjs';

// THE DECODE IS TOLD THE VOCABULARY LIST; NOTHING GATES IT (owner, 2026-09-30:
// regenerate the Spanish headlines that used listed words, the gate stays as
// it is). Page 1, rule 3: on bill decodes the vocabulary rule is a prompt
// instruction, not a gate. These tests pin the instruction to the one list in
// lib/moments-gate.mjs, so a word added there reaches call 2 with no second
// edit, and pin call 1 so the instruction never moves a stored fingerprint.

const bill = { bill_type: 'hconres', bill_number: 89, title: 'A fixture title' };

test('call 2 carries the vocabulary instruction', () => {
  expect(buildStructurePrompt(bill, 'A plain summary.')).toContain(VOCABULARY_RULE);
});

test('the instruction names every listed word, in both languages', () => {
  for (const lang of ['en', 'es'] as const) {
    for (const { word } of FORBIDDEN[lang]) {
      if (/part(y|ido)/.test(word)) continue; // regex entries, stated in prose
      expect(VOCABULARY_RULE, `${lang}: ${word}`).toContain(word);
    }
  }
  expect(VOCABULARY_RULE).toContain('Never name a political party.');
});

test('call 1 does not carry it, so no stored fingerprint moves', () => {
  const prompt = buildSummaryPrompt(bill, 'SEC. 1. SHORT TITLE.');
  expect(prompt).not.toContain('advocacy vocabulary');
  expect(prompt).not.toContain('detener');
  expect(textFingerprint(buildSummaryPrompt({ ...bill, bill_type: 'hr', bill_number: 10167 }, 'SEC. 1. SHORT TITLE.'))).toBe(
    '323eb7e24a5fbd01'
  );
});
