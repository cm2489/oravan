import { buildFeedRss } from '@/lib/core/feed';

/*
 * S21 — the free, public, keyless "what moved this week" RSS 2.0 feed (EN).
 * See app/feed/whats-moving.json/route.ts (its JSON twin) for the full
 * force-static / no-auth / four-static-routes rationale — identical here.
 */
export const dynamic = 'force-static';

export function GET() {
  return new Response(buildFeedRss('en'), {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
