import { buildFeedPayload } from '@/lib/core/feed';

/*
 * S21 — the Spanish twin of app/feed/whats-moving.json/route.ts. This lives
 * under a literal `app/es/` folder, NOT `app/[locale]/es/...` — the path
 * `/es/feed/whats-moving.json` contains a dot, so proxy.ts's matcher
 * (`'/((?!api|_next|_vercel|embed/|embed$|.*\\..*).*)'`) already excludes
 * it from next-intl's middleware entirely, exactly like every other dotted
 * top-level route in this repo (llms.txt, sitemap.xml, robots.txt). A
 * literal `app/es` directory is therefore a normal, unambiguous static
 * route segment here, not a collision with the `[locale]` dynamic segment.
 */
export const dynamic = 'force-static';

export function GET() {
  return new Response(JSON.stringify(buildFeedPayload('es'), null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
