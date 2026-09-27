import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import {
  billSearchDoc,
  compareLastActionDesc,
  foldSearchText,
  isEmptyBillQuery,
  matchesBillQuery,
  parseBillQuery,
  readCitation,
  searchStem,
  teaserSearchDoc,
} from '../lib/bill-search.mjs';
import { billSlug, getAllBills, getTeasers, localizeBill } from '../lib/core/bills';
import { formatCitation } from '../lib/format';
import type { Bill } from '../lib/types';

/*
 * THE ONE BILL MATCHER (lib/bill-search.mjs) — the 2026-09-27 audit's SY-21.
 * Both search surfaces used to match the whole query as one substring: "Iran
 * war powers" returned 1 bill while the corpus held 12, and "hconres 89"
 * returned 0.
 *
 * Most of this file pins the rule on synthetic documents, so every case is a
 * fact about the code, not about tonight's corpus. The corpus-wide checks
 * derive their expectations from the corpus itself (the OFFICIAL title, which
 * a re-decode never rewrites, or the old rule run side by side), so a nightly
 * sync can never turn them red by rewording a summary.
 *
 * The MCP tool itself is exercised end to end, over the real stdio entry, in
 * tests/mcp-stdio.unit.spec.ts: lib/core/mcp.ts reaches `import 'server-only'`
 * (through lib/freshness.ts), which only that spawned entry knows how to shim.
 */

/** The MCP tool's topic label, read the way lib/core/mcp.ts's categoryLabel reads it. */
const categoryLabel = (id: string, locale: 'en' | 'es') =>
  ((locale === 'en' ? en : es).categories as Record<string, string>)[id] ?? id;

const doc = (slug: string, ...fields: Array<string | null>) => billSearchDoc(slug, fields);
const hits = (query: string, d: ReturnType<typeof doc>) => matchesBillQuery(parseBillQuery(query), d);

/* ------------------------------------------------------------------------ *
 * Citations
 * ------------------------------------------------------------------------ */

test.describe('citations', () => {
  const hconres89 = doc('hconres-89-119', 'Directing the President to remove forces from hostilities with Iran.');

  test('every common spelling of a bill number names the same bill', () => {
    for (const q of [
      'H.Con.Res. 89',
      'H. Con. Res. 89',
      'H.Con.Res.89',
      'hconres 89',
      'hconres89',
      'HCONRES89',
      'hconres-89',
      'hconres-89-119',
      'h con res 89',
    ]) {
      expect(parseBillQuery(q).citations, q).toEqual([
        { key: 'hconres89', congress: q.endsWith('-119') ? 119 : null },
      ]);
      expect(hits(q, hconres89), q).toBe(true);
    }
  });

  test('all eight bill types normalise, and leading zeros do not matter', () => {
    const cases: Array<[string, string]> = [
      ['H.R. 6500', 'hr6500'],
      ['h.r.6500,', 'hr6500'],
      ['HR 06500', 'hr6500'],
      ['S. 4668', 's4668'],
      ['s4668', 's4668'],
      ['H.Res. 12', 'hres12'],
      ['S. Res. 12', 'sres12'],
      ['H.J.Res. 45', 'hjres45'],
      ['S.J.Res.185', 'sjres185'],
      ['sjres 185', 'sjres185'],
      ['S.Con.Res. 7', 'sconres7'],
    ];
    for (const [q, key] of cases) expect(parseBillQuery(q).citations.map((c) => c.key), q).toEqual([key]);
  });

  test('a citation matches EXACTLY: no type confusion, no number prefixes', () => {
    // "s89" sits inside "hconres89"; "hr65" is a prefix of "hr650". Neither
    // may match — the old site rule's punctuation-stripped substring did both.
    expect(hits('S. 89', hconres89)).toBe(false);
    expect(hits('H.Res. 89', hconres89)).toBe(false);
    expect(hits('hconres 8', hconres89)).toBe(false);
    expect(hits('hr 65', doc('hr-650-119', 'A bill'))).toBe(false);
    expect(hits('hr 650', doc('hr-650-119', 'A bill'))).toBe(true);
  });

  test('a slug-shaped query also pins the Congress', () => {
    expect(hits('hconres-89-119', hconres89)).toBe(true);
    expect(hits('hconres-89-118', hconres89)).toBe(false);
    expect(hits('hconres 89', doc('hconres-89-118', 'An older one'))).toBe(true);
  });

  test('several citations are alternatives; words still narrow them', () => {
    const q = parseBillQuery('hr 1 s 2');
    expect(q.citations.map((c) => c.key)).toEqual(['hr1', 's2']);
    expect(matchesBillQuery(q, doc('hr-1-119', 'One'))).toBe(true);
    expect(matchesBillQuery(q, doc('s-2-119', 'Two'))).toBe(true);
    expect(matchesBillQuery(q, doc('s-3-119', 'Three'))).toBe(false);
    expect(hits('hconres 89 iran', hconres89)).toBe(true);
    expect(hits('hconres 89 tariffs', hconres89)).toBe(false);
  });

  test('words that only look like citations are words', () => {
    // A possessive, an abbreviation and an ordinary plural each put an "s"
    // before a number; none of them is S. <n>.
    for (const q of ['U.S. 2026', "women's 2026", 'women’s 2026', 'veterans 2026', 'sept. 24', 'Sec. 5', 'section 5(c)']) {
      expect(parseBillQuery(q).citations, q).toEqual([]);
    }
    // More than five digits is not a bill number.
    expect(parseBillQuery('hr 123456').citations).toEqual([]);
  });

  test('readCitation reads a whole slug or display citation, and nothing else', () => {
    expect(readCitation('hconres-89-119')).toEqual({ key: 'hconres89', congress: 119 });
    expect(readCitation('H.Con.Res. 89')).toEqual({ key: 'hconres89', congress: null });
    expect(readCitation('hr 1 x')).toBeNull();
    expect(readCitation('Iran')).toBeNull();
  });

  test('every slug in the corpus reads back as its own citation', () => {
    for (const b of getAllBills()) {
      expect(readCitation(billSlug(b)), billSlug(b)).toEqual({
        key: `${b.bill_type}${b.bill_number}`,
        congress: b.congress_number,
      });
      // …and so does its display citation, the form a reader copies.
      expect(readCitation(formatCitation(b.bill_type, b.bill_number))?.key).toBe(`${b.bill_type}${b.bill_number}`);
    }
  });

  test('a bare number or a bare type still finds the bill through its citation', () => {
    expect(hits('89', hconres89)).toBe(true);
    expect(hits('hconres', hconres89)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * Words
 * ------------------------------------------------------------------------ */

test.describe('words', () => {
  const hconres89 = doc(
    'hconres-89-119',
    'Directing the President, pursuant to section 5(c) of the War Powers Resolution, to remove United States Armed Forces from hostilities with Iran.',
    null,
    'Resolution would direct president to halt military action against Iran'
  );

  test('every word must match, in any order, in any field', () => {
    expect(hits('Iran war powers', hconres89)).toBe(true);
    expect(hits('powers war IRAN', hconres89)).toBe(true);
    // "halt" is only in the headline, "war" only in the title.
    expect(hits('halt war', hconres89)).toBe(true);
    // One word missing anywhere sinks it.
    expect(hits('Iran war powers tariffs', hconres89)).toBe(false);
  });

  test('a word never matches across two fields', () => {
    const d = doc('hr-1-119', 'war', 'powers');
    expect(hits('war powers', d)).toBe(true);
    expect(hits('warpowers', d)).toBe(false);
  });

  test('accents and case are ignored on both sides (Spanish queries)', () => {
    const d = doc('hr-2-119', 'An official English title', 'Resolución para limitar la acción militar contra Irán');
    for (const q of ['Irán', 'iran', 'IRAN', 'resolucion', 'RESOLUCIÓN', 'accion militar', 'acción militar irán']) {
      expect(hits(q, d), q).toBe(true);
    }
    expect(foldSearchText('Inmigración Ñandú')).toBe('inmigracion nandu');
  });

  test('function words are dropped in English and Spanish, unless they are all there is', () => {
    expect(parseBillQuery('the Iran war powers resolutions').words).toEqual(['iran', 'war', 'power', 'resolution']);
    expect(parseBillQuery('poderes de guerra de Irán').words).toEqual(['podere', 'guerra', 'iran']);
    expect(parseBillQuery('la ley sobre el aborto').words).toEqual(['ley', 'aborto']);
    // A query of nothing BUT function words still searches for them.
    expect(parseBillQuery('the').words).toEqual(['the']);
    expect(parseBillQuery('de la').words).toEqual(['de', 'la']);
  });

  test('the plural fold only ever strips one trailing "s" from words of 4+ letters', () => {
    expect(searchStem('resolutions')).toBe('resolution');
    expect(searchStem('fuerzas')).toBe('fuerza');
    expect(searchStem('congress')).toBe('congress');
    expect(searchStem('gas')).toBe('gas');
    expect(searchStem('iran')).toBe('iran');
    expect(hits('war powers resolutions', hconres89)).toBe(true);
  });

  test('blank or punctuation-only queries are empty; another script is not', () => {
    for (const q of ['', '   ', '...', ' - ']) expect(isEmptyBillQuery(parseBillQuery(q)), q).toBe(true);
    const other = parseBillQuery('中文');
    expect(isEmptyBillQuery(other)).toBe(false);
    expect(matchesBillQuery(other, hconres89)).toBe(false);
  });

  test('repeated words are searched once', () => {
    expect(parseBillQuery('iran Iran IRÁN').words).toEqual(['iran']);
  });
});

test('compareLastActionDesc: newest first, unknown dates last', () => {
  const dates = ['2026-06-24', null, '2026-09-24', '2026-03-05', null, '2026-09-16'];
  expect([...dates].sort(compareLastActionDesc)).toEqual([
    '2026-09-24',
    '2026-09-16',
    '2026-06-24',
    '2026-03-05',
    null,
    null,
  ]);
});

/* ------------------------------------------------------------------------ *
 * No regression: the old whole-phrase rule's results survive, corpus-wide
 * ------------------------------------------------------------------------ */

/** The field list lib/core/mcp.ts's searchDocFor hands billSearchDoc. */
const mcpFields = (b: Bill, locale: 'en' | 'es') => [
  b.title,
  b.short_title,
  b.ai_headline,
  b.ai_summary,
  ...(b.issue_tags ?? []).map((id) => categoryLabel(id, locale)),
];

test('for word queries the new rule returns a SUPERSET of the old whole-phrase substring rule', () => {
  // Phrases lifted from the corpus itself — two- and three-word runs from
  // every 25th bill's official title, both locales' headline — so the check
  // covers real vocabulary, not phrases chosen to pass.
  const bills = getAllBills();
  const phrases = new Set<string>();
  bills.forEach((b, i) => {
    if (i % 25 !== 0) return;
    for (const text of [b.title, b.ai_headline, localizeBill(b, 'es').ai_headline]) {
      const words = (text ?? '').split(/\s+/).filter(Boolean);
      if (words.length >= 4) {
        phrases.add(words.slice(1, 3).join(' '));
        phrases.add(words.slice(1, 4).join(' '));
      }
    }
  });
  expect(phrases.size).toBeGreaterThan(50);

  for (const locale of ['en', 'es'] as const) {
    const localized = bills.map((b) => localizeBill(b, locale));
    const docs = localized.map((b) => billSearchDoc(billSlug(b), mcpFields(b, locale)));
    for (const phrase of phrases) {
      const q = parseBillQuery(phrase);
      if (q.citations.length > 0) continue; // a bill number is deliberately exact now
      const old = phrase.toLowerCase();
      localized.forEach((b, i) => {
        const oldHit = [b.title, b.short_title, b.ai_headline, b.ai_summary].some((v) =>
          (v ?? '').toLowerCase().includes(old)
        );
        if (oldHit) expect(matchesBillQuery(q, docs[i]), `${locale} "${phrase}" lost ${billSlug(b)}`).toBe(true);
      });
    }
  }
});

/* ------------------------------------------------------------------------ *
 * The site's card shape (teaserSearchDoc, the bills page's field list)
 * ------------------------------------------------------------------------ */

test.describe('teaserSearchDoc (the bills page)', () => {
  const label = (tag: string) => (en.categories as Record<string, string>)[tag] ?? tag;

  test('searches title, headline, topic names and the citation', () => {
    const d = teaserSearchDoc(
      {
        slug: 'hconres-89-119',
        title: 'Directing the President, pursuant to section 5(c) of the War Powers Resolution, to remove forces',
        headline: 'Resolution would direct president to halt military action against Iran',
        tags: ['national_security'],
      },
      label
    );
    expect(matchesBillQuery(parseBillQuery('Iran war powers'), d)).toBe(true);
    expect(matchesBillQuery(parseBillQuery('H.Con.Res. 89'), d)).toBe(true);
    expect(matchesBillQuery(parseBillQuery(label('national_security')), d)).toBe(true);
    expect(matchesBillQuery(parseBillQuery('S. 89'), d)).toBe(false);
  });

  test('over the real feed, "Iran war powers" finds every teaser whose title carries all three words', () => {
    const teasers = getTeasers('en');
    const q = parseBillQuery('Iran war powers');
    const found = teasers.filter((t) => matchesBillQuery(q, teaserSearchDoc(t, label))).map((t) => t.slug);
    const byTitle = teasers
      .filter((t) => ['iran', 'war', 'powers'].every((w) => t.title.toLowerCase().includes(w)))
      .map((t) => t.slug);
    expect(byTitle.length).toBeGreaterThan(0);
    for (const s of byTitle) expect(found).toContain(s);
  });
});
