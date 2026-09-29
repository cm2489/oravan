import type { Metadata } from 'next';
import { statusKeyFor } from '@/lib/journey';
import { ArrowRight, Phone } from 'lucide-react';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { JsonLd } from '@/components/JsonLd';
import { ZipForm } from '@/components/ZipForm';
import { SavedZipLookup, ZipKeptNote } from '@/components/SavedZipLookup';
import { AddressForm } from '@/components/AddressForm';
import { RepCard } from '@/components/RepCard';
import { VacantSeatCard } from '@/components/VacantSeatCard';
import { BillCard } from '@/components/BillCard';
import { UrgencyEmptyState } from '@/components/UrgencyEmptyState';
import { YourRecord } from '@/components/YourRecord';
import { CALL_BUTTON } from '@/components/call-button';
import { Link } from '@/i18n/navigation';
import {
  billSlug,
  districtsForZip,
  getAllBills,
  getTopActions,
  repsForDistrict,
  specialElectionsFor,
  vacancyForDistrict,
  vacancySlug,
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
 *
 * THE ORDER (wireframes v2, reps.html, the owner's decided design,
 * 2026-09-29): Your members, with the ZIP they came from and Change ZIP (Q8
 * "a"); the members, House member first (a lookup has no bill in context, so
 * there is no voting chamber to lead with: repsForDistrict's order, the one
 * the page's own copy uses, "one House representative and two senators");
 * then the bills worth a call (R06, rule 8); then the reader's own record —
 * Your calls, the folded topics and reading, Erase my data (Q4 "b + c",
 * RC01–RC04, components/YourRecord.tsx). The call panel's "See your record"
 * lands on Your calls (`#your-calls`).
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
  searchParams: Promise<{ zip?: string; district?: string; change?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { zip, district: districtParam, change } = await searchParams;
  const t = await getTranslations('reps');
  // The Capitol switchboard's words are the call panel's own (bill.*), so the
  // two surfaces cannot drift.
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

  // `replace`: on this page a typed ZIP takes the prompt's place in history
  // (see ZipForm's prop), so Back leaves /reps instead of bouncing forward.
  const prompt = (
    <div className="max-w-xl rounded-control border-[1.5px] border-line-strong bg-paper p-6">
      <p className="mb-4 text-lg font-bold">{t('noZip')}</p>
      <ZipForm autoFocus replace />
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <JsonLd id="org-jsonld" data={orgJsonLd} />
      <h1 className="text-h1-bill font-extrabold">{t('membersHeading')}</h1>

      {/* WHICH ZIP, AND THE WAY TO CHANGE IT, UP TOP (owner, Q8 "a",
          2026-09-28: "The Reps tab opens on your members, with 'Change
          ZIP'"). The members may now appear without the reader typing
          anything, so the ZIP they came from is named before them, not after
          the continuation. "kept on this device only" is printed only when
          this browser really holds that ZIP (ZipKeptNote): a shared
          /reps?zip= link keeps nothing. min-h-11: the link's hit box is 44px;
          the text stays text-sm. */}
      {zip && districts.length > 0 && (
        <p data-zip-line="" className="mt-4 text-sm text-ink-2">
          {/* The no-break space keeps the "·" at the end of a wrapped line,
              never at the start of the next (BillCard's rule). */}
          {t('zipLine', { zip })}
          <ZipKeptNote zip={zip} />
          {' ·'}{' '}
          <Link
            href="/reps?change=1"
            className="inline-flex min-h-11 items-center underline underline-offset-2"
          >
            {t('changeZip')}
          </Link>
        </p>
      )}

      {/* A saved ZIP ANSWERS THIS PROMPT ON ITS OWN (owner, Q8 "a",
          2026-09-28): SavedZipLookup reads it in the browser and swaps in
          /reps?zip=<ZIP>. `?change=1` is the "Change ZIP code" link's way in,
          so there the prompt stays put and the saved ZIP only pre-fills it. */}
      {!zip && (
        <div className="mt-8">
          {change === undefined ? (
            <SavedZipLookup>{prompt}</SavedZipLookup>
          ) : (
            prompt
          )}

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
            <ZipForm replace />
          </div>
        </div>
      )}

      {/* THE CAPITOL SWITCHBOARD, where a ZIP matched nothing (wireframes v2,
          reps.html, state 3): the call panel's own block, words and number
          (components/ActionPanel.tsx), so a reader in Guam, the Virgin
          Islands, American Samoa or the Northern Mariana Islands — none of
          whose ZIPs data/zip-districts.json maps (R02) — still leaves with a
          number that reaches any congressional office. Tappable, no Copy (the
          owner's card A, 2026-09-28). */}
      {zip && districts.length === 0 && (
        <div className="mt-4 max-w-xl rounded-control border-[1.5px] border-line-strong p-4" data-switchboard="">
          <p className="max-w-note text-sm text-ink-2">{tBill('switchboardNote')}</p>
          <a
            href="tel:+12022243121"
            className={`mt-2 inline-flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 ${CALL_BUTTON}`}
          >
            <Phone className="h-4 w-4 flex-none" aria-hidden />
            {tBill('switchboard')}
            <span className="whitespace-nowrap tabular-nums">(202) 224-3121</span>
          </a>
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
          <p data-multi-district className={`mt-6 max-w-read ${NOTE}`}>
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
              {vacancy && (
                <VacantSeatCard href={`/reps/${vacancySlug(vacancy)}`} elections={specialElectionsFor(vacancy)} />
              )}
            </div>
          </section>
        );
      })}

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
          not bite here. Invariant I2 in tests/funnel.spec.ts reads this
          section by its `data-testid="reps-continuation"` hook.

          The sub-line under the title is gone since 2026-09-29, as the decided
          wireframe draws it (reps.html: "I dropped its sub-line … to save
          words"); the title and the bills are the continuation. */}
      {zip && districts.length > 0 && (
        <section
          className="mt-12 rounded-control border-2 border-ink bg-paper p-6 md:p-8"
          aria-labelledby="reps-next"
          data-testid="reps-continuation"
        >
          <h2 id="reps-next" className="text-h2 font-extrabold">
            {t('nextTitle')}
          </h2>
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
                    statusKey: statusKeyFor(b),
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

      {/* YOUR RECORD, folded into this tab (owner, UX question Q4 "b + c";
          wireframes v2, reps.html, 2026-09-29): Your calls, then what you
          follow and what you've read as folded rows, then Erase my data. It
          renders in every state — no ZIP yet, a ZIP that matched nothing,
          Change ZIP — because it is read from this browser, not from the
          lookup. The call panel's "See your record" lands on its Your calls
          (`#your-calls`), and /record renders the same component. */}
      <div className="mt-12 border-t-[3px] border-ink pt-4">
        <YourRecord />
      </div>
    </div>
  );
}
