import { buildFeedPayload } from '@/lib/core/feed';

/*
 * S21 — the free, public, keyless "what moved this week" JSON feed (EN).
 * `force-static`, matching app/llms.txt/route.ts exactly: the underlying
 * data (data/bills.json, data/sync-state.json) is itself a build-time
 * static import that only changes on nightly-sync-and-redeploy, so there is
 * no request-time freshness a dynamic route could gain here — and
 * force-static means zero new Upstash usage, zero new rate limiter, zero
 * new abuse surface for this route (no auth, by design — see
 * lib/core/feed.ts's header comment).
 *
 * The folder name IS the URL (`/feed/whats-moving.json`) — the same
 * pre-13.3 dotted-folder route-handler convention app/llms.txt/route.ts
 * already uses, because Next has no first-class metadata-route convention
 * for an arbitrary JSON feed the way it does for sitemap.xml/robots.txt.
 * Four locale-explicit routes (this one + its .xml twin + the two under
 * app/es/feed/) exist instead of one route reading a `?locale=` param
 * because a `force-static` handler renders at build with no request object
 * to read a query string from.
 */
export const dynamic = 'force-static';

export function GET() {
  return new Response(JSON.stringify(buildFeedPayload('en'), null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
