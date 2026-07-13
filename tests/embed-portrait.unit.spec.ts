import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): the route only touches next/server, which
// resolves under the test runner - same pattern as tests/feedback.unit.spec.ts.
import { GET, buildPortraitResponse } from '../app/embed/portrait/[bioguide]/route';
import { BIOGUIDE_RE, hasMirroredPortrait, mirroredPortraitBioguides } from '../lib/core/portraits';
import manifestJson from '../data/portrait-manifest.json';

/*
 * S15 - the embed's same-origin portrait proxy. The graceful-fallback
 * contract this pins: BOTH states of data/portrait-manifest.json (empty/
 * "dark" - no Blob store provisioned yet - and populated/"armed", the
 * state it has carried since 2026-07-12 once scripts/mirror-portraits.mjs
 * ran for real) must never let the browser's own request leave this app's
 * origin. This spec proves the SERVER half of that (the route never
 * proxies without a token AND a manifest entry, and streams bytes through
 * unmodified when both exist); the "no <img> renders for an unmirrored
 * bioguide" half is components/embed/RepLookupWidget.tsx's job, exercised
 * in tests/embed-rep-lookup.spec.ts and tests/embed-loader.spec.ts's
 * existing zero-third-party network trace.
 *
 * These assertions derive their expectations from the REAL, committed
 * data/portrait-manifest.json (imported here directly as `manifestJson`,
 * independent of lib/core/portraits.ts's own read of the same file) rather
 * than hardcoding either state - so this file keeps holding no matter how
 * many rows scripts/mirror-portraits.mjs has mirrored on a given day.
 * Separately: local/CI test runs never carry BLOB_READ_WRITE_TOKEN (no
 * .env* file in this repo ships or sets it), so the route's own
 * defense-in-depth token check keeps 404ing every real request in this
 * suite regardless of manifest content unless a test explicitly sets the
 * env var itself (and restores it in afterEach below).
 */

const REAL_BIOGUIDE = 'C000127'; // Maria Cantwell - a real row in data/legislators.json
const realFetch = globalThis.fetch;
const realToken = process.env.BLOB_READ_WRITE_TOKEN;

test.afterEach(() => {
  globalThis.fetch = realFetch;
  if (realToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = realToken;
});

function req(bioguide: string) {
  return GET(new Request(`http://localhost/embed/portrait/${bioguide}`) as never, {
    params: Promise.resolve({ bioguide }),
  });
}

/**
 * A syntactically-valid bioguide (matches BIOGUIDE_RE) proven to have no
 * manifest entry TODAY by checking it against the real committed manifest,
 * rather than assuming either state. Real bioguide IDs are assigned by the
 * Clerk of the House / Secretary of the Senate off a scheme this reserved
 * "Z9xxxxx" block never intersects, so this search is safe indefinitely.
 */
function pickAbsentBioguide(): string {
  for (let n = 999999; n >= 900000; n--) {
    const candidate = `Z${n}`;
    if (!hasMirroredPortrait(candidate)) return candidate;
  }
  throw new Error(
    'every candidate in the reserved Z9xxxxx block is already mirrored - widen pickAbsentBioguide()'
  );
}

test.describe('lib/core/portraits.ts: reads the real committed manifest (holds whether the Blob store is dark or armed)', () => {
  test("mirroredPortraitBioguides() exactly matches the committed manifest's keys", () => {
    const expected = Object.keys(manifestJson)
      .filter((b) => BIOGUIDE_RE.test(b))
      .sort();
    expect(mirroredPortraitBioguides().sort()).toEqual(expected);
  });

  test("hasMirroredPortrait() for a real bioguide matches the committed manifest's membership", () => {
    const inManifest = Object.prototype.hasOwnProperty.call(manifestJson, REAL_BIOGUIDE);
    expect(hasMirroredPortrait(REAL_BIOGUIDE)).toBe(inManifest);
  });

  test('BIOGUIDE_RE matches real bioguide shapes and rejects garbage', () => {
    expect(BIOGUIDE_RE.test('C000127')).toBe(true);
    expect(BIOGUIDE_RE.test('c000127')).toBe(false); // case-sensitive
    expect(BIOGUIDE_RE.test('../../etc/passwd')).toBe(false);
    expect(BIOGUIDE_RE.test('C00012')).toBe(false); // one digit short
    expect(BIOGUIDE_RE.test('')).toBe(false);
  });
});

test.describe('app/embed/portrait/[bioguide]/route.ts: fails closed, never fetches without a real reason to', () => {
  test('malformed bioguide: 404, no fetch attempted', async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error('must not be called');
    }) as typeof fetch;

    const res = await req('../../etc/passwd');
    expect(res.status).toBe(404);
    expect(fetchCalled).toBe(false);
  });

  test('no BLOB_READ_WRITE_TOKEN configured (this suite\'s own environment - no .env* ships or sets it): 404, no fetch attempted, even for a bioguide the manifest DOES carry', async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error('must not be called');
    }) as typeof fetch;

    // REAL_BIOGUIDE's manifest membership is irrelevant here - the route
    // checks the token BEFORE it ever looks at the manifest, so this proves
    // that ordering regardless of which state data/portrait-manifest.json
    // is in today.
    const res = await req(REAL_BIOGUIDE);
    expect(res.status).toBe(404);
    expect(fetchCalled).toBe(false);
  });

  test('token present but no manifest entry for this bioguide: 404, no fetch attempted', async () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'test-blob-token';
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error('must not be called');
    }) as typeof fetch;

    // pickAbsentBioguide() proves against the REAL committed manifest that
    // this bioguide has no entry, rather than assuming the manifest is
    // empty - proves the route checks the manifest, not just the token.
    const res = await req(pickAbsentBioguide());
    expect(res.status).toBe(404);
    expect(fetchCalled).toBe(false);
  });

  test('token present and the manifest DOES carry an entry: the route proceeds past both guards to a real fetch attempt (mocked here)', async () => {
    test.skip(
      mirroredPortraitBioguides().length === 0,
      'no Blob store armed in this committed tree yet - nothing to exercise this branch against (see the dark-state tests above)'
    );
    process.env.BLOB_READ_WRITE_TOKEN = 'test-blob-token';
    const mirroredBioguide = mirroredPortraitBioguides()[0];
    const expectedUrl = (manifestJson as Record<string, { blobUrl: string }>)[mirroredBioguide].blobUrl;
    let fetchCalled = false;
    let requestedUrl: string | null = null;
    globalThis.fetch = (async (url: unknown) => {
      fetchCalled = true;
      requestedUrl = String(url);
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }) as typeof fetch;

    const res = await req(mirroredBioguide);
    expect(fetchCalled).toBe(true);
    expect(requestedUrl).toBe(expectedUrl);
    expect(res.status).toBe(200);
  });
});

test.describe('buildPortraitResponse: the token-present, manifest-has-an-entry state', () => {
  /*
   * This block exercises the exact network/streaming logic the route
   * delegates to once a bioguide has a real manifest entry, with the one
   * variable (the resolved Blob URL) supplied directly rather than routed
   * through the real manifest - the route-level test just above this one
   * covers that routing (when the committed manifest has at least one
   * entry to exercise it against; see that test's own skip condition for
   * the dark-state case).
   */
  const FAKE_BLOB_URL = 'https://fake-store.public.blob.vercel-storage.com/portraits/C000127.jpg';

  test('happy path: streams the upstream bytes back with image content-type and a long cache header', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    let requestedUrl: string | null = null;
    globalThis.fetch = (async (url: unknown) => {
      requestedUrl = String(url);
      return new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }) as typeof fetch;

    const res = await buildPortraitResponse(FAKE_BLOB_URL);
    expect(requestedUrl).toBe(FAKE_BLOB_URL);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toContain('immutable');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual(Array.from(bytes));
  });

  test('upstream Blob fetch returns a non-2xx: 404, never throws', async () => {
    globalThis.fetch = (async () => new Response('gone', { status: 404 })) as typeof fetch;
    const res = await buildPortraitResponse(FAKE_BLOB_URL);
    expect(res.status).toBe(404);
  });

  test('upstream Blob fetch throws (network failure): 404, never throws out of this function', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('mock network failure');
    }) as typeof fetch;
    const res = await buildPortraitResponse(FAKE_BLOB_URL);
    expect(res.status).toBe(404);
  });
});
