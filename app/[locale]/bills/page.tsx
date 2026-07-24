import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { BillsBrowser } from '@/components/BillsBrowser';
import { NewsLens } from '@/components/NewsLens';
import { StalenessNote } from '@/components/StalenessNote';
import { Chip } from '@/components/system';
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
  const t = await getTranslations();
  const news = getNewsBills(locale, 6);
  const freshness = getFreshness();
  const dataAsOf = await dataAsOfString(locale);

  return (
    <div className="mx-auto max-w-5xl px-4 pt-12 pb-16">
      {/* The page-title rung: the home hero owns `text-h1`, every other page
          titles itself one rung down at `text-h1-bill`. */}
      <h1 className="text-h1-bill font-extrabold text-ink">{t('bills.title')}</h1>
      <p className="mt-4 max-w-read text-lede text-ink-2">{t('bills.sub')}</p>
      {/* R2: the client-side stale caveat continues the stamp's own
          sentence — one line, one date; renders nothing while fresh. This is
          this page's SOLE printed sync date. */}
      <p className="mt-3 max-w-read text-xs text-ink-2">
        {dataAsOf}
        <StalenessNote checkedAt={freshness.checkedAt} />
      </p>
      {/* AI labeled at first contact: every headline in the feed below is an
          AI decode, so the label goes above the feed, not in a footnote. */}
      <p className="mt-5">
        <Chip tone="ai" marker={t('common.aiMarker')} className="max-w-read">
          {t('bills.aiNote')}
        </Chip>
      </p>
      {/* Search-first (2026-07 critique, majority P0): the page's stated
          purpose - find and browse bills - leads; the news lens follows as
          compact rows instead of a duplicated homepage card wall. */}
      <BillsBrowser bills={getTeasers(locale)} freshness={freshness} />
      {news.length > 0 && (
        <div className="mt-16 border-t border-line pt-8">
          <NewsLens bills={news.slice(0, 3)} compact />
        </div>
      )}
    </div>
  );
}
