import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { BillsBrowser } from '@/components/BillsBrowser';
import { StalenessNote } from '@/components/StalenessNote';
import { Chip } from '@/components/system';
import { getTeasers } from '@/lib/core';
import { getMomentSearchTeasers } from '@/lib/moments-ui';
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
          purpose - find and browse bills - leads, and since 2026-09-28 it is
          the whole page. */}
      {/* Live Moments travel with the page so a search that matches one can
          pin it (spec §7.3). Resolved on the server: the browser gets two
          short localized strings and the alias list per moment, never the
          moments corpus. */}
      <BillsBrowser
        bills={getTeasers(locale)}
        freshness={freshness}
        moments={getMomentSearchTeasers(locale)}
      />
      {/* "IN THE NEWS" LEFT THIS PAGE on 2026-09-28 (owner, UX inventory B05:
          cut). It repeated the homepage's band and sat under 3,000+ bills;
          the homepage keeps it (H16). NewsLens still has its `compact` rows,
          so bringing it back is getNewsBills(locale, 6) and
          <NewsLens bills={news.slice(0, 3)} compact /> in a
          `mt-16 border-t border-line pt-8` wrapper here — plus '/bills' back
          on the news-band line of scripts/indexnow-urls.mjs. */}
    </div>
  );
}
