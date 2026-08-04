import type { Metadata } from 'next';
import { ArrowRight, BookOpen } from 'lucide-react';
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

/*
 * THE LOOKUP SURFACE, as ruled paper.
 *
 * This page changes shape zero times. That is deliberate: data-gated loudness
 * means the full-bleed green enamel panel is spent on ONE bill standing on the
 * floor calendar, and the page that earns it is the one whose subject is a
 * bill. A ZIP lookup's subject is three phone numbers, so every band here is
 * paper - bordered cards for people, a rule-and-`wash` note for anything the
 * page has to caveat, and one green control per rep card, which is the dial.
 *
 * NOTES ARE OPENED BY A RULE, NOT BY A FILL. The failure register is a 3px ink
 * rule plus a bold uppercase label plus role="alert"; the informational
 * register is a 1.5px line-strong rule and no label at all. Neither one is
 * amber: amber is reserved for a bill standing on the floor calendar, with the
 * date printed beside it, and "your ZIP spans two districts" is not that fact.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'reps' });
  return { title: t('title'), alternates: hreflangAlternates(locale, '/reps') };
}

/** The informational register: a hairline rule over a recessed ground. */
const NOTE = 'border-t-[1.5px] border-line-strong bg-wash p-4 text-sm text-ink-2';

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
      <h1 className="text-h1-bill font-extrabold">{t('title')}</h1>
      <p className="mt-4 max-w-read text-lede text-ink-2">{t('sub')}</p>

      {!zip && (
        <div className="mt-8">
          <div className="max-w-xl rounded-control border-[1.5px] border-line-strong bg-paper p-6">
            <p className="mb-4 text-lg font-bold">{t('noZip')}</p>
            <ZipForm autoFocus />
          </div>

          {/* The payoff, previewed before anything is asked (2026-07 critique
              round 2): a ghost of the three cards a ZIP unlocks, so the
              privacy-sensitive visitor deciding whether to type anything sees
              exactly what they get. The skeletons are decorative — the
              caption carries the promise. They are drawn in `wash` rather than
              dimmed with opacity, so nothing here is a faded copy of a real
              contrast pair. */}
          <p className="mt-12 max-w-note text-sm text-ink-2">{t('previewNote')}</p>
          <div aria-hidden className="mt-4 grid gap-4 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="rounded-control border-[1.5px] border-line-strong bg-paper p-5"
              >
                <div className="flex gap-4">
                  <div className="h-22 w-18 shrink-0 rounded-stamp border-[1.5px] border-line-strong bg-wash" />
                  <div className="min-w-0 flex-1">
                    <div className="h-3 w-24 rounded-stamp bg-wash" />
                    <div className="mt-2 h-5 w-36 max-w-full rounded-stamp bg-wash" />
                  </div>
                </div>
                <div className="mt-4 grid gap-2">
                  <div className="h-12 rounded-control bg-wash" />
                  <div className="h-11 rounded-control bg-wash" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {zip && districts.length === 0 && (
        <div className="mt-8 max-w-xl border-t-[3px] border-ink bg-wash p-4" role="alert">
          <p className="text-2xs font-extrabold tracking-[0.1em] text-alert uppercase">
            {t('errorLabel')}
          </p>
          <p className="mt-1 font-semibold text-ink">{t('zipNotFound')}</p>
          <div className="mt-4">
            <ZipForm />
          </div>
        </div>
      )}

      {refined && zip && (
        <div className={`mt-6 max-w-read ${NOTE}`}>
          <p>
            {t('refinedNote')}
            {refinedOutsideZip && <> {t('refinedOutsideZip', { zip })}</>}
          </p>
          <p>
            <Link
              href={`/reps?zip=${zip}`}
              className="inline-flex min-h-11 items-center font-semibold text-ink underline underline-offset-2"
            >
              {t('showAllDistricts', { zip })}
            </Link>
          </p>
        </div>
      )}

      {!refined && districts.length > 1 && zip && (
        <>
          {/* {count}: 841 ZIPs map to 3-6 districts, and the old copy said
              "both" under six district headings (Phase-1 P1 — a miscount on
              the truth surface). The message pluralizes on the real count. */}
          <p className={`mt-6 max-w-read ${NOTE}`}>
            {t('multiDistrict', { count: districts.length })}
          </p>
          <AddressForm zip={zip} />
        </>
      )}

      {districts.map((d) => {
        const reps = repsForDistrict(d);
        const noSenators = reps.every((r) => r.type !== 'sen');
        const vacancy = vacancyForDistrict(d);
        return (
          <section key={`${d.state}-${d.district}`} className="mt-12" aria-label={`${d.state} ${d.district}`}>
            <h2 className="text-h2 font-extrabold">
              {d.district === 0
                ? t('atLargeHeading', { state: d.state })
                : t('districtHeading', { state: d.state, district: d.district })}
            </h2>
            {noSenators && <p className={`mt-4 max-w-read ${NOTE}`}>{t('delegateNote', { state: d.state })}</p>}
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
            className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-ink underline underline-offset-4"
          >
            <BookOpen className="h-4 w-4 shrink-0" aria-hidden />
            {tBill('whyLink')}
          </Link>
        </p>
      )}

      {/* The obvious next step: a rep card is a phone number, not a
          destination. Point straight at what's actually callable this week
          so the ZIP-first path never dead-ends here. The 2px ink edge is the
          one weight change on the page — it is the continuation, so it gets
          the heaviest rule the paper register has.

          TRUTH-FIRST COPY REVIEW, 2026-08-01 (repositioning spec §5.5).
          `nextTitle`/`nextSub` were reviewed against the de-assignment pass
          that rewrote `home.topTitle` and `bills.band.now`, and are KEPT
          near-verbatim — deliberately, not by omission. Call-forward copy is
          *earned* on this surface: a visitor who has just typed a ZIP asked
          who represents them, so "Now you know who to call" reports what
          they already did rather than assigning them a task. The
          de-assignment rule bites on surfaces a visitor reaches before
          engaging (the homepage front door, the bills index bands); it does
          not bite here. The section id `reps-next` is frozen — invariant I2
          in tests/funnel.spec.ts reads it. */}
      {zip && districts.length > 0 && (
        <section
          className="mt-12 rounded-control border-2 border-ink bg-paper p-6 md:p-8"
          aria-labelledby="reps-next"
        >
          <h2 id="reps-next" className="text-h2 font-extrabold">
            {t('nextTitle')}
          </h2>
          <p className="mt-2 max-w-read text-ink-2">{t('nextSub')}</p>
          {topActions.length > 0 ? (
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
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
            <div className="mt-6">
              <UrgencyEmptyState {...freshness} />
            </div>
          )}
          <Link
            href="/bills"
            className="mt-6 inline-flex min-h-11 items-center gap-2 font-semibold text-ink underline underline-offset-4"
          >
            {t('nextSeeAll', { count: totalBills })}
            <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
          </Link>
        </section>
      )}

      {zip && districts.length > 0 && (
        <p className="mt-12 text-sm text-ink-2">
          ZIP {zip} ·{' '}
          <Link href="/reps" className="underline underline-offset-2">
            {t('changeZip')}
          </Link>
        </p>
      )}
    </div>
  );
}
