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
    <article className="mx-auto max-w-read px-4 pt-6 pb-12 md:pt-8 xl:max-w-page">
      {/* THE TITLE ACROSS THE TOP, THEN ONE ROW OF TWO (layout pass
          2026-11-28, round 3). Below 80rem: one 33rem column, exactly as
          before. From 80rem the page sits on the site's shell, its left edge
          under the logo, and the terms form two 33rem cells read left then
          right, each a run of whole paragraphs in the page's order: what
          Oravan is, who runs it, AI and its limits, no guarantees on the
          left; the phone, your data and the law on the right. The split is
          the one round 2's pictures showed ending within a few pixels of
          each other; a cell per paragraph left a hole beside the short ones. */}
      <h1 className="text-h2-loud font-extrabold">{t('title')}</h1>
      <div className="mt-6 space-y-5 xl:grid xl:max-w-[calc(2*var(--container-read)_+_4rem)] xl:grid-cols-2 xl:items-start xl:gap-x-16 xl:space-y-0">
        <div className="min-w-0 space-y-5">
          {(['p1', 'operator', 'p2', 'p3'] as const).map((p) => (
            <p key={p}>{t(p)}</p>
          ))}
        </div>
        <div className="min-w-0 space-y-5">
          <p>{t('p4')}</p>
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
