import { buildFeedRss } from '@/lib/core/feed';

/*
 * S21 — the Spanish twin of app/feed/whats-moving.xml/route.ts. See
 * app/es/feed/whats-moving.json/route.ts for why a literal `app/es/`
 * folder is safe here (the dotted path bypasses next-intl's middleware).
 */
export const dynamic = 'force-static';

export function GET() {
  return new Response(buildFeedRss('es'), {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
