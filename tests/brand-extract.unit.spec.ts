import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { extractFromHtml, mergeCssSignals, normalizeCssColor } from '../lib/brand-extract';

const fixture = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', 'brand', name), 'utf8');

const SITE_URL = new URL('https://www.rivertonledger.com/');

test.describe('normalizeCssColor', () => {
  test('hex shapes normalize to #rrggbb, alpha dropped', () => {
    expect(normalizeCssColor('#fff')).toBe('#ffffff');
    expect(normalizeCssColor('#0B5CAD')).toBe('#0b5cad');
    expect(normalizeCssColor('#abcd')).toBe('#aabbcc');
    expect(normalizeCssColor('#11223344')).toBe('#112233');
  });

  test('rgb()/rgba() normalize; fully transparent is discarded; keywords are not colors', () => {
    expect(normalizeCssColor('rgb(255, 255, 255)')).toBe('#ffffff');
    expect(normalizeCssColor('rgba(11, 92, 173, 0.5)')).toBe('#0b5cad');
    expect(normalizeCssColor('rgba(0, 0, 0, 0)')).toBeNull();
    expect(normalizeCssColor('red')).toBeNull();
    expect(normalizeCssColor('var(--brand)')).toBeNull();
    expect(normalizeCssColor('color-mix(in srgb, red, blue)')).toBeNull();
  });
});

test.describe('extractFromHtml', () => {
  test('normal site: name, theme color, icon preference, same-origin stylesheets only', () => {
    const c = extractFromHtml(fixture('normal-site.html'), SITE_URL);
    expect(c.siteName).toBe('The Riverton Ledger');
    expect(c.themeColor).toBe('#0b5cad');
    // apple-touch-icon preferred over favicon; resolved absolute + same host.
    expect(c.logoUrl).toBe('https://www.rivertonledger.com/apple-icon.png');
    // The cross-origin vendor.css is excluded; cap is 2.
    expect(c.stylesheets).toEqual([
      'https://www.rivertonledger.com/css/main.css',
      'https://www.rivertonledger.com/css/extra.css',
    ]);
    expect(c.darkBackground).toBe(false);
    // The brand blue is present and boosted by the theme-color vote.
    const blue = c.colors.find((entry) => entry.value === '#0b5cad');
    expect(blue).toBeDefined();
    expect(blue!.count).toBeGreaterThanOrEqual(3);
    expect(c.fonts.some((f) => f.value.includes('georgia'))).toBe(true);
    expect(c.radii.some((r) => r.value === '8px')).toBe(true);
  });

  test('dark site: darkBackground true from body/html background declarations', () => {
    const c = extractFromHtml(fixture('dark-site.html'), new URL('https://nightowl.example/'));
    expect(c.darkBackground).toBe(true);
    expect(c.colors.some((entry) => entry.value === '#2ea043')).toBe(true);
    expect(c.fonts.some((f) => f.value.includes('montserrat'))).toBe(true);
  });

  test('multi-byte content (CJK + emoji) extracts without corruption', () => {
    const c = extractFromHtml(fixture('cjk-emoji.html'), new URL('https://shimin.example/'));
    expect(c.siteName).toContain('市民ニュース');
    expect(c.colors.some((entry) => entry.value === '#333333')).toBe(true);
  });

  test('tag soup never throws and still yields the recoverable signals', () => {
    const c = extractFromHtml(fixture('tag-soup.html'), new URL('https://broken.example/'));
    expect(c.themeColor).toBe('#aa3355');
    expect(c.siteName).toContain('Broken & Co');
    expect(c.colors.some((entry) => entry.value === '#f5f0e8')).toBe(true);
  });

  test('truncated input (byte-cap cut mid-document) never throws', () => {
    const whole = fixture('normal-site.html');
    for (const cut of [10, 100, 300, whole.length - 40]) {
      expect(() => extractFromHtml(whole.slice(0, cut), SITE_URL)).not.toThrow();
    }
  });

  test('icon/stylesheet resolution refuses cross-host and non-https', () => {
    const html = `<link rel="icon" href="https://cdn.other.example/icon.png">
      <link rel="stylesheet" href="http://www.rivertonledger.com/insecure.css">`;
    const c = extractFromHtml(html, SITE_URL);
    expect(c.logoUrl).toBeUndefined();
    expect(c.stylesheets).toEqual([]);
  });
});

test.describe('mergeCssSignals', () => {
  test('linked-CSS-only site: colors arrive via the merge, dark stays false', () => {
    const base = extractFromHtml(
      '<title>Linked Only</title><link rel="stylesheet" href="/css/main.css">',
      SITE_URL
    );
    expect(base.colors).toEqual([]);
    const merged = mergeCssSignals(base, fixture('main.css'));
    expect(merged.colors.some((entry) => entry.value === '#b91c1c')).toBe(true);
    expect(merged.fonts.some((f) => f.value.includes('source serif pro'))).toBe(true);
    expect(merged.radii.some((r) => r.value === '24px')).toBe(true);
    expect(merged.darkBackground).toBe(false);
    expect(merged.siteName).toBe('Linked Only');
  });

  test('merge accumulates counts instead of replacing them', () => {
    const base = extractFromHtml(fixture('normal-site.html'), SITE_URL);
    const before = base.colors.find((entry) => entry.value === '#0b5cad')!.count;
    const merged = mergeCssSignals(base, 'a { color: #0b5cad } b { color: #0b5cad }');
    const after = merged.colors.find((entry) => entry.value === '#0b5cad')!.count;
    expect(after).toBe(before + 2);
  });
});
