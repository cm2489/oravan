import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { contrastRatio, mixHex } from '../lib/contrast';

/*
 * THE ISLAND BAR'S GLASS, COMPUTED (rule 7: AA contrast computed, not
 * eyeballed). The bar (components/Header.tsx, `.island-bar` in
 * app/globals.css) is paper at `--island-glass` over whatever scrolls under
 * it. The frost's darkest possible result is that alpha of paper over pure
 * black — nothing beneath, blurred or saturated, can be darker than black —
 * so every label and the focus ring are held to that floor. The browser
 * blends in sRGB, which is what lib/contrast.ts `mixHex` does.
 *
 * These pairs are not in the globals.css ledger's PAIR lines because the
 * frost is not a token (the ledger's own test resolves both sides to
 * `--color-*` hex values); its prose paragraph cites this file.
 */

const css = readFileSync('app/globals.css', 'utf8');
const header = readFileSync('components/Header.tsx', 'utf8');

function token(name: string): string {
  const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`--color-${name} not found in app/globals.css`);
  return m[1];
}

const glassMatch = css.match(/--island-glass:\s*(\d+(?:\.\d+)?)%/);
const ALPHA = glassMatch ? Number(glassMatch[1]) / 100 : NaN;
const paper = token('paper');
const ink = token('ink');
const ink2 = token('ink-2');
/** Paper at the glass alpha over a backdrop colour. */
const frost = (backdrop: string) => mixHex(backdrop, paper, ALPHA);

test.describe('the island bar glass', () => {
  test('the alpha is declared once, in app/globals.css', () => {
    expect(ALPHA, '--island-glass: <n>% in .island-bar').toBeGreaterThan(0);
    expect(ALPHA).toBeLessThanOrEqual(1);
  });

  test('ink labels clear AA over the worst backdrop (pure black), with the printed figures', () => {
    expect(frost('#000000')).toBe('#b5b4b0');
    expect(contrastRatio(ink, frost('#000000')).toFixed(2)).toBe('8.30');
    expect(contrastRatio(ink, frost('#000000'))).toBeGreaterThanOrEqual(4.5);
  });

  test('over the real grounds that scroll beneath: ink footer and Big Questions band, lamp, paper, band green', () => {
    const grounds: Record<string, string> = {
      'ink (footer, dark band)': token('ink-deep'),
      lamp: token('urgent'),
      paper,
      wash: token('wash'),
      stone: token('stone'),
      'go-deep (masthead band)': token('go-deep'),
      go: token('go'),
      alert: token('alert'),
    };
    for (const [name, hex] of Object.entries(grounds)) {
      expect(contrastRatio(ink, frost(hex)), `ink label over frost on ${name}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(ink, frost(token('ink-deep'))).toFixed(2)).toBe('9.05');
    expect(contrastRatio(ink, frost(token('urgent'))).toFixed(2)).toBe('14.70');
  });

  test('ink-2 would fail on the frost, so no label in the bar uses it', () => {
    expect(contrastRatio(ink2, frost('#000000'))).toBeLessThan(4.5);
    const bar = header.slice(header.indexOf('data-thumb-bar'));
    expect(bar).not.toMatch(/text-ink-2\b/);
  });

  test('the focus ring (ink) and the current-tab lozenge clear their pairs', () => {
    // The ring sits inside the tab, on the frost or on the lozenge.
    expect(contrastRatio(ink, frost('#000000'))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(ink, token('wash')).toFixed(2)).toBe('15.13');
    // The lozenge's edge against its own fill.
    expect(contrastRatio(token('line-strong'), token('wash'))).toBeGreaterThanOrEqual(3);
  });

  test('solid fallbacks exist: no backdrop-filter, reduced transparency, more contrast', () => {
    const block = css.slice(css.indexOf('.island-bar {'), css.indexOf('/* prefers-reduced-motion kills'));
    // The base rule is solid paper; the glass is only inside @supports.
    expect(block).toMatch(/\.island-bar \{\s*--island-glass:[^}]*background-color: var\(--color-paper\);/);
    expect(block).toContain('@supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))');
    for (const q of ['@media (prefers-reduced-transparency: reduce)', '@media (prefers-contrast: more)']) {
      const at = block.indexOf(q);
      expect(at, q).toBeGreaterThan(block.indexOf('@supports'));
      const rule = block.slice(at, block.indexOf('}', at));
      expect(rule, q).toContain('background-color: var(--color-paper)');
      expect(rule, q).toContain('backdrop-filter: none');
    }
    expect(header).toContain('island-bar');
  });
});
