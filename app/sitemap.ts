import type { MetadataRoute } from 'next';
import { routing } from '@/i18n/routing';
import { billSlug, getAllBills } from '@/lib/core';
// Imported DIRECTLY, never through the lib/core barrel — that module's header
// forbids the barrel so no bundle pays for data/nominations.json by accident.
import { getNomination } from '@/lib/core/nominations';
import { getFreshness } from '@/lib/freshness';
import { absoluteUrl } from '@/lib/hreflang';
import { getMoments, vehicleKind } from '@/lib/moments';
import { latestUpdateDay } from '@/lib/moment-updates';
import { latestVehicleAction } from '@/lib/moments-ui';

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
  '/record',
  '/citations',
  '/embeds',
  '/embeds/terms',
  '/partners',
  '/mcp',
  '/questions',
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

  // Moments (v2 slice S5): every non-retired moment, both locales — settled
  // ones stay listed because their pages persist as the fight's record.
  // Retired means the page 404s, so listing it would be a lie to crawlers.
  // lastModified prefers a recorded live-layer update (the strongest recency
  // claim we can prove), then the newest vehicle action, then the corpus
  // stamp — never an invented date, mirroring the bills loop above.
  for (const moment of getMoments()) {
    if (moment.state === 'retired') continue;
    const href = `/questions/${moment.id}`;
    const alternates = { languages: languagesFor(href) };
    const day = latestUpdateDay(moment.id) ?? latestVehicleAction(moment.vehicles);
    const lastModified = day ? new Date(day) : siteLastModified;
    for (const locale of routing.locales) {
      entries.push({
        url: absoluteUrl(locale, href),
        lastModified,
        alternates,
      });
    }
  }

  /*
   * Senate nominations — ONLY the ones a non-retired moment actually cites.
   *
   * The corpus holds 857 records and every one of them has a reachable page,
   * but a page being reachable is not the same as this site claiming it. The
   * uncited ones self-report `noindex` (see the nomination page's header), so
   * listing them here would tell a crawler to go look at 1,714 URLs whose own
   * head tags say not to index them — a sitemap arguing with its own pages.
   *
   * Read off the moments file rather than off a nomination flag, because
   * "this site publishes it" is a fact about curation, not about the Senate.
   * lastModified prefers the record's own last action, then the corpus stamp
   * — never an invented date, mirroring both loops above.
   */
  const citedNominations = new Map<string, string | null>();
  for (const moment of getMoments()) {
    if (moment.state === 'retired') continue;
    for (const v of moment.vehicles) {
      if (vehicleKind(v) !== 'nomination') continue;
      citedNominations.set(v.slug, getNomination(v.slug)?.last_action_date ?? null);
    }
  }
  for (const [slug, day] of citedNominations) {
    const href = `/nominations/${slug}`;
    const alternates = { languages: languagesFor(href) };
    const lastModified = day ? new Date(day) : siteLastModified;
    for (const locale of routing.locales) {
      entries.push({ url: absoluteUrl(locale, href), lastModified, alternates });
    }
  }

  return entries;
}
