import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'privacy' });
  return { title: t('title') };
}

export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('privacy');

  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="font-display text-4xl font-bold">{t('title')}</h1>
      <div className="mt-6 space-y-5 leading-relaxed max-w-prose">
        {(['p1', 'p2', 'p3', 'p4', 'p5'] as const).map((p) => (
          <p key={p} className={p === 'p5' ? 'font-semibold' : undefined}>
            {t(p)}
          </p>
        ))}
        <p className="text-ink-soft">{t('contact')}</p>
      </div>
    </article>
  );
}
