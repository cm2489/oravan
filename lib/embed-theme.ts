/**
 * Embed theming validation (S14). CSS custom properties are the ONLY
 * tenant-facing theming mechanism (docs/ideation/2026-07-02-embeds-spec.md
 * §3.4) — no arbitrary tenant CSS or JS, ever; that's the script-injection
 * door the spec explicitly closes. Every knob here is either a strict
 * format regex (accent: a hex color and nothing else) or a closed enum
 * mapped to a hardcoded safe value (radius, font) — an attacker-controlled
 * query param can therefore never reach the DOM as anything other than one
 * of these pre-approved shapes, regardless of what string is submitted. A
 * value that fails validation is discarded outright (falls back to the
 * default), never partially sanitized and kept.
 *
 * Deliberately NOT 'server-only': the server pages (parsing searchParams)
 * and the configurator's client-side controls (components/EmbedConfigurator)
 * share this one module rather than duplicating the allowlists.
 *
 * Delivery mechanism (brand-preview build): resolveEmbedTheme() +
 * buildThemeCss() render ONE `<style>` tag per embed page
 * (components/embed/EmbedThemeStyle.tsx) whose entire contents are
 * `--oravan-*` custom-property declarations plus `color-scheme` — every
 * value either a re-verified hex or a literal from the closed RADIUS_VALUES/
 * FONT_VALUES maps. That is still "CSS custom properties are the ONLY
 * theming mechanism": the tag can never carry a selector, rule, or value a
 * validator didn't produce, and buildThemeCss defensively re-tests every
 * hex before interpolation.
 */
import { contrastRatio, hexToRgb, pickTextColor, relativeLuminance } from './contrast';

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export type RadiusKey = 'sharp' | 'soft' | 'round';
export type FontKey = 'system' | 'serif' | 'humanist' | 'geometric';
export type ModeKey = 'light' | 'dark' | 'auto';

/** --oravan-radius values, keyed by the closed enum above — never a raw string. */
export const RADIUS_VALUES: Record<RadiusKey, string> = {
  sharp: '2px',
  soft: '10px',
  round: '20px',
};

/** --oravan-font values, keyed by the closed enum above — never a raw string. */
// Double-quoted, not single-quoted: browsers re-serialize font-family lists
// with double quotes in computed style (WebKit confirmed), so this literal
// matches what getComputedStyle().getPropertyValue('--oravan-font') returns.
// humanist/geometric are system-font-only stacks (modern-font-stacks canon):
// approximating a tenant's typeface vibe must never cost a network request —
// loading a real webfont inside the iframe would hand visitor IPs to a font
// host and break the "collects nothing about your visitors" claim.
export const FONT_VALUES: Record<FontKey, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  humanist: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif',
  geometric: 'Avenir, Montserrat, Corbel, "URW Gothic", source-sans-pro, sans-serif',
};

/**
 * The default palette per forced mode — the exact literals embed.css ships
 * as token fallbacks. A forced mode with no tenant pair pins these, so
 * "mode=dark" renders the brand's own dark palette regardless of the
 * visitor's OS preference.
 */
export const MODE_DEFAULTS: Record<'light' | 'dark', { surface: string; ink: string }> = {
  light: { surface: '#f3ecdd', ink: '#2a2318' },
  dark: { surface: '#1b1611', ink: '#e4d9c0' },
};

/**
 * A validated hex color, or undefined if the input isn't exactly one. This
 * is the one theming knob that carries free-form-looking text, so it's the
 * one an injection attempt targets — a full-string regex match (not a
 * substring search) means anything beyond a bare `#rgb`/`#rrggbb` fails
 * closed rather than getting truncated/escaped and partially honored.
 */
export function safeAccent(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  return HEX_COLOR_RE.test(value) ? value : undefined;
}

/**
 * safeSurface/safeInk: the exact same fail-closed hex gate as safeAccent,
 * under names that make call sites read as what they validate. A lone valid
 * surface or ink is later discarded by resolveEmbedTheme (pair-or-nothing) —
 * validation here is shape-only.
 */
export function safeSurface(value: string | undefined | null): string | undefined {
  return safeAccent(value);
}

export function safeInk(value: string | undefined | null): string | undefined {
  return safeAccent(value);
}

export function safeRadiusKey(value: string | undefined | null): RadiusKey {
  return value === 'sharp' || value === 'round' ? value : 'soft';
}

export function safeFontKey(value: string | undefined | null): FontKey {
  return value === 'serif' || value === 'humanist' || value === 'geometric' ? value : 'system';
}

export function safeModeKey(value: string | undefined | null): ModeKey {
  return value === 'light' || value === 'dark' ? value : 'auto';
}

/*
 * White-label knobs (S5a). Same closed-enum, fail-closed convention:
 * anything but the exact opt-in token means the branded default.
 * `brandless` removes the Oravan name from widget chrome (never the
 * AI-integrity chip); attribution stays ON unless `attribution=none`,
 * which the embeds docs gate to licensed partners.
 */
export function safeBrandless(value: string | undefined | null): boolean {
  return value === '1' || value === 'true';
}

export function safeAttribution(value: string | undefined | null): 'on' | 'none' {
  return value === 'none' ? 'none' : 'on';
}

/**
 * The fully-resolved theme an embed page renders: validated knobs plus the
 * two derived colors (accentInk, focus) that are computed server-side and
 * never accepted as input. `surface`/`ink` are only ever present as a pair
 * that already cleared AA (4.5:1).
 */
export interface ResolvedEmbedTheme {
  accent?: string;
  surface?: string;
  ink?: string;
  /** Derived: chip/toggle text on the accent, picked by computed contrast. */
  accentInk?: string;
  /** Derived: focus-outline color — accent when it reads on the surface, else ink. */
  focus?: string;
  mode: ModeKey;
  radiusKey: RadiusKey;
  fontKey: FontKey;
}

/**
 * Validate + resolve every theming searchParam into the closed shape above.
 *
 * Contrast policy at THIS boundary is reject, never repair (the header's
 * "discarded outright, never partially sanitized and kept"): an ink/surface
 * pair below 4.5:1 is dropped as a pair, and a lone surface or lone ink is
 * dropped too (pair-or-nothing — a supplied ink can't be checked against
 * the two mode-dependent default surfaces at once). /api/brand is the
 * surface that repairs instead of rejecting, before values ever get here.
 *
 * A forced mode with no surviving pair pins that mode's default palette so
 * the widget actually renders forced-dark/-light instead of following the
 * visitor's OS preference.
 */
export function resolveEmbedTheme(raw: {
  accent?: string;
  surface?: string;
  ink?: string;
  mode?: string;
  radius?: string;
  font?: string;
}): ResolvedEmbedTheme {
  const accent = safeAccent(raw.accent);
  const mode = safeModeKey(raw.mode);

  let surface = safeSurface(raw.surface);
  let ink = safeInk(raw.ink);
  if (!surface || !ink || contrastRatio(ink, surface) < 4.5) {
    surface = undefined;
    ink = undefined;
  }
  if (!surface && mode !== 'auto') {
    ({ surface, ink } = MODE_DEFAULTS[mode]);
  }

  const accentInk = accent ? pickTextColor(accent) : undefined;
  const focus =
    accent && surface ? (contrastRatio(accent, surface) >= 3 ? accent : ink) : undefined;

  return {
    accent,
    surface,
    ink,
    accentInk,
    focus,
    mode,
    radiusKey: safeRadiusKey(raw.radius),
    fontKey: safeFontKey(raw.font),
  };
}

/**
 * The one place theme values become CSS text. Selector `:root:root` so
 * `color-scheme` here deterministically outranks embed.css's own
 * `:root { color-scheme: light dark }` regardless of stylesheet order —
 * custom properties don't need the specificity, color-scheme does.
 *
 * Defense in depth: every hex is re-tested against HEX_COLOR_RE at the
 * moment of interpolation (even though resolveEmbedTheme only produces
 * validated values), and enum-keyed values come straight out of the closed
 * maps — a future refactor bug upstream turns into a dropped declaration
 * here, never injected CSS.
 */
export function buildThemeCss(theme: ResolvedEmbedTheme): string {
  const decls: string[] = [];
  const hex = (name: string, value: string | undefined) => {
    if (value && HEX_COLOR_RE.test(value)) decls.push(`${name}:${value}`);
  };

  hex('--oravan-accent', theme.accent);
  hex('--oravan-surface', theme.surface);
  hex('--oravan-ink', theme.ink);
  hex('--oravan-accent-ink', theme.accentInk);
  hex('--oravan-focus', theme.focus);
  decls.push(`--oravan-radius:${RADIUS_VALUES[theme.radiusKey]}`);
  decls.push(`--oravan-font:${FONT_VALUES[theme.fontKey]}`);

  // Forced mode states its scheme outright; a tenant pair under auto derives
  // its scheme from the surface so form controls match the rendered palette;
  // plain auto emits nothing and embed.css's `light dark` + media query rule.
  const scheme =
    theme.mode !== 'auto'
      ? theme.mode
      : theme.surface && hexToRgb(theme.surface)
        ? relativeLuminance(hexToRgb(theme.surface)!) >= 0.1791
          ? 'light'
          : 'dark'
        : undefined;
  if (scheme) decls.push(`color-scheme:${scheme}`);

  return `:root:root{${decls.join(';')}}`;
}
