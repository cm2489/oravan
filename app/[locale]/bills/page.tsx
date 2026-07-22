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
      {/* R2: the client-side stale caveat continues the stamp's own
          sentence — one line, one date; renders nothing while fresh */}
      <p className="mt-1 max-w-prose text-xs text-ink-faint">
        {dataAsOf}
        <StalenessNote checkedAt={freshness.checkedAt} />
      </p>
      {/* Search-first (2026-07 critique, majority P0): the page's stated
          purpose - find and browse bills - leads; the news lens follows as
          compact rows instead of a duplicated homepage card wall. */}
      <BillsBrowser bills={getTeasers(locale)} freshness={freshness} />
      {news.length > 0 && (
        <div className="mt-12 border-t border-line pt-8">
          <NewsLens bills={news.slice(0, 3)} compact />
        </div>
      )}
    </div>
  );
}
