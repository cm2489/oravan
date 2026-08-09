import { expect, test } from '@playwright/test';
// Relative import (not '@/'): mirrors tests/urgency.unit.spec.ts, whose curve
// this floor logic sits directly on top of.
import { ABSOLUTE_FLOORS, BAND_SIZES, bandFloors, bandForEff } from '../lib/taxonomy';
import { activeBills, floorsAt } from './corpus';
import { effectiveUrgency } from '../lib/urgency.mjs';

/*
 * KTD-2: bands are rank-relative, floored by the absolute thresholds
 * reinstated from the pre-21dfaaf implementation (score >= 0.75 = "now",
 * >= 0.5 = "moving"). These tests pin that both halves actually apply: rank
 * still orders a hot week, but the absolute floor - not rank - decides
 * whether "Act now" gets to exist at all on a quiet one.
 */

test.describe('ABSOLUTE_FLOORS', () => {
  test('pins the reinstated v1 thresholds', () => {
    expect(ABSOLUTE_FLOORS).toEqual({ nowFloor: 0.75, movingFloor: 0.5 });
  });
});

test.describe('bandFloors', () => {
  test('rank floor wins when it is stricter than the absolute floor (a hot week)', () => {
    const effs = Array.from({ length: 20 }, (_, i) => 0.95 - i * 0.01); // 0.95 down to 0.76, already descending
    const floors = bandFloors(effs);
    expect(floors.nowFloor).toBeCloseTo(effs[BAND_SIZES.now - 1], 5);
    expect(floors.nowFloor).toBeGreaterThan(ABSOLUTE_FLOORS.nowFloor);
  });

  test('absolute floor wins when nothing clears it (a genuinely quiet week)', () => {
    // Real corpus shape: everything idling well under both thresholds.
    const effs = [0.6, 0.55, 0.5, 0.45, 0.3, 0.2];
    const floors = bandFloors(effs);
    expect(floors.nowFloor).toBe(ABSOLUTE_FLOORS.nowFloor);
    expect(effs.every((e) => bandForEff(e, floors) !== 'now')).toBe(true);
  });

  test('a bill can clear "moving" without clearing "now"', () => {
    const effs = [0.6, 0.55];
    const floors = bandFloors(effs);
    expect(bandForEff(0.6, floors)).toBe('moving');
    expect(bandForEff(0.75, floors)).toBe('now');
    expect(bandForEff(0.49, floors)).toBe('radar');
  });

  test('a short corpus (fewer bills than a band size) still floors sanely', () => {
    // Only one active bill, urgency 0.6: below the "now" absolute floor (so
    // "now" falls back to 0.75), but above the "moving" absolute floor, and
    // the too-short array clamps the rank lookup onto this same bill - so
    // "moving"'s floor is its own 0.6, not the absolute 0.5.
    const floors = bandFloors([0.6]);
    expect(floors.nowFloor).toBe(ABSOLUTE_FLOORS.nowFloor);
    expect(floors.movingFloor).toBe(0.6);
    expect(bandForEff(0.6, floors)).toBe('moving');
  });

  test('empty corpus floors to the absolute minimums, never -Infinity', () => {
    expect(bandFloors([])).toEqual(ABSOLUTE_FLOORS);
  });
});

/*
 * v3a — THE DELETED MIDDLE BAND (2026-08-09).
 *
 * The moving floor used to be read off the fixed 18th rank, which assumed the
 * "now" band stops at rank 6. Ties make that false: on the live corpus 21
 * active bills sat at 0.95, so rank 6 AND rank 18 were the same number, both
 * floors came out 0.95, and bandForEff — which asks `eff >= nowFloor` first —
 * could never return 'moving'. /bills printed "Deciding now" straight into "On
 * the radar", filing 38 bills that outscored almost the entire corpus under
 * "quieter right now".
 *
 * These pin the invariant rather than the arithmetic: the floors are strictly
 * ordered, so the middle band is always reachable whenever the distribution
 * has anything to put in it.
 */
test.describe('bandFloors · strict floor ordering', () => {
  test('the degenerate tie corpus still yields three non-empty bands', () => {
    // The 2026-08-09 shape in miniature: one big tie block at the top (longer
    // than now+moving combined), then ordinary scores underneath.
    const effs = [
      ...Array.from({ length: 21 }, () => 0.95),
      ...Array.from({ length: 40 }, () => 0.9),
      ...Array.from({ length: 100 }, () => 0.6),
    ];
    const floors = bandFloors(effs);
    expect(floors.nowFloor).toBe(0.95);
    expect(floors.movingFloor).toBeLessThan(floors.nowFloor);

    const bands = effs.map((e) => bandForEff(e, floors));
    expect(bands.filter((b) => b === 'now')).toHaveLength(21);
    expect(bands.filter((b) => b === 'moving').length).toBeGreaterThan(0);
    expect(bands.filter((b) => b === 'radar').length).toBeGreaterThan(0);
  });

  test('a bill just under the top tie block is "moving", never "radar"', () => {
    const effs = [...Array.from({ length: 21 }, () => 0.95), 0.9, 0.2];
    const floors = bandFloors(effs);
    expect(bandForEff(0.95, floors)).toBe('now');
    expect(bandForEff(0.9, floors)).toBe('moving');
    expect(bandForEff(0.2, floors)).toBe('radar');
  });

  test('floors stay strictly decreasing across every corpus shape', () => {
    const shapes: number[][] = [
      [],
      [0.6],
      [1, 1, 1, 1, 1, 1],
      Array.from({ length: 50 }, () => 0.95), // every bill tied, nothing below
      Array.from({ length: 50 }, () => 1), // …and tied at the ceiling
      Array.from({ length: 30 }, (_, i) => 1 - i * 0.02),
      [0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.4, 0.3, 0.2],
      [0.2, 0.2, 0.2],
    ];
    for (const effs of shapes) {
      const floors = bandFloors(effs);
      expect(
        floors.movingFloor,
        `movingFloor must sit strictly below nowFloor for ${JSON.stringify(effs.slice(0, 6))}…`
      ).toBeLessThan(floors.nowFloor);
      expect(floors.movingFloor).toBeGreaterThanOrEqual(ABSOLUTE_FLOORS.movingFloor);
      expect(floors.nowFloor).toBeGreaterThanOrEqual(ABSOLUTE_FLOORS.nowFloor);
    }
  });

  /*
   * THE INVARIANT, ASSERTED AGAINST THE LIVE CORPUS — the one that actually
   * failed in production. The synthetic cases above prove the arithmetic; this
   * proves tonight's real nightly-synced distribution is banded honestly.
   *
   * Stated exactly: the highest-scoring ACTIVE bill that the "now" floor does
   * not claim belongs in "moving" — provided it also clears the absolute
   * moving floor, because a bill scoring 0.3 is genuinely quiet no matter what
   * ranks above it (that clause is v1's floor doing its job, not a loophole).
   * Before this fix, that bill scored 0.9 — higher than 98% of the corpus —
   * and rendered under "On the radar · Quieter right now".
   *
   * Clock-free by construction: it derives both the floor and the bill from
   * the same instant, so there is no build-vs-assert window to skip around.
   */
  test('live corpus: the best bill below the "now" floor is "moving", never "radar"', () => {
    const at = Date.now();
    const floors = floorsAt(at);
    const below = activeBills
      .map((b) => effectiveUrgency(b.status, b.last_action_date, at))
      .filter((e) => e < floors.nowFloor);
    test.skip(below.length === 0, 'every active bill clears the "now" floor — no middle band to check');
    const best = Math.max(...below);
    if (best >= ABSOLUTE_FLOORS.movingFloor) {
      expect(bandForEff(best, floors), `eff ${best} vs floors ${JSON.stringify(floors)}`).toBe(
        'moving'
      );
    } else {
      // Honest quiet corpus: nothing below the top band clears 0.5.
      expect(bandForEff(best, floors)).toBe('radar');
    }
  });

  test('an untied corpus keeps the pre-v3a floor exactly (no ordinary-week change)', () => {
    // 30 distinct descending scores: the "now" band ends at rank 6 on its own,
    // so the moving floor is still read at rank 18 — the old expression.
    const effs = Array.from({ length: 30 }, (_, i) => Math.round((0.99 - i * 0.005) * 1000) / 1000);
    const floors = bandFloors(effs);
    expect(floors.nowFloor).toBeCloseTo(effs[BAND_SIZES.now - 1], 5);
    expect(floors.movingFloor).toBeCloseTo(effs[BAND_SIZES.now + BAND_SIZES.moving - 1], 5);
  });
});
