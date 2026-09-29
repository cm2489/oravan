/**
 * Mirrors public-domain congressional portraits (the unitedstates/images
 * project) into Vercel Blob so the embed can serve them same-origin,
 * instead of hotlinking a third party from inside the iframe (S15, the
 * portrait companion to F3; the project records §2.3
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
 * Writes data/portrait-missing.json: { [bioguide]: { firstMissing, lastChecked } }
 * - members whose upstream photo answered 404. They are skipped for
 * RECHECK_DAYS days, then asked again; the record is dropped the moment a
 * photo turns up. Nothing on the site reads it: a reader still sees the
 * initials fallback exactly as before, and the manifest keeps its meaning
 * ("a portrait is mirrored"). This file only stops the nightly run asking
 * for photos that are known not to exist.
 *
 * Run manually with `node scripts/mirror-portraits.mjs` once the owner has
 * added the token, to backfill the initial manifest without waiting for the
 * next scheduled sync.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const MANIFEST_PATH = 'data/portrait-manifest.json';
const MISSING_PATH = 'data/portrait-missing.json';
const LEGISLATORS_PATH = 'data/legislators.json';

/** A member whose photo answered 404 is not asked again for this many days. */
export const RECHECK_DAYS = 30;

function sourceUrl(bioguide) {
  return `https://unitedstates.github.io/images/congress/450x550/${bioguide}.jpg`;
}

function readJsonObject(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Corrupt/unparseable file: don't guess, don't overwrite blindly on top
    // of something a human should look at - but don't crash the pipeline
    // over an asset-mirroring nicety either. Start from empty; every
    // bioguide will simply be treated as "not yet recorded" this run.
    console.error(`mirror-portraits: ${path} did not parse as JSON - starting from an empty file`);
    return {};
  }
}

/**
 * The run itself, with every outside thing injected so a test needs no
 * network, no Blob store and no clock. Mutates `manifest` and `missing` and
 * returns the counts.
 */
export async function runMirror({
  legislators,
  manifest,
  missing,
  fetchImpl,
  put,
  token,
  now = new Date(),
  log = console.log,
  error = console.error,
}) {
  const today = now.toISOString().slice(0, 10);
  const recheckBefore = now.getTime() - RECHECK_DAYS * 86_400_000;
  let mirrored = 0;
  let failed = 0;
  let skipped = 0;
  let knownMissing = 0;

  for (const { bioguide } of legislators) {
    if (!bioguide) continue;
    if (manifest[bioguide]) {
      skipped += 1;
      continue;
    }
    const seen = missing[bioguide];
    if (seen && Date.parse(seen.lastChecked) > recheckBefore) {
      knownMissing += 1;
      continue;
    }
    try {
      const res = await fetchImpl(sourceUrl(bioguide));
      if (!res.ok) {
        failed += 1;
        // Keep this line's format: lib/pipeline-health.mjs (countPortrait404s) parses it.
        error(`mirror-portraits: ${bioguide} source fetch failed (status ${res.status}) - skipped`);
        if (res.status === 404) {
          missing[bioguide] = { firstMissing: seen?.firstMissing ?? today, lastChecked: today };
        }
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
      manifest[bioguide] = { blobUrl: blob.url, mirroredAt: now.toISOString() };
      delete missing[bioguide];
      mirrored += 1;
    } catch (err) {
      failed += 1;
      error(`mirror-portraits: ${bioguide} failed - ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }

  log(
    `mirror-portraits: ${mirrored} newly mirrored, ${skipped} already mirrored (skipped), ${knownMissing} known missing upstream (not re-requested), ${failed} failed, ${Object.keys(manifest).length} total in manifest`
  );
  return { mirrored, skipped, knownMissing, failed };
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
  const manifest = readJsonObject(MANIFEST_PATH);
  const missing = readJsonObject(MISSING_PATH);
  const missingBefore = JSON.stringify(missing);

  await runMirror({ legislators, manifest, missing, fetchImpl: fetch, put, token });

  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  // Only rewrite when something changed, so a quiet night adds no diff.
  if (JSON.stringify(missing) !== missingBefore || !existsSync(MISSING_PATH)) {
    writeFileSync(MISSING_PATH, `${JSON.stringify(missing, null, 2)}\n`);
  }
}

if (/(^|\/)mirror-portraits\.mjs$/.test(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error(`mirror-portraits: unexpected failure - ${err instanceof Error ? err.message : String(err)}`);
    // Never fail the nightly pipeline over a portrait-mirroring nicety - the
    // embed's own graceful fallback (initials avatar) covers any bioguide
    // this run didn't get to.
    process.exitCode = 0;
  });
}
