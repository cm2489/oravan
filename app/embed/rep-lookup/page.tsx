import type { Metadata } from 'next';
import { mirroredPortraitBioguides } from '@/lib/core';
import { RepLookupWidget } from '@/components/embed/RepLookupWidget';

export const metadata: Metadata = {
  title: 'Rostra — representative lookup',
  robots: { index: false, follow: false },
};

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
 */
export default async function RepLookupEmbedPage({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string; zip?: string }>;
}) {
  const { locale: localeParam, zip } = await searchParams;
  const locale = normalizeLocale(localeParam);
  const initialZip = zip && /^\d{5}$/.test(zip) ? zip : null;

  return (
    <RepLookupWidget
      initialLocale={locale}
      initialZip={initialZip}
      availablePortraits={mirroredPortraitBioguides()}
    />
  );
}
