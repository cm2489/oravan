import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { hreflangAlternates } from '@/lib/hreflang';

/*
 * The bold is the paragraph's promise (owner's pick, 2026-09-29: Version 2,
 * "bold key phrases, no new words, no headers"). The `<strong>` tags live in
 * messages/*.json around words the page already said, so each language picks
 * its own phrase; the page only maps the tag to a semantic <strong>.
 */
const strong = (chunks: ReactNode) => <strong className="font-bold">{chunks}</strong>;

/*
 * The outside services the page names, in the order it names them
 * (privacy.services*). Not exported: a page module may export only what
 * Next.js expects of it, so tests/privacy-services.unit.spec.ts reads this
 * list from the source.
 */
const PRIVACY_SERVICES = [
  'servicesVercel',
  'servicesAnthropic',
  'servicesUpstash',
  'servicesCensus',
  'servicesGitHub',
  'servicesStripe',
] as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'privacy' });
  return { title: t('title'), alternates: hreflangAlternates(locale, '/privacy') };
}

export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('privacy');

  return (
    <article className="mx-auto max-w-page px-4 pt-6 pb-12 md:pt-8">
      {/* THE TITLE ACROSS THE TOP, THE TEXT IN TWO COLUMNS (layout pass
          2026-11-28, round 2). The page sits on the site's shell, its left
          edge under the logo. From 80rem the text flows as one sequence down
          two 33rem columns, like a newspaper page: the left column, then the
          right, both ending at about the same depth, so no column stands
          empty (round 1's title column did, for the page's whole length).
          The order is the DOM order, so every "above" and "below" in the text
          still points the way the reader goes. One column on a phone and up
          to 80rem, as before. */}
      <h1 className="text-h2-loud font-extrabold">{t('title')}</h1>
      <div className="mt-6 max-w-read min-w-0 space-y-5 xl:max-w-[calc(2*var(--container-read)_+_4rem)] xl:columns-2 xl:gap-x-16">
        {(['p1', 'p2', 'p3', 'p7', 'p4', 'p8', 'p9', 'p5'] as const).map((p) => (
          <p key={p} data-privacy-paragraph={p} className={p === 'p5' ? 'font-semibold' : undefined}>
            {t.rich(p, { strong })}
          </p>
        ))}
        {/*
         * The outside services, by name (owner's decision 49, option a,
         * 2026-11-11). Each entry names what that service receives from a
         * visit and what it does not; the code each sentence rests on is
         * listed in the pull request that added it, and
         * tests/privacy-services.unit.spec.ts pins that every service named
         * here is named in both languages.
         */}
        <section aria-labelledby="privacy-services" className="space-y-5 pt-4">
          <h2 id="privacy-services" className="text-h3 font-extrabold break-after-avoid">
            {t('servicesTitle')}
          </h2>
          <p>{t('servicesIntro')}</p>
          {PRIVACY_SERVICES.map((s) => (
            <p key={s} data-privacy-service={s}>
              {t.rich(s, { strong })}
            </p>
          ))}
          <p className="text-sm tabular-nums text-ink-2">{t('lastUpdated')}</p>
        </section>
        <p className="border-t border-line pt-5 text-sm text-ink-2">{t('contact')}</p>
      </div>
    </article>
  );
}
