/**
 * WCAG 2.x color math for the embed theming surface (brand-preview build).
 * Pure and dependency-free on purpose: three consumers share it — the
 * embed-theme resolver (server pages), the /api/brand finalizer, and the
 * configurator's live contrast readout (client). The client copy existing is
 * the point: the configurator must warn/omit on EXACTLY the pairs the server
 * would discard, so both sides call this one implementation rather than
 * approximating each other.
 *
 * Deliberately NOT 'server-only' for that reason. Contains no secrets, no
 * I/O, no logging.
 */

/** Parsed sRGB channels 0-255, or null for anything that isn't #rgb/#rrggbb. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#(?:([0-9a-f]{3})|([0-9a-f]{6}))$/i.exec(hex);
  if (!m) return null;
  const s = m[1] ? [...m[1]].map((c) => c + c).join('') : m[2];
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/**
 * WCAG contrast ratio between two hex colors, 1..21. Returns 0 (never a
 * passing value) when either color fails to parse — callers treat 0 as
 * "fails every threshold", which is the fail-closed behavior the theming
 * doctrine requires.
 */
export function contrastRatio(hexA: string, hexB: string): number {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return 0;
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Whichever of the two candidate text colors reads better on `bgHex`.
 * Defaults are the brand's near-white/near-black ink pair, so the shipped
 * default accent (#82632a) keeps yielding today's #fbf8f0 chip text.
 * Unparseable background falls back to the light candidate (matches the
 * pre-existing hardcoded chip color, so a validation slip can only ever
 * reproduce the old look, never invent a new one).
 */
export function pickTextColor(bgHex: string, light = '#fbf8f0', dark = '#1b1611'): string {
  const bg = hexToRgb(bgHex);
  if (!bg) return light;
  return contrastRatio(bgHex, light) >= contrastRatio(bgHex, dark) ? light : dark;
}

/** Linear blend of two parseable hex colors, t in [0,1], returned as #rrggbb. */
export function mixHex(fromHex: string, toHex: string, t: number): string {
  const from = hexToRgb(fromHex)!;
  const to = hexToRgb(toHex)!;
  const ch = (a: number, b: number) => Math.round(a + (b - a) * t);
  const out = [ch(from.r, to.r), ch(from.g, to.g), ch(from.b, to.b)];
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Nudge `ink` toward black or white (direction picked by the surface's
 * luminance) until it clears `min` contrast against `surface`. Used ONLY by
 * /api/brand to repair an AI-suggested palette — the widget boundary rejects
 * instead (lib/embed-theme.ts), because a widget must never render colors
 * the tenant didn't supply.
 *
 * Always converges for min <= 4.58: the better of pure black/white against
 * ANY surface is >= sqrt(21) ~ 4.58 (worst case is the mid-luminance surface
 * where both directions tie), so the extreme is a guaranteed final fallback
 * for the 4.5 threshold. Returns null only for unparseable input.
 */
export function adjustInkForContrast(
  ink: string,
  surface: string,
  min = 4.5
): { ink: string; adjusted: boolean } | null {
  if (!hexToRgb(ink) || !hexToRgb(surface)) return null;
  if (contrastRatio(ink, surface) >= min) return { ink, adjusted: false };

  const target = relativeLuminance(hexToRgb(surface)!) >= 0.1791 ? '#000000' : '#ffffff';
  const STEPS = 12;
  for (let i = 1; i <= STEPS; i++) {
    const candidate = mixHex(ink, target, i / STEPS);
    if (contrastRatio(candidate, surface) >= min) return { ink: candidate, adjusted: true };
  }
  // Unreachable for min <= 4.58 (the i = STEPS candidate IS the extreme),
  // kept for callers that pass a stricter threshold.
  const extreme = contrastRatio('#1b1611', surface) >= contrastRatio('#fbf8f0', surface)
    ? '#1b1611'
    : '#fbf8f0';
  return contrastRatio(extreme, surface) >= min ? { ink: extreme, adjusted: true } : null;
}
