import manifest from '@/data/portrait-manifest.json';

/*
 * Mirrored-portrait manifest reader (S15, the portrait companion to F3;
 * docs/ideation/2026-07-02-embeds-spec.md §2.3 item 3). The MAIN site
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
