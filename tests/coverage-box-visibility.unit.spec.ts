import { expect, test } from '@playwright/test';
import coverageData from '../data/coverage.json';
import { coverageForBillPage, coverageTier, getCoverage } from '../lib/coverage';
import { getMomentsForBill } from '../lib/moments';
import type { CoverageArticle, Lean } from '../lib/types';

/*
 * Which bill pages show the "Read" coverage box (owner, 2026-11-13: "hide the
 * box on non-Big-Question bills when it shows only one side"). His 2026-09-28
 * ruling stands: a Big Question bill keeps its box, one-sided or not.
 *
 * Two halves, like tests/moments-backlink.unit.spec.ts: the rule is pinned on
 * fixture bills (so every case is provable whatever the corpus holds today),
 * and the corpus binding is swept over every bill data/coverage.json stores,
 * with no bill id written down here.
 */

const article = (source: string, lean: Lean | null = null): CoverageArticle => ({
  title: 't',
  url: `https://${source}/x`,
  source,
  snippet: 's',
  publishedAt: null,
  lean,
});

/** A fixture bill: its stored articles and whether it is a Big Question vehicle. */
const FIXTURES = {
  oneSidedNotAVehicle: {
    partOfBigQuestion: false,
    articles: [article('breitbart.com', 'right'), article('dailycaller.com', 'right')],
  },
  // One partisan outlet plus a center one is still one side: the same
  // reading coverageTier has always given (and CoverageSection's note reads).
  oneSidedWithCenterNotAVehicle: {
    partOfBigQuestion: false,
    articles: [article('cnn.com', 'left'), article('reuters.com', 'center'), article('example.com', null)],
  },
  oneSidedVehicle: {
    partOfBigQuestion: true,
    articles: [article('breitbart.com', 'right'), article('dailycaller.com', 'right')],
  },
  twoSidedNotAVehicle: {
    partOfBigQuestion: false,
    articles: [article('cnn.com', 'left'), article('foxnews.com', 'right')],
  },
  twoSidedVehicle: {
    partOfBigQuestion: true,
    articles: [article('cnn.com', 'left'), article('foxnews.com', 'right')],
  },
  neutralNotAVehicle: {
    partOfBigQuestion: false,
    articles: [article('reuters.com', 'center'), article('apnews.com', 'center')],
  },
  noCoverageNotAVehicle: { partOfBigQuestion: false, articles: [] },
  noCoverageVehicle: { partOfBigQuestion: true, articles: [] },
  oneOutletNotAVehicle: {
    partOfBigQuestion: false,
    articles: [article('breitbart.com', 'right'), article('breitbart.com', 'right')],
  },
} as const;

test.describe('coverageForBillPage — the rule, on fixture bills', () => {
  test('one-sided and not a vehicle of a Big Question: the box is hidden', () => {
    for (const f of [FIXTURES.oneSidedNotAVehicle, FIXTURES.oneSidedWithCenterNotAVehicle]) {
      expect(coverageTier([...f.articles])).toBe('one_sided');
      expect(coverageForBillPage([...f.articles], f.partOfBigQuestion)).toEqual([]);
    }
  });

  test('one-sided and a vehicle of a Big Question: the box is shown, unchanged', () => {
    const f = FIXTURES.oneSidedVehicle;
    expect(coverageTier([...f.articles])).toBe('one_sided');
    expect(coverageForBillPage([...f.articles], f.partOfBigQuestion)).toEqual(f.articles);
  });

  test('coverage from more than one side is shown, vehicle or not', () => {
    for (const f of [FIXTURES.twoSidedNotAVehicle, FIXTURES.twoSidedVehicle]) {
      expect(coverageTier([...f.articles])).toBe('cross');
      expect(coverageForBillPage([...f.articles], f.partOfBigQuestion)).toEqual(f.articles);
    }
  });

  test('center-only (neutral) coverage is not one-sided, so it is shown', () => {
    const f = FIXTURES.neutralNotAVehicle;
    expect(coverageTier([...f.articles])).toBe('neutral');
    expect(coverageForBillPage([...f.articles], f.partOfBigQuestion)).toEqual(f.articles);
  });

  test('no coverage shows nothing, as before, for either kind of bill', () => {
    expect(coverageForBillPage([...FIXTURES.noCoverageNotAVehicle.articles], false)).toEqual([]);
    expect(coverageForBillPage([...FIXTURES.noCoverageVehicle.articles], true)).toEqual([]);
  });

  test('"one side" is the tier CoverageSection reads for its note, not a new definition', () => {
    // A set below the two-outlet floor is 'none', never 'one_sided': the rule
    // must not start hiding (or showing) anything that tier did not.
    const f = FIXTURES.oneOutletNotAVehicle;
    expect(coverageTier([...f.articles])).toBe('none');
    expect(coverageForBillPage([...f.articles], f.partOfBigQuestion)).toEqual(f.articles);
  });
});

test.describe('coverageForBillPage — the corpus binding', () => {
  const slugs = Object.keys(coverageData).filter((k) => !k.startsWith('_'));

  test('every stored bill: only a non-Big-Question one-sided set is hidden', () => {
    for (const slug of slugs) {
      const stored = getCoverage(slug);
      const vehicle = getMomentsForBill(slug).length > 0;
      const shown = coverageForBillPage(stored, vehicle);
      const oneSided = stored.length > 0 && coverageTier(stored) === 'one_sided';
      if (oneSided && !vehicle) {
        expect(shown, `${slug} is one-sided and not a vehicle`).toEqual([]);
      } else {
        expect(shown, `${slug} must be unchanged`).toEqual(stored);
      }
    }
  });
});
