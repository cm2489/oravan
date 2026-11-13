import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { after } from 'next/server';
import { mirroredPortraitBioguides } from '@/lib/core';
import { resolveEmbedTheme, safeAttribution, safeBrandless } from '@/lib/embed-theme';
import { noteImpressionForToken } from '@/lib/impressions';
import { callerIp } from '@/lib/ratelimit';
import { EmbedThemeStyle } from '@/components/embed/EmbedThemeStyle';
import { RepLookupWidget } from '@/components/embed/RepLookupWidget';

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ brandless?: string }>;
}): Promise<Metadata> {
  const { brandless } = await searchParams;
  return {
    // Brandless embeds keep the name out of the page title too.
    title: safeBrandless(brandless) ? 'Representative lookup' : 'Oravan — representative lookup',
    robots: { index: false, follow: false },
  };
}

function normalizeLocale(value: string | undefined): 'en' | 'es' {
  return value === 'es' ? 'es' : 'en';
}

/*
 * The rep-lookup embed (S13). `locale` (plus the theme and white-label knobs)
 * is what a host page's iframe src (built by public/embed.js) supplies.
 * Everything else (the ZIP, results, errors, the EN/ES toggle) is component
 * state in RepLookupWidget - see that file.
 *
 * NO `?zip=` (2026-10-06). This page used to accept an initial ZIP in its own
 * address. public/embed.js never sent one and the configurator never built
 * one; only hand-built iframes could, and every such page load left the
 * visitor's ZIP in the host's request logs (which keep the path with its
 * query string). The visitor types the ZIP into the widget, and the widget
 * POSTs it to /api/reps in the request body. scripts/check-zip-urls.mjs fails
 * CI if this page starts reading a `zip` param again.
 *
 * S20 (F6): an OPTIONAL `token` param. Absent -> byte-for-byte unchanged
 * (no lookup, no write, nothing new touches the request). Present -> a
 * background, non-blocking impression count for the resolved tenant, scheduled
 * via after() so it can never affect this page's own rendering either way
 * (a bad/invalid/revoked token silently no-ops the count, never a new
 * paywall) - see lib/impressions.ts for the full mechanism.
 */
export default async function RepLookupEmbedPage({
  searchParams,
}: {
  searchParams: Promise<{
    locale?: string;
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
  const { locale: localeParam, token, accent, surface, ink, mode, radius, font, brandless, attribution } =
    await searchParams;
  const locale = normalizeLocale(localeParam);

  if (token) {
    const ip = callerIp(await headers());
    after(() => noteImpressionForToken(token, ip));
  }

  return (
    <>
      <EmbedThemeStyle theme={resolveEmbedTheme({ accent, surface, ink, mode, radius, font })} />
      <RepLookupWidget
        initialLocale={locale}
        availablePortraits={mirroredPortraitBioguides()}
        brandless={safeBrandless(brandless)}
        attribution={safeAttribution(attribution)}
      />
    </>
  );
}
