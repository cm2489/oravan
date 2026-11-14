import manifest from '@/data/portrait-manifest.json';
import missing from '@/data/portrait-missing.json';

/*
 * Mirrored-portrait manifest reader (S15, the portrait companion to F3;
 * the project records §2.3 item 3). The MAIN site
 * (components/RepCard.tsx) still hotlinks `unitedstates.github.io` via
 * `lib/core/reps.ts`'s portraitUrl() through next/image's own optimization
 * proxy — a deliberate, out-of-scope-for-S15 choice: the citizen site never
 * made the embed's "collects nothing, calls no one else" claim, and
 * next/image already keeps the BROWSER's request same-origin there. The
 * embed is different: its whole marquee claim is that nothing it does is
 * observable by, or dependent on, any third party, so this file exists to
 * give the embed its OWN portrait source that never touches
 * unitedstates.github.io from the embed's request path at all — mirrored
 * copies in Vercel Blob, proxied same-origin (see
 * app/embed/portrait/[bioguide]/route.ts).
 *
 * data/portrait-manifest.json is the ONLY thing this file (and that route)
 * ever reads to decide whether a bioguide has a mirrored portrait. It ships
 * committed as `{}` (nothing mirrored yet — no Blob store has been
 * provisioned; see the PR's "Owner enable checklist") and is populated by
 * scripts/mirror-portraits.mjs, which itself no-ops until
 * BLOB_READ_WRITE_TOKEN exists. Both states — empty manifest (no token) and
 * populated manifest (token present) — must keep the embed's browser-side
 * requests same-origin; this module is what lets the widget render NOTHING
 * (an initials fallback) for a bioguide with no entry, rather than a broken
 * <img> tag pointed at a Blob URL the browser would have to fetch itself.
 */

export interface PortraitManifestEntry {
  /** The Vercel Blob URL scripts/mirror-portraits.mjs uploaded to. Never
   *  read directly by the browser — only by the same-origin proxy route. */
  blobUrl: string;
  mirroredAt: string;
}

const MANIFEST = manifest as Record<string, PortraitManifestEntry>;

/** Bioguide IDs are one letter followed by six digits (e.g. "C000127"). */
export const BIOGUIDE_RE = /^[A-Z]\d{6}$/;

export function hasMirroredPortrait(bioguide: string): boolean {
  return BIOGUIDE_RE.test(bioguide) && Object.prototype.hasOwnProperty.call(MANIFEST, bioguide);
}

/** Every bioguide with a mirrored portrait — what the embed widget renders an <img> for. */
export function mirroredPortraitBioguides(): string[] {
  return Object.keys(MANIFEST).filter((b) => BIOGUIDE_RE.test(b));
}

/** The Blob URL for a mirrored bioguide, or null — read ONLY by the proxy route, never the client. */
export function mirroredPortraitBlobUrl(bioguide: string): string | null {
  if (!hasMirroredPortrait(bioguide)) return null;
  return MANIFEST[bioguide].blobUrl;
}

const MISSING = missing as Record<string, { firstMissing: string; lastChecked: string }>;

/**
 * Is this member's photo known to be missing at the portrait source (it
 * answered 404)? data/portrait-missing.json is the record of that,
 * written by scripts/mirror-portraits.mjs. A page that knows the answer
 * renders the initials alone, the way the embed renders nothing for a
 * bioguide with no mirrored portrait, rather than an image that fails.
 * Read by the record page of a member who left (2026-11-13): Sylvester
 * Turner's photo answers 404.
 */
export function portraitKnownMissing(bioguide: string): boolean {
  return BIOGUIDE_RE.test(bioguide) && Object.prototype.hasOwnProperty.call(MISSING, bioguide);
}

/**
 * The flag a member card reads (lib/types.ts CardMember): `{ portraitMissing:
 * true }` for a member whose photo is known missing, `{}` for everyone else.
 * Spread it onto the member on the server, so a card that draws in the
 * browser (components/RepsLookup.tsx) needs no data/ file of its own.
 */
export function portraitFlag(bioguide: string): { portraitMissing?: true } {
  return portraitKnownMissing(bioguide) ? { portraitMissing: true } : {};
}
