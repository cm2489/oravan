import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { after } from 'next/server';
import { mirroredPortraitBioguides } from '@/lib/core';
import { safeAccent, safeAttribution, safeBrandless, safeFontKey, safeRadiusKey } from '@/lib/embed-theme';
import { noteImpressionForToken } from '@/lib/impressions';
import { callerIp } from '@/lib/ratelimit';
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
 * The rep-lookup embed (S13). `locale` and `zip` are the only inputs a host
 * page's iframe src (built by public/embed.js) ever supplies - both plain
 * query params, both public/non-sensitive (a ZIP code, a language choice),
 * consistent with the rest of the API surface's "never a caller-originating
 * content identifier" posture. Everything else (results, errors, the
 * EN/ES toggle) is component state in RepLookupWidget - see that file.
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
    zip?: string;
    token?: string;
    accent?: string;
    radius?: string;
    font?: string;
    brandless?: string;
    attribution?: string;
  }>;
}) {
  const { locale: localeParam, zip, token, accent, radius, font, brandless, attribution } = await searchParams;
  const locale = normalizeLocale(localeParam);
  const initialZip = zip && /^\d{5}$/.test(zip) ? zip : null;

  if (token) {
    const ip = callerIp(await headers());
    after(() => noteImpressionForToken(token, ip));
  }

  return (
    <RepLookupWidget
      initialLocale={locale}
      initialZip={initialZip}
      availablePortraits={mirroredPortraitBioguides()}
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
