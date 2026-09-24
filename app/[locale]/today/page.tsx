import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { TodayBrief } from '@/components/TodayBrief';
import { hreflangAlternates } from '@/lib/hreflang';
import { briefToday, buildBrief } from '@/lib/today';

/*
 * /today — the daily brief (plan item C3). Prerendered like every flat
 * [locale] page (tests/static-rendering.spec.ts): the data it reads is a
 * static import that only changes when a data commit triggers a rebuild, and
 * "today" is the newest date the data itself vouches for (lib/today.ts), never
 * the request's clock. Its dated twin, /today/{date}, renders the identical
 * derivation for any of the last 14 days.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'today' });
  const format = await getFormatter({ locale });
  const date = format.dateTime(new Date(`${briefToday()}T00:00:00Z`), {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return {
    title: t('title'),
    description: t('metaDescription', { date }),
    alternates: hreflangAlternates(locale, '/today'),
  };
}

export default async function TodayPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <TodayBrief brief={buildBrief(briefToday())} locale={locale} />;
}
