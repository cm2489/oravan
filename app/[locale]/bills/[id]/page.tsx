import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ExternalLink } from 'lucide-react';
import { setRequestLocale, getTranslations, getFormatter } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { getPathname } from '@/i18n/navigation';
import { ActionPanel } from '@/components/ActionPanel';
import { CoverageSection } from '@/components/CoverageSection';
import { FloatingCallButton } from '@/components/FloatingCallButton';
import { DecodedSections } from '@/components/DecodedSections';
import { JsonLd } from '@/components/JsonLd';
import { SharePanel } from '@/components/SharePanel';
import { TldrStrip } from '@/components/TldrStrip';
import { WalkthroughDisclosure } from '@/components/call-walkthrough/WalkthroughDisclosure';
import { coverageTier, getCoverage } from '@/lib/coverage';
import { StalenessNote } from '@/components/StalenessNote';
import { billSlug, getAllBills, getBill, localizeBill } from '@/lib/core';
import { formatCitation } from '@/lib/format';
import { dataAsOfString, getFreshness } from '@/lib/freshness';
import { hreflangAlternates } from '@/lib/hreflang';
import { buildBillJsonLd } from '@/lib/jsonld';
import { SITE_ORIGIN } from '@/lib/site';

export function generateStaticParams() {
  return routing.locales.flatMap((locale) =>
    getAllBills().map((b) => ({ locale, id: billSlug(b) }))
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}): Promise<Metadata> {
  const { locale, id } = await params;
  const raw = getBill(id);
  if (!raw) return {};
  const bill = localizeBill(raw, locale);
  const title = `${formatCitation(bill.bill_type, bill.bill_number)} — ${bill.ai_headline ?? bill.short_title ?? bill.title}`;
  const description = bill.ai_summary?.slice(0, 160);
  // Canonical, slug-only URLs (no query params, no stance — same rule as
  // SharePanel): the absolute origin lives in lib/site.ts, nowhere else.
  const urlFor = (l: string) => `${SITE_ORIGIN}${getPathname({ locale: l, href: `/bills/${id}` })}`;
  return {
    title,
    description,
    // hreflangAlternates (lib/hreflang.ts) is the same canonical/language-map
    // shape this page originated in PR #30, generalized site-wide and with
    // an x-default entry added (S22 hreflang correctness pass).
    alternates: hreflangAlternates(locale, `/bills/${id}`),
    openGraph: {
      title,
      description,
      url: urlFor(locale),
      siteName: 'Oravan',
      type: 'website',
      locale: locale === 'es' ? 'es_ES' : 'en_US',
      alternateLocale: locale === 'es' ? 'en_US' : 'es_ES',
      // og:image comes from the file convention (./opengraph-image.tsx),
      // which overrides anything set here — don't duplicate it.
    },
    twitter: { card: 'summary_large_image' },
  };
}

export default async function BillPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const raw = getBill(id);
  if (!raw) notFound();
  const bill = localizeBill(raw, locale);
  // Coverage is the same articles regardless of locale (chrome is localized).
  const coverage = getCoverage(id);

  const t = await getTranslations();
  const format = await getFormatter();
  const fmtDate = (d: string) => format.dateTime(new Date(d), { year: 'numeric', month: 'long', day: 'numeric' });
  // KTD-1: the one accessor (and one phrasing helper) behind every "as of"
  // claim - no surface reads data/sync-state.json or assembles the stamp.
  const dataAsOf = await dataAsOfString(locale);

  const citation = formatCitation(bill.bill_type, bill.bill_number);
  const displayTitle = bill.ai_headline ?? bill.short_title ?? bill.title;
  // Headlines often already name the bill; don't repeat the citation (same
  // rule the action panel uses for call-log labels).
  const norm = (x: string) => x.toLowerCase().replace(/[.\s]/g, '');
  const shareText = norm(displayTitle).includes(norm(citation))
    ? displayTitle
    : `${citation} — ${displayTitle}`;
  // Canonical, slug-only share URL: no query params, no stance, no
  // locale-tracking params. The origin lives in lib/site.ts (rename in flight).
  const shareUrl = `${SITE_ORIGIN}${getPathname({ locale, href: `/bills/${id}` })}`;

  // Article (+ FAQPage when the decode structure supports it) — lib/jsonld.ts.
  const jsonLd = await buildBillJsonLd(bill, locale, id);

  const header = (
    <>
      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink-faint">
        <span className="font-mono">{formatCitation(bill.bill_type, bill.bill_number)}</span>
        <span aria-hidden>·</span>
        <span>{t(`bills.status.${bill.status}`)}</span>
        {(bill.issue_tags ?? []).slice(0, 2).map((tag) => (
          <span key={tag} className="rounded-full bg-brass-soft px-2.5 py-1 text-xs font-medium text-ink">
            {t(`categories.${tag}`)}
          </span>
        ))}
      </p>

      <h1 className="mt-3 font-display text-3xl md:text-4xl font-bold leading-tight">
        {bill.ai_headline ?? bill.short_title ?? bill.title}
      </h1>
      {/* R2: this page urges a call — the staleness caveat continues the
          stamp's own sentence, client-side (one line, one date). */}
      <p className="mt-1.5 max-w-prose text-xs text-ink-faint">
        {dataAsOf}
        <StalenessNote checkedAt={getFreshness().checkedAt} />
      </p>

      <TldrStrip bill={bill} />
    </>
  );

  const decodedBlock = (
    // Decoded - the plain-language translation is the hero
    <section aria-labelledby="decoded" className="mt-8 rounded-card bg-paper-deep border border-line p-6 md:p-8">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="decoded" className="font-display text-2xl font-bold">
          {t('bill.decoded')}
        </h2>
        {/* The label lives at the header, not only in the fine print at the
            card's foot (2026-07 critique, unanimous AI-labeling gap). */}
        {(bill.ai_summary || bill.ai_sections) && (
          <span className="rounded-full bg-brass-soft px-2.5 py-1 text-xs font-semibold text-ink">
            {t('bill.aiChip')}
          </span>
        )}
      </div>
      {bill.ai_summary || bill.ai_sections ? (
        <>
          <DecodedSections bill={bill} />
          <p className="mt-5 text-xs font-medium text-ink-soft">{t('bill.aiDisclaimer')}</p>
        </>
      ) : (
        <p className="mt-3 text-ink-soft">{t('bills.decodedPending')}</p>
      )}
    </section>
  );

  const officialBlock = (
    // Official record
    <section className="mt-8 space-y-3 text-sm">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
        {t('bill.officialTitle')}
      </h2>
      <p className="max-w-prose italic text-ink-soft leading-relaxed">{bill.title}</p>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 pt-2">
        {bill.introduced_date && (
          <div className="flex gap-2">
            <dt className="font-semibold">{t('bill.introduced')}:</dt>
            <dd className="text-ink-soft">{fmtDate(bill.introduced_date)}</dd>
          </div>
        )}
        {bill.last_action_date && (
          <div className="flex gap-2">
            <dt className="font-semibold">{t('bill.lastAction')}:</dt>
            <dd className="text-ink-soft">{fmtDate(bill.last_action_date)}</dd>
          </div>
        )}
      </dl>
      {bill.last_action_text && <p className="max-w-prose text-ink-soft">{bill.last_action_text}</p>}
      {bill.congress_gov_url && (
        <a
          href={bill.congress_gov_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 font-semibold underline underline-offset-4"
        >
          {t('bill.viewOfficial')}
          <ExternalLink className="h-4 w-4" aria-hidden />
        </a>
      )}
    </section>
  );

  const action = (
    <ActionPanel
      slug={id}
      identifier={formatCitation(bill.bill_type, bill.bill_number)}
      title={bill.ai_headline ?? bill.short_title ?? bill.title}
    />
  );

  // 2026-07 critique (majority): the read-then-act path must not detour
  // through press headlines and procedural prose - the action panel sits at
  // the moment of comprehension, right after Decoded (only the one-row share
  // utility between); coverage and the official record follow it. The old
  // CallPrompt jump band existed to bridge the gap this ordering removes.
  const content = (
    <>
      {decodedBlock}
      {/* Pass the page along - a quiet utility, not a hero. Below Decoded,
          not above it: sharing intent forms after reading, and the hero
          shouldn't spend prime space on a secondary action (2026-07
          critique round 2). One compact row - the action panel is still
          immediately in view below. */}
      <SharePanel url={shareUrl} text={shareText} />
      {action}
      {/* For the hesitant: what a call actually looks like, on demand,
          collapsed so it never displaces the CTA */}
      <WalkthroughDisclosure />
      {/* Read - how the bill is being covered (third-party articles + outlet lean) */}
      <CoverageSection articles={coverage} tier={coverageTier(coverage)} />
      {officialBlock}
    </>
  );

  return (
    <>
      <JsonLd id="bill-jsonld" data={jsonLd} />
      {/* Bottom padding clears the floating call pill on mobile so it never
          sits on the last lines of body text (2026-07 critique). */}
      <article className="mx-auto max-w-3xl px-4 pt-12 pb-28 md:pb-16">
        {header}
        {content}
      </article>

      {/* Keeps the call reachable while reading; yields when another call CTA is on screen */}
      <FloatingCallButton />
    </>
  );
}
