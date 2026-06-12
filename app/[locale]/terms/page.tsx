import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'terms' });
  return { title: t('title') };
}

export default async function TermsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('terms');
  const tc = await getTranslations('common');

  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="font-display text-4xl font-bold">{t('title')}</h1>
      <div className="mt-6 space-y-5 leading-relaxed max-w-prose">
        {(['p1', 'p2', 'p3', 'p4'] as const).map((p) => (
          <p key={p}>{t(p)}</p>
        ))}
        <p>
          {t('p5')}{' '}
          <Link href="/privacy" className="underline underline-offset-2 font-semibold">
            {tc('footer.privacy')}
          </Link>
        </p>
      </div>
    </article>
  );
}
