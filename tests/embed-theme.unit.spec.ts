import { expect, test } from '@playwright/test';
// Relative import on purpose: plain lib modules resolve under the Playwright
// runner without the @/ alias (same note as tests/embed-referrer.unit.spec.ts).
import {
  FONT_VALUES,
  MODE_DEFAULTS,
  RADIUS_VALUES,
  buildThemeCss,
  resolveEmbedTheme,
  safeFontKey,
  safeInk,
  safeModeKey,
  safeSurface,
} from '../lib/embed-theme';
import { contrastRatio } from '../lib/contrast';

// The payload family the existing e2e injection tests throw at safeAccent —
// every new hex-shaped knob must fail-close on all of them.
const HOSTILE_VALUES = [
  '#fff"}body{display:none}',
  '#fff;background:url(https://evil.example/x)',
  'expression(alert(1))',
  '#ffff',
  ' #ffffff',
  '#ffffff ',
  'red',
  'var(--x)',
  '#fffffff',
  '<script>window.__pwned=1</script>',
];

test.describe('safeSurface / safeInk', () => {
  test('accept exactly the safeAccent hex shapes', () => {
    expect(safeSurface('#0f1a2b')).toBe('#0f1a2b');
    expect(safeInk('#F5F7FA')).toBe('#F5F7FA');
    expect(safeSurface('#abc')).toBe('#abc');
  });

  test('fail closed on the hostile payload family', () => {
    for (const value of HOSTILE_VALUES) {
      expect(safeSurface(value)).toBeUndefined();
      expect(safeInk(value)).toBeUndefined();
    }
  });
});

test.describe('safeModeKey / safeFontKey', () => {
  test('mode: only the two exact tokens force; everything else is auto', () => {
    expect(safeModeKey('light')).toBe('light');
    expect(safeModeKey('dark')).toBe('dark');
    for (const junk of ['Dark', 'DARK', 'night', 'auto', '', undefined, null, '1']) {
      expect(safeModeKey(junk as string | undefined | null)).toBe('auto');
    }
  });

  test('font: the four closed keys pass, everything else is system', () => {
    expect(safeFontKey('serif')).toBe('serif');
    expect(safeFontKey('humanist')).toBe('humanist');
    expect(safeFontKey('geometric')).toBe('geometric');
    for (const junk of ['Humanist', 'comic-sans', 'Arial, sans-serif', '', undefined]) {
      expect(safeFontKey(junk as string | undefined)).toBe('system');
    }
  });

  test('the two new stacks exist and are double-quoted (computed-style parity)', () => {
    expect(FONT_VALUES.humanist).toContain('"Gill Sans Nova"');
    expect(FONT_VALUES.geometric).toContain('"URW Gothic"');
    expect(FONT_VALUES.humanist).not.toContain("'");
    expect(FONT_VALUES.geometric).not.toContain("'");
  });
});

test.describe('resolveEmbedTheme', () => {
  test('a lone surface or lone ink is discarded (pair-or-nothing)', () => {
    expect(resolveEmbedTheme({ surface: '#ffffff' }).surface).toBeUndefined();
    expect(resolveEmbedTheme({ ink: '#000000' }).ink).toBeUndefined();
  });

  test('a pair below 4.5:1 is discarded as a pair', () => {
    const theme = resolveEmbedTheme({ surface: '#888888', ink: '#999999' });
    expect(theme.surface).toBeUndefined();
    expect(theme.ink).toBeUndefined();
  });

  test('a passing pair survives intact — never adjusted at this boundary', () => {
    const theme = resolveEmbedTheme({ surface: '#0f1a2b', ink: '#f5f7fa' });
    expect(theme.surface).toBe('#0f1a2b');
    expect(theme.ink).toBe('#f5f7fa');
  });

  test('forced mode with no pair pins that mode default palette', () => {
    const dark = resolveEmbedTheme({ mode: 'dark' });
    expect(dark.surface).toBe(MODE_DEFAULTS.dark.surface);
    expect(dark.ink).toBe(MODE_DEFAULTS.dark.ink);
    const light = resolveEmbedTheme({ mode: 'light' });
    expect(light.surface).toBe(MODE_DEFAULTS.light.surface);
    // Both shipped default palettes must themselves clear the bar they enforce.
    expect(contrastRatio(MODE_DEFAULTS.dark.ink, MODE_DEFAULTS.dark.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(MODE_DEFAULTS.light.ink, MODE_DEFAULTS.light.surface)).toBeGreaterThanOrEqual(4.5);
  });

  test('forced mode with a valid pair keeps the tenant pair (pair wins)', () => {
    const theme = resolveEmbedTheme({ mode: 'dark', surface: '#ffffff', ink: '#111111' });
    expect(theme.surface).toBe('#ffffff');
    expect(theme.ink).toBe('#111111');
    expect(theme.mode).toBe('dark');
  });

  test('auto mode with no pair leaves surface/ink unset (media query rules)', () => {
    const theme = resolveEmbedTheme({});
    expect(theme.surface).toBeUndefined();
    expect(theme.ink).toBeUndefined();
    expect(theme.mode).toBe('auto');
  });

  test('accentInk derives from accent by contrast; focus needs a surface', () => {
    const noSurface = resolveEmbedTheme({ accent: '#82632a' });
    expect(noSurface.accentInk).toBe('#fbf8f0'); // the shipped default chip text
    expect(noSurface.focus).toBeUndefined();

    const light = resolveEmbedTheme({ accent: '#ffe680' });
    expect(light.accentInk).toBe('#1b1611');

    // With a tenant pair, accentInk uses the TENANT's own light/dark, not
    // Oravan's cream — a black accent on a white/near-black brand yields the
    // tenant's pure white, not #fbf8f0.
    const themed = resolveEmbedTheme({ accent: '#000000', surface: '#ffffff', ink: '#121212' });
    expect(themed.accentInk).toBe('#ffffff');

    // Accent readable on the surface -> focus = accent.
    const readable = resolveEmbedTheme({ accent: '#82632a', surface: '#ffffff', ink: '#111111' });
    expect(readable.focus).toBe('#82632a');
    // Accent illegible on the surface -> focus falls back to ink.
    const illegible = resolveEmbedTheme({ accent: '#f0e9da', surface: '#f3ecdd', ink: '#2a2318' });
    expect(illegible.focus).toBe('#2a2318');
  });
});

test.describe('buildThemeCss', () => {
  test('defaults emit exactly radius + font, no accent/surface/ink/scheme', () => {
    const css = buildThemeCss(resolveEmbedTheme({}));
    expect(css).toBe(
      `:root:root{--oravan-radius:${RADIUS_VALUES.soft};--oravan-font:${FONT_VALUES.system}}`
    );
  });

  test('forced dark pins palette + color-scheme', () => {
    const css = buildThemeCss(resolveEmbedTheme({ mode: 'dark' }));
    expect(css).toContain(`--oravan-surface:${MODE_DEFAULTS.dark.surface}`);
    expect(css).toContain(`--oravan-ink:${MODE_DEFAULTS.dark.ink}`);
    expect(css).toContain('color-scheme:dark');
  });

  test('a tenant pair under auto derives its scheme from surface luminance', () => {
    expect(buildThemeCss(resolveEmbedTheme({ surface: '#0f1a2b', ink: '#f5f7fa' }))).toContain(
      'color-scheme:dark'
    );
    expect(buildThemeCss(resolveEmbedTheme({ surface: '#ffffff', ink: '#111111' }))).toContain(
      'color-scheme:light'
    );
  });

  test('output is a single closed rule made only of validated declarations', () => {
    const css = buildThemeCss(
      resolveEmbedTheme({
        accent: '#336699',
        surface: '#ffffff',
        ink: '#111111',
        mode: 'dark',
        radius: 'round',
        font: 'geometric',
      })
    );
    // Exactly one rule block, no HTML-significant characters, no selectors
    // beyond the fixed :root:root prefix.
    expect(css.startsWith(':root:root{')).toBe(true);
    expect(css.endsWith('}')).toBe(true);
    expect(css.indexOf('{')).toBe(css.lastIndexOf('{'));
    expect(css).not.toContain('<');
    expect(css).not.toContain('>');
    expect(css).toContain('--oravan-accent:#336699');
    expect(css).toContain(`--oravan-radius:${RADIUS_VALUES.round}`);
    expect(css).toContain(`--oravan-font:${FONT_VALUES.geometric}`);
  });

  test('property test: hostile raw values can never surface in the CSS text', () => {
    for (const value of HOSTILE_VALUES) {
      const css = buildThemeCss(
        resolveEmbedTheme({ accent: value, surface: value, ink: value, mode: value, radius: value, font: value })
      );
      expect(css).not.toContain('evil');
      expect(css).not.toContain('expression');
      expect(css).not.toContain('<');
      expect(css).not.toContain('display:none');
      // Fail-closed means fully default output.
      expect(css).toBe(
        `:root:root{--oravan-radius:${RADIUS_VALUES.soft};--oravan-font:${FONT_VALUES.system}}`
      );
    }
  });
});
