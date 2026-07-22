import { adjustInkForContrast, contrastRatio } from './contrast';
import {
  safeAccent,
  safeFontKey,
  safeInk,
  safeModeKey,
  safeRadiusKey,
  safeSurface,
  type FontKey,
  type ModeKey,
  type RadiusKey,
} from './embed-theme';
import type { BrandCandidates } from './brand-extract';

/*
 * The Anthropic mapping step for /api/brand (brand-preview build): messy
 * extracted signals in, the closed theme knobs out. Same single-prompt-
 * module convention as lib/scriptprompt (the /api/script pair) so there is
 * exactly one brand prompt in the codebase.
 *
 * Security shape: the model's output CANNOT become CSS. parseBrandResponse
 * only ever yields a shape-checked object, and finalizeBrandTheme pushes
 * every field through the same fail-closed validators the widgets use —
 * the model contributes three hex colors and three enum picks, or the
 * request fails. Raw HTML/CSS never reaches the API; only the compact
 * candidates JSON (~500-900 tokens) does.
 */

// Owner decision 2026-07-16 (plan: we-need-planning-mode): Sonnet 5 —
// palette-picking from polluted candidate lists is a judgment task where
// Haiku missteps read as "off-brand" at the sales moment; one-line swap.
export const BRAND_MODEL = 'claude-sonnet-5';
export const BRAND_MAX_TOKENS = 300;

export interface BrandTheme {
  surface: string;
  ink: string;
  accent: string;
  radius: RadiusKey;
  font: FontKey;
  mode: ModeKey;
}

export function buildBrandPrompt(candidates: BrandCandidates): string {
  // Only the signal fields — stylesheet/logo URLs are routing data for the
  // route handler, not brand signals, and never reach the model.
  const signals = {
    siteName: candidates.siteName ?? null,
    themeColor: candidates.themeColor ?? null,
    darkBackground: candidates.darkBackground,
    colorsByFrequency: candidates.colors,
    fontFamiliesByFrequency: candidates.fonts,
    borderRadiiByFrequency: candidates.radii,
  };

  return [
    'You map extracted website brand signals onto a fixed embed-widget theme.',
    'Return ONLY a JSON object with EXACTLY these keys and no prose:',
    '"surface" (hex page background), "ink" (hex body text color), "accent" (hex),',
    '"radius" ("sharp"|"soft"|"round"), "font" ("system"|"serif"|"humanist"|"geometric"),',
    '"mode" ("light"|"dark").',
    '',
    'Guidance:',
    '- surface: the site\'s main page background; ink: its body text color. The pair must read together.',
    '- accent: the most distinctive saturated brand color (theme-color, buttons, links) — never a gray, never a background tint.',
    '- The frequency-counted lists are noisy: they include borders, ad colors, and framework defaults. Prefer colors that look deliberate for this brand over merely frequent ones.',
    '- radius: mostly 0-3px → "sharp"; 4-14px → "soft"; 15px+ or pill shapes → "round".',
    '- font: serif body type → "serif"; geometric/rounded sans → "geometric"; humanist sans → "humanist"; otherwise "system".',
    '- mode: "dark" if the page background is dark, else "light".',
    '',
    'Signals (mechanically extracted, possibly noisy):',
    JSON.stringify(signals),
  ].join('\n');
}

/**
 * The model's text → a shape-checked candidate object, or null. Tolerates
 * JSON wrapped in prose by slicing the outermost brace pair; everything
 * else about the shape is strict (object, no array).
 */
export function parseBrandResponse(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Expand a validated `#rgb` to `#rrggbb`; a 6-digit value is returned as-is. */
function expandHex(hex: string): string {
  return hex.length === 4
    ? '#' + [...hex.slice(1)].map((c) => c + c).join('')
    : hex;
}

/**
 * Fail-closed finalization: every model-suggested value through the exact
 * widget-boundary validators, then the ONE place in the system that repairs
 * contrast instead of rejecting (the widgets reject; a suggestion should
 * come back usable). Returns null when the model's colors don't survive
 * validation — the route maps that to generation_failed.
 */
export function finalizeBrandTheme(
  raw: Record<string, unknown> | null
): { theme: BrandTheme; adjusted: boolean } | null {
  if (!raw) return null;

  const rawSurface = safeSurface(asString(raw.surface));
  const rawAccent = safeAccent(asString(raw.accent));
  const rawInk = safeInk(asString(raw.ink));
  if (!rawSurface || !rawInk || !rawAccent) return null;

  // Expand #rgb → #rrggbb. The validators accept 3-digit hex, but the
  // configurator's <input type="color"> swatches only accept #rrggbb and
  // sanitize a 3-digit value to #000000 (black) — so a model answer of "#fff"
  // would show a black swatch while the preview/snippet used white.
  const surface = expandHex(rawSurface);
  const accent = expandHex(rawAccent);
  let ink = expandHex(rawInk);

  let adjusted = false;
  if (contrastRatio(ink, surface) < 4.5) {
    const repaired = adjustInkForContrast(ink, surface, 4.5);
    if (!repaired) return null;
    ink = repaired.ink;
    adjusted = repaired.adjusted;
  }

  return {
    theme: {
      surface,
      ink,
      accent,
      radius: safeRadiusKey(asString(raw.radius)),
      font: safeFontKey(asString(raw.font)),
      mode: safeModeKey(asString(raw.mode)),
    },
    adjusted,
  };
}
