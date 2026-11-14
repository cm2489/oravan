import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IntlMessageFormat } from 'intl-messageformat';
import coverageData from '../data/coverage.json';
import en from '../messages/en.json';
import es from '../messages/es.json';
import {
  TWIN_ARTICLES_MAX,
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
  RELATED_BILLS_SCHEMA,
  emptyRelatedBills,
  identicalFromRecord,
  planRelatedRun,
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
  ...emptyRelatedBills(),
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
    // …and a Big Question bill keeps it (his 2026-09-28 ruling), with the note.
    expect(coverageForBillPage(narrowed.articles, true)).toHaveLength(3);
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

  test('the committed file passes its own gate', () => {
    const related = JSON.parse(readFileSync(join(process.cwd(), 'data/related-bills.json'), 'utf8'));
    expect(verifyRelatedBills({ data: related, today: new Date().toISOString().slice(0, 10) }).failures).toEqual([]);
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
      expect(m.coverage.subheadTwins).toContain(m === en ? 'identical' : 'idéntico');
      // The rest of the intro (the lean sentence) is the shipped one, word for word.
      const leanSentence = m.coverage.subhead.slice(m.coverage.subhead.indexOf('. ') + 2);
      expect(m.coverage.subheadTwins.endsWith(leanSentence)).toBe(true);
      expect(m.coverage.oneSidedNoteTwins).not.toBe(m.coverage.oneSidedNote);
    }
  });
});

test.describe('the nightly writer (scripts/sync-related.mjs), network stubbed', () => {
  const REPO = process.cwd();
  const SCRIPT = join(REPO, 'scripts/sync-related.mjs');
  const MOCK = pathToFileURL(join(REPO, 'tests/fixtures/sync-related-fetch-mock.mjs')).href;
  const KEY = 'test-congress-key-DO-NOT-PRINT';
  const bill = (type: string, number: number) => ({ bill_type: type, bill_number: number, congress_number: 119 });

  function run(dir: string, scenario: Record<string, unknown>, env: Record<string, string> = {}) {
    writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
    const r = spawnSync(process.execPath, ['--import', MOCK, SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        CONGRESS_API_KEY: KEY,
        RELATED_MOCK_SCENARIO: join(dir, 'scenario.json'),
        RELATED_MOCK_LOG: join(dir, 'requests.log'),
        ...env,
      } as unknown as NodeJS.ProcessEnv,
      timeout: 90_000,
    });
    return { ...r, out: `${r.stdout}${r.stderr}` };
  }

  function corpus() {
    const dir = mkdtempSync(join(tmpdir(), 'sync-related-'));
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data/bills.json'), JSON.stringify([bill('hr', 10), bill('s', 20), bill('hr', 30)]));
    writeFileSync(
      join(dir, 'data/coverage.json'),
      JSON.stringify({ _checkedAt: {}, 'hr-10-119': [{ url: 'https://a.test/1' }], 'hr-30-119': [{ url: 'https://b.test/1' }] })
    );
    return dir;
  }

  test('looks up bills with coverage, keeps "Identical bill" only, and passes its own gate', () => {
    const dir = corpus();
    try {
      const r = run(dir, {
        'hr/10': {
          relatedBills: [
            { congress: 119, number: 20, type: 'S', relationshipDetails: [{ type: 'Identical bill', identifiedBy: 'CRS' }] },
            { congress: 119, number: 30, type: 'HR', relationshipDetails: [{ type: 'Related bill', identifiedBy: 'CRS' }] },
          ],
        },
        'hr/30': { relatedBills: [] },
      });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('RELATED DONE: looked up 2 of 2 planned (0 failed');
      expect(r.out).not.toContain(KEY);
      const written = JSON.parse(readFileSync(join(dir, 'data/related-bills.json'), 'utf8'));
      expect(written._meta).toEqual({ schema: RELATED_BILLS_SCHEMA, kept_types: ['Identical bill'] });
      expect(written['hr-10-119']).toEqual([{ slug: 's-20-119', type: 'Identical bill', identifiedBy: ['CRS'] }]);
      expect(written['hr-30-119']).toBeUndefined(); // none: left out, but dated
      expect(Object.keys(written._checkedAt).sort()).toEqual(['hr-10-119', 'hr-30-119']);
      // s-20 has no coverage, so it costs no request: the relation is read both ways.
      expect(readFileSync(join(dir, 'requests.log'), 'utf8').trim().split('\n').sort()).toEqual([
        '/v3/bill/119/hr/10/relatedbills',
        '/v3/bill/119/hr/30/relatedbills',
      ]);
      const today = new Date().toISOString().slice(0, 10);
      expect(verifyRelatedBills({ data: written, today }).failures).toEqual([]);
      // A second run the same day looks nothing up (each bill at most once a week).
      const again = run(dir, {});
      expect(again.out).toContain('looked up 0 of 0 planned');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a night on which every lookup fails leaves the file byte-for-byte as it was', () => {
    test.setTimeout(120_000); // the shared fetcher retries a failed request four times
    const dir = corpus();
    try {
      writeFileSync(join(dir, 'data/coverage.json'), JSON.stringify({ 'hr-10-119': [{ url: 'https://a.test/1' }] }));
      const before = `${JSON.stringify(
        { ...emptyRelatedBills(), _checkedAt: { 'hr-30-119': '2026-01-01' }, 'hr-30-119': [{ slug: 's-20-119', type: 'Identical bill', identifiedBy: ['CRS'] }] },
        null,
        1
      )}\n`;
      writeFileSync(join(dir, 'data/related-bills.json'), before);
      const r = run(dir, { 'hr/10': 'fail' });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('all 1 lookups failed');
      expect(readFileSync(join(dir, 'data/related-bills.json'), 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with no key it only makes sure an empty, valid file exists', () => {
    const dir = corpus();
    try {
      const r = run(dir, {}, { CONGRESS_API_KEY: '' });
      expect(r.status, r.out).toBe(0);
      const written = JSON.parse(readFileSync(join(dir, 'data/related-bills.json'), 'utf8'));
      expect(written).toEqual(emptyRelatedBills());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the plan: never-checked first, then the oldest; a bill checked this week waits', () => {
    expect(
      planRelatedRun({
        candidates: ['hr-1-119', 'hr-2-119', 'hr-3-119', 'hr-4-119'],
        checkedAt: { 'hr-1-119': '2026-11-13', 'hr-2-119': '2026-10-01', 'hr-3-119': '2026-11-01' },
        today: '2026-11-14',
        perNight: 2,
        recheckDays: 7,
      })
    ).toEqual(['hr-4-119', 'hr-2-119']);
  });
});
