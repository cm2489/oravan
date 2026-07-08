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
  const t = await getTranslations({ locale, namespace: 'partners' });
  return { title: t('title'), alternates: hreflangAlternates(locale, '/partners') };
}

/*
 * S5b — the GTM surface for the three launch audiences (Spanish-language
 * newsrooms, libraries, paid orgs). Docs-grade and pricing-free by founder
 * decision (M6, 2026-07-07: terms deferred); the licensing section's
 * primary contact is now hello@oravan.org (M12, S8 cutover), with the
 * beta feedback channel kept as a fallback for anyone who'd rather not
 * email. NOTE: hello@oravan.org is not live yet — this PR is do-not-merge
 * until the inbox is confirmed live.
 */
export default async function PartnersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('partners');

  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="font-display text-4xl font-bold">{t('title')}</h1>
      <p className="mt-4 text-lg leading-relaxed text-ink-soft">{t('intro')}</p>

      <section className="mt-10">
        <h2 className="font-display text-2xl font-bold">{t('newsroomsTitle')}</h2>
        <p className="mt-2 max-w-prose leading-relaxed">{t('newsroomsBody')}</p>
        <Link
          href="/embeds"
          className="mt-3 inline-flex min-h-[44px] items-center gap-1.5 rounded-control bg-brass px-5 py-3 font-semibold text-paper hover:bg-brass-deep"
        >
          {t('newsroomsCta')} →
        </Link>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-2xl font-bold">{t('librariesTitle')}</h2>
        <p className="mt-2 max-w-prose leading-relaxed">{t('librariesBody')}</p>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-2xl font-bold">{t('orgsTitle')}</h2>
        <p className="mt-2 max-w-prose leading-relaxed">{t('orgsBody')}</p>
      </section>

      <section className="mt-10 rounded-card border border-line bg-surface p-6">
        <h2 className="font-display text-2xl font-bold">{t('licensingTitle')}</h2>
        <p className="mt-2 max-w-prose leading-relaxed">{t('licensingBody')}</p>
        {/* Primary partnership contact (M12). The beta feedback dialog
            (footer, #feedback anchor — same one the citations
            correction-path uses) remains a secondary fallback, referenced
            in licensingBody, for anyone who'd rather not email. */}
        <a
          href="mailto:hello@oravan.org"
          className="mt-3 inline-flex min-h-[44px] items-center gap-1.5 rounded-control border-2 border-ink px-5 py-3 font-semibold hover:bg-paper-deep"
        >
          {t('licensingCta')} →
        </a>
      </section>
    </article>
  );
}
