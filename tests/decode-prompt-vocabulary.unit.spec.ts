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

const EXPECTED_RULE =
  '- No advocacy vocabulary, in any field, in either language. Do not use these words, or their forms, to characterise what a bill or a side is doing or to urge anything: English: fight, resist, stop, save, defend, block, crisis, attack, scheme. Spanish: luchar, resistir, detener, salvar, defender, bloquear, crisis, ataque, esquema. A plain noun or an official term that happens to contain one is fine (a truck stop, a crisis line, a shark attack, a name the summary gives). Never name a political party. Say what the bill would do in neutral words instead (for example "would bar", "would end", "would overturn"; "impediría", "pondría fin a", "anularía").';

test('call 2 carries the vocabulary instruction, scoped to advocacy use', () => {
  // Pinned whole: the scope sentence ("A plain noun or an official term …")
  // is what keeps neutral description allowed — the reason the 2026-08-06
  // measurement kept the lint off decodes. Losing it should fail here.
  expect(VOCABULARY_RULE).toBe(EXPECTED_RULE);
  expect(buildStructurePrompt(bill, 'A plain summary.')).toContain(EXPECTED_RULE);
});

test('the prompt names every listed word, in both languages', () => {
  const prompt = buildStructurePrompt(bill, 'A plain summary.');
  for (const lang of ['en', 'es'] as const) {
    for (const { word } of FORBIDDEN[lang]) {
      if (/part(y|ido)/.test(word)) continue; // regex entries, stated in prose
      expect(prompt, `${lang}: ${word}`).toContain(word);
    }
  }
  expect(prompt).toContain('Never name a political party.');
});

test('call 1 does not carry it, so no stored fingerprint moves', () => {
  const prompt = buildSummaryPrompt(bill, 'SEC. 1. SHORT TITLE.');
  expect(prompt).not.toContain('advocacy vocabulary');
  expect(prompt).not.toContain('detener');
  expect(textFingerprint(buildSummaryPrompt({ ...bill, bill_type: 'hr', bill_number: 10167 }, 'SEC. 1. SHORT TITLE.'))).toBe(
    '323eb7e24a5fbd01'
  );
});
