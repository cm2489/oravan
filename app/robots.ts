import type { MetadataRoute } from 'next';
import { SITE_ORIGIN } from '@/lib/site';

/*
 * S22 — no robots.txt existed before this PR, so crawling was implicitly
 * unrestricted (Next's behavior with no file present); the noindex meta tag
 * in app/[locale]/layout.tsx (`robots: { index: false, follow: false }`) has
 * been the *only* gate, and stays the only gate — this file does not loosen
 * or tighten that gate, and must not.
 *
 * The rule below intentionally preserves the same permissive-crawl posture
 * rather than disallowing everything. That's not an oversight: a noindex
 * directive only works if the crawler is able to reach the page and read it
 * — Google's own guidance is that blocking crawl access via robots.txt hides
 * the noindex tag from Googlebot entirely, which can paradoxically cause a
 * bare URL to surface in results (linked from elsewhere) with no snippet,
 * worse than today's no-file default. So: keep crawling open, keep noindex
 * doing the actual work, exactly as today. The one real hardening beyond the
 * prior (nonexistent) file — /api/* is excluded, since those routes were
 * never meant to be crawled or indexed regardless of the launch gate.
 *
 * TODO(launch): nothing needs to change in this file when the noindex gate
 * lifts (app/[locale]/layout.tsx) — crawl access is already correct today,
 * so indexing activates the moment that meta tag flips, with no separate
 * robots.txt change to remember.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: '/api/',
    },
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
  };
}
