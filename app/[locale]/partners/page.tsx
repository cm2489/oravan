import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { hreflangAlternates } from '@/lib/hreflang';
import { EMBEDS_PAGES_PUBLIC } from '@/lib/site';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'partners' });
  return { title: t('title'), alternates: hreflangAlternates(locale, '/partners') };
}

/*
 * S5b — the GTM surface for the three launch audiences (Spanish-language
 * newsrooms, libraries, paid orgs). Docs-grade and pricing-free by founder
 * decision (M6, 2026-07-07: terms deferred); the licensing section's
 * contact is hello@oravan.org (M12, S8 cutover; confirmed live via PR #64).
 * The beta feedback fallback it used to offer was removed on 2026-09-28.
 *
 * Also 2026-09-28: the /embeds pages are hidden until embeds come back
 * (lib/site.ts EMBEDS_PAGES_PUBLIC), so the "Build your embed" button prints
 * only while that constant is true, and the copy says the embeds aren't open
 * to new sites right now.
 */
export default async function PartnersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('partners');

  return (
    <article className="mx-auto max-w-read px-4 py-12">
      {/* one cap on the column, not one per block */}
      <div className="max-w-read">
        <h1 className="text-h2-loud font-extrabold">{t('title')}</h1>
        <p className="mt-4 text-lede text-ink-2">{t('intro')}</p>

        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-h3 font-extrabold">{t('newsroomsTitle')}</h2>
          <p className="mt-2">{t('newsroomsBody')}</p>
          {/* the page's one filled action — green, with the two-tone focus
              stack (`ring-gap` swaps the border to paper so the ink ring is
              never adjacent to the green fill) */}
          {EMBEDS_PAGES_PUBLIC && (
            <Link
              href="/embeds"
              className="ring-gap mt-4 inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-go bg-go px-5 font-bold text-paper no-underline hover:border-go-deep hover:bg-go-deep"
            >
              {t('newsroomsCta')} <span aria-hidden>→</span>
            </Link>
          )}
        </section>

        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-h3 font-extrabold">{t('librariesTitle')}</h2>
          <p className="mt-2">{t('librariesBody')}</p>
        </section>

        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-h3 font-extrabold">{t('orgsTitle')}</h2>
          <p className="mt-2">{t('orgsBody')}</p>
        </section>

        {/* A recessed `wash` panel, so its own edge is `ink-2` (7.23:1), not
            `line-strong` — line-strong on wash is 2.97:1 and only an inactive
            control may take it. */}
        <section className="mt-8 rounded-control border border-ink-2 bg-wash p-6">
          <h2 className="text-h3 font-extrabold">{t('licensingTitle')}</h2>
          <p className="mt-2">{t('licensingBody')}</p>
          {/* The partnership contact (M12). */}
          <a
            href="mailto:hello@oravan.org"
            className="mt-4 inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-ink px-5 font-bold text-ink no-underline hover:bg-ink hover:text-paper"
          >
            {t('licensingCta')} <span aria-hidden>→</span>
          </a>
        </section>
      </div>
    </article>
  );
}
