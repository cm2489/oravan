import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { hreflangAlternates } from '@/lib/hreflang';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'privacy' });
  return { title: t('title'), alternates: hreflangAlternates(locale, '/privacy') };
}

export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('privacy');

  return (
    <article className="mx-auto max-w-read px-4 py-12">
      {/* one cap on the column, not one per block */}
      <div className="max-w-read">
        <h1 className="text-h2-loud font-extrabold">{t('title')}</h1>
        <div className="mt-6 space-y-5">
          {(['p1', 'p2', 'p3', 'p7', 'p4', 'p5'] as const).map((p) => (
            <p key={p} className={p === 'p5' ? 'font-semibold' : undefined}>
              {t(p)}
            </p>
          ))}
          <p className="border-t border-line pt-5 text-sm text-ink-2">{t('contact')}</p>
        </div>
      </div>
    </article>
  );
}
