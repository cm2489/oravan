import { expect, test } from '@playwright/test';
// Relative import on purpose: plain lib modules resolve under the Playwright
// runner without the @/ alias (same note as tests/embed-referrer.unit.spec.ts).
import {
  adjustInkForContrast,
  contrastRatio,
  hexToRgb,
  pickTextColor,
  relativeLuminance,
} from '../lib/contrast';

test.describe('hexToRgb', () => {
  test('parses #rrggbb and #rgb (shorthand doubles digits)', () => {
    expect(hexToRgb('#2a2318')).toEqual({ r: 0x2a, g: 0x23, b: 0x18 });
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb('#ABC')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
  });

  test('rejects everything else, full-string only', () => {
    for (const bad of ['fff', '#ffff', '#gggggg', '#fff "}', ' #fff', '#fffffff', 'rgb(0,0,0)', '']) {
      expect(hexToRgb(bad)).toBeNull();
    }
  });
});

test.describe('relativeLuminance / contrastRatio', () => {
  test('anchors: white=1, black=0, white-on-black=21, self=1', () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 3);
    expect(contrastRatio('#82632a', '#82632a')).toBeCloseTo(1, 5);
  });

  test('is symmetric and matches a known WCAG pair', () => {
    expect(contrastRatio('#2a2318', '#f3ecdd')).toBeCloseTo(contrastRatio('#f3ecdd', '#2a2318'), 6);
    // The brand's default ink/surface pair must itself clear AA body text —
    // if this ever fails, the shipped default widget violates the constitution.
    expect(contrastRatio('#2a2318', '#f3ecdd')).toBeGreaterThanOrEqual(4.5);
    // And the default dark pair too.
    expect(contrastRatio('#e4d9c0', '#1b1611')).toBeGreaterThanOrEqual(4.5);
  });

  test('unparseable input fails closed to 0 (never a passing ratio)', () => {
    expect(contrastRatio('#zzz', '#ffffff')).toBe(0);
    expect(contrastRatio('#ffffff', 'white')).toBe(0);
  });
});

test.describe('pickTextColor', () => {
  test('default accent keeps the shipped chip color', () => {
    expect(pickTextColor('#82632a')).toBe('#fbf8f0');
  });

  test('light backgrounds get dark text, dark get light', () => {
    expect(pickTextColor('#f3ecdd')).toBe('#1b1611');
    expect(pickTextColor('#ffe680')).toBe('#1b1611');
    expect(pickTextColor('#1b1611')).toBe('#fbf8f0');
    expect(pickTextColor('#0f1a2b')).toBe('#fbf8f0');
  });

  test('unparseable background falls back to the light candidate', () => {
    expect(pickTextColor('nope')).toBe('#fbf8f0');
  });
});

test.describe('adjustInkForContrast', () => {
  test('passing pair returns unchanged with adjusted:false', () => {
    expect(adjustInkForContrast('#2a2318', '#f3ecdd')).toEqual({ ink: '#2a2318', adjusted: false });
  });

  test('failing pair converges to >= 4.5 with adjusted:true', () => {
    const result = adjustInkForContrast('#888888', '#999999');
    expect(result).not.toBeNull();
    expect(result!.adjusted).toBe(true);
    expect(contrastRatio(result!.ink, '#999999')).toBeGreaterThanOrEqual(4.5);
  });

  test('converges for 4.5 even on the worst-case mid-gray surface', () => {
    // sqrt(21) ~ 4.58 is the guaranteed floor for the better extreme against
    // any surface; #757575 sits near the tie point where both directions are
    // weakest.
    const result = adjustInkForContrast('#757575', '#757575');
    expect(result).not.toBeNull();
    expect(contrastRatio(result!.ink, '#757575')).toBeGreaterThanOrEqual(4.5);
  });

  test('is idempotent: adjusting an adjusted ink changes nothing', () => {
    const once = adjustInkForContrast('#6699cc', '#88aadd')!;
    const twice = adjustInkForContrast(once.ink, '#88aadd')!;
    expect(twice).toEqual({ ink: once.ink, adjusted: false });
  });

  test('unparseable input returns null, never a guess', () => {
    expect(adjustInkForContrast('junk', '#ffffff')).toBeNull();
    expect(adjustInkForContrast('#ffffff', 'junk')).toBeNull();
  });
});
