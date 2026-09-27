import { expect, test } from '@playwright/test';
// Relative import (not '@/'): lib/coverage.ts is plain (no 'server-only') and
// imports its JSON relatively, so the matcher resolves under the test runner.
import coverageData from '../data/coverage.json';
import {
  coverageOutletCount,
  coverageTier,
  getCoverage,
  leanFor,
  normalizeSource,
  rankNews,
  ratedCoverage,
} from '../lib/coverage';
import type { CoverageArticle, CoverageTier, Lean } from '../lib/types';

const article = (source: string, lean: Lean | null = null): CoverageArticle => ({
  title: 't',
  url: `https://${source}/x`,
  source,
  snippet: 's',
  publishedAt: null,
  lean,
});

test.describe('coverage matcher', () => {
  test('normalizeSource reduces any source form to a bare domain', () => {
    expect(normalizeSource('https://www.CNN.com/politics/x')).toBe('cnn.com');
    expect(normalizeSource('www.foxnews.com')).toBe('foxnews.com');
    expect(normalizeSource('NPR.org')).toBe('npr.org');
    expect(normalizeSource('  thehill.com  ')).toBe('thehill.com');
  });

  test('leanFor returns the AllSides lean for rated outlets', () => {
    expect(leanFor('cnn.com')).toBe('left');
    expect(leanFor('https://www.foxnews.com/politics/x')).toBe('right');
    expect(leanFor('thehill.com')).toBe('center');
  });

  test('leanFor returns null for unrated outlets (no chip)', () => {
    expect(leanFor('chir.georgetown.edu')).toBeNull();
    expect(leanFor('example.com')).toBeNull();
    expect(leanFor('')).toBeNull();
  });
});

test.describe('coverageTier', () => {
  test("'none' when fewer than two distinct outlets", () => {
    expect(coverageTier([])).toBe('none');
    expect(coverageTier([article('breitbart.com', 'right')])).toBe('none');
    // one outlet, two articles -> still not "how it's being covered"
    expect(coverageTier([article('cnn.com', 'left'), article('cnn.com', 'left')])).toBe('none');
  });

  test("'cross' when left and right are both present", () => {
    expect(coverageTier([article('cnn.com', 'left'), article('foxnews.com', 'right')])).toBe('cross');
  });

  test("'one_sided' when 2+ outlets all lean one partisan way", () => {
    expect(coverageTier([article('breitbart.com', 'right'), article('dailycaller.com', 'right')])).toBe('one_sided');
    // a partisan outlet + a center one is still one-sided (no opposing side)
    expect(coverageTier([article('breitbart.com', 'right'), article('reuters.com', 'center')])).toBe('one_sided');
  });

  test("'neutral' when 2+ outlets are all center/unrated", () => {
    expect(coverageTier([article('nextgov.com', null), article('cyberscoop.com', null)])).toBe('neutral');
    expect(coverageTier([article('reuters.com', 'center'), article('apnews.com', 'center')])).toBe('neutral');
  });
});

/*
 * These three ordering pins predate the recency gate (2026-08-12) and every one
 * of them still asserts exactly what it always did. What changed is the ITEM
 * SHAPE: rankNews now also reads `newestArticle`, so the factory dates every
 * item inside the window. The pins are about ORDER, and dating them keeps them
 * about order — an undated item would now be dropped by the gate and all three
 * would have started passing vacuously. The gate itself is pinned in
 * tests/act-now-pool.unit.spec.ts.
 */
test.describe('rankNews (the "In the news" lens order)', () => {
  const NOW = Date.parse('2026-08-12T12:00:00Z');
  const fresh = new Date(NOW - 2 * 86_400_000).toISOString().slice(0, 10);
  const item = (tier: CoverageTier, sources: number, urgency = 0.5) => ({
    tier,
    sources,
    urgency,
    newestArticle: fresh,
  });

  test('drops one-sided and none — only cross/neutral surface', () => {
    const r = rankNews([item('cross', 2), item('one_sided', 9), item('none', 5), item('neutral', 2)], 10, NOW);
    expect(r.map((x) => x.tier)).toEqual(['cross', 'neutral']);
  });

  test('orders cross before neutral, then by #sources, then urgency', () => {
    const r = rankNews([item('neutral', 9), item('cross', 2), item('cross', 4)], 10, NOW);
    expect(r.map((x) => [x.tier, x.sources])).toEqual([['cross', 4], ['cross', 2], ['neutral', 9]]);
  });

  test('caps at n', () => {
    expect(rankNews([item('cross', 1), item('cross', 2), item('neutral', 1)], 1, NOW)).toHaveLength(1);
  });
});

/*
 * THE RATED-ONLY FLOOR (owner ruling n1, 2026-09-26; the 2026-09-27 audit's
 * SY-04). The Read section, the Big Question vehicle card's "N outlets" chip
 * and the fallback news band all read getCoverage, which now keeps only
 * articles from outlets with a lean in data/media-bias.json and returns
 * nothing below two distinct rated outlets.
 */
test.describe('ratedCoverage / coverageOutletCount — rated outlets only', () => {
  const raw = (source: string, title = `on ${source}`) => ({
    title,
    url: `https://${source}/${title.replace(/\W+/g, '-')}`,
    source,
    snippet: null,
    publishedAt: '2026-09-20',
  });

  test('unrated articles are never shown, and the rated ones carry their lean', () => {
    const shown = ratedCoverage([raw('cnn.com'), raw('naturalnews.com'), raw('foxnews.com'), raw('rttnews.com')]);
    expect(shown.map((a) => a.source)).toEqual(['cnn.com', 'foxnews.com']);
    expect(shown.map((a) => a.lean)).toEqual(['left', 'right']);
  });

  test('the H.Con.Res. 89 shape — unrated outlets only — shows nothing', () => {
    expect(
      ratedCoverage([
        raw('thestockmarketwatch.com'),
        raw('hurriyetdailynews.com'),
        raw('naturalnews.com'),
        raw('rttnews.com'),
        raw('timesofindia.indiatimes.com'),
      ]),
    ).toEqual([]);
  });

  test('one rated outlet among unrated ones is still too thin — the floor is two RATED outlets', () => {
    expect(ratedCoverage([raw('cnn.com'), raw('naturalnews.com'), raw('rttnews.com')])).toEqual([]);
    expect(ratedCoverage([raw('cnn.com', 'a'), raw('cnn.com', 'b')])).toEqual([]);
  });

  test('the tier is judged on the rated set alone', () => {
    // Two right-rated outlets plus an unrated one: one-sided, whatever the unrated one says.
    const shown = ratedCoverage([raw('breitbart.com'), raw('dailycaller.com'), raw('naturalnews.com')]);
    expect(coverageTier(shown)).toBe('one_sided');
  });

  test('the chip counts distinct rated outlets, and is 0 when the section would not render', () => {
    const shown = ratedCoverage([raw('cnn.com', 'a'), raw('https://www.cnn.com', 'b'), raw('foxnews.com'), raw('naturalnews.com')]);
    expect(coverageOutletCount(shown)).toBe(2);
    expect(coverageOutletCount(ratedCoverage([raw('naturalnews.com'), raw('rttnews.com')]))).toBe(0);
  });

  test('getCoverage never returns an unrated article anywhere in the committed corpus', () => {
    let shownBills = 0;
    for (const slug of Object.keys(coverageData).filter((k) => !k.startsWith('_'))) {
      const shown = getCoverage(slug);
      if (shown.length === 0) continue;
      shownBills++;
      for (const a of shown) expect(leanFor(a.source), `${slug} ${a.source}`).not.toBeNull();
      expect(coverageOutletCount(shown), slug).toBeGreaterThanOrEqual(2);
    }
    // Non-vacuity: the corpus still renders some sections.
    expect(shownBills).toBeGreaterThan(0);
  });
});
