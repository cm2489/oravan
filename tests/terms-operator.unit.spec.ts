import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * Who runs Oravan and which law governs the Terms (owner, 2026-11-12: no
 * company; "Colby Maxwell, an individual in Washington, DC"; the law of the
 * District of Columbia). Drafted without legal review. This pins that both
 * Terms pages say it, in both languages, and that no placeholder is left.
 */
const LAW = { en: /District of Columbia/, es: /Distrito de Columbia/ } as const;

for (const [locale, m] of [
  ['en', en],
  ['es', es],
] as const) {
  test(`${locale}: the citizen Terms name the operator and the governing law`, () => {
    expect(m.terms.operator).toContain('Colby Maxwell');
    expect(m.terms.operator).toContain('Washington, DC');
    expect(m.terms.law).toMatch(LAW[locale]);
  });

  test(`${locale}: the partner terms name the operator, the governing law, and keep no placeholder`, () => {
    expect(m.embedsTerms.scopeBody).toContain('Colby Maxwell');
    expect(m.embedsTerms.lawBody).toMatch(LAW[locale]);
    for (const text of Object.values(m.embedsTerms)) expect(text).not.toContain('[FOUNDER');
  });
}
