/*
 * THE MEMBERS' PICTURES, SENT INSIDE THE LOOKUP'S ANSWER (owner, 2026-11-12:
 * "Send the pictures inside the lookup's own answer, so no separate request
 * names a member. Nothing a visitor sees changes."; CLAUDE.md rule 1).
 *
 * Until that day the members page drew each picture with next/image, so after
 * a lookup the browser asked for `/_next/image?url=…/C001056.jpg…` on its
 * own, once per member. A House member's id names one congressional district,
 * so the host's request log could show which district a visitor looked up.
 * Now the answer to the lookup itself (lib/members-action.ts, and the page's
 * own render for an old /reps?zip= link) carries each picture as a `data:`
 * address, which the browser draws without asking anyone for anything.
 *
 * WHERE THE BYTES COME FROM. data/portrait-thumbs.json, committed, written
 * by scripts/portrait-thumbs.mjs in the nightly job: the public-domain
 * portrait cut to 216 x 264 (three times the card's frame) in WebP. Nothing
 * here fetches: a lookup reads the file the build bundled, so no request
 * leaves the server because of a lookup, and none names a member.
 *
 * SERVER ONLY. This module reads data/, so no 'use client' module may import
 * it (scripts/check-client-imports.mjs, scripts/check-client-bundle.mjs).
 * The client receives only the strings an answer carries.
 */
import thumbs from '@/data/portrait-thumbs.json';
import type { MembersResult } from '@/lib/members';

const THUMBS = thumbs as Record<string, string>;

/** What every picture's address starts with: the bytes follow, in base64. */
export const PORTRAIT_DATA_PREFIX = 'data:image/webp;base64,';

/** The member's picture as a `data:` address, or null when there is none (the card shows the initials). */
export function inlinePortrait(bioguide: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(THUMBS, bioguide)) return null;
  const b64 = THUMBS[bioguide];
  return typeof b64 === 'string' && b64.length > 0 ? `${PORTRAIT_DATA_PREFIX}${b64}` : null;
}

/**
 * The pictures of every member the answer shows, once each (a senator
 * appears under every district of a split ZIP; their picture is sent once).
 * Members with no picture are left out.
 */
export function portraitsFor(result: MembersResult): Record<string, string> {
  const portraits: Record<string, string> = {};
  for (const d of result.districts) {
    for (const r of d.reps) {
      if (r.bioguide in portraits) continue;
      const src = inlinePortrait(r.bioguide);
      if (src) portraits[r.bioguide] = src;
    }
  }
  return portraits;
}

/**
 * The answer with its pictures. `later`: the pictures as a promise that
 * settles one task after the answer is handed back, so React writes the
 * names first and the pictures after them in the same response (a lookup
 * made with JavaScript). Without it, a plain object (the page's own HTML).
 */
export function withPortraits(result: MembersResult | null, later = false): MembersResult | null {
  if (!result || result.districts.length === 0) return result;
  const portraits = portraitsFor(result);
  if (!later) return { ...result, portraits };
  return { ...result, portraits: new Promise((resolve) => setTimeout(() => resolve(portraits), 0)) };
}
