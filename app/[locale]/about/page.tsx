import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { DonateSupport } from '@/components/DonateSupport';
import { DONATE_URL } from '@/lib/site';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'about' });
  return { title: t('title') };
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
      </section>

      {/* §6: the donations leg — link-out only, never a payment field on our
          own infra. Dark by construction until DONATE_URL is set (HCB
          onboarding is separate, in-flight paperwork); flipping that one
          constant is the entire code change needed to light this up. */}
      <DonateSupport donateUrl={DONATE_URL} />
    </article>
  );
}
