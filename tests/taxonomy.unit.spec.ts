import { expect, test } from '@playwright/test';
// Relative import (not '@/'): mirrors tests/urgency.unit.spec.ts, whose curve
// this floor logic sits directly on top of.
import { ABSOLUTE_FLOORS, BAND_SIZES, bandFloors, bandForEff } from '../lib/taxonomy';

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
