import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { TodayBrief } from '@/components/TodayBrief';
import { routing } from '@/i18n/routing';
import { hreflangAlternates } from '@/lib/hreflang';
import { briefWindow, buildBrief, isBriefDate } from '@/lib/today';

/*
 * /today/{YYYY-MM-DD} — a dated permalink for each of the last 14 days, every
 * one prerendered from the data at build time with the same derivation as
 * /today. A day with nothing on the record renders the honest empty state.
 *
 * Anything outside the window is a real 404 inside the locale boundary (the
 * bills/[id] posture: `dynamicParams = true` + notFound(), so a Spanish
 * visitor gets the Spanish not-found page). The window is computed from the
 * committed data, not from the clock, so an on-demand render can never admit
 * a date the build did not — see lib/today.ts.
 */
export const dynamicParams = true;

export function generateStaticParams() {
  return routing.locales.flatMap((locale) => briefWindow().map((date) => ({ locale, date })));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; date: string }>;
}): Promise<Metadata> {
  const { locale, date } = await params;
  // notFound(), not `{}`: the same condition as the page body below, thrown
  // here too so the 404's tab title comes from app/[locale]/not-found.tsx
  // rather than the site default (UI audit F11; the bills/[id] posture).
  if (!isBriefDate(date)) notFound();
  const t = await getTranslations({ locale, namespace: 'today' });
  const format = await getFormatter({ locale });
  const label = format.dateTime(new Date(`${date}T00:00:00Z`), {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return {
    title: t('titleDated', { date: label }),
    description: t('metaDescription', { date: label }),
    alternates: hreflangAlternates(locale, `/today/${date}`),
  };
}

export default async function TodayDatedPage({
  params,
}: {
  params: Promise<{ locale: string; date: string }>;
}) {
  const { locale, date } = await params;
  setRequestLocale(locale);
  if (!isBriefDate(date)) notFound();
  return <TodayBrief brief={buildBrief(date)} locale={locale} />;
}
