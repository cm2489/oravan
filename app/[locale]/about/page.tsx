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
  // The name's origin used to sit in the footer of all ~1,000 pages. It reads
  // as an aside there and as an answer here, so it moved — same string, same
  // key, no new copy in either language.
  const tc = await getTranslations('common');

  // One reading column, capped ONCE on the wrapper so every block below shares
  // the same left and right edge (DESIGN.md, Measure).
  return (
    <article className="mx-auto max-w-read px-4 py-12">
      <div className="max-w-read">
        <h1 className="text-h2-loud font-extrabold">{t('title')}</h1>
        <p className="mt-4 text-lede text-ink-2">{t('intro')}</p>
        <p className="mt-4 text-sm text-ink-2">{tc('footer.lore')}</p>

        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-h3 font-extrabold">{t('fundingTitle')}</h2>
          <p className="mt-2">{t('fundingBody')}</p>
          {/* The operator, named, with the verifiable half of "built in the
              open": an outside audit (2026-08-02) found the site claiming
              inspectability while linking no repository and naming no human —
              while asking for money. The repo IS public; now the claim
              carries its proof, and the donation ask below has a name on it. */}
          <p className="mt-2">
            {t('builtBy')}{' '}
            <a
              href="https://github.com/cm2489/oravan"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-go underline underline-offset-2 hover:text-go-deep"
            >
              {t('repoLinkLabel')}
            </a>
          </p>
          {/* The one support ask on this page (the HCB fiscal-sponsorship route
              was denied 2026-07-15, so the former DonateSupport section and its
              sponsor/tax-deductible claims are retired). Dark by construction
              until DONATE_URL is set - one constant, no second flag. Never
              claims tax-deductibility or nonprofit status - this is a personal,
              founder-funded contribution, not a charitable gift. Link-out only:
              never an iframe or a payment field on Oravan's own infra (§6).
              The link is an ACTION, so it is green — an inline link inside a
              sentence is exempt from the 44px floor (WCAG 2.5.8), and forcing
              the height onto it would break the line it sits in. */}
          {DONATE_URL && (
            <p className="mt-2">
              {t('fundingSupportBody')}{' '}
              <a
                href={DONATE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-go underline underline-offset-2 hover:text-go-deep"
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
        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-h3 font-extrabold">{t('accountabilityTitle')}</h2>
          <p className="mt-2">{t('accountabilityBody')}</p>
        </section>
      </div>
    </article>
  );
}
