import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { BillsBrowser } from '@/components/BillsBrowser';
import { NewsLens } from '@/components/NewsLens';
import { getNewsBills, getTeasers } from '@/lib/data';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'bills' });
  return { title: t('title') };
}

export default async function BillsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('bills');
  const news = getNewsBills(locale, 6);

  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <h1 className="font-display text-4xl font-bold">{t('title')}</h1>
      <p className="mt-2 max-w-prose text-ink-soft">{t('sub')}</p>
      {news.length > 0 && (
        <div className="mt-8 border-b border-line pb-10">
          <NewsLens bills={news} />
        </div>
      )}
      <BillsBrowser bills={getTeasers(locale)} />
    </div>
  );
}
