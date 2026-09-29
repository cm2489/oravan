import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import bills from '../data/bills.json';
import en from '../messages/en.json';
import es from '../messages/es.json';
import {
  CRS_WAR_POWERS_REPORT,
  adoptedConcurrentReading,
  invokesWarPowers5c,
  isConcurrentResolution,
} from '../lib/concurrent-explainer';
import { glossaryEntry, isGlossaryTermId } from '../lib/glossary';
import { settledDecision } from '../lib/journey';
import type { Bill } from '../lib/types';

/*
 * WHAT A CONCURRENT RESOLUTION CAN AND CANNOT DO (owner, 2026-09-29, reviewing
 * #368: "What is a concurrent resolution? Add to glossary. We are still at war
 * and this didn't stop the president. It's now September and this passed in
 * June. This needs more explaination because it's confusing.").
 *
 * Pinned here: the glossary entry and its official source; which records get
 * the explainer (an adopted concurrent resolution, and the War Powers
 * sentence only when the official title invokes section 5(c)); and the words
 * in both languages — the CRS quote verbatim and short, and no claim the
 * record does not hold (no "at war", nothing about what the president has or
 * has not done). The pages are pinned in tests/concurrent-explainer.spec.ts.
 */

const corpus = bills as unknown as Bill[];
const find = (type: string, n: number) => corpus.find((b) => b.bill_type === type && b.bill_number === n);
const HCONRES_86 = find('hconres', 86)!;
const HCONRES_89 = find('hconres', 89)!;
const HCONRES_38 = find('hconres', 38)!;

const tEn = createTranslator({ locale: 'en', messages: en });
const tEs = createTranslator({ locale: 'es', messages: es });

/** A message's text with its rich-text tags stripped (the words a reader sees). */
const plain = (s: string) => s.replace(/<\/?[a-z]+>/gi, '');

/* ------------------------------------------------------------------ *
 * The glossary entry
 * ------------------------------------------------------------------ */
test.describe('the glossary entry', () => {
  test('"concurrent resolution" is an entry, in the lawmaking section, sourced to senate.gov', () => {
    expect(isGlossaryTermId('concurrent-resolution')).toBe(true);
    const entry = glossaryEntry('concurrent-resolution');
    expect(entry.category).toBe('lawmaking');
    // The Senate's "Types of Legislation", its "Concurrent Resolutions"
    // anchor: the one official page that says both "express the sentiments
    // of both of the houses" and "make or amend rules that apply to both
    // houses", besides "do not require the signature of the president and do
    // not have the force of law". Read 2026-09-29.
    expect(entry.source).toBe('https://www.senate.gov/legislative/common/briefing/leg_laws_acts.htm#3');
    // Both languages mark the phrase where it already appears.
    expect(entry.match.en).toContain('concurrent resolution');
    expect(entry.match.es).toContain('resolución concurrente');
  });

  test('it says what one is, that it does not go to the president, and that it is not law — in both languages', () => {
    const enBody = en.glossary.terms['concurrent-resolution'].body;
    const esBody = es.glossary.terms['concurrent-resolution'].body;
    expect(en.glossary.terms['concurrent-resolution'].term).toBe('Concurrent resolution');
    expect(es.glossary.terms['concurrent-resolution'].term).toBe('Resolución concurrente');

    expect(enBody).toContain('both chambers pass in the same form');
    expect(enBody).toContain('to state a position they share or to handle their own business');
    expect(enBody).toContain('It is not sent to the president');
    expect(enBody).toContain('does not have the force of law');

    expect(esBody).toContain('ambas cámaras aprueban con el mismo texto');
    expect(esBody).toContain('para expresar una posición común o para ocuparse de sus propios asuntos');
    expect(esBody).toContain('No se envía al presidente');
    expect(esBody).toContain('no tiene fuerza de ley');

    // The owner's style rule (docs/copy-style.md): "the president", lowercase.
    expect(enBody).not.toMatch(/President/);
    expect(esBody).not.toMatch(/Presidente/);
  });
});

/* ------------------------------------------------------------------ *
 * Which records get the explainer
 * ------------------------------------------------------------------ */
test.describe('which records get the explainer', () => {
  test('the two concurrent-resolution types, and nothing else', () => {
    expect(isConcurrentResolution({ bill_type: 'hconres' })).toBe(true);
    expect(isConcurrentResolution({ bill_type: 'sconres' })).toBe(true);
    for (const t of ['hr', 's', 'hjres', 'sjres', 'hres', 'sres']) {
      expect(isConcurrentResolution({ bill_type: t }), t).toBe(false);
    }
  });

  test('H.Con.Res. 86, adopted by both chambers under section 5(c), gets the general sentence AND the War Powers sentence', () => {
    // The record: the House 215–208 on June 3, 2026; the Senate "without
    // amendment" 50–48 on June 23, 2026 (record vote 184).
    expect(HCONRES_86.status_basis_text).toMatch(
      /^Resolution agreed to in Senate without amendment by Yea-Nay Vote\. 50 - 48\. Record Vote Number: 184\./
    );
    expect(HCONRES_86.status_basis_date).toBe('2026-06-23');
    // The official title invokes section 5(c), word for word.
    expect(HCONRES_86.title).toBe(
      'Directing the President, pursuant to section 5(c) of the War Powers Resolution, to remove United States Armed Forces from hostilities with Iran.'
    );
    expect(settledDecision(HCONRES_86)).toEqual({ kind: 'adopted', chamber: 'senate' });
    expect(adoptedConcurrentReading(HCONRES_86)).toEqual({ warPowers5c: true });
  });

  test('the rejected concurrent resolutions (H.Con.Res. 89 and 38) get no explainer — nothing was adopted', () => {
    // H.Con.Res. 89: the Senate rejected it 49–50 on September 24, 2026.
    expect(HCONRES_89.last_action_text).toMatch(/^Failed of passage in Senate by Yea-Nay Vote\. 49 - 50\./);
    // H.Con.Res. 38: the House rejected it 212–219 on March 5, 2026.
    expect(HCONRES_38.status_basis_text).toMatch(/Failed by the Yeas and Nays: 212 - 219 \(Roll no\. 85\)/);
    for (const b of [HCONRES_89, HCONRES_38]) {
      expect(isConcurrentResolution(b)).toBe(true);
      // Both titles invoke section 5(c) too — the reading, not the title,
      // decides: a rejected measure has no adoption to explain.
      expect(invokesWarPowers5c(b)).toBe(true);
      expect(settledDecision(b)?.kind).toBe('rejected');
      expect(adoptedConcurrentReading(b)).toBeNull();
    }
  });

  test('an adopted concurrent resolution whose title does not invoke section 5(c) gets the general sentence only', () => {
    const budget = {
      ...HCONRES_86,
      title: 'Establishing the congressional budget for the United States Government for fiscal year 2027.',
    };
    expect(adoptedConcurrentReading(budget)).toEqual({ warPowers5c: false });
  });

  test('the War Powers reading is the OFFICIAL TITLE\'s, never the AI summary\'s', () => {
    const summaryOnly = {
      ...HCONRES_86,
      title: 'Expressing the sense of Congress on hostilities with Iran.',
      ai_summary: 'This resolution uses section 5(c) of the War Powers Resolution to direct the president.',
    };
    expect(invokesWarPowers5c(summaryOnly)).toBe(false);
    expect(adoptedConcurrentReading(summaryOnly)).toEqual({ warPowers5c: false });
  });

  test('over the committed corpus: exactly the adopted concurrent resolutions, and today that is H.Con.Res. 86 alone', () => {
    const got = corpus.filter((b) => adoptedConcurrentReading(b) !== null);
    for (const b of got) {
      expect(isConcurrentResolution(b), `${b.bill_type} ${b.bill_number}`).toBe(true);
      expect(settledDecision(b)?.kind, `${b.bill_type} ${b.bill_number}`).toBe('adopted');
    }
    for (const b of corpus) {
      if (isConcurrentResolution(b) && settledDecision(b)?.kind === 'adopted') {
        expect(got, `${b.bill_type} ${b.bill_number}`).toContain(b);
      }
    }
    expect(got.map((b) => `${b.bill_type}-${b.bill_number}`)).toEqual(['hconres-86']);
  });
});

/* ------------------------------------------------------------------ *
 * The words
 * ------------------------------------------------------------------ */
test.describe('the words, in both languages', () => {
  test('the general sentence: where both chambers stand, not a law, no president — the term tagged for the glossary', () => {
    expect(en.bill.concurrent.general).toBe(
      "A <term>concurrent resolution</term> states where both chambers stand. It isn't a law and doesn't go to the president, so it doesn't bind the president the way a law does."
    );
    expect(es.bill.concurrent.general).toBe(
      'Una <term>resolución concurrente</term> expresa la posición de ambas cámaras. No es una ley y no pasa al presidente, así que no obliga al presidente como lo haría una ley.'
    );
  });

  test('the War Powers detail names section 5(c), INS v. Chadha (1983) and the CRS, and quotes the CRS verbatim, in English, under 15 words', () => {
    const CRS_QUOTE = 'constitutionally suspect';
    for (const [lang, s] of [
      ['en', en.bill.concurrent.warPowers],
      ['es', es.bill.concurrent.warPowers],
    ] as const) {
      expect(s, lang).toContain('5(c)');
      expect(s, lang).toContain('INS v. Chadha');
      expect(s, lang).toContain('1983');
      expect(s, lang).toContain(`<quote>${CRS_QUOTE}</quote>`);
      // One quote, and it is the report's own words: "it is constitutionally
      // suspect under the reasoning applied by the Court" (R42699).
      expect(s.match(/<quote>/g), lang).toHaveLength(1);
      expect(CRS_QUOTE.split(/\s+/).length).toBeLessThan(15);
    }
    expect(en.bill.concurrent.warPowers).toContain('the Congressional Research Service');
    expect(en.bill.concurrent.warPowers).toContain('War Powers Resolution');
    expect(es.bill.concurrent.warPowers).toContain('el Servicio de Investigación del Congreso');
    // The corpus's own Spanish name for it (data/moments.json, data/bills-es.json).
    expect(es.bill.concurrent.warPowers).toContain('Resolución de Poderes de Guerra');
    // What section 5(c) says, paraphrased from 50 U.S.C. 1544(c): "such
    // forces shall be removed by the President if the Congress so directs by
    // concurrent resolution" (govinfo.gov, read 2026-09-29).
    expect(en.bill.concurrent.warPowers).toContain('if Congress so directs by concurrent resolution');
    expect(es.bill.concurrent.warPowers).toContain('si el Congreso así lo ordena mediante una resolución concurrente');
  });

  test('version 2 folds the War Powers detail under a neutral question, in both languages', () => {
    expect(en.bill.concurrent.bindsQuestion).toBe('Does this bind the president?');
    expect(es.bill.concurrent.bindsQuestion).toBe('¿Obliga esto al presidente?');
  });

  test('the source line names the report and its number; the link is the CRS report on congress.gov', () => {
    expect(tEn.markup('bill.concurrent.crsSource', { report: 'R42699', title: (c) => c })).toBe(
      'Source: Congressional Research Service, The War Powers Resolution: Concepts and Practice (R42699, March 2019)'
    );
    expect(tEs.markup('bill.concurrent.crsSource', { report: 'R42699', title: (c) => c })).toBe(
      'Fuente: Servicio de Investigación del Congreso, The War Powers Resolution: Concepts and Practice (R42699, marzo de 2019; en inglés)'
    );
    expect(CRS_WAR_POWERS_REPORT.url).toBe('https://www.congress.gov/crs-product/R42699');
    expect(CRS_WAR_POWERS_REPORT.number).toBe('R42699');
    expect(CRS_WAR_POWERS_REPORT.title).toBe('The War Powers Resolution: Concepts and Practice');
    // The version read on 2026-09-29 (version 17), which the line's
    // "March 2019" names.
    expect(CRS_WAR_POWERS_REPORT.published).toBe('2019-03-08');
  });

  test('no claim the record does not hold: no "at war", no state of operations, no word on the president\'s compliance', () => {
    const texts = [
      en.bill.concurrent.general,
      en.bill.concurrent.warPowers,
      en.bill.concurrent.crsSource,
      en.bill.concurrent.aiNote,
      es.bill.concurrent.general,
      es.bill.concurrent.warPowers,
      es.bill.concurrent.crsSource,
      es.bill.concurrent.aiNote,
      en.bill.settled.adopted,
      es.bill.settled.adopted,
      en.glossary.terms['concurrent-resolution'].body,
      es.glossary.terms['concurrent-resolution'].body,
    ].map(plain);
    const FORBIDDEN = [
      /\bat war\b/i,
      /\bwar with\b/i,
      /\bstill (fighting|at war|in combat)\b/i,
      /\ben guerra\b/i,
      /\bguerra con\b/i,
      // Nothing about what the president has or has not done.
      /\b(ignor|defied|defies|defy|compl(y|ied|ies|iance)|obey|disobey)/i,
      /\b(ignor|desafi|cumpli|acat|desobedec)/i,
      // Nothing about operations continuing or ending.
      /\boperations? (continue|continued|ended|end)\b/i,
      /\boperaciones (contin|termin)/i,
    ];
    for (const s of texts) {
      for (const re of FORBIDDEN) expect(s, `${re} in: ${s}`).not.toMatch(re);
    }
  });

  test('"the president", lowercase, with the article (docs/copy-style.md)', () => {
    for (const s of [
      en.bill.concurrent.general,
      en.bill.concurrent.warPowers,
      es.bill.concurrent.general,
      es.bill.concurrent.warPowers,
    ]) {
      expect(s).not.toMatch(/President|Presidente/);
    }
    expect(en.bill.concurrent.general).toContain('the president');
    expect(es.bill.concurrent.general).toContain('al presidente');
  });

  test('every key exists in both languages, the Spanish is not an English copy, and the AI note says who wrote it', () => {
    for (const key of ['general', 'bindsQuestion', 'warPowers', 'crsSource', 'aiNote'] as const) {
      expect(typeof en.bill.concurrent[key], `en.bill.concurrent.${key}`).toBe('string');
      expect(typeof es.bill.concurrent[key], `es.bill.concurrent.${key}`).toBe('string');
      expect(es.bill.concurrent[key], `es.bill.concurrent.${key}`).not.toBe(en.bill.concurrent[key]);
    }
    expect(Object.keys(en.bill.concurrent).sort()).toEqual(Object.keys(es.bill.concurrent).sort());
    // Rule 4: labeled as AI-drafted, and never "reviewed".
    expect(en.bill.concurrent.aiNote).toMatch(/\bAI\b/);
    expect(es.bill.concurrent.aiNote).toMatch(/\bIA\b/);
    expect(en.bill.concurrent.aiNote).not.toMatch(/review/i);
    expect(es.bill.concurrent.aiNote).not.toMatch(/revis/i);
  });
});
