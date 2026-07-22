import { expect, test } from '@playwright/test';
import { billSlug, getTopActions, hasActNow } from '../lib/core';
import { anyNowAt, anyTopAt, stableAcross, topActionSlugsAt } from './corpus';

/*
 * Drift canary: tests/corpus.ts re-derives lib/core/bills.ts's scoring with
 * an injectable clock (the production path deliberately reads the real
 * clock). A mirror that drifts from the real implementation is the exact
 * failure mode docs/solutions/stale-urgency-freeze.md closed for the curve
 * itself — so the mirror is pinned here against the functions it mirrors,
 * evaluated at the same instant. If one of these fails, tests/corpus.ts no
 * longer describes the site and every spec importing it is asserting
 * fiction: fix the mirror, never the pin.
 *
 * Skips (rather than flakes) when the corpus sits at a scoring boundary —
 * the mirror runs at this file's Date.now(), lib/core at its own a few
 * milliseconds later, and a knife-edge corpus could legitimately disagree
 * across even that gap.
 */
test.describe('tests/corpus.ts mirrors lib/core/bills.ts', () => {
  const stable = stableAcross((at) => [anyNowAt(at), topActionSlugsAt(at)]);

  test('hasActNow agrees with anyNowAt', () => {
    test.skip(!stable, 'corpus sits at a scoring boundary right now');
    expect(anyNowAt(Date.now())).toBe(hasActNow());
  });

  test('getTopActions agrees with topActionSlugsAt, order included', () => {
    test.skip(!stable, 'corpus sits at a scoring boundary right now');
    expect(topActionSlugsAt(Date.now())).toEqual(getTopActions(10_000).map(billSlug));
  });

  test('anyTopAt is exactly "getTopActions is non-empty"', () => {
    test.skip(!stable, 'corpus sits at a scoring boundary right now');
    expect(anyTopAt(Date.now())).toBe(getTopActions(10_000).length > 0);
  });
});
