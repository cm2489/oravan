import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { after } from 'next/server';
import { billSlug, getBill, localizeBill } from '@/lib/core';
import { formatCitation } from '@/lib/format';
import { getFreshness } from '@/lib/freshness';
import { resolveEmbedTheme, safeAttribution, safeBrandless } from '@/lib/embed-theme';
import { noteImpressionForToken } from '@/lib/impressions';
import { callerIp } from '@/lib/ratelimit';
import { BillCardWidget, type BillCardData } from '@/components/embed/BillCardWidget';
import { EmbedThemeStyle } from '@/components/embed/EmbedThemeStyle';

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ brandless?: string }>;
}): Promise<Metadata> {
  const { brandless } = await searchParams;
  return {
    // Brandless embeds keep the name out of the page title too.
    title: safeBrandless(brandless) ? 'Bill card' : 'Oravan embed — bill card',
    robots: { index: false, follow: false },
  };
}

function normalizeLocale(value: string | undefined): 'en' | 'es' {
  return value === 'es' ? 'es' : 'en';
}

/*
 * The bill-card embed (S14). `locale` and `slug` are the content inputs a
 * host page's iframe src (built by public/embed.js) supplies; the theming
 * inputs (accent/surface/ink/mode/radius/font) are each validated through
 * lib/embed-theme's resolveEmbedTheme before they ever reach CSS
 * (CSS-custom-properties-only theming, no exceptions). An unknown or
 * missing slug renders the widget's own "bill not found" state rather than
 * calling notFound() — this route has no not-found boundary of its own
 * (app/embed's root layout carries no site chrome to render around one),
 * and a graceful in-widget message keeps the iframe's contract (always
 * something coherent, only ever content Oravan authored) intact.
 *
 * S20 (F6): an OPTIONAL `token` param, same contract as rep-lookup's own —
 * absent -> byte-for-byte unchanged; present -> a background, non-blocking
 * impression count via after(), never a new paywall, never affects
 * rendering either way. See lib/impressions.ts.
 */
export default async function BillCardEmbedPage({
  searchParams,
}: {
  searchParams: Promise<{
    locale?: string;
    slug?: string;
    token?: string;
    accent?: string;
    surface?: string;
    ink?: string;
    mode?: string;
    radius?: string;
    font?: string;
    brandless?: string;
    attribution?: string;
  }>;
}) {
  const { locale: localeParam, slug, token, accent, surface, ink, mode, radius, font, brandless, attribution } =
    await searchParams;
  const locale = normalizeLocale(localeParam);
  const raw = typeof slug === 'string' && slug.length > 0 ? getBill(slug) : undefined;
  const bill = raw ? localizeBill(raw, locale) : null;

  if (token) {
    const ip = callerIp(await headers());
    after(() => noteImpressionForToken(token, ip));
  }

  const billData: BillCardData | null = bill
    ? {
        slug: billSlug(bill),
        citation: formatCitation(bill.bill_type, bill.bill_number),
        headline: bill.ai_headline,
        officialTitle: bill.short_title ?? bill.title,
        status: bill.status,
      }
    : null;

  return (
    <>
      <EmbedThemeStyle theme={resolveEmbedTheme({ accent, surface, ink, mode, radius, font })} />
      <BillCardWidget
        initialLocale={locale}
        bill={billData}
        dataAsOf={getFreshness().checkedAt}
        brandless={safeBrandless(brandless)}
        attribution={safeAttribution(attribution)}
      />
    </>
  );
}
