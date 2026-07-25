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
import { contrastRatio, hexToRgb, mixHex, pickTextColor, relativeLuminance } from './contrast';

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export type RadiusKey = 'sharp' | 'soft' | 'round';
export type FontKey = 'system' | 'serif' | 'humanist' | 'geometric';
export type ModeKey = 'light' | 'dark' | 'auto';

/**
 * --oravan-radius values, keyed by the closed enum above — never a raw string.
 *
 * This knob governs the CONTROL scale only (panels, cards, buttons, inputs).
 * embed.css derives the MARK scale from it as `min(radius, 3px)`, so the
 * shape law — radius assigned by scale, a chip and a card never sharing a
 * corner — survives every tenant choice: `round` cannot inflate a chip into a
 * capsule, and `sharp` cannot make a mark rounder than the card holding it.
 *
 * `soft` is the default (safeRadiusKey falls back to it), so it is also the
 * value nearly every rendered embed actually gets — which is why it is the
 * design system's own control radius, 8px, and not a near-miss.
 */
export const RADIUS_VALUES: Record<RadiusKey, string> = {
  sharp: '2px',
  soft: '8px',
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
 *
 * LOCKSTEP (DESIGN.md § Embed lockstep): these are variant B's `paper`
 * (#ffffff) and `ink` (#16191b). Variant B has exactly ONE dark, so the dark
 * mode is not a second palette — it is the same two colors swapped, ink
 * becoming the ground it was named for. Both pairs compute to 17.66:1.
 * Change these only together with app/embed/embed.css's :root fallbacks,
 * components/EmbedConfigurator.tsx's DEFAULT_*, and lib/contrast.ts's ink
 * pair — four mirrors, one move.
 */
export const MODE_DEFAULTS: Record<'light' | 'dark', { surface: string; ink: string }> = {
  light: { surface: '#ffffff', ink: '#16191b' },
  dark: { surface: '#16191b', ink: '#ffffff' },
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
  /**
   * The tenant's accent — or, when they supplied a surface/ink pair and no
   * accent, their own ink standing in for it, so embed.css's Oravan-green
   * fallback can never surface on a widget wearing someone else's colors.
   */
  accent?: string;
  surface?: string;
  ink?: string;
  /** Derived: chip/toggle text on the accent, picked by computed contrast. */
  accentInk?: string;
  /** Derived: focus-outline color — accent when it reads on the surface, else ink. */
  focus?: string;
  /**
   * Derived: the info-note callout border/fill, an accent tint over the
   * surface. Emitted ONLY when a real theme is present (accent + a known
   * surface); otherwise embed.css's own neutral ink wash stands. Never
   * amber — amber is spent site-wide on one dated floor-calendar fact, and
   * no widget renders that fact.
   */
  noteBorder?: string;
  noteFill?: string;
  mode: ModeKey;
  radiusKey: RadiusKey;
  fontKey: FontKey;
}

/**
 * WCAG AA for normal text — the ONE bar for every theming decision the widget
 * makes: the tenant's ink/surface pair, and (since 2026-07-25) the derived
 * text color on an accent fill. Exported so components/EmbedConfigurator.tsx
 * imports it instead of keeping a second copy: that mirror is documented, and
 * a documented mirror is still a mirror.
 */
export const MIN_PAIR_CONTRAST = 4.5;

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
  const rawAccent = safeAccent(raw.accent);
  const mode = safeModeKey(raw.mode);

  let surface = safeSurface(raw.surface);
  let ink = safeInk(raw.ink);
  if (!surface || !ink || contrastRatio(ink, surface) < MIN_PAIR_CONTRAST) {
    surface = undefined;
    ink = undefined;
  }
  // Captured BEFORE the forced-mode default is pinned below: the white-label
  // rule turns on whether the TENANT supplied this palette, and Oravan's own
  // mode default must not be mistaken for one.
  const tenantPair = Boolean(surface && ink);
  if (!surface && mode !== 'auto') {
    ({ surface, ink } = MODE_DEFAULTS[mode]);
  }

  // THE WHITE-LABEL BOUNDARY. embed.css's --_accent falls back to Oravan's
  // own `go` green, which is right for an un-themed widget and a LEAK for a
  // tenant who supplied a palette and no accent of their own — they would see
  // our green on their page. Emitting their ink as the accent makes that
  // fallback literal unreachable the moment a tenant palette exists, which is
  // the only way the guarantee can hold: CSS cannot express "fall back to
  // green ONLY if nothing else was themed", so the server has to decide it.
  // Same shape as the derived focus/accentInk below — computed here, never
  // accepted as input.
  const accent = rawAccent ?? (tenantPair ? ink : undefined);

  // accentInk (the text on an accent-filled chip/toggle) picks the tenant's
  // OWN light/dark color when a pair is set — not Oravan's paper/ink — so a
  // themed widget's button text is the buyer's white, not ours. With no pair,
  // pickTextColor's defaults are the variant-B paper/ink pair.
  //
  // ...but WITH an AA FLOOR. Picking the better of the tenant's own two
  // colors says nothing about whether the better one is legible: the
  // ink/surface pair is validated at 4.5:1 above, while the accent is only
  // validated as well-formed hex, so an ordinary tenant palette (a mid-tone
  // accent whose brand ink and surface both sit near it) shipped sub-AA text
  // inside the widget on the buyer's own site (pre-launch audit, 2026-07-25).
  //
  // If the tenant's own choice does not clear 4.5, fall back to whichever of
  // paper/ink does — lib/contrast.ts proves one of them always clears >= 4.58
  // against any surface, so this always converges. The buyer's palette is
  // honored whenever it is legible, and never at the cost of legibility.
  const accentInk = accent
    ? (() => {
        const tenantChoice = pickTextColor(accent, surface, ink);
        if (contrastRatio(accent, tenantChoice) >= MIN_PAIR_CONTRAST) return tenantChoice;
        return pickTextColor(accent);
      })()
    : undefined;
  const focus =
    accent && surface ? (contrastRatio(accent, surface) >= 3 ? accent : ink) : undefined;

  // Note callout tint — only for a genuinely themed widget (accent + a known
  // surface). Absent otherwise, so embed.css's own neutral ink wash stands on
  // the un-themed default. (The historic amber default is gone: amber is
  // spent site-wide on exactly one fact, a bill standing on the floor
  // calendar with its date printed, and no widget renders that fact.)
  const noteBorder = accent && surface ? mixHex(surface, accent, 0.42) : undefined;
  const noteFill = accent && surface ? mixHex(surface, accent, 0.09) : undefined;

  return {
    accent,
    surface,
    ink,
    accentInk,
    focus,
    noteBorder,
    noteFill,
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
  hex('--oravan-note-border', theme.noteBorder);
  hex('--oravan-note-fill', theme.noteFill);
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
