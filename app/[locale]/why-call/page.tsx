import type { Metadata } from 'next';
import { ArrowRight } from 'lucide-react';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { hreflangAlternates } from '@/lib/hreflang';
import { PAIR_ROW } from '@/lib/layout';

/*
 * A DOCUMENT, set as ruled paper: every block at the reading measure
 * (`max-w-read`), and a hairline `line` rule opening each section. `line` is
 * decorative here — it separates two paper areas and carries no state — which
 * is the only thing it is allowed to do.
 *
 * SIDE BY SIDE (layout pass 2026-11-28): the page sits on the site's shell,
 * its left edge under the logo, and from 64rem the five short sections and
 * the sources run two to a row (three rows), so the page no longer reads as a
 * narrow strip in the middle of the window. The grid reads row by row in
 * source order; on a phone it is one column, as before.
 *
 * The closing control is the page's one ACTION, so it is the one green thing
 * on it (`ring-gap` keeps the focus ring off the green fill).
 */

const SECTIONS = ['tally', 'email', 'voicemail', 'script', 'respect'] as const;

/*
 * Every sentence on this page either cites one of these reports or states no
 * fact (advice, or what Oravan does). A figure added to `why.*` needs its
 * report here. Both are Congressional Management Foundation PDFs; they are
 * links, so the page itself makes no third-party request.
 */
const SOURCES = [
  { key: 'sourceCca', href: 'https://www.congressfoundation.org/s/cmf-citizen-centric-advocacy.pdf' },
  { key: 'sourcePca', href: 'https://www.congressfoundation.org/s/cwc-perceptions-of-citizen-advocacy.pdf' },
] as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'why' });
  return { title: t('title'), alternates: hreflangAlternates(locale, '/why-call') };
}

export default async function WhyCallPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('why');

  return (
    <article className="mx-auto max-w-page px-4 pt-6 pb-12 md:pt-8">
      <div>
        <div className="max-w-read">
          <h1 className="text-h2-loud font-extrabold">{t('title')}</h1>
          <p className="mt-3 text-lede text-ink-2">{t('intro')}</p>
        </div>

        <div className={PAIR_ROW}>
          {SECTIONS.map((s) => (
            <section key={s} className="mt-8 max-w-read min-w-0 border-t border-line pt-6">
              <h2 className="text-h3 font-extrabold">{t(`${s}Title`)}</h2>
              <p className="mt-2">{t(`${s}Body`)}</p>
            </section>
          ))}

          <section className="mt-8 max-w-read min-w-0 border-t border-line pt-6">
            <h2 className="text-h3 font-extrabold">{t('sourcesTitle')}</h2>
            <p className="mt-2 text-sm text-ink-2">{t('sourcesNote')}</p>
            <ul className="mt-2 text-sm text-ink-2">
              {SOURCES.map((s) => (
                <li key={s.key}>
                  <a
                    href={s.href}
                    hrefLang="en"
                    rel="noopener noreferrer"
                    target="_blank"
                    className="inline-flex min-h-11 items-center underline decoration-line-strong underline-offset-4 hover:decoration-ink"
                  >
                    {t(s.key)}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <Link
          href="/bills"
          className="ring-edge mt-8 inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-ink bg-urgent px-6 font-bold text-ink no-underline hover:bg-urgent-deep"
        >
          {t('cta')}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </article>
  );
}
