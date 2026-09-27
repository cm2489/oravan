import { readFileSync } from 'node:fs';
import { hexToRgb } from '../lib/contrast';

/*
 * THE PALETTE AS ITS SOURCE DECLARES IT — read, never restated.
 *
 * A spec that needs "the colour the site uses for X" reads it here, from
 * app/globals.css's @theme tokens or from the fallbacks app/embed/embed.css
 * ships to an un-themed widget, instead of carrying a hex or an rgb() literal
 * of its own. A literal in a spec is a second copy of the palette: the day the
 * palette changes, that copy either goes red for a reason that has nothing to
 * do with the promise under test, or keeps passing against a colour nothing
 * ships any more.
 *
 * Every lookup throws with the name it could not find, so renaming a token
 * fails the specs that read it loudly instead of letting them compare against
 * `undefined`.
 */

const GLOBALS_CSS = 'app/globals.css';
const EMBED_CSS = 'app/embed/embed.css';

/** Every `--color-NAME: #hex;` token declared in app/globals.css. */
export function colorTokens(css: string = readFileSync(GLOBALS_CSS, 'utf8')): Map<string, string> {
  return new Map(
    [...css.matchAll(/--color-([a-z][a-z0-9-]*):\s*(#[0-9a-fA-F]{3,6})\s*;/g)].map((m) => [m[1], m[2]])
  );
}

/** One app/globals.css colour token's hex, e.g. colorToken('urgent'). */
export function colorToken(name: string): string {
  const hex = colorTokens().get(name);
  if (!hex) throw new Error(`app/globals.css declares no hex --color-${name}`);
  return hex;
}

/**
 * The colour app/embed/embed.css ships when the host sets nothing: the
 * fallback inside the FIRST `var(--oravan-NAME, #hex)` in the file, which is
 * the light `:root` block (the dark media query re-declares only surface and
 * ink). e.g. embedFallback('accent-ink').
 */
export function embedFallback(name: string): string {
  const css = readFileSync(EMBED_CSS, 'utf8');
  const m = new RegExp(`var\\(--oravan-${name},\\s*(#[0-9a-fA-F]{3,6})\\s*\\)`).exec(css);
  if (!m) throw new Error(`app/embed/embed.css has no hex fallback for --oravan-${name}`);
  return m[1];
}

/** A hex in the spelling WebKit's computed style uses: `rgb(r, g, b)`. */
export function rgbOf(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) throw new Error(`not a hex colour: ${hex}`);
  return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
}
