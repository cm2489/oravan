import type { Metadata } from 'next';
import { hasLocale, useTranslations } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';

/*
 * The locale-scoped 404. Living under [locale] is the point: it renders inside
 * the locale layout, so the header, the footer and the correct `lang` all
 * survive — a visitor who mistypes a bill slug is still on Oravan, not on a
 * bare browser error.
 *
 * Every string here already existed, written and reviewed in both languages,
 * and was wired to nothing. No new copy was introduced — the tab title below
 * reuses `notFound.title`, so the tab and the headline say the same thing.
 */

/* The tab title. Without this the 404 inherited the layout's default — the
   site's own name and tagline — so a mistyped link looked like the homepage
   in the tab strip and in history (UI audit F11). Next resolves a
   not-found boundary's metadata through the same template as any page, so
   this reads "Page not found — Oravan" / "Página no encontrada — Oravan". */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale?: string }>;
}): Promise<Metadata> {
  const requested = (await params)?.locale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  const t = await getTranslations({ locale, namespace: 'notFound' });
  return { title: t('title') };
}

export default function NotFound() {
  const t = useTranslations('notFound');

  return (
    <article className="mx-auto max-w-read px-4 py-16">
      {/* text-h1-bill, not text-h1: the display h1 is the home hero's alone.
          A 404 set 12px LARGER than the homepage promise (68 vs 56px at
          desktop) was the loudest headline on the site. */}
      <h1 className="text-h1-bill font-extrabold text-ink">{t('title')}</h1>
      <p className="mt-4 text-lede text-ink-2">{t('body')}</p>
      <p className="mt-8">
        <Link
          href="/"
          className="ring-gap inline-flex min-h-12 items-center justify-center rounded-control border-2 border-go bg-go px-6 font-bold text-paper no-underline transition-colors hover:border-go-deep hover:bg-go-deep"
        >
          {t('cta')}
        </Link>
      </p>
    </article>
  );
}
