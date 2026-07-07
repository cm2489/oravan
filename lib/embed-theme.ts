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
 * Deliberately NOT 'server-only': the validated `RadiusKey`/`FontKey` enum
 * values get mapped to their CSS values inside the client widget
 * (components/embed/BillCardWidget.tsx), so both the server page (parsing
 * searchParams) and the client component (rendering the mapped value) share
 * this one module rather than duplicating the allowlists.
 */

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export type RadiusKey = 'sharp' | 'soft' | 'round';
export type FontKey = 'system' | 'serif';

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
export const FONT_VALUES: Record<FontKey, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
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

export function safeRadiusKey(value: string | undefined | null): RadiusKey {
  return value === 'sharp' || value === 'round' ? value : 'soft';
}

export function safeFontKey(value: string | undefined | null): FontKey {
  return value === 'serif' ? 'serif' : 'system';
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
