import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { hreflangAlternates } from '@/lib/hreflang';

/*
 * S21 — the embeds Terms of Service (embeds spec §6: "ToS/AUP"). A separate
 * document from the citizen /terms page (app/[locale]/terms/page.tsx),
 * following that page's exact routing convention
 * (hreflangAlternates(locale, '/embeds/terms'), added to sitemap.ts's
 * STATIC_PATHS) — it sits naturally beside the already-locale-routed
 * /embeds docs page rather than under a new top-level segment.
 *
 * GOVERNING-LANGUAGE CLAUSE: shipped in both languages in the same change
 * (bilingual parity is constitutional, CLAUDE.md, regardless of document
 * length or genre), but with an explicit clause in both versions saying the
 * English text controls — standard practice for a bilingual commercial
 * contract, and the only way to reconcile "both languages ship, CI-checked"
 * with "one text is legally authoritative."
 *
 * FLAGGED LOUDLY (see this sprint's PR body): this is AI-drafted legal
 * text. It must be reviewed by the founder — ideally a lawyer — before any
 * tenant is permitted to accept it, i.e. before Stripe Checkout's
 * consent_collection.terms_of_service is pointed at this page's live URL
 * and before any Payment Link goes live. Section 9 ("Governing law")
 * deliberately contains a literal [FOUNDER: fill] placeholder rather than
 * an invented jurisdiction — that decision belongs to Colby, not to this
 * document. This code change makes the page exist and resolve; pointing
 * Stripe at it is a separate, manual owner action (PR body checklist).
 *
 * tosVersion / re-consent tracking: deliberately NOT added to
 * TenantRecord this sprint (YAGNI) — lib/tenancy.ts's tosAcceptedAt (S18/
 * S19, adversarially hardened) stays untouched. Re-acceptance tracking is a
 * future problem only if this document is later materially revised.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'embedsTerms' });
  return { title: t('title'), alternates: hreflangAlternates(locale, '/embeds/terms') };
}

const PROHIBITED_ITEMS = ['prohibitedItem1', 'prohibitedItem2', 'prohibitedItem3', 'prohibitedItem4'] as const;

const SECTIONS = [
  ['scopeHeading', 'scopeBody'],
  ['nonpartisanHeading', 'nonpartisanBody'],
  ['attributionHeading', 'attributionBody'],
] as const;

const SECTIONS_AFTER_PROHIBITED = [
  ['tokenHeading', 'tokenBody'],
  ['licensingHeading', 'licensingBody'],
  ['billingHeading', 'billingBody'],
  ['warrantyHeading', 'warrantyBody'],
  ['lawHeading', 'lawBody'],
  ['contactHeading', 'contactBody'],
  ['changesHeading', 'changesBody'],
] as const;

export default async function EmbedsTermsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('embedsTerms');

  return (
    <article className="mx-auto max-w-read px-4 py-12">
      <h1 className="text-h1-bill font-extrabold">{t('title')}</h1>
      <p className="mt-6 text-lede text-ink-2">{t('intro')}</p>
      {/* The governing-language clause is the one thing a reader must not
          skim past, so it is opened by the 3px ink rule this system uses to
          say "stop and read this" — the same mark as a failure, without
          borrowing a law-bearing color for a clause that is not a failure. */}
      <p className="mt-6 border-t-[3px] border-ink bg-wash p-4 text-sm italic">
        {t('governingLanguageNotice')}
      </p>

      <div className="mt-8 space-y-8">
        {SECTIONS.map(([heading, body]) => (
          <section key={heading}>
            <h2 className="text-h3 font-extrabold">{t(heading)}</h2>
            <p className="mt-2">{t(body)}</p>
          </section>
        ))}

        <section>
          <h2 className="text-h3 font-extrabold">{t('prohibitedHeading')}</h2>
          <p className="mt-2">{t('prohibitedIntro')}</p>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            {PROHIBITED_ITEMS.map((item) => (
              <li key={item}>{t(item)}</li>
            ))}
          </ul>
        </section>

        {SECTIONS_AFTER_PROHIBITED.map(([heading, body]) => (
          <section key={heading}>
            <h2 className="text-h3 font-extrabold">{t(heading)}</h2>
            <p className="mt-2">{t(body)}</p>
          </section>
        ))}
      </div>

      <p className="mt-8 text-sm tabular-nums text-ink-2">{t('lastUpdated')}</p>

      <div className="mt-6 flex flex-col gap-2 border-t border-line pt-6 text-sm">
        <Link href="/embeds" className="font-semibold text-go underline hover:text-go-deep">
          {t('backLinkText')}
        </Link>
        <Link href="/terms" className="text-go underline hover:text-go-deep">
          {t('citizenTermsLinkText')}
        </Link>
      </div>
    </article>
  );
}
