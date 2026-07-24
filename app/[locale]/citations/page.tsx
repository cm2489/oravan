import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { absoluteUrl, hreflangAlternates } from '@/lib/hreflang';
import { dataAsOfString } from '@/lib/freshness';
import { AI_LABEL_TEXT, LICENSE_AI_CONTENT, LICENSE_PUBLIC_DOMAIN, SOURCE } from '@/lib/core/mcp';

/*
 * S23 — the citability/correction page (docs/ideation/2026-07-05-build-gtm-
 * strategy.md §1.3 S23; canonical-source playbook item 10 in
 * docs/ideation/2026-07-02-mcp-spec.md §4). Trust infrastructure for
 * reporters and librarians: how to cite Oravan, what's official record vs.
 * AI-drafted, and how to report — and what happens after confirming — an
 * error. Nonpartisan register throughout, no marketing language, same as
 * every other page.
 *
 * Every fact quoted here is read from the one place it's already defined,
 * not re-typed: SOURCE/AI_LABEL_TEXT/LICENSE_* are the literal strings an
 * agent's MCP `meta` envelope carries (lib/core/mcp.ts), and the "as of"
 * date is the same dataAsOfString() every bill page renders (lib/freshness).
 * A reporter reading this page sees exactly what the data actually says.
 *
 * Post-#46 fix: those four constants are now locale pairs (the envelope
 * itself used to emit English text regardless of the request's locale - a
 * bilingual-parity gap this PR closes). This page quotes BOTH language
 * variants of each, unconditionally of which locale route you're on -
 * a reporter using either language should be able to verify what an
 * EN-locale *and* an ES-locale MCP query actually receive, on the same page.
 */

const EXAMPLE_SLUG = 'hr-1787-119'; // the same demo bill the walkthrough + ES spot-check use

/**
 * Renders one envelope-derived string in both of its locale variants, each
 * marked with its own `lang` attribute (accessibility: a screen reader
 * should switch pronunciation between the two, same as any other bilingual
 * quote on this page). `langEnglish`/`langSpanish` are translated labels
 * from the `citations` namespace, not hardcoded - CLAUDE.md's bilingual
 * hard rule applies to a label naming a language exactly the same as any
 * other UI string.
 */
function BilingualQuote({
  en,
  es,
  langEnglish,
  langSpanish,
}: {
  en: string;
  es: string;
  langEnglish: string;
  langSpanish: string;
}) {
  // A quoted machine string, so it stands on the recessed ground (`wash`) and
  // is opened by an ink rule. No box border: this is quoted text, not a
  // control, and `line` on `wash` would be invisible anyway.
  return (
    <div className="mt-3 space-y-2 rounded-control border-l-[3px] border-ink bg-wash px-4 py-3 text-sm">
      <p lang="en">
        <span className="font-semibold text-ink-2">{langEnglish}: </span>
        {en}
      </p>
      <p lang="es">
        <span className="font-semibold text-ink-2">{langSpanish}: </span>
        {es}
      </p>
    </div>
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'citations' });
  return { title: t('title'), alternates: hreflangAlternates(locale, '/citations') };
}

export default async function CitationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('citations');
  const dataAsOf = await dataAsOfString(locale);

  const exampleUrl = absoluteUrl(locale, `/bills/${EXAMPLE_SLUG}`);

  return (
    <article className="mx-auto max-w-5xl px-4 py-12">
      {/* one cap on the column, not one per block */}
      <div className="max-w-read">
        <h1 className="text-h2-loud font-extrabold">{t('title')}</h1>
        <p className="mt-4 text-lede text-ink-2">{t('intro')}</p>
        {/* S12: the intro above already names the MCP server as one of this
            page's audiences - this is the one link out to its own docs page
            (endpoint, tools, client config, privacy posture), added here
            rather than in the site-wide footer/header (smallest-surface). */}
        <p className="mt-3 text-sm text-ink-2">
          {t('mcpNoteBody')}{' '}
          <Link
            href="/mcp"
            className="font-semibold text-go underline underline-offset-2 hover:text-go-deep"
          >
            {t('mcpNoteLinkText')} →
          </Link>
        </p>

        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-h3 font-extrabold">{t('urlTitle')}</h2>
          <p className="mt-2">{t('urlBody')}</p>
          <p className="mt-3 text-sm text-ink-2">{t('urlExampleLabel')}</p>
          <p className="mt-1 rounded-control bg-wash px-4 py-3 font-mono text-sm break-all">
            {exampleUrl}
          </p>
        </section>

        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-h3 font-extrabold">{t('asOfTitle')}</h2>
          <p className="mt-2">{t('asOfBody', { asOfField: 'as_of' })}</p>
          <p className="mt-3 rounded-control bg-wash px-4 py-3 text-sm font-semibold tabular-nums">
            {dataAsOf}
          </p>
        </section>

        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-h3 font-extrabold">{t('sourceTitle')}</h2>
          <p className="mt-2">{t('sourceBody')}</p>
          <BilingualQuote
            en={SOURCE.en}
            es={SOURCE.es}
            langEnglish={t('langEnglish')}
            langSpanish={t('langSpanish')}
          />
        </section>

        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-h3 font-extrabold">{t('aiTitle')}</h2>
          <p className="mt-2">{t('aiBody')}</p>
          <BilingualQuote
            en={AI_LABEL_TEXT.en}
            es={AI_LABEL_TEXT.es}
            langEnglish={t('langEnglish')}
            langSpanish={t('langSpanish')}
          />
          <p className="mt-4">{t('aiCallScript')}</p>
        </section>

        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-h3 font-extrabold">{t('licenseTitle')}</h2>
          <dl className="mt-2 space-y-4 text-sm">
            <div>
              <dt className="font-semibold text-ink-2">{t('licenseOfficialLabel')}</dt>
              <dd>
                <BilingualQuote
                  en={LICENSE_PUBLIC_DOMAIN.en}
                  es={LICENSE_PUBLIC_DOMAIN.es}
                  langEnglish={t('langEnglish')}
                  langSpanish={t('langSpanish')}
                />
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-ink-2">{t('licenseAiLabel')}</dt>
              <dd>
                <BilingualQuote
                  en={LICENSE_AI_CONTENT.en}
                  es={LICENSE_AI_CONTENT.es}
                  langEnglish={t('langEnglish')}
                  langSpanish={t('langSpanish')}
                />
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-sm text-ink-2">{t('licenseCoverage')}</p>
        </section>

        {/* The one thing on this page a reader DOES: report an error. It is an
            action, so it is the page's one green control. */}
        <section className="mt-8 rounded-control bg-wash p-6">
          <h2 className="text-h3 font-extrabold">{t('correctionTitle')}</h2>
          <p className="mt-2">{t('correctionBody')}</p>
          {/* Same-page anchor to the Footer's own FeedbackDialog (components/
              Footer.tsx#feedback) - one intake, not a parallel correction form. */}
          <a
            href="#feedback"
            className="ring-gap mt-4 inline-flex min-h-12 items-center rounded-control border-2 border-go bg-go px-5 font-bold text-paper no-underline hover:border-go-deep hover:bg-go-deep"
          >
            {t('correctionLinkText')}
          </a>

          <h3 className="mt-6 text-xl font-extrabold">{t('whenConfirmedTitle')}</h3>
          <p className="mt-2">{t('whenConfirmedBody', { asOfField: 'as_of' })}</p>
          <p className="mt-3 text-sm text-ink-2">{t('backlogNote')}</p>
        </section>
      </div>
    </article>
  );
}
