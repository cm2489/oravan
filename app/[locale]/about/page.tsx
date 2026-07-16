import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { hreflangAlternates } from '@/lib/hreflang';
import { DONATE_URL } from '@/lib/site';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'about' });
  return { title: t('title'), alternates: hreflangAlternates(locale, '/about') };
}

export default async function AboutPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('about');

  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="font-display text-4xl font-bold">{t('title')}</h1>
      <p className="mt-4 text-lg leading-relaxed text-ink-soft">{t('intro')}</p>

      <section className="mt-10">
        <h2 className="font-display text-2xl font-bold">{t('fundingTitle')}</h2>
        <p className="mt-2 max-w-prose leading-relaxed">{t('fundingBody')}</p>
        {/* The one support ask on this page (the HCB fiscal-sponsorship route
            was denied 2026-07-15, so the former DonateSupport section and its
            sponsor/tax-deductible claims are retired). Dark by construction
            until DONATE_URL is set - one constant, no second flag. Never
            claims tax-deductibility or nonprofit status - this is a personal,
            founder-funded contribution, not a charitable gift. Link-out only:
            never an iframe or a payment field on Oravan's own infra (§6). */}
        {DONATE_URL && (
          <p className="mt-2 max-w-prose leading-relaxed">
            {t('fundingSupportBody')}{' '}
            <a
              href={DONATE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center font-semibold underline underline-offset-2 hover:text-ink"
            >
              {t('fundingSupportCta')}
            </a>
          </p>
        )}
      </section>

      {/* Who's accountable + how to reach a person — surfaced outside the
          donation-gated section so it never depends on DONATE_URL being live
          (S6 persona gate: newsroom/library/nonprofit seats couldn't tell who
          stands behind the widget or how to reach them). */}
      <section className="mt-10">
        <h2 className="font-display text-2xl font-bold">{t('accountabilityTitle')}</h2>
        <p className="mt-2 max-w-prose leading-relaxed">{t('accountabilityBody')}</p>
      </section>
    </article>
  );
}
