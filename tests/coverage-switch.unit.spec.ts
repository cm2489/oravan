import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import coverageData from '../data/coverage.json';
import { coverageForBillPage, coverageShownOnBillPage, getCoverageWithTwins } from '../lib/coverage';
import { COVERAGE_BOX_ON } from '../lib/coverage-switch';
import { getMomentsForBill } from '../lib/moments';
import type { CoverageArticle, Lean } from '../lib/types';

/*
 * THE SWITCH for the "How it's being covered" box (lib/coverage-switch.ts;
 * owner, 2026-11-25, his card "'How it's being covered': remove it, as both
 * reviewers say?", answered "Remove it everywhere for now").
 *
 * Three halves, none of which opens a browser:
 *   1. the switch function on fixtures, both ways: off shows nothing for any
 *      bill; on is exactly the earlier rule (coverageForBillPage), so flipping
 *      it back restores the previous behaviour unchanged;
 *   2. the corpus binding, at the switch's current value, over every bill
 *      data/coverage.json stores (and their record twins);
 *   3. the render paths, read as source: every place that could draw the box,
 *      its lean labels, its notes or the cards' outlet count goes through the
 *      switch, and nothing else reaches the `coverage` messages.
 */

const article = (source: string, lean: Lean | null = null): CoverageArticle => ({
  title: 't',
  url: `https://${source}/x`,
  source,
  snippet: 's',
  publishedAt: '2026-11-20',
  lean,
});

const FIXTURES: { name: string; partOfBigQuestion: boolean; articles: CoverageArticle[] }[] = [
  { name: 'two-sided, not a vehicle', partOfBigQuestion: false, articles: [article('a.com', 'left'), article('b.com', 'right')] },
  { name: 'two-sided, a vehicle', partOfBigQuestion: true, articles: [article('a.com', 'left'), article('b.com', 'right')] },
  { name: 'one-sided, a vehicle', partOfBigQuestion: true, articles: [article('a.com', 'right'), article('b.com', 'right')] },
  { name: 'one-sided, not a vehicle', partOfBigQuestion: false, articles: [article('a.com', 'left'), article('b.com', 'left')] },
  { name: 'center only', partOfBigQuestion: false, articles: [article('a.com', 'center'), article('b.com', 'center')] },
  { name: 'unrated only', partOfBigQuestion: true, articles: [article('a.com'), article('b.com')] },
  { name: 'none', partOfBigQuestion: true, articles: [] },
];

test.describe('coverageShownOnBillPage — the switch, on fixture bills', () => {
  test('off: no bill shows a single article, Big Question or not', () => {
    for (const f of FIXTURES) {
      expect(coverageShownOnBillPage(f.articles, f.partOfBigQuestion, false), f.name).toEqual([]);
    }
  });

  test('on: exactly the earlier rule (coverageForBillPage), so flipping it back changes nothing else', () => {
    for (const f of FIXTURES) {
      expect(coverageShownOnBillPage(f.articles, f.partOfBigQuestion, true), f.name).toEqual(
        coverageForBillPage(f.articles, f.partOfBigQuestion)
      );
    }
    // And that rule still shows what it showed: a two-sided set, as stored.
    expect(coverageShownOnBillPage(FIXTURES[0].articles, false, true)).toEqual(FIXTURES[0].articles);
  });

  test('the default is the switch itself', () => {
    for (const f of FIXTURES) {
      expect(coverageShownOnBillPage(f.articles, f.partOfBigQuestion), f.name).toEqual(
        coverageShownOnBillPage(f.articles, f.partOfBigQuestion, COVERAGE_BOX_ON)
      );
    }
  });
});

test.describe('coverageShownOnBillPage — the corpus binding, at the current switch', () => {
  const slugs = Object.keys(coverageData).filter((k) => !k.startsWith('_'));

  test('every stored bill shows what the switch allows, and nothing else', () => {
    let wouldShow = 0;
    for (const slug of slugs) {
      const { articles } = getCoverageWithTwins(slug);
      const vehicle = getMomentsForBill(slug).length > 0;
      const before = coverageForBillPage(articles, vehicle);
      if (before.length > 0) wouldShow++;
      const now = coverageShownOnBillPage(articles, vehicle);
      expect(now, slug).toEqual(COVERAGE_BOX_ON ? before : []);
    }
    // Control: the stored data would still fill boxes if the switch were on,
    // so the "off" result above is the switch at work, not an empty corpus.
    test.skip(wouldShow === 0, 'the committed corpus holds no showable coverage');
    expect(wouldShow).toBeGreaterThan(0);
  });
});

/* ---- the render paths, read as source ---------------------------------- */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.(tsx?|mjs)$/.test(name)) out.push(rel);
  }
  return out;
}
const RENDER_FILES = [...walk('app'), ...walk('components')];

test.describe('the render paths go through the switch', () => {
  test('CoverageSection is mounted in one place only, behind COVERAGE_BOX_ON', () => {
    const mounts = RENDER_FILES.filter((f) => /<CoverageSection\b/.test(read(f)));
    expect(mounts).toEqual(['app/[locale]/bills/[id]/page.tsx']);
    const page = read('app/[locale]/bills/[id]/page.tsx');
    expect(page).toMatch(/\{COVERAGE_BOX_ON && \(\s*<CoverageSection\b/);
  });

  test('CoverageSection returns nothing on its own while the switch is off', () => {
    const src = read('components/CoverageSection.tsx');
    expect(src).toContain("from '@/lib/coverage-switch'");
    expect(src).toMatch(/if \(!COVERAGE_BOX_ON \|\| articles\.length === 0\) return null;/);
  });

  test('no page reads the box rule without the switch (the box and the Big Question cards’ outlet count)', () => {
    const bare = RENDER_FILES.filter((f) => /\bcoverageForBillPage\(/.test(read(f)));
    expect(bare, 'call coverageShownOnBillPage, which applies the switch').toEqual([]);
    const switched = RENDER_FILES.filter((f) => /\bcoverageShownOnBillPage\(/.test(read(f))).sort();
    expect(switched).toEqual(['app/[locale]/bills/[id]/page.tsx', 'app/[locale]/questions/[id]/page.tsx']);
  });

  test('only CoverageSection reads the `coverage` messages (heading, lean labels, notes)', () => {
    const readers = RENDER_FILES.filter((f) =>
      /(?:useTranslations|getTranslations)\(\s*['"]coverage['"]\s*\)|\bt\(\s*['"`]coverage\./.test(read(f))
    );
    expect(readers).toEqual(['components/CoverageSection.tsx']);
  });
});
