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

/** One cell of the two-across rows: a whole paragraph, or a short run of
 *  them, spaced as the single column spaces them. */
const CELL = 'min-w-0 space-y-5';

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

  // Each paragraph and each service is rendered once, in the page's order,
  // then laid into its cell by slicing that one list in sequence, so the DOM
  // order is still exactly the list's order.
  const paragraphs = (['p1', 'p2', 'p3', 'p7', 'p4', 'p8', 'p9', 'p5'] as const).map((p) => (
    <p key={p} data-privacy-paragraph={p} className={p === 'p5' ? 'font-semibold' : undefined}>
      {t.rich(p, { strong })}
    </p>
  ));
  const services = PRIVACY_SERVICES.map((s) => (
    <p key={s} data-privacy-service={s}>
      {t.rich(s, { strong })}
    </p>
  ));

  return (
    <article className="mx-auto max-w-read px-4 pt-6 pb-12 md:pt-8 xl:max-w-page">
      {/* THE TITLE ACROSS THE TOP, THEN ROWS OF TWO (layout pass 2026-11-28,
          round 3). Below 80rem: one 33rem column, exactly as before. From
          80rem the page sits on the site's shell, its left edge under the
          logo, and the text forms rows of two 33rem cells, read row by row,
          left then right. A cell holds one paragraph or a short run of them,
          always whole and always in the page's order, and the runs are
          chosen so the two cells of a row end at about the same depth (round
          2's newspaper columns split a paragraph and sent the reader back up
          the page; one paragraph per cell left holes beside the long ones):
          p1 and p2 beside p3, p7 and p4; then p8 beside p9 and p5. The DOM
          order is the reading order, so every "above" still points to a
          paragraph read earlier and every "below" to one read later, and the
          rows keep them true on screen as well: p8's rate limiting (p3) and
          reading message (p4) stand in the row above it, and p7, the
          "explained below" of p1, starts lower down, in the cell beside it. */}
      <h1 className="text-h2-loud font-extrabold">{t('title')}</h1>
      <div className="mt-6 space-y-5 xl:grid xl:max-w-[calc(2*var(--container-read)_+_4rem)] xl:grid-cols-2 xl:items-start xl:gap-x-16 xl:gap-y-8 xl:space-y-0">
        <div className={CELL}>{paragraphs.slice(0, 2)}</div>
        <div className={CELL}>{paragraphs.slice(2, 5)}</div>
        <div className={CELL}>{paragraphs.slice(5, 6)}</div>
        <div className={CELL}>{paragraphs.slice(6)}</div>
        {/*
         * The outside services, by name (owner's decision 49, option a,
         * 2026-11-11). Each entry names what that service receives from a
         * visit and what it does not; the code each sentence rests on is
         * listed in the pull request that added it, and
         * tests/privacy-services.unit.spec.ts pins that every service named
         * here is named in both languages.
         *
         * From 80rem the section spans both columns: its heading and intro
         * across its top at the reading measure, then the services in rows
         * of two, in the order the page names them: Vercel beside Anthropic,
         * then Upstash beside the three short ones (Census, GitHub, Stripe).
         */}
        <section
          aria-labelledby="privacy-services"
          className="min-w-0 space-y-5 pt-4 xl:col-span-2 xl:grid xl:grid-cols-2 xl:items-start xl:gap-x-16 xl:gap-y-8 xl:space-y-0"
        >
          <div className="min-w-0 space-y-5 xl:col-span-2 xl:max-w-read">
            <h2 id="privacy-services" className="text-h3 font-extrabold">
              {t('servicesTitle')}
            </h2>
            <p>{t('servicesIntro')}</p>
          </div>
          <div className={CELL}>{services.slice(0, 1)}</div>
          <div className={CELL}>{services.slice(1, 2)}</div>
          <div className={CELL}>{services.slice(2, 3)}</div>
          <div className={CELL}>{services.slice(3)}</div>
          <p className="min-w-0 text-sm tabular-nums text-ink-2 xl:col-span-2">{t('lastUpdated')}</p>
        </section>
        <p className="min-w-0 border-t border-line pt-5 text-sm text-ink-2 xl:col-span-2">{t('contact')}</p>
      </div>
    </article>
  );
}
