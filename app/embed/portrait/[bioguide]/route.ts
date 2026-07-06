import { NextRequest, NextResponse } from 'next/server';
import { BIOGUIDE_RE, mirroredPortraitBlobUrl } from '@/lib/core/portraits';

/*
 * Same-origin portrait proxy for the embed (S15, the portrait companion to
 * F3; docs/ideation/2026-07-02-embeds-spec.md §2.3 item 3). The browser
 * NEVER talks to Vercel Blob directly — only to this route, on the embed's
 * own origin — so the embed CSP's `img-src 'self'` (next.config.ts) needs
 * no third-party allowance, and the "zero third-party requests" claim holds
 * in BOTH the no-token and token-present states:
 *
 *   - no BLOB_READ_WRITE_TOKEN configured (today's shipped state — no Blob
 *     store has been provisioned yet; see the PR's Owner enable checklist):
 *     this route 404s without attempting any fetch at all, and
 *     components/embed/RepLookupWidget.tsx never even renders an <img>
 *     pointed at it (it only does so for bioguides
 *     lib/core/portraits.ts's mirroredPortraitBioguides() lists — which is
 *     empty until scripts/mirror-portraits.mjs has actually run with a real
 *     token).
 *   - token configured and a bioguide has a mirrored entry: this route
 *     fetches the Blob URL SERVER-SIDE and streams the bytes back under the
 *     embed's own origin — the browser's request never leaves
 *     embed.rostra.org (or whatever the current origin is; see lib/site.ts).
 *
 * Fails closed and cheaply on every edge (bad bioguide shape, no token, no
 * manifest entry, a dead/failed Blob fetch) — a 404, never a thrown error,
 * never a redirect to the third party.
 */
const NOT_FOUND = () => new NextResponse(null, { status: 404 });

/**
 * The network/streaming half, factored out so it's unit-testable against a
 * mocked fetch without needing a real manifest entry (data/portrait-
 * manifest.json ships empty — no bioguide has one yet). Given a resolved
 * Blob URL, fetches it server-side and either streams the bytes back with
 * the right headers, or fails closed to 404 — never throws, never a
 * redirect to the third party.
 */
export async function buildPortraitResponse(blobUrl: string): Promise<NextResponse> {
  let upstream: Response;
  try {
    upstream = await fetch(blobUrl, { cache: 'no-store' });
  } catch {
    return NOT_FOUND();
  }
  if (!upstream.ok || !upstream.body) {
    return NOT_FOUND();
  }
  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'image/jpeg',
      // Portraits essentially never change once mirrored (a member's photo
      // is retaken rarely, if ever, mid-term) - safe to cache aggressively
      // on the same-origin response the browser actually sees.
      'cache-control': 'public, max-age=86400, immutable',
    },
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ bioguide: string }> }
): Promise<NextResponse> {
  const { bioguide } = await params;

  if (!BIOGUIDE_RE.test(bioguide)) {
    return NOT_FOUND();
  }
  // Defense in depth: even if a stale manifest entry were ever committed
  // without the token (it shouldn't be — scripts/mirror-portraits.mjs only
  // writes entries when it successfully uploaded to a real store), this
  // route still refuses to serve anything without the token present at
  // request time.
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NOT_FOUND();
  }

  const blobUrl = mirroredPortraitBlobUrl(bioguide);
  if (!blobUrl) {
    return NOT_FOUND();
  }

  return buildPortraitResponse(blobUrl);
}
