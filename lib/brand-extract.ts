/*
 * Mechanical brand-signal extraction for /api/brand (brand-preview build).
 * Pure string → candidates; no I/O, no DOM, no parser dependency. Regex
 * harvesting is deliberate: the output is CANDIDATES FOR A LANGUAGE MODEL
 * (lib/brandprompt maps them onto the closed theme knobs), not ground
 * truth, so parser-grade precision buys nothing. Every regex below is a
 * bounded character-class scan over input the fetcher already byte-capped —
 * no nested quantifiers, no backtracking blowups.
 *
 * Privacy shape: candidates carry colors, font names, radii, a site name,
 * and same-host asset URLs — the raw HTML/CSS never leaves this process
 * (never reaches the Anthropic API, never gets stored).
 */

import { relativeLuminance, hexToRgb } from './contrast';
import { isAllowlistedWebfontUrl } from './webfont-allowlist';

export { isAllowlistedWebfontUrl, WEBFONT_HOST_ALLOWLIST } from './webfont-allowlist';

export interface CountedValue {
  value: string;
  count: number;
}

export interface BrandCandidates {
  siteName?: string;
  themeColor?: string;
  /** Same-host https icon, apple-touch-icon preferred (bigger art). */
  logoUrl?: string;
  /** Same-origin stylesheet URLs, first 2 — fetched separately by the route. */
  stylesheets: string[];
  colors: CountedValue[];
  fonts: CountedValue[];
  radii: CountedValue[];
  darkBackground: boolean;
  /**
   * The dominant body font-family, as a CSS-ready stack string. Used ONLY by
   * the /embeds preview MOCKUP chrome (Oravan's own page) for an exact
   * typeface match — never by the shipping widget, which stays on the closed
   * system-font stacks so its zero-third-party-request promise holds.
   */
  bodyFontFamily?: string;
  /**
   * A webfont stylesheet URL (Google Fonts / Typekit / Bunny), if the page
   * links one — so the mockup can actually render the exact face. Host-
   * allowlisted at extraction AND re-validated in the route before the
   * client is ever told to load it.
   */
  webfontHref?: string;
}

const MAX_INPUT_BYTES = 1_572_864; // defensive re-cap; the fetcher already caps
const TOP_COLORS = 12;
const TOP_FONTS = 8;
const TOP_RADII = 5;
const MAX_STYLESHEETS = 2;

/**
 * Normalize a raw font-family declaration into a compact CSS stack string.
 * Strips `<>{};` and control characters so the value is inherently safe to
 * hand the client for the mockup's `style.fontFamily` — legitimate stacks
 * only carry letters, digits, spaces, commas, hyphens, and quotes.
 */
function cleanFontFamily(raw: string): string | undefined {
  const value = normalizeFontRaw(raw);
  // Must name at least one real family, not just inherit/var()/initial.
  if (!value || /^(inherit|initial|unset|revert|var\()/i.test(value)) return undefined;
  return value;
}

function normalizeFontRaw(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20) continue; // control chars
    if (ch === '<' || ch === '>' || ch === '{' || ch === '}' || ch === ';') continue;
    out += ch;
  }
  return out.replace(/!important/gi, '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** All attributes of one HTML tag, lowercased keys, entity-light values. */
function tagAttrs(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([a-zA-Z][\w:-]{0,63})\s*=\s*(?:"([^"]{0,2048})"|'([^']{0,2048})')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    attrs.set(m[1].toLowerCase(), (m[2] ?? m[3] ?? '').trim());
  }
  return attrs;
}

function toHex6(r: number, g: number, b: number): string {
  return (
    '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')
  );
}

/** Normalize a CSS color literal to #rrggbb, or null (keywords, var(), etc). */
export function normalizeCssColor(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 4 || digits.length === 8) {
      // Drop alpha; a fully-transparent color is no brand signal but still a
      // legitimate hue candidate at this stage.
      digits = digits.length === 4 ? digits.slice(0, 3) : digits.slice(0, 6);
    }
    if (digits.length === 3) digits = [...digits].map((c) => c + c).join('');
    return `#${digits}`;
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]{1,6})\s*)?\)$/.exec(
    value
  );
  if (rgb) {
    if (rgb[4] !== undefined && Number(rgb[4]) === 0) return null; // invisible
    return toHex6(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  }
  return null;
}

class Counter {
  private counts = new Map<string, number>();
  add(key: string, by = 1) {
    this.counts.set(key, (this.counts.get(key) ?? 0) + by);
  }
  top(n: number): CountedValue[] {
    return [...this.counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([value, count]) => ({ value, count }));
  }
}

interface CssSignals {
  colors: Counter;
  fonts: Counter;
  radii: Counter;
  bodyBackgrounds: string[];
  /** font-family declared on a body/html rule — the exact body face, ordered. */
  bodyFonts: string[];
  /** Allowlisted webfont stylesheet URLs seen via @import (or carried in). */
  webfontHrefs: string[];
}

function scanCss(cssText: string, into: CssSignals): void {
  const css = cssText.slice(0, MAX_INPUT_BYTES);

  const colorRe = /#[0-9a-f]{3,8}\b|rgba?\([\d\s.,/%]{5,40}\)/gi;
  let m: RegExpExecArray | null;
  while ((m = colorRe.exec(css)) !== null) {
    const hex = normalizeCssColor(m[0]);
    if (hex) into.colors.add(hex);
  }

  const fontRe = /font-family\s*:\s*([^;}{]{1,160})/gi;
  while ((m = fontRe.exec(css)) !== null) {
    into.fonts.add(m[1].trim().slice(0, 120).toLowerCase());
  }

  const radiusRe = /border-radius\s*:\s*([^;}{]{1,60})/gi;
  while ((m = radiusRe.exec(css)) !== null) {
    into.radii.add(m[1].trim().slice(0, 40).toLowerCase());
  }

  // Background AND font-family declarations on body/html rules — the exact
  // page background (dark-site vote) and the exact body typeface (mockup).
  const bodyRuleRe = /(?:^|[}\s,])(?:body|html)[^{}]{0,120}\{([^}]{0,2000})\}/gi;
  while ((m = bodyRuleRe.exec(css)) !== null) {
    const block = m[1];
    const bg = /background(?:-color)?\s*:\s*([^;}]{1,60})/i.exec(block);
    if (bg) {
      const hex = normalizeCssColor(bg[1].trim().split(/\s+/)[0] ?? '');
      if (hex) into.bodyBackgrounds.push(hex);
    }
    const font = /font-family\s*:\s*([^;}]{1,160})/i.exec(block);
    if (font) {
      const cleaned = cleanFontFamily(font[1]);
      if (cleaned) into.bodyFonts.push(cleaned);
    }
  }

  // @import url("https://fonts.googleapis.com/...") — allowlisted only.
  const importRe = /@import\s+(?:url\(\s*)?["']?([^"')\s]{1,300})/gi;
  while ((m = importRe.exec(css)) !== null) {
    if (isAllowlistedWebfontUrl(m[1])) into.webfontHrefs.push(m[1]);
  }
}

function emptySignals(): CssSignals {
  return {
    colors: new Counter(),
    fonts: new Counter(),
    radii: new Counter(),
    bodyBackgrounds: [],
    bodyFonts: [],
    webfontHrefs: [],
  };
}

function isDark(hex: string): boolean {
  const rgb = hexToRgb(hex);
  return rgb !== null && relativeLuminance(rgb) < 0.1791;
}

/**
 * Harvest candidates from a fetched homepage. `finalUrl` (the post-redirect
 * URL) anchors relative hrefs and the same-host rule for icons/stylesheets.
 */
export function extractFromHtml(html: string, finalUrl: URL): BrandCandidates {
  const doc = html.slice(0, MAX_INPUT_BYTES);
  const signals = emptySignals();

  let siteName: string | undefined;
  let themeColor: string | undefined;
  let iconUrl: string | undefined;
  let appleIconUrl: string | undefined;
  const stylesheets: string[] = [];

  const sameHostHttps = (href: string): string | undefined => {
    try {
      const resolved = new URL(href, finalUrl);
      return resolved.protocol === 'https:' && resolved.hostname === finalUrl.hostname
        ? resolved.href
        : undefined;
    } catch {
      return undefined;
    }
  };

  const metaRe = /<meta\b[^>]{0,4096}>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(doc)) !== null) {
    const attrs = tagAttrs(m[0]);
    const content = attrs.get('content');
    if (!content) continue;
    if (attrs.get('property') === 'og:site_name' && !siteName) {
      siteName = content.slice(0, 80);
    }
    if (attrs.get('name') === 'theme-color' && !themeColor) {
      themeColor = normalizeCssColor(content) ?? undefined;
    }
  }

  if (!siteName) {
    const title = /<title[^>]{0,256}>([^<]{1,200})/i.exec(doc);
    if (title) siteName = title[1].trim().slice(0, 80) || undefined;
  }

  const linkRe = /<link\b[^>]{0,4096}>/gi;
  while ((m = linkRe.exec(doc)) !== null) {
    const attrs = tagAttrs(m[0]);
    const rel = (attrs.get('rel') ?? '').toLowerCase();
    const href = attrs.get('href');
    if (!href) continue;
    if (/\bstylesheet\b/.test(rel)) {
      // A cross-origin sheet from an allowlisted font CDN is a webfont link
      // (mockup-only); a same-host sheet is a signal source to fetch.
      let resolved: URL | undefined;
      try {
        resolved = new URL(href, finalUrl);
      } catch {
        resolved = undefined;
      }
      if (resolved && isAllowlistedWebfontUrl(resolved.href) && /[?/][^/]/.test(resolved.pathname + resolved.search)) {
        // Require a real path/query (a Google Fonts `css2?family=…` sheet),
        // not a bare preconnect origin.
        signals.webfontHrefs.push(resolved.href);
      } else if (stylesheets.length < MAX_STYLESHEETS) {
        const url = sameHostHttps(href);
        if (url) stylesheets.push(url);
      }
    } else if (/\bapple-touch-icon\b/.test(rel) && !appleIconUrl) {
      appleIconUrl = sameHostHttps(href);
    } else if (/\bicon\b/.test(rel) && !iconUrl) {
      iconUrl = sameHostHttps(href);
    }
  }

  const styleRe = /<style\b[^>]{0,1024}>([\s\S]{0,262144}?)<\/style/gi;
  while ((m = styleRe.exec(doc)) !== null) {
    scanCss(m[1], signals);
  }
  if (themeColor) signals.colors.add(themeColor, 3); // strong, author-declared signal

  return finalize(signals, { siteName, themeColor, logoUrl: appleIconUrl ?? iconUrl, stylesheets });
}

/** Fold a fetched same-origin stylesheet's signals into existing candidates. */
export function mergeCssSignals(candidates: BrandCandidates, cssText: string): BrandCandidates {
  const signals = emptySignals();
  for (const { value, count } of candidates.colors) signals.colors.add(value, count);
  for (const { value, count } of candidates.fonts) signals.fonts.add(value, count);
  for (const { value, count } of candidates.radii) signals.radii.add(value, count);
  if (candidates.darkBackground) signals.bodyBackgrounds.push('#000000');
  scanCss(cssText, signals);
  return finalize(signals, candidates);
}

function finalize(
  signals: CssSignals,
  base: Pick<
    BrandCandidates,
    'siteName' | 'themeColor' | 'logoUrl' | 'stylesheets' | 'bodyFontFamily' | 'webfontHref'
  >
): BrandCandidates {
  const darkVotes = signals.bodyBackgrounds.filter(isDark).length;
  const darkBackground =
    signals.bodyBackgrounds.length > 0
      ? darkVotes * 2 >= signals.bodyBackgrounds.length
      : base.themeColor
        ? isDark(base.themeColor)
        : false;

  // The exact body face: a body/html font-family declaration if we found one,
  // else the most-frequent font-family overall, else whatever was carried in.
  const bodyFontFamily = signals.bodyFonts[0] ?? cleanFontFamily(signals.fonts.top(1)[0]?.value ?? '') ?? base.bodyFontFamily;
  const webfontHref = signals.webfontHrefs[0] ?? base.webfontHref;

  return {
    siteName: base.siteName,
    themeColor: base.themeColor,
    logoUrl: base.logoUrl,
    stylesheets: base.stylesheets,
    colors: signals.colors.top(TOP_COLORS),
    fonts: signals.fonts.top(TOP_FONTS),
    radii: signals.radii.top(TOP_RADII),
    darkBackground,
    bodyFontFamily,
    webfontHref,
  };
}
