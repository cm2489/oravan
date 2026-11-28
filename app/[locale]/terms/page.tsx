import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { hreflangAlternates } from '@/lib/hreflang';
import { DOC_ROW } from '@/lib/layout';

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
    <article className="mx-auto max-w-page px-4 pt-6 pb-12 md:pt-8">
      {/* A TITLE COLUMN BESIDE THE TEXT (layout pass 2026-11-28), as on
          /privacy: the title on the left, riding along as the reader scrolls,
          and the terms in one 33rem reading column on the right. One column
          on a phone, as before. */}
      <div className={DOC_ROW}>
        <div className="lg:sticky lg:top-4 lg:self-start">
          <h1 className="text-h2-loud font-extrabold">{t('title')}</h1>
        </div>
        <div className="mt-6 max-w-read min-w-0 space-y-5 lg:mt-0">
          {(['p1', 'operator', 'p2', 'p3', 'p4'] as const).map((p) => (
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
          <p>{t('law')}</p>
        </div>
      </div>
    </article>
  );
}
