import { expect, test } from '@playwright/test';
import { buildStructurePrompt, buildSummaryPrompt, textFingerprint } from '../scripts/bill-decode.mjs';

// THE DECODE NEVER SAYS WHERE A BILL STANDS (owner, 2026-09-30, decision 70,
// option a). Call 1 reads the newest printed text, whose header can record an
// old referral, and the model narrated it: H.R. 10167's decode said "it is now
// in a Senate committee" after the Senate had passed it. The bill page prints
// the status from the official record, so call 2 (the headlines, tl;dr and
// sections people read) is told never to state it.
//
// Call 1 is deliberately NOT changed: its prompt is what `decode_text_sha`
// fingerprints, and one changed character would re-decode every bill in the
// corpus. The second test pins it byte for byte so an edit fails loudly here.

const bill = { bill_type: 'hr', bill_number: 10167, title: 'A fixture title' };

test('call 2 tells the model never to say where the bill stands', () => {
  const prompt = buildStructurePrompt(bill, 'A plain summary.');
  expect(prompt).not.toContain('where it stands');
  expect(prompt).toContain(
    '- Never say where the bill stands in Congress in the headlines, the TLDR, or any section (WHAT, WHO, WHY, COST, chips), in either language: not which chamber has it, not which committee, not whether a vote happened or is coming, not whether it went to the president, even if the summary says so. The page prints that from the official record.'
  );
  expect(prompt).toContain('Prioritize the most decision-relevant specifics: what it does, who it affects, or what it costs.');
});

test('call 1 is byte-identical to the prompt every stored fingerprint was taken from', () => {
  const expected =
    'Explain this congressional bill in plain language for an everyday US resident (8th-grade reading level). 2-3 short paragraphs: what it actually does, and who it affects. Strictly nonpartisan, no advocacy, no preamble, no markdown.\n\nBill: HR 10167 — A fixture title\n\nFull text (may be truncated):\nSEC. 1. SHORT TITLE.';
  const prompt = buildSummaryPrompt(bill, 'SEC. 1. SHORT TITLE.');
  expect(prompt).toBe(expected);
  expect(textFingerprint(prompt)).toBe('323eb7e24a5fbd01');
});
