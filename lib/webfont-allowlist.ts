/*
 * The font-CDN allowlist for the /embeds preview mockup's exact-typeface
 * load (brand-preview build). Its own tiny module so the client mockup can
 * import the check without pulling the whole HTML/CSS extraction bundle in.
 *
 * Tight on purpose: the submitted URL is attacker-influenced, so the mockup
 * will only ever <link> a stylesheet from a known font host, never an
 * arbitrary third-party CSS URL. This governs ONLY the mockup on /embeds
 * (Oravan's own page) — the widget iframe never loads any of these.
 */
export const WEBFONT_HOST_ALLOWLIST = [
  'fonts.googleapis.com',
  'fonts.bunny.net',
  'use.typekit.net',
  'p.typekit.net',
];

/** True if `url` is an https stylesheet from an allowlisted font CDN. */
export function isAllowlistedWebfontUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && WEBFONT_HOST_ALLOWLIST.includes(parsed.hostname);
  } catch {
    return false;
  }
}
