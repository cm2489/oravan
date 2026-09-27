import { readFileSync } from 'node:fs';
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
import { MODE_DEFAULTS } from '../lib/embed-theme';
import { colorTokens, embedFallback } from './palette';

/*
 * The contrast gate (CLAUDE.md rule 7: AA contrast on every enforced pair,
 * computed, not eyeballed). The math is pinned with neutral fixtures; every
 * assertion about a colour the site actually ships reads that colour from its
 * source — app/globals.css, app/embed/embed.css, lib/embed-theme.ts — so a new
 * palette is checked the day it lands, and no retired one is checked forever.
 */

/** The shipped default pairs — what an un-themed widget renders. */
const LIGHT = MODE_DEFAULTS.light;
const DARK = MODE_DEFAULTS.dark;
/** pickTextColor's two default candidates are the light pair's two halves
 *  (lib/contrast.ts is one of that pair's mirrors). */
const LIGHT_CANDIDATE = LIGHT.surface;
const DARK_CANDIDATE = LIGHT.ink;

test.describe('hexToRgb', () => {
  test('parses #rrggbb and #rgb (shorthand doubles digits)', () => {
    expect(hexToRgb('#1a2b3c')).toEqual({ r: 0x1a, g: 0x2b, b: 0x3c });
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
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });

  test('is symmetric', () => {
    expect(contrastRatio('#1a2b3c', '#e0d0c0')).toBeCloseTo(contrastRatio('#e0d0c0', '#1a2b3c'), 6);
  });

  test('the shipped default widget pairs, light and dark, each clear AA body text', () => {
    // If this fails, an un-themed embed on a partner's page ships text below
    // 4.5:1 — read from lib/embed-theme.ts, the pair the widget pins.
    expect(contrastRatio(LIGHT.ink, LIGHT.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(DARK.ink, DARK.surface)).toBeGreaterThanOrEqual(4.5);
  });

  test('unparseable input fails closed to 0 (never a passing ratio)', () => {
    expect(contrastRatio('#zzz', '#ffffff')).toBe(0);
    expect(contrastRatio('#ffffff', 'white')).toBe(0);
  });
});

/*
 * THE LEDGER. app/globals.css opens with the list of every colour pair the
 * site commits to, each with the ratio it computes to; docs/accessibility.md
 * names that block as the full ledger. These tests read the pairs AND the
 * token values out of that one file, so they cover whatever the palette is on
 * the day they run.
 *
 * Text pairs must clear 4.5:1 (no text pair may be declared failing). A
 * boundary pair the ledger marks PASS must clear 3:1; the ones it documents
 * as exempt (decorative, a fill, the disabled-only edge) are held to their
 * printed ratio instead, so an exemption cannot hide a colour that moved.
 */
test.describe('the contrast ledger in app/globals.css', () => {
  const css = readFileSync('app/globals.css', 'utf8');
  const tokens = colorTokens(css);
  const start = css.indexOf('CONTRAST LEDGER');
  const end = css.indexOf('=====', start);
  const ledger = start === -1 || end === -1 ? '' : css.slice(start, end);
  const textAt = ledger.indexOf('TEXT PAIRS');
  const boundaryAt = ledger.indexOf('NON-TEXT');

  /** `fg (note) on bg ........ 6.43  VERDICT` — one ledger line. */
  const PAIR = /^\s+([a-z][a-z0-9-]*)(?:\s+\([^)]*\))?\s+on\s+([a-z][a-z0-9-]*)\s+\.{2,}\s+(\d+\.\d+)\s+(\S+)/gm;
  const pairs = (block: string) =>
    [...block.matchAll(PAIR)].map((m) => ({
      label: `${m[1]} on ${m[2]}`,
      fg: tokens.get(m[1]),
      bg: tokens.get(m[2]),
      fgName: m[1],
      bgName: m[2],
      printed: m[3],
      verdict: m[4],
    }));
  const textPairs = textAt === -1 || boundaryAt === -1 ? [] : pairs(ledger.slice(textAt, boundaryAt));
  const boundaryPairs = boundaryAt === -1 ? [] : pairs(ledger.slice(boundaryAt));

  test('the ledger exists, lists both kinds of pair, and names only real hex tokens', () => {
    // A ledger this file can no longer find would turn every test below into
    // a loop over nothing — a gate that passes by checking no pair at all.
    expect(ledger, 'app/globals.css has no CONTRAST LEDGER block').not.toBe('');
    expect(textPairs.length, 'no TEXT PAIRS lines found in the ledger').toBeGreaterThan(0);
    expect(boundaryPairs.length, 'no NON-TEXT pair lines found in the ledger').toBeGreaterThan(0);
    for (const p of [...textPairs, ...boundaryPairs]) {
      expect(p.fg, `${p.label}: --color-${p.fgName} is not a hex token in app/globals.css`).toBeTruthy();
      expect(p.bg, `${p.label}: --color-${p.bgName} is not a hex token in app/globals.css`).toBeTruthy();
    }
  });

  test('every text pair clears AA (4.5:1), computed from the current tokens', () => {
    for (const p of textPairs) {
      expect(contrastRatio(p.fg!, p.bg!), `${p.label} (${p.fg} on ${p.bg})`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('every boundary pair the ledger marks PASS clears 3:1', () => {
    const passing = boundaryPairs.filter((p) => p.verdict === 'PASS');
    expect(passing.length, 'no boundary pair is marked PASS').toBeGreaterThan(0);
    for (const p of passing) {
      expect(contrastRatio(p.fg!, p.bg!), `${p.label} (${p.fg} on ${p.bg})`).toBeGreaterThanOrEqual(3);
    }
  });

  test('every ratio the ledger prints is the one lib/contrast.ts computes', () => {
    // "Computed, not eyeballed": a token that changes without its ledger line
    // being recomputed fails here, exemptions included.
    for (const p of [...textPairs, ...boundaryPairs]) {
      expect(contrastRatio(p.fg!, p.bg!).toFixed(2), `${p.label}: ledger prints ${p.printed}`).toBe(
        p.printed
      );
    }
  });
});

test.describe('pickTextColor', () => {
  test('the un-themed widget accent gets the chip text embed.css ships, and it reads', () => {
    // app/embed/embed.css's own fallbacks: the accent an un-themed widget
    // fills with, and the text colour it prints on it. The server derives the
    // same text colour by measurement (lib/embed-theme.ts); the two must agree
    // or a partner sees one colour before hydration and another after.
    const accent = embedFallback('accent');
    const accentInk = embedFallback('accent-ink');
    expect(pickTextColor(accent)).toBe(accentInk);
    expect(contrastRatio(accent, accentInk)).toBeGreaterThanOrEqual(4.5);
  });

  test('its default candidates are the shipped default pair', () => {
    // lib/contrast.ts is one of the mirrors of the embed's default pair
    // (CLAUDE.md rule 12): each default ground gets the other half of its pair.
    expect(pickTextColor(LIGHT.surface)).toBe(LIGHT.ink);
    expect(pickTextColor(DARK.surface)).toBe(DARK.ink);
  });

  test('light backgrounds get the dark candidate, dark get the light — measured, not looked up', () => {
    expect(pickTextColor('#ffe680')).toBe(DARK_CANDIDATE);
    expect(pickTextColor('#f0ead8')).toBe(DARK_CANDIDATE);
    expect(pickTextColor('#0f1a2b')).toBe(LIGHT_CANDIDATE);
    expect(pickTextColor('#7a3b12')).toBe(LIGHT_CANDIDATE);
  });

  test('unparseable background falls back to the light candidate', () => {
    expect(pickTextColor('nope')).toBe(LIGHT_CANDIDATE);
  });
});

test.describe('adjustInkForContrast', () => {
  test('passing pair returns unchanged with adjusted:false', () => {
    expect(adjustInkForContrast(LIGHT.ink, LIGHT.surface)).toEqual({ ink: LIGHT.ink, adjusted: false });
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
