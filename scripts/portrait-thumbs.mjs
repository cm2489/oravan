/**
 * The small member pictures the members page sends INSIDE its lookup's answer
 * (owner, 2026-11-12: "Send the pictures inside the lookup's own answer, so
 * no separate request names a member. Nothing a visitor sees changes.").
 *
 * WHY. After a ZIP lookup the browser used to request each member's picture
 * on its own, through next/image: `GET /_next/image?url=…/C001056.jpg…`. A
 * House member's id points to one congressional district, so the host's
 * request log could show which district a visitor looked up (CLAUDE.md rule
 * 1). Now the server action that answers the lookup (lib/members-action.ts)
 * puts each member's picture in its answer as a `data:` address, read from
 * the file this script writes, so the browser makes no request that names a
 * member. lib/member-portraits.ts is the reader.
 *
 * WHAT IT WRITES. data/portrait-thumbs.json: { [bioguide]: base64 WebP }, one
 * member per line, sorted. Each picture is the public-domain portrait
 * (unitedstates.github.io, the same source the site has always shown and
 * the same file the embed mirrors) cut to 216 x 264 pixels: three times the
 * card's 72 x 88 frame, so it is as sharp as today's on a 3x phone screen,
 * in WebP at quality 75, the format and quality next/image served it in.
 * About 5 KB a member; the whole file is about 3.6 MB.
 *
 * WHEN IT FETCHES. Never at lookup time: only here, in the nightly job
 * (sync-bills.yml, next to the embed's mirror step), and only for a member
 * the file does not have yet. A member who left the roster is dropped. A
 * member whose photo answered 404 is left out (the card shows the initials,
 * as it always has when a picture fails) and, like the embed's mirror, not
 * asked again until data/portrait-missing.json's re-check comes round. A
 * picture already in the file is never fetched again (a member's official
 * photo rarely changes mid-term; the embed's mirror makes the same call).
 *
 * NEVER FAILS THE NIGHTLY RUN. A member that fails is logged and skipped; an
 * unexpected failure leaves the file as it was and exits 0. The file is
 * written once, at the end, and only when it changed.
 *
 *   node scripts/portrait-thumbs.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { RECHECK_DAYS } from './mirror-portraits.mjs';

export const THUMBS_PATH = 'data/portrait-thumbs.json';
const MISSING_PATH = 'data/portrait-missing.json';
const LEGISLATORS_PATH = 'data/legislators.json';

/** Three times the card's 72 x 88 CSS-pixel frame (components/RepCard.tsx). */
export const THUMB_WIDTH = 216;
export const THUMB_HEIGHT = 264;
/** next/image's default quality, which is what the card was served at. */
export const THUMB_QUALITY = 75;
/** How many pictures are fetched at once. */
const CONCURRENCY = 6;

const BIOGUIDE_RE = /^[A-Z]\d{6}$/;

export function sourceUrl(bioguide) {
  return `https://unitedstates.github.io/images/congress/450x550/${bioguide}.jpg`;
}

/**
 * One picture, cut to the card's frame the way the card shows it
 * (`object-cover`, centred) and encoded as base64 WebP. `sharp` is passed in
 * so a test can use the real one on a generated image without the network.
 */
export async function encodeThumb(sharp, bytes) {
  const out = await sharp(Buffer.from(bytes))
    .rotate()
    .resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: 'cover', position: 'centre' })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer();
  return out.toString('base64');
}

/**
 * The run, with every outside thing injected so a test needs no network and
 * no clock. Returns the new map (sorted by bioguide) and the counts; it never
 * throws for one member.
 */
export async function runThumbs({
  legislators,
  thumbs,
  missing = {},
  fetchImpl,
  encode,
  now = new Date(),
  log = console.log,
  error = console.error,
}) {
  const recheckBefore = now.getTime() - RECHECK_DAYS * 86_400_000;
  const roster = new Set(legislators.map((l) => l.bioguide).filter((b) => typeof b === 'string' && BIOGUIDE_RE.test(b)));
  const next = {};
  let kept = 0;
  let dropped = 0;
  let knownMissing = 0;
  const todo = [];
  for (const bioguide of [...roster].sort()) {
    if (typeof thumbs[bioguide] === 'string' && thumbs[bioguide].length > 0) {
      next[bioguide] = thumbs[bioguide];
      kept += 1;
      continue;
    }
    const seen = missing[bioguide];
    if (seen && Date.parse(seen.lastChecked) > recheckBefore) {
      knownMissing += 1;
      continue;
    }
    todo.push(bioguide);
  }
  for (const bioguide of Object.keys(thumbs)) if (!roster.has(bioguide)) dropped += 1;

  let added = 0;
  let failed = 0;
  async function one(bioguide) {
    try {
      const res = await fetchImpl(sourceUrl(bioguide));
      if (!res.ok) {
        failed += 1;
        error(`portrait-thumbs: ${bioguide} source fetch failed (status ${res.status}) - skipped`);
        return;
      }
      next[bioguide] = await encode(await res.arrayBuffer());
      added += 1;
    } catch (err) {
      failed += 1;
      error(`portrait-thumbs: ${bioguide} failed - ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    await Promise.all(todo.slice(i, i + CONCURRENCY).map(one));
  }

  const sorted = Object.fromEntries(Object.keys(next).sort().map((b) => [b, next[b]]));
  log(
    `portrait-thumbs: ${added} added, ${kept} kept, ${dropped} dropped (left the roster), ${knownMissing} known missing upstream (not re-requested), ${failed} failed, ${Object.keys(sorted).length} total`
  );
  return { thumbs: sorted, added, kept, dropped, knownMissing, failed };
}

/** The file's text: one member per line, so a nightly diff names only the members that changed. */
export function serializeThumbs(thumbs) {
  const keys = Object.keys(thumbs).sort();
  if (keys.length === 0) return '{}\n';
  return `{\n${keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(thumbs[k])}`).join(',\n')}\n}\n`;
}

function readJsonObject(path) {
  if (!existsSync(path)) return {};
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    console.error(`portrait-thumbs: ${path} did not parse as JSON - starting from an empty file`);
    return {};
  }
}

async function main() {
  const { default: sharp } = await import('sharp');
  const legislators = JSON.parse(readFileSync(LEGISLATORS_PATH, 'utf8'));
  const before = existsSync(THUMBS_PATH) ? readFileSync(THUMBS_PATH, 'utf8') : '';
  const { thumbs } = await runThumbs({
    legislators,
    thumbs: readJsonObject(THUMBS_PATH),
    missing: readJsonObject(MISSING_PATH),
    fetchImpl: fetch,
    encode: (bytes) => encodeThumb(sharp, bytes),
  });
  const text = serializeThumbs(thumbs);
  if (text !== before) writeFileSync(THUMBS_PATH, text);
}

if (/(^|\/)portrait-thumbs\.mjs$/.test(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error(`portrait-thumbs: unexpected failure - ${err instanceof Error ? err.message : String(err)}`);
    // Never fail the nightly pipeline over the pictures: a member without one
    // shows the initials, as a failed picture always has.
    process.exitCode = 0;
  });
}
