import type { Metadata } from 'next';
import { ArrowRight, BookOpen, Info } from 'lucide-react';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { JsonLd } from '@/components/JsonLd';
import { ZipForm } from '@/components/ZipForm';
import { AddressForm } from '@/components/AddressForm';
import { RepCard } from '@/components/RepCard';
import { VacantSeatCard } from '@/components/VacantSeatCard';
import { BillCard } from '@/components/BillCard';
import { UrgencyEmptyState } from '@/components/UrgencyEmptyState';
import { Link } from '@/i18n/navigation';
import {
  billSlug,
  districtsForZip,
  getAllBills,
  getTopActions,
  repsForDistrict,
  vacancyForDistrict,
} from '@/lib/core';
import { parseDistrictParam } from '@/lib/district';
import { formatCitation } from '@/lib/format';
import { getFreshness } from '@/lib/freshness';
import { hreflangAlternates } from '@/lib/hreflang';
import { buildOrganizationJsonLd } from '@/lib/jsonld';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'reps' });
  return { title: t('title'), alternates: hreflangAlternates(locale, '/reps') };
}

export default async function RepsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ zip?: string; district?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { zip, district: districtParam } = await searchParams;
  const t = await getTranslations('reps');
  // Reused verbatim from the bill namespace (the ActionPanel's own why-call
  // line) rather than duplicated into reps.* — the two surfaces can't drift.
  const tBill = await getTranslations('bill');

  const candidates = zip && /^\d{5}$/.test(zip) ? districtsForZip(zip) : [];

  // Address refinement lands here as ?district=NY-12 - only the derived
  // district, never the address. A param that names no actual House seat
  // (or arrives without a valid ZIP) is ignored and the ZIP's candidate
  // districts render as usual.
  const parsed = zip && /^\d{5}$/.test(zip) ? parseDistrictParam(districtParam) : null;
  const refined =
    parsed && repsForDistrict(parsed).some((r) => r.type === 'rep') ? parsed : null;
  const refinedOutsideZip =
    !!refined &&
    candidates.length > 0 &&
    !candidates.some((c) => c.state === refined.state && c.district === refined.district);

  const districts = refined ? [refined] : candidates;

  // Continuation: after a ZIP lookup, a rep card is not the end of the
  // path - the same callable bills that lead the homepage funnel surface
  // here too, so a visitor never dead-ends on "here are your reps."
  const topActions = getTopActions(2, locale);
  const totalBills = getAllBills().length;
  const freshness = getFreshness();
  const orgJsonLd = buildOrganizationJsonLd();

  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <JsonLd id="org-jsonld" data={orgJsonLd} />
      <h1 className="font-display text-4xl font-bold">{t('title')}</h1>
      <p className="mt-2 max-w-prose text-ink-soft">{t('sub')}</p>

      {!zip && (
        <div className="mt-8">
          <div className="max-w-xl rounded-card border border-line bg-surface p-6 shadow-lift">
            <p className="mb-4 font-medium">{t('noZip')}</p>
            <ZipForm autoFocus />
          </div>

          {/* The payoff, previewed before anything is asked (2026-07 critique
              round 2): a ghost of the three cards a ZIP unlocks, so the
              privacy-sensitive visitor deciding whether to type anything sees
              exactly what they get. The skeletons are decorative — the
              caption carries the promise. */}
          <p className="mt-10 max-w-prose text-sm text-ink-soft">{t('previewNote')}</p>
          <div aria-hidden className="mt-4 grid gap-4 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-card border border-line bg-surface p-5 opacity-60">
                <div className="flex gap-4">
                  <div className="h-22 w-18 shrink-0 rounded-lg bg-paper-deep" />
                  <div className="min-w-0 flex-1">
                    <div className="h-3 w-24 rounded-full bg-paper-deep" />
                    <div className="mt-2.5 h-5 w-36 max-w-full rounded-full bg-paper-deep" />
                  </div>
                </div>
                <div className="mt-4 space-y-2">
                  <div className="h-11 rounded-control bg-paper-deep" />
                  <div className="h-11 rounded-control bg-paper-deep" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {zip && districts.length === 0 && (
        <div className="mt-8 rounded-card border border-clay/30 bg-clay-soft p-6 max-w-xl" role="alert">
          <p className="font-medium text-ink">{t('zipNotFound')}</p>
          <div className="mt-4">
            <ZipForm />
          </div>
        </div>
      )}

      {refined && zip && (
        <div className="mt-6 max-w-prose rounded-card border border-brass/40 bg-brass-soft p-4 text-sm">
          <p className="flex gap-2">
            <Info className="h-5 w-5 shrink-0 text-ink-soft" aria-hidden />
            <span>
              {t('refinedNote')}
              {refinedOutsideZip && <> {t('refinedOutsideZip', { zip })}</>}
            </span>
          </p>
          <p className="mt-2 pl-7">
            <Link href={`/reps?zip=${zip}`} className="underline underline-offset-2">
              {t('showAllDistricts', { zip })}
            </Link>
          </p>
        </div>
      )}

      {!refined && districts.length > 1 && zip && (
        <>
          <p className="mt-6 flex max-w-prose gap-2 rounded-card border border-brass/40 bg-brass-soft p-4 text-sm">
            <Info className="h-5 w-5 shrink-0 text-ink-soft" aria-hidden />
            {t('multiDistrict')}
          </p>
          <AddressForm zip={zip} />
        </>
      )}

      {districts.map((d) => {
        const reps = repsForDistrict(d);
        const noSenators = reps.every((r) => r.type !== 'sen');
        const vacancy = vacancyForDistrict(d);
        return (
          <section key={`${d.state}-${d.district}`} className="mt-10" aria-label={`${d.state} ${d.district}`}>
            <h2 className="font-display text-2xl font-bold">
              {d.district === 0
                ? t('atLargeHeading', { state: d.state })
                : t('districtHeading', { state: d.state, district: d.district })}
            </h2>
            {noSenators && (
              <p className="mt-3 flex max-w-prose gap-2 rounded-card border border-brass/40 bg-brass-soft p-4 text-sm">
                <Info className="h-5 w-5 shrink-0 text-ink-soft" aria-hidden />
                {t('delegateNote', { state: d.state })}
              </p>
            )}
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              {reps.map((r) => (
                <RepCard key={r.bioguide} rep={r} />
              ))}
              {vacancy && <VacantSeatCard />}
            </div>
          </section>
        );
      })}

      {/* Why call, right under the numbers (2026-07 critique round 2): the
          page holding the persuasion isn't in the mobile tab bar, so every
          pre-call surface links it in-flow — same line the ActionPanel uses. */}
      {zip && districts.length > 0 && (
        <p className="mt-6">
          <Link
            href="/why-call"
            className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold underline underline-offset-4"
          >
            <BookOpen className="h-4 w-4" aria-hidden />
            {tBill('whyLink')}
          </Link>
        </p>
      )}

      {/* The obvious next step: a rep card is a phone number, not a
          destination. Point straight at what's actually callable this week
          so the ZIP-first path never dead-ends here. */}
      {zip && districts.length > 0 && (
        <section
          className="mt-12 rounded-card border-2 border-ink bg-surface p-6 shadow-lift md:p-8"
          aria-labelledby="reps-next"
        >
          <h2 id="reps-next" className="font-display text-2xl font-bold">
            {t('nextTitle')}
          </h2>
          <p className="mt-1 max-w-prose text-ink-soft">{t('nextSub')}</p>
          {topActions.length > 0 ? (
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              {topActions.map((b) => (
                <BillCard
                  key={billSlug(b)}
                  bill={{
                    slug: billSlug(b),
                    identifier: formatCitation(b.bill_type, b.bill_number),
                    headline: b.ai_headline,
                    title: b.short_title ?? b.title,
                    status: b.status,
                    tags: b.issue_tags ?? [],
                    lastActionDate: b.last_action_date,
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="mt-5">
              <UrgencyEmptyState {...freshness} />
            </div>
          )}
          <Link
            href="/bills"
            className="mt-5 inline-flex items-center gap-1.5 font-semibold text-ink underline underline-offset-4 hover:text-night"
          >
            {t('nextSeeAll', { count: totalBills })}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </section>
      )}

      {zip && districts.length > 0 && (
        <p className="mt-10 text-sm text-ink-faint">
          ZIP {zip} ·{' '}
          <Link href="/reps" className="underline underline-offset-2">
            {t('changeZip')}
          </Link>
        </p>
      )}
    </div>
  );
}
