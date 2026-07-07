import type { Metadata } from 'next';
import { billSlug, getBill, localizeBill } from '@/lib/core';
import { formatCitation } from '@/lib/format';
import { getFreshness } from '@/lib/freshness';
import { safeAccent, safeAttribution, safeBrandless, safeFontKey, safeRadiusKey } from '@/lib/embed-theme';
import { BillCardWidget, type BillCardData } from '@/components/embed/BillCardWidget';

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
 * host page's iframe src (built by public/embed.js) supplies; `accent`,
 * `radius`, and `font` are the theming inputs — every one of the three is
 * validated through lib/embed-theme before it ever reaches a style prop
 * (CSS-custom-properties-only theming, no exceptions). An unknown or
 * missing slug renders the widget's own "bill not found" state rather than
 * calling notFound() — this route has no not-found boundary of its own
 * (app/embed's root layout carries no site chrome to render around one),
 * and a graceful in-widget message keeps the iframe's contract (always
 * something coherent, only ever content Oravan authored) intact.
 */
export default async function BillCardEmbedPage({
  searchParams,
}: {
  searchParams: Promise<{
    locale?: string;
    slug?: string;
    accent?: string;
    radius?: string;
    font?: string;
    brandless?: string;
    attribution?: string;
  }>;
}) {
  const { locale: localeParam, slug, accent, radius, font, brandless, attribution } = await searchParams;
  const locale = normalizeLocale(localeParam);
  const raw = typeof slug === 'string' && slug.length > 0 ? getBill(slug) : undefined;
  const bill = raw ? localizeBill(raw, locale) : null;

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
    <BillCardWidget
      initialLocale={locale}
      bill={billData}
      dataAsOf={getFreshness().checkedAt}
      theme={{
        accent: safeAccent(accent),
        radiusKey: safeRadiusKey(radius),
        fontKey: safeFontKey(font),
      }}
      brandless={safeBrandless(brandless)}
      attribution={safeAttribution(attribution)}
    />
  );
}
