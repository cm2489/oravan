import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IntlMessageFormat } from 'intl-messageformat';
import coverageData from '../data/coverage.json';
import en from '../messages/en.json';
import es from '../messages/es.json';
import {
  TWIN_ARTICLES_MAX,
  boxCoverage,
  coverageCheckedAt,
  coverageCheckedAtWithTwins,
  coverageForBillPage,
  coverageTier,
  getCoverage,
  getCoverageWithTwins,
  mergeTwinCoverage,
} from '../lib/coverage';
import {
  KEPT_RELATION_TYPES,
  emptyRelatedBills,
  identicalFromRecord,
  twinsOf,
  verifyRelatedBills,
} from '../lib/related-bills.mjs';

import type { CoverageArticle, Lean } from '../lib/types';

/*
 * A bill's twin's press, shown under the bill (owner, 2026-11-13, his card:
 * "Show news about a bill's twin under the bill? …" — he chose "Yes, show it
 * under the bill as it is."). The relation comes from the record only:
 * Congress.gov's related-bills list, "Identical bill" (lib/related-bills.mjs).
 * The box shows the union under every rule it had (lib/coverage.ts).
 */

const art = (url: string, source: string, lean: Lean | null, publishedAt: string | null, title = url): CoverageArticle => ({
  title,
  url: `https://${source}/${url}`,
  source,
  snippet: null,
  publishedAt,
  lean,
});

const file = (rows: Record<string, { slug: string; type: string; identifiedBy?: string[] }[]>) => ({
  ...emptyRelatedBills('2026-11-14'),
  ...Object.fromEntries(
    Object.entries(rows).map(([k, v]) => [k, v.map((r) => ({ identifiedBy: ['CRS'], ...r }))])
  ),
});

test.describe('which bills are twins: the record, "Identical bill" only', () => {
  test('an identical bill is a twin, read in both directions', () => {
    const f = file({ 'hr-10-119': [{ slug: 's-20-119', type: 'Identical bill' }] });
    expect(twinsOf(f, 'hr-10-119')).toEqual(['s-20-119']);
    expect(twinsOf(f, 's-20-119')).toEqual(['hr-10-119']);
  });

  test('a merely related bill does NOT make a twin, whatever the label', () => {
    for (const type of ['Related bill', 'Procedurally related', 'Text similarities', 'Contained in public law', 'Cross-Congress related bill']) {
      const f = file({ 'hr-10-119': [{ slug: 's-20-119', type }] });
      expect(twinsOf(f, 'hr-10-119'), type).toEqual([]);
      expect(twinsOf(f, 's-20-119'), type).toEqual([]);
      expect(verifyRelatedBills({ data: { ...f, _checkedAt: { 'hr-10-119': '2026-11-01' } }, today: '2026-11-14' }).failures.length, type).toBeGreaterThan(0);
    }
  });

  test('the record payload is read for "Identical bill" only, same Congress, never itself', () => {
    const rows = identicalFromRecord(
      {
        relatedBills: [
          { congress: 119, number: 20, type: 'S', relationshipDetails: [{ type: 'Identical bill', identifiedBy: 'CRS' }] },
          // listed twice by the record, once per identifier: one row
          { congress: 119, number: 20, type: 'S', relationshipDetails: [{ type: 'Identical bill', identifiedBy: 'House' }] },
          { congress: 119, number: 707, type: 'HRES', relationshipDetails: [{ type: 'Procedurally related', identifiedBy: 'House' }] },
          { congress: 119, number: 30, type: 'HR', relationshipDetails: [{ type: 'Related bill', identifiedBy: 'CRS' }] },
          { congress: 119, number: 31, type: 'S', relationshipDetails: [{ type: 'Contained in public law', identifiedBy: 'CRS' }] },
          { congress: 118, number: 40, type: 'S', relationshipDetails: [{ type: 'Identical bill', identifiedBy: 'CRS' }] },
          { congress: 119, number: 10, type: 'HR', relationshipDetails: [{ type: 'Identical bill', identifiedBy: 'CRS' }] },
          { congress: 119, number: 50, type: 'SRES', relationshipDetails: [{ type: 'Identical bill', identifiedBy: 'CRS' }] },
        ],
      },
      'hr-10-119'
    );
    expect(rows).toEqual([{ slug: 's-20-119', type: 'Identical bill', identifiedBy: ['CRS', 'House'] }]);
    expect(KEPT_RELATION_TYPES).toEqual(['Identical bill']);
  });

  test("a bill that is its own twin's twin does not loop, and a twin's twin is not followed", () => {
    // A lists B, B lists A (the record usually lists both ways), B lists C.
    const f = file({
      'hr-10-119': [{ slug: 's-20-119', type: 'Identical bill' }],
      's-20-119': [
        { slug: 'hr-10-119', type: 'Identical bill' },
        { slug: 'hr-30-119', type: 'Identical bill' },
      ],
    });
    expect(twinsOf(f, 'hr-10-119')).toEqual(['s-20-119']);
    expect(twinsOf(f, 's-20-119')).toEqual(['hr-10-119', 'hr-30-119']);
    expect(twinsOf(f, 'hr-30-119')).toEqual(['s-20-119']);
    // A row naming the bill itself is ignored even if one got past the gate.
    expect(twinsOf(file({ 'hr-10-119': [{ slug: 'hr-10-119', type: 'Identical bill' }] }), 'hr-10-119')).toEqual([]);
  });
});

test.describe('what the box lists: own articles plus the twin’s, as they are', () => {
  test("an identical twin's article is added unchanged, and the twin is named", () => {
    const own = [art('a', 'npr.org', 'center', '2026-11-10'), art('b', 'foxnews.com', 'right', '2026-11-01')];
    const twinArticle = art('c', 'cnn.com', 'left', '2026-11-05', 'Senate committee advances the twin');
    const r = mergeTwinCoverage(own, [{ slug: 's-20-119', articles: [twinArticle] }]);
    expect(r.articles.map((a) => a.url)).toEqual([own[0].url, twinArticle.url, own[1].url]);
    expect(r.articles[1]).toBe(twinArticle); // the same object: headline, outlet, date, lean untouched
    expect(r.twins).toEqual(['s-20-119']);
  });

  test('an article stored under both bills is listed once (same URL, or same title)', () => {
    const shared = art('same', 'apnews.com', 'center', '2026-11-03', 'House passes the bill');
    const syndicated = { ...art('other-url', 'yahoo.com', null, '2026-11-03'), title: 'HOUSE  passes the bill' };
    const r = mergeTwinCoverage([shared], [{ slug: 's-20-119', articles: [{ ...shared }, syndicated] }]);
    expect(r.articles).toHaveLength(1);
    expect(r.twins).toEqual([]); // nothing of the twin's was added, so the box names no twin
    // …and two twins that share an article add it once.
    const x = art('x', 'npr.org', 'center', '2026-11-02');
    const two = mergeTwinCoverage([], [
      { slug: 's-20-119', articles: [x] },
      { slug: 'hr-30-119', articles: [{ ...x }] },
    ]);
    expect(two.articles).toHaveLength(1);
    expect(two.twins).toEqual(['s-20-119']);
  });

  test(`a twin adds at most ${TWIN_ARTICLES_MAX} articles, newest first, and never pushes an own article out`, () => {
    const own = Array.from({ length: 5 }, (_, i) => art(`own${i}`, `own${i}.com`, null, `2026-01-0${i + 1}`));
    const twin = Array.from({ length: 9 }, (_, i) => art(`tw${i}`, `tw${i}.com`, null, `2026-10-1${i}`));
    const r = mergeTwinCoverage(own, [{ slug: 's-20-119', articles: twin }]);
    expect(r.articles).toHaveLength(5 + TWIN_ARTICLES_MAX);
    for (const o of own) expect(r.articles).toContain(o);
    expect(r.articles.filter((a) => a.url.includes('/tw')).map((a) => a.publishedAt)).toEqual([
      '2026-10-18',
      '2026-10-17',
      '2026-10-16',
      '2026-10-15',
      '2026-10-14',
    ]);
  });

  test('undated articles sort last; on the same day the bill’s own comes first', () => {
    const own = art('own', 'npr.org', 'center', '2026-11-03');
    const twinSameDay = art('tw', 'cnn.com', 'left', '2026-11-03');
    const twinUndated = art('tw-undated', 'wsj.com', 'center', null);
    const r = mergeTwinCoverage([own], [{ slug: 's-20-119', articles: [twinUndated, twinSameDay] }]);
    expect(r.articles.map((a) => a.url)).toEqual([own.url, twinSameDay.url, twinUndated.url]);
  });

  test("a twin's coverage can flip the one-sided rule, both ways, and the existing rule decides the box", () => {
    // One-sided on its own; the twin's right-leaning article makes it two-sided:
    // a bill outside the Big Questions GAINS a box it did not show.
    const ownLeft = [art('a', 'cnn.com', 'left', '2026-11-10'), art('b', 'msnbc.com', 'left', '2026-11-09')];
    expect(coverageForBillPage(ownLeft, false)).toEqual([]);
    const flipped = mergeTwinCoverage(ownLeft, [{ slug: 's-20-119', articles: [art('c', 'foxnews.com', 'right', '2026-11-08')] }]);
    expect(coverageTier(flipped.articles)).toBe('cross');
    expect(coverageForBillPage(flipped.articles, false)).toHaveLength(3);

    // Neutral on its own (center + unrated); the twin adds only a left-leaning
    // outlet: one-sided, so outside the Big Questions the box is HIDDEN…
    const ownNeutral = [art('d', 'apnews.com', 'center', '2026-11-10'), art('e', 'example.org', null, '2026-11-09')];
    expect(coverageForBillPage(ownNeutral, false)).toHaveLength(2);
    const narrowed = mergeTwinCoverage(ownNeutral, [{ slug: 's-20-119', articles: [art('f', 'cnn.com', 'left', '2026-11-08')] }]);
    expect(coverageTier(narrowed.articles)).toBe('one_sided');
    expect(coverageForBillPage(narrowed.articles, false)).toEqual([]);
    // …so outside the Big Questions the box shows the bill's OWN list, as on
    // main, naming no twin (a twin never hides a box; see below)…
    expect(boxCoverage(ownNeutral, narrowed, false)).toEqual({ articles: ownNeutral, twins: [] });
    // …and a Big Question bill keeps the combined list (his 2026-09-28
    // ruling), with the one-sided note.
    expect(coverageForBillPage(narrowed.articles, true)).toHaveLength(3);
    expect(boxCoverage(ownNeutral, narrowed, true)).toEqual(narrowed);
  });

  test('one outlet across both bills is still too thin to show', () => {
    const r = mergeTwinCoverage([art('a', 'npr.org', 'center', '2026-11-10')], [
      { slug: 's-20-119', articles: [art('b', 'npr.org', 'center', '2026-11-09')] },
    ]);
    expect(coverageTier(r.articles)).toBe('none');
  });
});

test.describe('on the committed data', () => {
  const slugs = Object.keys(coverageData).filter((k) => !k.startsWith('_'));

  test('a bill with no twin carrying coverage reads exactly as before', () => {
    let compared = 0;
    for (const s of slugs) {
      const r = getCoverageWithTwins(s);
      if (r.twins.length > 0) continue;
      expect(r.articles, s).toEqual(getCoverage(s));
      expect(coverageCheckedAtWithTwins(s, r.twins), s).toBe(coverageCheckedAt(s));
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
  });

  test('every listed twin article really is stored under a twin the record names', () => {
    const related = JSON.parse(readFileSync(join(process.cwd(), 'data/related-bills.json'), 'utf8'));
    const cov = coverageData as unknown as Record<string, { url: string }[]>;
    for (const s of slugs) {
      const r = getCoverageWithTwins(s);
      const own = new Set((cov[s] ?? []).map((a) => a.url));
      for (const t of r.twins) expect(twinsOf(related, s), s).toContain(t);
      for (const a of r.articles) {
        if (own.has(a.url)) continue;
        expect(
          r.twins.some((t) => (cov[t] ?? []).some((x) => x.url === a.url)),
          `${s}: ${a.url}`
        ).toBe(true);
      }
    }
  });

  test('the committed file passes its own gate (its shape; the date rule is CI\'s check-related-bills)', () => {
    const related = JSON.parse(readFileSync(join(process.cwd(), 'data/related-bills.json'), 'utf8'));
    // A pinned far date, not today's clock: this pins the file's shape only, so
    // it cannot start failing by itself as days pass. The "no check day after
    // today" rule is CI's scripts/check-related-bills.mjs, on the real clock.
    expect(verifyRelatedBills({ data: related, today: '2099-12-31' }).failures).toEqual([]);
  });
});

test.describe('the wording, both languages (hard rules 4 and 5)', () => {
  test('the intro names the twin when, and only when, its articles are listed', () => {
    for (const [locale, m, cite] of [
      ['en', en, 'S. 20'],
      ['es', es, 'S. 20'],
    ] as const) {
      const one = new IntlMessageFormat(m.coverage.subheadTwins, locale).format({ citations: cite, count: 1 }) as string;
      const two = new IntlMessageFormat(m.coverage.subheadTwins, locale).format({ citations: 'S. 20 / H.R. 30', count: 2 }) as string;
      expect(one).toContain(cite);
      expect(one).not.toBe(two);
      expect(m.coverage.subheadTwins).toContain(m === en ? 'identical to it' : 'idéntico a este');
      if (m === es) expect(m.coverage.subheadTwins).toContain('idénticos a este');
      // The rest of the intro (the lean sentence) is the shipped one, word for word.
      const leanSentence = m.coverage.subhead.slice(m.coverage.subhead.indexOf('. ') + 2);
      expect(m.coverage.subheadTwins.endsWith(leanSentence)).toBe(true);
      expect(m.coverage.oneSidedNoteTwins).not.toBe(m.coverage.oneSidedNote);
    }
  });
});

test.describe('a twin never hides a box (2026-11-17)', () => {
  // The independent check's case: outside the Big Questions, the bill's own
  // articles are from two center outlets (a box on main); its twin's are
  // left only, so the combined list is one-sided and would be hidden.
  const own = [
    art('o1', 'apnews.com', 'center', '2026-11-10'),
    art('o2', 'reuters.com', 'center', '2026-11-09'),
    art('o3', 'apnews.com', 'center', '2026-11-08'),
    art('o4', 'reuters.com', 'center', '2026-11-07'),
  ];
  const twin = { slug: 's-20-119', articles: [art('t1', 'cnn.com', 'left', '2026-11-06'), art('t2', 'msnbc.com', 'left', '2026-11-05')] };

  test("the check's fixture: the own box shows exactly as on main, and no twin is named", () => {
    const merged = mergeTwinCoverage(own, [twin]);
    expect(coverageForBillPage(merged.articles, false)).toEqual([]); // the combined list alone would hide it
    const box = boxCoverage(own, merged, false);
    expect(box).toEqual({ articles: own, twins: [] });
    expect(coverageForBillPage(box.articles, false)).toHaveLength(4); // what main shows
  });

  test('a twin still ADDS a box the own articles could not show, and is named', () => {
    const thin = [art('o1', 'apnews.com', 'center', '2026-11-10')]; // one outlet: no box on main
    const merged = mergeTwinCoverage(thin, [{ slug: 's-20-119', articles: [art('t1', 'wsj.com', 'center', '2026-11-09')] }]);
    expect(coverageForBillPage(boxCoverage(thin, merged, false).articles, false)).toHaveLength(2);
    expect(boxCoverage(thin, merged, false).twins).toEqual(['s-20-119']);
  });

  test('a twin still turns a one-sided list into both sides, and is named', () => {
    const left = [art('o1', 'cnn.com', 'left', '2026-11-10'), art('o2', 'msnbc.com', 'left', '2026-11-09')];
    const merged = mergeTwinCoverage(left, [{ slug: 's-20-119', articles: [art('t1', 'foxnews.com', 'right', '2026-11-08')] }]);
    for (const bq of [false, true]) {
      const box = boxCoverage(left, merged, bq);
      expect(coverageTier(box.articles)).toBe('cross');
      expect(box.twins).toEqual(['s-20-119']);
    }
  });

  test('THE PROPERTY, over every small mix of leans: whenever the own list shows a box, the result shows one', () => {
    const leans: (Lean | null)[] = ['left', 'center', 'right', null];
    const lists = (prefix: string, max: number): CoverageArticle[][] => {
      const out: CoverageArticle[][] = [[]];
      for (let n = 1; n <= max; n++) {
        const next: CoverageArticle[][] = [];
        for (const base of out.filter((l) => l.length === n - 1)) {
          for (const lean of leans) next.push([...base, art(`${prefix}${n}`, `${prefix}${n}-${lean}.test`, lean, `2026-11-${10 + n}`)]);
        }
        out.push(...next);
      }
      return out;
    };
    let cases = 0;
    let rescued = 0;
    for (const o of lists('own', 3)) {
      for (const t of lists('twin', 2)) {
        for (const bq of [false, true]) {
          const merged = mergeTwinCoverage(o, t.length ? [{ slug: 's-20-119', articles: t }] : []);
          const box = boxCoverage(o, merged, bq);
          const ownShown = coverageForBillPage(coverageTier(o) === 'none' ? [] : o, bq).length > 0;
          const shown = coverageForBillPage(box.articles, bq).length > 0;
          if (ownShown) expect(shown, JSON.stringify({ o: o.map((a) => a.lean), t: t.map((a) => a.lean), bq })).toBe(true);
          // A twin is named only when the box actually lists one of its articles.
          if (box.twins.length) expect(box.articles.some((a) => t.includes(a))).toBe(true);
          if (ownShown && coverageForBillPage(merged.articles, bq).length === 0) rescued++;
          cases++;
        }
      }
    }
    expect(cases).toBe(85 * 21 * 2);
    expect(rescued).toBeGreaterThan(0); // the rule is exercised, not vacuous
  });
});

test('with no twin, the box list is the own list exactly, in its stored order', () => {
  // Stored out of date order (as a re-filed row can leave it): no twin, no re-sort.
  const own = [art('a', 'npr.org', 'center', '2026-11-01'), art('b', 'wsj.com', 'center', '2026-11-09')];
  const box = boxCoverage(own, mergeTwinCoverage(own, []), false);
  expect(box.articles).toBe(own);
  expect(box.twins).toEqual([]);
});
