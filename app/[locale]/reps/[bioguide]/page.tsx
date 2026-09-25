import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { Link } from '@/i18n/navigation';
import { BillCard } from '@/components/BillCard';
import { RepCard, RepContact, RepPortrait, repRoleKey, usePartyLabel } from '@/components/RepCard';
import { UrgencyEmptyState } from '@/components/UrgencyEmptyState';
import { VacantSeatCard } from '@/components/VacantSeatCard';
import { AiNote } from '@/components/system';
import {
  billSlug,
  getAllLegislators,
  getBillsSponsoredBy,
  getLegislator,
  getTopActions,
  getVacancies,
  getVacancyBySlug,
  localizeBill,
  senatorsForState,
  vacancySlug,
} from '@/lib/core';
import { formatCitation } from '@/lib/format';
import { getFreshness } from '@/lib/freshness';
import { hreflangAlternates } from '@/lib/hreflang';
import { statusKeyFor } from '@/lib/journey';
import type { Bill, BillTeaser, Legislator, Vacancy } from '@/lib/types';

/*
 * ONE MEMBER OF CONGRESS, AS RULED PAPER.
 *
 * Every sitting member gets a page at /reps/<bioguide>, prerendered in both
 * languages. Its subject is a person with a phone number, so - like /reps -
 * nothing on it is loud: bordered paper, the one green dial per member, and
 * party as plain ink text in the meta line (components/RepCard.tsx's rule,
 * reused here rather than restated, so this page has no branch that can reach
 * a party-keyed color either).
 *
 * THE FUNNEL ON THIS SURFACE (tests/funnel.spec.ts, "member page"):
 *   I1 - every bill link here is a DECODED corpus bill (getBillsSponsoredBy
 *        filters to decoded ones), so each is one click from a decoded,
 *        AI-labeled answer.
 *   I2 - that bill page's rail is one stance away from a completed script:
 *        two interactions from here. A member who sponsors nothing Oravan
 *        tracks gets the /reps continuation instead (the same callable bills,
 *        or the honest quiet-week state), so this page never dead-ends.
 *
 * A VACANT SEAT has no bioguide - data/vacancies.json is built so it cannot
 * carry the departed member's - so its page is keyed on the seat ("fl-20",
 * see lib/core/reps.ts vacancySlug). It says the one true thing the lookup
 * says (VacantSeatCard), then hands over the state's senators, who still
 * represent that district. Never the departed member, never an election
 * claim.
 */

const WRAP = 'mx-auto max-w-5xl px-4 py-12';
const EYEBROW = 'text-xs font-semibold tracking-[0.04em] text-ink-2';
/** How many sponsored bills show before the rest fold into a disclosure. */
const SHOWN = 6;

export const dynamicParams = true;

export function generateStaticParams() {
  const ids = [
    ...getAllLegislators().map((l) => l.bioguide),
    ...getVacancies().map((v) => vacancySlug(v)),
  ];
  return routing.locales.flatMap((locale) => ids.map((bioguide) => ({ locale, bioguide })));
}

type Resolved =
  | { kind: 'member'; rep: Legislator }
  | { kind: 'vacancy'; seat: Vacancy };

function resolve(id: string): Resolved | null {
  const rep = getLegislator(id);
  if (rep) return { kind: 'member', rep };
  const seat = getVacancyBySlug(id);
  if (seat) return { kind: 'vacancy', seat };
  return null;
}

type RepsT = Awaited<ReturnType<typeof getTranslations<'reps'>>>;

/** "WA", "TX district 23", "AK at-large": the seat a member holds. */
function placeLabel(t: RepsT, state: string, district: number | null): string {
  if (district === null) return state;
  return district === 0
    ? t('atLargeHeading', { state })
    : t('districtHeading', { state, district });
}

function teaser(b: Bill): BillTeaser {
  return {
    slug: billSlug(b),
    identifier: formatCitation(b.bill_type, b.bill_number),
    headline: b.ai_headline,
    title: b.short_title ?? b.title,
    statusKey: statusKeyFor(b.status, b.last_action_text, b.last_action_date),
    status: b.status,
    tags: b.issue_tags ?? [],
    lastActionDate: b.last_action_date,
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; bioguide: string }>;
}): Promise<Metadata> {
  const { locale, bioguide } = await params;
  const found = resolve(bioguide);
  if (!found) notFound();
  const t = await getTranslations({ locale, namespace: 'rep' });
  const tReps = await getTranslations({ locale, namespace: 'reps' });
  const alternates = hreflangAlternates(locale, `/reps/${bioguide}`);

  if (found.kind === 'vacancy') {
    const place = placeLabel(tReps, found.seat.state, found.seat.district);
    return {
      title: t('vacantMetaTitle', { place }),
      description: t('vacantMetaDescription'),
      alternates,
    };
  }
  const { rep } = found;
  return {
    title: t('metaTitle', {
      name: rep.name,
      role: tReps(repRoleKey(rep)),
      place: placeLabel(tReps, rep.state, rep.type === 'sen' ? null : rep.district),
    }),
    description: t('metaDescription', { name: rep.name }),
    alternates,
  };
}

export default async function RepPage({
  params,
}: {
  params: Promise<{ locale: string; bioguide: string }>;
}) {
  const { locale, bioguide } = await params;
  setRequestLocale(locale);
  const found = resolve(bioguide);
  if (!found) notFound();

  const t = await getTranslations('rep');
  const tReps = await getTranslations('reps');

  return (
    <div className={WRAP}>
      <p>
        <Link
          href="/reps"
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-ink underline underline-offset-4"
        >
          <ArrowLeft className="h-4 w-4 flex-none" aria-hidden />
          {t('crumb')}
        </Link>
      </p>
      {found.kind === 'member' ? (
        <MemberBody rep={found.rep} locale={locale} t={t} tReps={tReps} />
      ) : (
        <VacancyBody seat={found.seat} locale={locale} t={t} tReps={tReps} />
      )}
    </div>
  );
}

type RepT = Awaited<ReturnType<typeof getTranslations<'rep'>>>;

function MemberBody({
  rep,
  locale,
  t,
  tReps,
}: {
  rep: Legislator;
  locale: string;
  t: RepT;
  tReps: RepsT;
}) {
  const party = usePartyLabel(rep);
  const tCommon = useTranslations('common');
  const place = placeLabel(tReps, rep.state, rep.type === 'sen' ? null : rep.district);
  const sponsored = getBillsSponsoredBy(rep.bioguide).map((b) => teaser(localizeBill(b, locale)));
  const shown = sponsored.slice(0, SHOWN);
  const rest = sponsored.slice(SHOWN);

  return (
    <>
      <header className="mt-6 flex items-start gap-4 md:gap-6">
        <RepPortrait rep={rep} large />
        <div className="min-w-0">
          {/* Party is ink text at the same weight as the role and the seat -
              the record's own label, nothing added to it. */}
          {/* Wraps BETWEEN whole chunks, never inside one, and the separator
              rides at the end of the chunk before it, so a wrapped line never
              starts with a floating "·" (BillCard's rule). */}
          <p className={`flex flex-wrap gap-x-1 ${EYEBROW}`}>
            {[tReps(repRoleKey(rep)), party, place]
              .filter((c): c is string => Boolean(c))
              .map((chunk, i, all) => (
                <span key={i} className="whitespace-nowrap">
                  {chunk}
                  {i < all.length - 1 && <span aria-hidden> ·</span>}
                </span>
              ))}
          </p>
          <h1 className="mt-1 text-h1-bill font-extrabold">{rep.name}</h1>
          {rep.url && (
            <a
              href={rep.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex min-h-11 items-center text-sm text-ink-2 underline underline-offset-2 hover:text-ink"
            >
              {tReps('website')}
            </a>
          )}
        </div>
      </header>

      <div className="mt-8 grid gap-8 min-[62rem]:grid-cols-[minmax(0,1fr)_minmax(20rem,22rem)] min-[62rem]:items-start">
        {/* THE CALL. Same dial, same local numbers as the lookup's card. On a
            wide screen it holds to the right of the record, so the number is
            never below the fold of what you're reading about. */}
        <section
          aria-labelledby="rep-contact"
          className="rounded-control border-[1.5px] border-line-strong bg-paper p-5 min-[62rem]:sticky min-[62rem]:top-4 min-[62rem]:col-start-2 min-[62rem]:row-start-1"
        >
          <h2 id="rep-contact" className="text-xl font-extrabold">
            {t('contactHeading')}
          </h2>
          <div className="mt-4">
            <RepContact rep={rep} />
          </div>
        </section>

        <div className="min-w-0 min-[62rem]:col-start-1 min-[62rem]:row-start-1">
          <section aria-labelledby="rep-sponsored">
            <div className="border-t-[3px] border-ink pt-4">
              <h2 id="rep-sponsored" className="text-h2 font-extrabold">
                {t('sponsoredHeading')}
              </h2>
            </div>
            {sponsored.length > 0 ? (
              <>
                <p className="mt-3 max-w-read text-sm text-ink-2">
                  {t('sponsoredNote', { count: sponsored.length })}
                </p>
                {/* Eight words: over the ai chip's short-label budget, so a
                    caption (AiNote), in the same first-contact spot. */}
                <AiNote marker={tCommon('aiMarker')} className="mt-3 max-w-read">
                  {t('aiNote')}
                </AiNote>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  {shown.map((b) => (
                    <BillCard key={b.slug} bill={b} />
                  ))}
                </div>
                {rest.length > 0 && (
                  <details className="mt-4 border-t border-line pt-2">
                    <summary className="flex min-h-11 cursor-pointer items-center text-sm font-bold select-none">
                      {t('showAll', { count: sponsored.length })}
                    </summary>
                    <div className="mt-2 grid gap-4 md:grid-cols-2">
                      {rest.map((b) => (
                        <BillCard key={b.slug} bill={b} />
                      ))}
                    </div>
                  </details>
                )}
              </>
            ) : (
              <p className="mt-3 max-w-read text-sm text-ink-2">
                {t('sponsoredNone', { name: rep.name })}
              </p>
            )}
          </section>

          {/*
           * ── VOTE RECORD SLOT: EMPTY BY DESIGN ──
           * A sibling workstream is building data/votes.json + lib/votes.ts.
           * Until that lands, this slot renders NOTHING - no heading, no
           * "coming soon", no placeholder rows: an empty promise is a claim
           * about data we do not hold. When it lands, the vote section goes
           * here, between what they sponsor and the continuation.
           */}

          {sponsored.length === 0 && <Continuation locale={locale} t={t} />}
        </div>
      </div>
    </>
  );
}

function VacancyBody({
  seat,
  locale,
  t,
  tReps,
}: {
  seat: Vacancy;
  locale: string;
  t: RepT;
  tReps: RepsT;
}) {
  const place = placeLabel(tReps, seat.state, seat.district);
  const senators = senatorsForState(seat.state);
  return (
    <>
      <header className="mt-6">
        <p className={EYEBROW}>{t('houseSeat')}</p>
        <h1 className="mt-1 text-h1-bill font-extrabold">{place}</h1>
      </header>
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        <VacantSeatCard />
      </div>
      {senators.length > 0 && (
        <section aria-labelledby="rep-senators" className="mt-12">
          <h2 id="rep-senators" className="text-h2 font-extrabold">
            {t('senatorsHeading', { state: seat.state })}
          </h2>
          <p className="mt-2 max-w-read text-sm text-ink-2">{t('senatorsNote')}</p>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            {senators.map((s) => (
              <RepCard key={s.bioguide} rep={s} />
            ))}
          </div>
        </section>
      )}
      <Continuation locale={locale} t={t} />
    </>
  );
}

/**
 * The /reps continuation, for a page with no sponsored bill to follow: the
 * same callable bills (or the honest quiet-week state), so the member page is
 * never a dead end. Its id is `rep-next`, NOT the frozen `reps-next` - that
 * one belongs to the lookup, and tests/funnel.spec.ts reads each separately.
 */
function Continuation({ locale, t }: { locale: string; t: RepT }) {
  const topActions = getTopActions(2, locale);
  const freshness = getFreshness();
  return (
    <section
      className="mt-12 rounded-control border-2 border-ink bg-paper p-6 md:p-8"
      aria-labelledby="rep-next"
    >
      <h2 id="rep-next" className="text-h2 font-extrabold">
        {t('nextTitle')}
      </h2>
      {topActions.length > 0 ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {topActions.map((b) => (
            <BillCard key={billSlug(b)} bill={teaser(b)} />
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
        {t('nextSeeAll')}
        <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
      </Link>
    </section>
  );
}
