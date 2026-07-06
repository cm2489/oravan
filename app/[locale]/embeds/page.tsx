import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { hreflangAlternates } from '@/lib/hreflang';
import { getTeasers } from '@/lib/core';
import { EmbedConfigurator } from '@/components/EmbedConfigurator';

/*
 * S16 — the embeds configurator + public docs page (docs/ideation/2026-07-05-
 * build-gtm-strategy.md §1.3 S16; product spec: docs/ideation/2026-07-02-
 * embeds-spec.md §3.3, §2.3, §3.4). Public, bilingual, and noindex-gated the
 * same way every other page is right now — this page sets no `robots`
 * metadata of its own, so it inherits app/[locale]/layout.tsx's site-wide
 * launch-gate noindex (still on) rather than trying to lift it locally.
 *
 * This is also the artifact KTD-8's outreach (docs/press/embeds-launch-kit.md)
 * sends recipients to, and the page tests/embeds-cold-walkthrough.spec.ts
 * drives to prove a fresh visitor can go from this page's own generated
 * snippet to a working embed with no other context.
 *
 * getTeasers(locale) is reused as-is (not a second bill-listing query) - the
 * exact same corpus-wide data app/[locale]/bills/page.tsx already ships to
 * its own client-side search component (components/BillsBrowser.tsx), so the
 * bill picker below searches the real corpus, not a curated sample.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'embeds' });
  return { title: t('title'), alternates: hreflangAlternates(locale, '/embeds') };
}

export default async function EmbedsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('embeds');
  const bills = getTeasers(locale);

  return (
    <article className="mx-auto max-w-5xl px-4 py-12">
      <h1 className="font-display text-4xl font-bold">{t('title')}</h1>
      <p className="mt-4 max-w-prose text-lg leading-relaxed text-ink-soft">{t('intro')}</p>

      <EmbedConfigurator bills={bills} />

      <section className="mt-16 max-w-3xl border-t border-line pt-10">
        <h2 className="font-display text-2xl font-bold">{t('docsHeading')}</h2>

        <div className="mt-6">
          <h3 className="font-display text-lg font-bold">{t('docsIsolationTitle')}</h3>
          <p className="mt-2 leading-relaxed">{t('docsIsolationBody')}</p>
        </div>

        <div className="mt-8">
          <h3 className="font-display text-lg font-bold">{t('docsPrivacyTitle')}</h3>
          <ul className="mt-2 list-disc space-y-2 pl-5 leading-relaxed">
            <li>{t('docsPrivacyCookies')}</li>
            <li>{t('docsPrivacyThirdParty')}</li>
            <li>{t('docsPrivacyZip')}</li>
            <li>{t('docsPrivacyNoData')}</li>
          </ul>
          <p className="mt-3 text-sm text-ink-soft">{t('docsPrivacyTested')}</p>
        </div>

        <div className="mt-8">
          <h3 className="font-display text-lg font-bold">{t('docsThemingTitle')}</h3>
          <p className="mt-2 leading-relaxed">{t('docsThemingBody')}</p>
        </div>

        <div className="mt-8">
          <h3 className="font-display text-lg font-bold">{t('docsAttributionTitle')}</h3>
          <p className="mt-2 leading-relaxed">{t('docsAttributionBody')}</p>
        </div>

        <div className="mt-8">
          <h3 className="font-display text-lg font-bold">{t('docsLoaderTitle')}</h3>
          <p className="mt-2 leading-relaxed">{t('docsLoaderBody')}</p>
        </div>
      </section>
    </article>
  );
}
