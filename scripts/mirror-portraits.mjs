/**
 * Mirrors public-domain congressional portraits (the unitedstates/images
 * project) into Vercel Blob so the embed can serve them same-origin,
 * instead of hotlinking a third party from inside the iframe (S15, the
 * portrait companion to F3; docs/ideation/2026-07-02-embeds-spec.md §2.3
 * item 3).
 *
 * SAFE BEFORE THE SECRET EXISTS - mirrors sync-bills.yml's NEWS_API_KEY-gated
 * "Sync coverage" step pattern: this script no-ops loudly (exit 0, one clear
 * log line, no network call) when BLOB_READ_WRITE_TOKEN is unset, so it is
 * safe to wire into the nightly workflow immediately, before a Blob store
 * has ever been created. See the PR's "Owner enable checklist" for the
 * one-time setup this needs (create the store, add the token).
 *
 * Writes data/portrait-manifest.json: { [bioguide]: { blobUrl, mirroredAt } }
 * - the ONLY thing app/embed/portrait/[bioguide]/route.ts and
 * lib/core/portraits.ts ever read to decide whether a mirrored portrait
 * exists for a given bioguide. Already-mirrored bioguides are skipped on
 * later runs (a member's portrait essentially never changes mid-term); a
 * per-legislator fetch/upload failure is logged and skipped, never aborting
 * the run - one broken portrait must not block the other ~536.
 *
 * Run manually with `node scripts/mirror-portraits.mjs` once the owner has
 * added the token, to backfill the initial manifest without waiting for the
 * next scheduled sync.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const MANIFEST_PATH = 'data/portrait-manifest.json';
const LEGISLATORS_PATH = 'data/legislators.json';

function sourceUrl(bioguide) {
  return `https://unitedstates.github.io/images/congress/450x550/${bioguide}.jpg`;
}

function readManifest() {
  if (!existsSync(MANIFEST_PATH)) return {};
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    // Corrupt/unparseable file: don't guess, don't overwrite blindly on top
    // of something a human should look at - but don't crash the pipeline
    // over an asset-mirroring nicety either. Start from empty; every
    // bioguide will simply be treated as "not yet mirrored" this run.
    console.error(`mirror-portraits: ${MANIFEST_PATH} did not parse as JSON - starting from an empty manifest`);
    return {};
  }
}

async function main() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    console.log(
      'mirror-portraits: BLOB_READ_WRITE_TOKEN not set - no Blob store provisioned yet, skipping (expected until the owner completes the enable checklist; see the S15 PR body)'
    );
    return;
  }

  const { put } = await import('@vercel/blob');
  const legislators = JSON.parse(readFileSync(LEGISLATORS_PATH, 'utf8'));
  const manifest = readManifest();

  let mirrored = 0;
  let failed = 0;
  let skipped = 0;

  for (const { bioguide } of legislators) {
    if (!bioguide) continue;
    if (manifest[bioguide]) {
      skipped += 1;
      continue;
    }
    try {
      const res = await fetch(sourceUrl(bioguide));
      if (!res.ok) {
        failed += 1;
        console.error(`mirror-portraits: ${bioguide} source fetch failed (status ${res.status}) - skipped`);
        continue;
      }
      const bytes = await res.arrayBuffer();
      const blob = await put(`portraits/${bioguide}.jpg`, bytes, {
        access: 'public',
        contentType: 'image/jpeg',
        token,
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      manifest[bioguide] = { blobUrl: blob.url, mirroredAt: new Date().toISOString() };
      mirrored += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `mirror-portraits: ${bioguide} failed - ${err instanceof Error ? err.message : 'unknown error'}`
      );
    }
  }

  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `mirror-portraits: ${mirrored} newly mirrored, ${skipped} already mirrored (skipped), ${failed} failed, ${Object.keys(manifest).length} total in manifest`
  );
}

main().catch((err) => {
  console.error(`mirror-portraits: unexpected failure - ${err instanceof Error ? err.message : String(err)}`);
  // Never fail the nightly pipeline over a portrait-mirroring nicety - the
  // embed's own graceful fallback (initials avatar) covers any bioguide
  // this run didn't get to.
  process.exitCode = 0;
});
