import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

/*
 * The locale-scoped 404. Living under [locale] is the point: it renders inside
 * the locale layout, so the header, the footer and the correct `lang` all
 * survive — a visitor who mistypes a bill slug is still on Oravan, not on a
 * bare browser error.
 *
 * Every string here already existed, written and reviewed in both languages,
 * and was wired to nothing. No new copy was introduced.
 */
export default function NotFound() {
  const t = useTranslations('notFound');

  return (
    <article className="mx-auto max-w-read px-4 py-16">
      <h1 className="text-h1 font-extrabold text-ink">{t('title')}</h1>
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
