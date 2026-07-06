import type { Metadata } from 'next';
import { ArrowRight } from 'lucide-react';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { hreflangAlternates } from '@/lib/hreflang';

const SECTIONS = ['tally', 'email', 'voicemail', 'script', 'respect'] as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'why' });
  return { title: t('title'), alternates: hreflangAlternates(locale, '/why-call') };
}

export default async function WhyCallPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('why');

  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="font-display text-4xl font-bold">{t('title')}</h1>
      <p className="mt-4 text-lg leading-relaxed text-ink-soft">{t('intro')}</p>

      {SECTIONS.map((s) => (
        <section key={s} className="mt-10">
          <h2 className="font-display text-2xl font-bold">{t(`${s}Title`)}</h2>
          <p className="mt-2 leading-relaxed max-w-prose">{t(`${s}Body`)}</p>
        </section>
      ))}

      <Link
        href="/bills"
        className="mt-12 inline-flex items-center gap-2 rounded-control bg-ink px-6 py-3.5 font-semibold text-paper hover:bg-night"
      >
        {t('cta')}
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </article>
  );
}
