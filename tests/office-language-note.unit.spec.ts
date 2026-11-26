import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * THE CALL-LANGUAGE NOTE ON THE SPANISH CALL PANEL (2026-11-25).
 *
 * /es/about promises a call "en inglés o español", but no page told a Spanish
 * speaker that the office may answer in English, or gave them an English line
 * to ask for a Spanish speaker. components/ActionPanel.tsx now prints two
 * sentences under the script on the Spanish edition. These tests pin the words
 * and where the note sits; no browser runs here.
 */

const PANEL = readFileSync(join(__dirname, '..', 'components', 'ActionPanel.tsx'), 'utf8');
const sentences = (s: string) => s.replace(/<\/?en>/g, '').split(/(?<=[.?!][»”]?)\s+/).filter(Boolean);

test('the key exists in both languages, and the Spanish is not the English', () => {
  expect(typeof en.bill.officeLanguageNote).toBe('string');
  expect(typeof es.bill.officeLanguageNote).toBe('string');
  expect(es.bill.officeLanguageNote).not.toBe(en.bill.officeLanguageNote);
});

test('it is two sentences, in both languages', () => {
  expect(sentences(es.bill.officeLanguageNote)).toHaveLength(2);
  expect(sentences(en.bill.officeLanguageNote)).toHaveLength(2);
});

test('it says "may", never that an office has a Spanish speaker', () => {
  expect(es.bill.officeLanguageNote).toContain('Es posible que la oficina conteste en inglés');
  expect(en.bill.officeLanguageNote).toContain('may answer in English');
  for (const promise of [/\bwill\b/i, /\bhabrá\b/i, /\btiene(n)? alguien\b/i, /\bsiempre\b/i, /\balways\b/i]) {
    expect(es.bill.officeLanguageNote).not.toMatch(promise);
    expect(en.bill.officeLanguageNote).not.toMatch(promise);
  }
});

test('the line to read aloud is English, inside the tag that marks it lang="en"', () => {
  const line = 'Is there someone who speaks Spanish?';
  expect(es.bill.officeLanguageNote).toContain(`<en>${line}</en>`);
  expect(en.bill.officeLanguageNote).toContain(`<en>${line}</en>`);
  expect(PANEL).toContain("en: (chunks) => <span lang=\"en\">{chunks}</span>");
});

test('the panel prints it on the Spanish edition only, after the script and before the call step', () => {
  const note = PANEL.indexOf("t.rich('officeLanguageNote'");
  expect(note).toBeGreaterThan(-1);
  expect(PANEL.slice(note - 400, note)).toContain("locale === 'es' && (");
  // Never a step before the script (rule 8): it follows the script's textarea
  // and copy button, and comes before the call step's heading.
  expect(note).toBeGreaterThan(PANEL.indexOf('<textarea'));
  expect(note).toBeGreaterThan(PANEL.indexOf('onClick={copyScript}'));
  expect(note).toBeLessThan(PANEL.indexOf('{/* Step 3 - call */}'));
});
