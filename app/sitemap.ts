import type { MetadataRoute } from 'next';
import { routing } from '@/i18n/routing';
import { billSlug, getAllBills } from '@/lib/core';
import { getFreshness } from '@/lib/freshness';
import { absoluteUrl } from '@/lib/hreflang';

/*
 * S22 — no sitemap existed before this PR. Ships alongside the still-active
 * noindex gate (app/[locale]/layout.tsx) harmlessly: a sitemap only tells a
 * crawler where pages are, it doesn't force indexing, and every listed page
 * still self-reports noindex until Colby lifts that gate. When it lifts,
 * this file needs no change — it becomes live ammunition immediately.
 *
 * Reuses lib/hreflang.ts's `absoluteUrl` (not a second copy of the same
 * URL-building logic) so this file's URLs are byte-identical to the pages'
 * own canonical/alternate tags — including the root-path special case Next's
 * Metadata resolver applies (bare origin, no trailing slash for "/").
 *
 * Every entry carries the same reciprocal, absolute language map (no
 * x-default here — Google's sitemap `xhtml:link` support doesn't define an
 * x-default convention the way the per-page <link rel="alternate"> tag
 * does, so this mirrors just en/es).
 */

const STATIC_PATHS = [
  '/',
  '/bills',
  '/reps',
  '/about',
  '/privacy',
  '/terms',
  '/why-call',
  '/impact',
  '/citations',
  '/embeds',
  '/embeds/terms',
  '/partners',
  '/mcp',
] as const;

function languagesFor(href: string): Record<string, string> {
  return Object.fromEntries(routing.locales.map((l) => [l, absoluteUrl(l, href)]));
}

export default function sitemap(): MetadataRoute.Sitemap {
  const { checkedAt } = getFreshness();
  const siteLastModified = new Date(checkedAt);
  const entries: MetadataRoute.Sitemap = [];

  for (const href of STATIC_PATHS) {
    const alternates = { languages: languagesFor(href) };
    for (const locale of routing.locales) {
      entries.push({
        url: absoluteUrl(locale, href),
        lastModified: siteLastModified,
        alternates,
      });
    }
  }

  for (const bill of getAllBills()) {
    const href = `/bills/${billSlug(bill)}`;
    const alternates = { languages: languagesFor(href) };
    // Real per-bill signal when we have one; the corpus-wide "last checked"
    // timestamp otherwise — never an invented date.
    const lastModified = bill.last_action_date ? new Date(bill.last_action_date) : siteLastModified;
    for (const locale of routing.locales) {
      entries.push({
        url: absoluteUrl(locale, href),
        lastModified,
        alternates,
      });
    }
  }

  return entries;
}
