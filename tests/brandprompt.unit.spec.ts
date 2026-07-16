import { expect, test } from '@playwright/test';
import { contrastRatio } from '../lib/contrast';
import type { BrandCandidates } from '../lib/brand-extract';
import {
  BRAND_MAX_TOKENS,
  BRAND_MODEL,
  buildBrandPrompt,
  finalizeBrandTheme,
  parseBrandResponse,
} from '../lib/brandprompt';

const CANDIDATES: BrandCandidates = {
  siteName: 'The Riverton Ledger',
  themeColor: '#0b5cad',
  logoUrl: 'https://www.rivertonledger.com/apple-icon.png',
  stylesheets: ['https://www.rivertonledger.com/css/main.css'],
  colors: [
    { value: '#0b5cad', count: 6 },
    { value: '#ffffff', count: 5 },
    { value: '#1a2233', count: 3 },
  ],
  fonts: [{ value: 'georgia, "times new roman", serif', count: 2 }],
  radii: [{ value: '8px', count: 2 }],
  darkBackground: false,
};

test.describe('buildBrandPrompt', () => {
  test('carries the signals and the closed output contract, never routing URLs', () => {
    const prompt = buildBrandPrompt(CANDIDATES);
    expect(prompt).toContain('#0b5cad');
    expect(prompt).toContain('georgia');
    expect(prompt).toContain('"radius" ("sharp"|"soft"|"round")');
    expect(prompt).toContain('"mode" ("light"|"dark")');
    // Asset URLs are routing data for the route handler, not model input.
    expect(prompt).not.toContain('apple-icon.png');
    expect(prompt).not.toContain('main.css');
  });

  test('sanity: the config constants hold their contract', () => {
    expect(BRAND_MODEL).toBe('claude-sonnet-5');
    expect(BRAND_MAX_TOKENS).toBeLessThanOrEqual(1024);
  });
});

test.describe('parseBrandResponse', () => {
  const CLEAN =
    '{"surface":"#ffffff","ink":"#1a2233","accent":"#0b5cad","radius":"soft","font":"serif","mode":"light"}';

  test('clean JSON parses', () => {
    expect(parseBrandResponse(CLEAN)).toMatchObject({ accent: '#0b5cad' });
  });

  test('JSON wrapped in prose parses (outermost brace slice)', () => {
    expect(parseBrandResponse(`Here is the mapping:\n${CLEAN}\nHope that helps!`)).toMatchObject({
      surface: '#ffffff',
    });
  });

  test('junk, arrays, and brace-less text yield null', () => {
    expect(parseBrandResponse('no braces here')).toBeNull();
    expect(parseBrandResponse('{not json}')).toBeNull();
    expect(parseBrandResponse('[1,2,3]')).toBeNull();
    expect(parseBrandResponse('')).toBeNull();
  });
});

test.describe('finalizeBrandTheme', () => {
  test('a valid suggestion passes through untouched, adjusted:false', () => {
    const result = finalizeBrandTheme({
      surface: '#ffffff',
      ink: '#1a2233',
      accent: '#0b5cad',
      radius: 'soft',
      font: 'serif',
      mode: 'light',
    });
    expect(result).toEqual({
      theme: {
        surface: '#ffffff',
        ink: '#1a2233',
        accent: '#0b5cad',
        radius: 'soft',
        font: 'serif',
        mode: 'light',
      },
      adjusted: false,
    });
  });

  test('a low-contrast suggestion is repaired to >= 4.5 with adjusted:true', () => {
    const result = finalizeBrandTheme({
      surface: '#f3ecdd',
      ink: '#c9c0a9', // fails AA on the cream surface
      accent: '#82632a',
      radius: 'soft',
      font: 'system',
      mode: 'light',
    });
    expect(result).not.toBeNull();
    expect(result!.adjusted).toBe(true);
    expect(contrastRatio(result!.theme.ink, result!.theme.surface)).toBeGreaterThanOrEqual(4.5);
  });

  test('hostile or missing colors reject to null — the model cannot emit CSS', () => {
    expect(finalizeBrandTheme(null)).toBeNull();
    expect(finalizeBrandTheme({})).toBeNull();
    expect(
      finalizeBrandTheme({ surface: '#fff"}body{display:none}', ink: '#000000', accent: '#123456' })
    ).toBeNull();
    expect(
      finalizeBrandTheme({ surface: 'white', ink: '#000000', accent: '#123456' })
    ).toBeNull();
    expect(finalizeBrandTheme({ surface: '#ffffff', ink: '#000000' })).toBeNull(); // accent missing
  });

  test('junk enums fall back to defaults instead of failing the whole theme', () => {
    const result = finalizeBrandTheme({
      surface: '#ffffff',
      ink: '#111111',
      accent: '#b91c1c',
      radius: 'circular',
      font: 'papyrus',
      mode: 'midnight',
    });
    expect(result!.theme.radius).toBe('soft');
    expect(result!.theme.font).toBe('system');
    expect(result!.theme.mode).toBe('auto');
  });
});
