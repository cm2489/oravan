import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { after } from 'next/server';
import { noteEmbedReferralDomain } from '@/lib/embed-referrer';
import './embed.css';

/*
 * Root layout for the app/embed/* subtree (S13). This is deliberately a
 * SEPARATE root from app/[locale]/layout.tsx - Next's documented "multiple
 * root layouts" pattern: with no shared app/layout.tsx, each top-level
 * branch under app/ owns its own <html>/<body>. Embed pages carry no app
 * chrome at all (no Header, Footer, skip link, no next-intl locale
 * routing/middleware - see proxy.ts's matcher, which excludes /embed) -
 * they exist to run inside someone else's <iframe>, not inside Oravan's
 * own navigation. Locale here is a widget-local concern (a query param +
 * an always-visible in-widget toggle - see components/embed), not a URL
 * segment, so this layout has none of the [locale] plumbing.
 *
 * noindex here is PERMANENT by construction (an iframe-only page is thin,
 * duplicate content per docs/ideation/2026-07-02-embeds-spec.md §2.2) -
 * this is NOT the citizen site's temporary launch-gate noindex in
 * app/[locale]/layout.tsx, which CI's "Launch-gate reminder" step tracks
 * separately by grepping that exact file path.
 *
 * CSP for this route group lives in next.config.ts's headers() (source:
 * '/embed/:path*') rather than here, since Next's per-route headers()
 * config is the mechanism that actually sets response headers.
 *
 * F3 (S15) - referrer-domain nomination lives HERE, in the shared layout,
 * rather than in each widget page: layouts wrap every current AND future
 * app/embed/*\/page.tsx (a widget's actual document load), so this is the
 * minimal single ingestion point the ledger calls for without duplicating
 * the call into each widget page individually. Deliberately NOT triggered
 * by app/embed/portrait/[bioguide]/route.ts - Route Handlers don't render
 * through a layout at all, and a portrait image is a sub-resource of an
 * already-counted page load, not a second embed visit; counting it too
 * would double- (or triple-, for a rep-lookup card with several members)
 * count a single page load. See lib/embed-referrer.ts for what this does
 * and does not mean (Referer only NOMINATES a candidate domain - it is
 * never auto-counted as a confirmed install). Scheduled with `after()` so a
 * slow or failed write can never delay the widget's own response - the same
 * fail-open posture as every other Upstash write in this repo
 * (lib/ratelimit.ts, lib/scriptcache.ts).
 */
export const metadata: Metadata = {
  title: 'Oravan embed',
  robots: { index: false, follow: false },
};

export default async function EmbedLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const referer = requestHeaders.get('referer');
  after(() => noteEmbedReferralDomain(referer));

  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
