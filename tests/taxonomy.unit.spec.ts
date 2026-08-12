import { expect, test } from '@playwright/test';
// Relative import (not '@/'): mirrors tests/urgency.unit.spec.ts.
import { BAND_SIZES, CATEGORIES } from '../lib/taxonomy';
import { bandForRung } from '../lib/docket.mjs';
import { anyBandExceedsCapAt, bandCountsAt, corpus } from './corpus';

/*
 * WHAT THIS FILE USED TO BE, AND WHY IT IS SHORT NOW.
 *
 * Until 2026-08-12 this suite pinned `ABSOLUTE_FLOORS`, `bandFloors` and
 * `bandForEff` — the percentile+absolute band cutoffs, across four recorded
 * revisions (v1 absolute, v2 rank, v3 both, v3a the tie-block repair). All
 * three are retired: the bands read a DOCKET RUNG now, which is a sentence from
 * the record rather than a number, so there is no floor left to tune and no tie
 * block to repair. lib/taxonomy.ts's own header keeps the full history of why.
 *
 * The ladder's own rules are pinned in tests/docket.unit.spec.ts. What stays
 * here is the part of taxonomy.ts that survived: the category list, and
 * BAND_SIZES as what it always was on the browse surface — a DISPLAY cap.
 */

test.describe('CATEGORIES', () => {
  test('the 12 CRS-anchored categories are stable and unique', () => {
    expect(CATEGORIES).toHaveLength(12);
    expect(new Set(CATEGORIES).size).toBe(12);
  });
});

test.describe('BAND_SIZES is a display cap and nothing else', () => {
  test('it decides how many cards a band shows, never which band a bill is in', () => {
    expect(BAND_SIZES).toEqual({ now: 6, moving: 12 });
    // The proof that it is not a cutoff any more: a band's membership is a pure
    // function of the rung, with no reference to a size or a rank.
    expect(bandForRung({ tier: 't0' })).toBe('now');
    expect(bandForRung({ tier: 't2' })).toBe('moving');
    expect(bandForRung({ tier: 't4' })).toBe('radar');
  });
});

test.describe('the live corpus bands', () => {
  test('every bill lands in exactly one band, and the three cover the corpus', () => {
    const at = Date.now();
    const counts = bandCountsAt(at);
    expect(counts.now + counts.moving + counts.radar).toBe(corpus.length);
    // Ranges, never counts: the corpus is nightly-synced. `now` and `moving` are
    // both allowed to be ZERO — that is a quiet fortnight, which is the whole
    // reason the floors were retired — but radar always holds the long tail.
    expect(counts.now).toBeGreaterThanOrEqual(0);
    expect(counts.moving).toBeGreaterThanOrEqual(0);
    expect(counts.radar).toBeGreaterThan(0);
  });

  test('the browse cap only ever fires on a band that exceeds it', () => {
    const at = Date.now();
    const counts = bandCountsAt(at);
    const expected = Object.values(counts).some((n) => n > BAND_SIZES.now);
    expect(anyBandExceedsCapAt(at)).toBe(expected);
  });
});
