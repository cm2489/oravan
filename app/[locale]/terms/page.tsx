import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { hreflangAlternates } from '@/lib/hreflang';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'terms' });
  return { title: t('title'), alternates: hreflangAlternates(locale, '/terms') };
}

export default async function TermsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('terms');
  const tc = await getTranslations('common');

  return (
    <article className="mx-auto max-w-read px-4 py-12">
      {/* one cap on the column, not one per block */}
      <div className="max-w-read">
        <h1 className="text-h2-loud font-extrabold">{t('title')}</h1>
        <div className="mt-6 space-y-5">
          {(['p1', 'p2', 'p3', 'p4'] as const).map((p) => (
            <p key={p}>{t(p)}</p>
          ))}
          <p>
            {t('p5')}{' '}
            <Link
              href="/privacy"
              className="font-semibold text-go underline underline-offset-2 hover:text-go-deep"
            >
              {tc('footer.privacy')}
            </Link>
          </p>
        </div>
      </div>
    </article>
  );
}
