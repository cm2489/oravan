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
    <article className="mx-auto max-w-page px-4 pt-6 pb-12 md:pt-8">
      {/* THE TITLE ACROSS THE TOP, THE TERMS IN TWO COLUMNS (layout pass
          2026-11-28, round 2), as on /privacy: from 80rem the paragraphs flow
          as one sequence down two 33rem columns, left then right, ending at
          about the same depth. One column on a phone and up to 80rem, as
          before. */}
      <h1 className="text-h2-loud font-extrabold">{t('title')}</h1>
      <div className="mt-6 max-w-read min-w-0 space-y-5 xl:max-w-[calc(2*var(--container-read)_+_4rem)] xl:columns-2 xl:gap-x-16">
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
    </article>
  );
}
