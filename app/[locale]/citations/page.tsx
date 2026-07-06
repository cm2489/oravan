import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { absoluteUrl, hreflangAlternates } from '@/lib/hreflang';
import { dataAsOfString } from '@/lib/freshness';
import { AI_LABEL_TEXT, LICENSE_AI_CONTENT, LICENSE_PUBLIC_DOMAIN, SOURCE } from '@/lib/core/mcp';

/*
 * S23 — the citability/correction page (docs/ideation/2026-07-05-build-gtm-
 * strategy.md §1.3 S23; canonical-source playbook item 10 in
 * docs/ideation/2026-07-02-mcp-spec.md §4). Trust infrastructure for
 * reporters and librarians: how to cite Rostra, what's official record vs.
 * AI-drafted, and how to report — and what happens after confirming — an
 * error. Nonpartisan register throughout, no marketing language, same as
 * every other page.
 *
 * Every fact quoted here is read from the one place it's already defined,
 * not re-typed: SOURCE/AI_LABEL_TEXT/LICENSE_* are the literal strings an
 * agent's MCP `meta` envelope carries (lib/core/mcp.ts), and the "as of"
 * date is the same dataAsOfString() every bill page renders (lib/freshness).
 * A reporter reading this page sees exactly what the data actually says.
 */

const EXAMPLE_SLUG = 'hr-1787-119'; // the same demo bill the walkthrough + ES spot-check use

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
    <article className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="font-display text-4xl font-bold">{t('title')}</h1>
      <p className="mt-4 text-lg leading-relaxed text-ink-soft">{t('intro')}</p>

      <section className="mt-10">
        <h2 className="font-display text-2xl font-bold">{t('urlTitle')}</h2>
        <p className="mt-2 max-w-prose leading-relaxed">{t('urlBody')}</p>
        <p className="mt-3 text-sm text-ink-soft">{t('urlExampleLabel')}</p>
        <p className="mt-1 break-all font-mono text-sm">{exampleUrl}</p>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-2xl font-bold">{t('asOfTitle')}</h2>
        <p className="mt-2 max-w-prose leading-relaxed">
          {t('asOfBody', { asOfField: 'as_of' })}
        </p>
        <p className="mt-3 rounded-control border border-line bg-paper-deep px-3 py-2 text-sm font-semibold">
          {dataAsOf}
        </p>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-2xl font-bold">{t('sourceTitle')}</h2>
        <p className="mt-2 max-w-prose leading-relaxed">{t('sourceBody')}</p>
        <p className="mt-2 max-w-prose font-mono text-sm text-ink-soft">&ldquo;{SOURCE}&rdquo;</p>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-2xl font-bold">{t('aiTitle')}</h2>
        <p className="mt-2 max-w-prose leading-relaxed">{t('aiBody')}</p>
        <p className="mt-2 max-w-prose rounded-control border border-line bg-paper-deep px-3 py-2 text-sm">
          {AI_LABEL_TEXT}
        </p>
        <p className="mt-4 max-w-prose leading-relaxed">{t('aiCallScript')}</p>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-2xl font-bold">{t('licenseTitle')}</h2>
        <dl className="mt-2 max-w-prose space-y-3 text-sm leading-relaxed">
          <div>
            <dt className="font-semibold text-ink-soft">{t('licenseOfficialLabel')}</dt>
            <dd className="mt-0.5">{LICENSE_PUBLIC_DOMAIN}</dd>
          </div>
          <div>
            <dt className="font-semibold text-ink-soft">{t('licenseAiLabel')}</dt>
            <dd className="mt-0.5">{LICENSE_AI_CONTENT}</dd>
          </div>
        </dl>
        <p className="mt-4 max-w-prose text-sm leading-relaxed text-ink-soft">{t('licenseCoverage')}</p>
      </section>

      <section className="mt-10 rounded-card border border-line bg-paper-deep p-6 md:p-8">
        <h2 className="font-display text-2xl font-bold">{t('correctionTitle')}</h2>
        <p className="mt-2 max-w-prose leading-relaxed">{t('correctionBody')}</p>
        {/* Same-page anchor to the Footer's own FeedbackDialog (components/
            Footer.tsx#feedback) - one intake, not a parallel correction form. */}
        <a
          href="#feedback"
          className="mt-4 inline-flex min-h-[44px] items-center rounded-control bg-ink px-5 font-semibold text-paper hover:bg-night active:translate-y-px"
        >
          {t('correctionLinkText')}
        </a>

        <h3 className="mt-6 font-display text-lg font-bold">{t('whenConfirmedTitle')}</h3>
        <p className="mt-2 max-w-prose leading-relaxed">{t('whenConfirmedBody', { asOfField: 'as_of' })}</p>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-soft">{t('backlogNote')}</p>
      </section>
    </article>
  );
}
