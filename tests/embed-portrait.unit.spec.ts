import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): the route only touches next/server, which
// resolves under the test runner - same pattern as tests/feedback.unit.spec.ts.
import { GET, buildPortraitResponse } from '../app/embed/portrait/[bioguide]/route';
import { BIOGUIDE_RE, hasMirroredPortrait, mirroredPortraitBioguides } from '../lib/core/portraits';

/*
 * S15 - the embed's same-origin portrait proxy. The graceful-fallback
 * contract this pins: BOTH states (no BLOB_READ_WRITE_TOKEN configured -
 * today's shipped default, since no Blob store has been provisioned yet -
 * and token-present-with-a-real-mirrored-entry) must never let the
 * browser's own request leave this app's origin. This spec proves the
 * SERVER half of that (the route never proxies without a token AND a
 * manifest entry, and streams bytes through unmodified when both exist);
 * the "no <img> renders for an unmirrored bioguide" half is
 * components/embed/RepLookupWidget.tsx's job, exercised in
 * tests/embed-rep-lookup.spec.ts and tests/embed-loader.spec.ts's existing
 * zero-third-party network trace (which the shipped empty manifest keeps
 * passing unchanged).
 *
 * lib/core/portraits.ts reads the REAL, committed data/portrait-manifest.json
 * (shipped as `{}` - no bioguide has been mirrored yet), so those read-only
 * assertions below describe the actual shipped state, not a fixture.
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

test.describe('lib/core/portraits.ts: the shipped manifest (no Blob store provisioned yet)', () => {
  test('the committed manifest is empty - every bioguide falls back to initials', () => {
    expect(mirroredPortraitBioguides()).toEqual([]);
    expect(hasMirroredPortrait(REAL_BIOGUIDE)).toBe(false);
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

  test('no BLOB_READ_WRITE_TOKEN configured (the shipped default): 404, no fetch attempted', async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error('must not be called');
    }) as typeof fetch;

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

    // Real, valid bioguide shape, but the shipped manifest has no entry for
    // ANY bioguide yet - proves the route checks the manifest, not just the
    // token.
    const res = await req(REAL_BIOGUIDE);
    expect(res.status).toBe(404);
    expect(fetchCalled).toBe(false);
  });

});

test.describe('buildPortraitResponse: the token-present, manifest-has-an-entry state', () => {
  /*
   * data/portrait-manifest.json ships empty, so the full route (GET) can
   * never reach this state in this repo today - that's the correct,
   * honestly-disclosed limit (see this file's header comment). This block
   * exercises the exact network/streaming logic the route delegates to
   * once scripts/mirror-portraits.mjs has populated a real entry, with the
   * one variable (the resolved Blob URL) supplied directly rather than
   * routed through the real manifest.
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
