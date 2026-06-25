import { expect, test } from '@playwright/test';
// Relative import (not '@/'): lib/coverage.ts is plain (no 'server-only') and
// imports its JSON relatively, so the matcher resolves under the test runner.
import { coverageTier, leanFor, normalizeSource } from '../lib/coverage';
import type { CoverageArticle, Lean } from '../lib/types';

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
