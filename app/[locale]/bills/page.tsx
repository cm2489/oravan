import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { BillsBrowser } from '@/components/BillsBrowser';
import { NewsLens } from '@/components/NewsLens';
import { StalenessNote } from '@/components/StalenessNote';
import { getNewsBills, getTeasers } from '@/lib/core';
import { dataAsOfString, getFreshness } from '@/lib/freshness';
import { hreflangAlternates } from '@/lib/hreflang';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'bills' });
  return { title: t('title'), alternates: hreflangAlternates(locale, '/bills') };
}

export default async function BillsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('bills');
  const news = getNewsBills(locale, 6);
  const freshness = getFreshness();
  const dataAsOf = await dataAsOfString(locale);

  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <h1 className="font-display text-4xl font-bold">{t('title')}</h1>
      <p className="mt-2 max-w-prose text-ink-soft">{t('sub')}</p>
      <p className="mt-1 text-xs text-ink-faint">{dataAsOf}</p>
      {/* R2: client-side stale caveat — renders nothing while fresh */}
      <StalenessNote checkedAt={freshness.checkedAt} />
      {news.length > 0 && (
        <div className="mt-8 border-b border-line pb-10">
          <NewsLens bills={news} />
        </div>
      )}
      <BillsBrowser bills={getTeasers(locale)} checkedAt={freshness.checkedAt} />
    </div>
  );
}
