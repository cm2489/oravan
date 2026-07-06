import type { Metadata } from 'next';
import './embed.css';

/*
 * Root layout for the app/embed/* subtree (S13). This is deliberately a
 * SEPARATE root from app/[locale]/layout.tsx - Next's documented "multiple
 * root layouts" pattern: with no shared app/layout.tsx, each top-level
 * branch under app/ owns its own <html>/<body>. Embed pages carry no app
 * chrome at all (no Header, Footer, skip link, no next-intl locale
 * routing/middleware - see proxy.ts's matcher, which excludes /embed) -
 * they exist to run inside someone else's <iframe>, not inside Rostra's
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
 */
export const metadata: Metadata = {
  title: 'Rostra embed',
  robots: { index: false, follow: false },
};

export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
