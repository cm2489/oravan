import type { Metadata } from 'next';
import { ArrowRight, ExternalLink, Phone } from 'lucide-react';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { CALL_BUTTON } from '@/components/call-button';
import { CallHubReach, CallHubRouting } from '@/components/CallHubReach';
import { RecordWords } from '@/components/RecordWords';
import { StalenessNote } from '@/components/StalenessNote';
import { UrgencyEmptyState } from '@/components/UrgencyEmptyState';
import { Chip } from '@/components/system';
import { activeBillCount, billSlug, getTopActions, hasActNow } from '@/lib/core';
import {
  announcementFor,
  chamberSession,
  coversDisplay,
  floorSignalsCheckedAt,
  floorSourcesPosture,
} from '@/lib/docket';
import { formatCitation, formatCount } from '@/lib/format';
import { dataAsOfString, getFreshness } from '@/lib/freshness';
import { hreflangAlternates } from '@/lib/hreflang';
import { liveCallTarget } from '@/lib/journey';
import { getMomentsForBill } from '@/lib/moments';

/*
 * /call — THE CALL HUB (owner, 2026-09-29, "nav 1"; wireframes v2,
 * call-hub.html; UX decision Q1 "c", a small Call hub).
 *
 * Reached from the footer's first Site link ("Make a call") on every page.
 * Until 2026-11-24 the phone bar's Call tab landed here too; the owner took
 * that tab off the bar that day. It lists this week's callable bills, then —
 * once a ZIP is saved on this device — who a call would reach.
 *
 * THE LIST IS THE ACT-NOW POOL, the same one the homepage's week and the
 * /reps continuation read (getTopActions, lib/core/bills.ts), in the pool's
 * own order: the record decides the order, never us. That pool never holds a
 * settled bill (rule 6: a settled decision shows no call apparatus), so every
 * "Read + call" here lands on a live panel. Five rows, the homepage
 * shortlist's own count before the rebuild (the wireframe's pick; its caption
 * lists it among the choices still open to the owner).
 *
 * STATIC-FIRST (rule 2). Everything above "Who you'll reach" is prerendered
 * at build, like every flat page (tests/static-rendering.spec.ts). The only
 * per-visitor parts — the members and each row's routing line — render in the
 * browser from the ZIP this device saved (components/CallHubReach.tsx).
 *
 * WHAT IS DELIBERATELY NOT HERE (wireframe): no phone numbers (a number list
 * with no script is what the hub exists to avoid), no settled bills, and no
 * stance picker — the stances live in each bill's panel, all three equal.
 *
 * THE PATH: footer "Make a call" → "Read + call" → a stance is a script on screen, three
 * interactions; with a saved ZIP the numbers are already under it. A headline
 * opens the bill's decoded answer at the top instead (truth first, I1).
 */

const HUB_ROWS = 5;

/*
 * THE WEEK AS CARDS (layout pass round 3, 2026-11-28). The list sizes itself
 * to its own width (a container query on the section), not the window's:
 * one column on a phone, two from 36rem, and from 64rem a six-track grid in
 * which a card takes two tracks, so three cards a row. A last row of two
 * takes three tracks each, and a last row of one (four or seven bills)
 * becomes two rows of two, so a row never ends on an empty slot (the
 * nth-child variants below count the cards; one card alone spans all six).
 * With a saved ZIP the reach column takes 22rem beside the list, the list is
 * narrower than 64rem and runs two across. Each card's buttons sit on its
 * bottom edge, level across the row. DOM order is the pool's order.
 */
const HUB_LIST = 'grid list-none gap-x-8 border-b border-line @xl:grid-cols-2 @5xl:grid-cols-6';
const HUB_CARD =
  'flex min-w-0 flex-col border-t border-line py-5 @5xl:col-span-2 ' +
  '@5xl:[&:nth-child(3n+1):nth-last-child(2)]:col-span-3 @5xl:[&:nth-child(3n+2):last-child]:col-span-3 ' +
  '@5xl:[&:nth-child(3n+1):nth-last-child(4)]:col-span-3 @5xl:[li:nth-child(3n+1):nth-last-child(4)~&]:col-span-3 ' +
  '@5xl:[&:only-child]:col-span-6';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'call' });
  return {
    title: t('title'),
    description: t('metaDescription'),
    alternates: hreflangAlternates(locale, '/call'),
  };
}

export default async function CallHubPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('call');
  const tShared = await getTranslations();
  const format = await getFormatter();

  const top = getTopActions(HUB_ROWS, locale);
  // "Browse all N active bills": a bill of an ended Congress is not active.
  const total = activeBillCount();
  const freshness = getFreshness();
  const dataAsOf = await dataAsOfString(locale);
  // AE3, the homepage's own rule: the quiet claim keys on the pool alone. In
  // the rare state where a bill stands in the pool undecoded, the list is
  // empty AND the week is not quiet — then neither renders, and the browse
  // link below still reaches it on /bills.
  const quiet = !hasActNow();

  const rows = top.map((bill) => {
    const slug = billSlug(bill);
    // The chamber's own schedule, gated exactly as the bill page gates it
    // (rungFor: terminal-first, spent once the chamber votes).
    const announcement = announcementFor(bill, slug);
    // The SAME routing the bill page's panel runs (app/[locale]/bills/[id]),
    // so the hub's "is the live call" line can never disagree with it.
    const live = liveCallTarget(
      bill,
      announcement
        ? {
            chamber: announcement.chamber,
            published: announcement.published,
            session: chamberSession(announcement.chamber),
          }
        : null
    );
    const covers = announcement ? coversDisplay(announcement) : null;
    const parent = getMomentsForBill(slug)[0] ?? null;
    return { bill, slug, announcement, liveChamber: live?.chamber ?? null, covers, parent };
  });

  const shortDate = (iso: string) =>
    format.dateTime(new Date(iso), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

  return (
    <div className="mx-auto max-w-page px-4 pt-6 pb-12 md:pt-8">
      <h1 className="text-h1-bill font-extrabold text-ink">{t('title')}</h1>
      <p className="mt-3 max-w-read text-lede text-ink-2">{t('lede')}</p>

      {/* THE WEEK, FULL WIDTH (layout pass round 3, 2026-11-28). "Who you'll
          reach" renders nothing until this device has a saved ZIP, so a fixed
          rail stood empty beside the list for every first visit. The week
          now takes the whole shell; only once the reach section is on the
          page (:has) does a 22rem side column open at xl beside the list
          (not sticky: three members' cards can run taller than a laptop
          window, and a sticky box would keep its last links below the fold),
          and the list's own container query drops it to two across.
          With no ZIP the empty wrapper is hidden, so it adds no gap. */}
      <div className="mt-8 grid gap-12 xl:has-[[data-call-reach]]:grid-cols-[minmax(0,1fr)_22rem] xl:has-[[data-call-reach]]:items-start">
        <section aria-labelledby="week-h" className="@container min-w-0">
          <div className="lg:flex lg:flex-wrap lg:items-baseline lg:gap-x-4">
            <h2 id="week-h" className="text-h2 font-extrabold text-ink">
              {t('weekTitle')}
            </h2>
            <p className="mt-2 text-xs text-ink-2 lg:mt-0">
              {dataAsOf}
              <StalenessNote checkedAt={freshness.checkedAt} />
            </p>
          </div>

          {rows.length > 0 ? (
            <>
              {/* One quiet AI label for the whole list (card a9, G12): every
                  headline below is AI-decoded; the record lines are not. The
                  wireframe's words, "Headlines decoded by AI · How this is
                  made", with the link to the AI-content policy that /glossary's
                  label already uses. */}
              <p className="mt-4 flex flex-wrap items-center gap-x-3">
                <Chip tone="ai" marker={tShared('common.aiMarker')}>
                  {t('aiNote')}
                </Chip>
                <Link
                  href="/citations#ai-policy"
                  className="inline-flex min-h-11 items-center text-2xs text-ink-2 underline decoration-line-strong underline-offset-4 hover:decoration-ink"
                >
                  {t('aiHowMade')}
                </Link>
              </p>
              <ol className={`mt-4 ${HUB_LIST}`}>
                {rows.map(({ bill, slug, announcement, liveChamber, covers, parent }) => (
                  <li key={slug} data-call-hub-row={slug} className={HUB_CARD}>
                    {/* A floor claim is dated and attributed (rule 6): the
                        chamber's own schedule, with its own printed label
                        (English verbatim, ruling V4) and the source link. */}
                    {announcement && (
                      <p className="text-xs font-bold tracking-[0.06em] text-ink-2 uppercase">
                        {tShared(
                          announcement.chamber === 'senate'
                            ? 'bill.floor.announcedSenate'
                            : 'bill.floor.announcedHouse'
                        )}
                        {covers && (
                          <span className="normal-case">
                            {' · '}
                            {covers.verbatim
                              ? /* The schedule's own printed words, English in
                                   both locales and marked so (ruling V4) — the
                                   same treatment components/FloorEvidence.tsx
                                   gives this label on the bill page and home;
                                   "for" / "para el" stays in the reader's
                                   language (components/RecordWords.tsx). */
                                tShared.rich('home.evidenceCovers', {
                                  date: covers.label,
                                  when: (chunks) => <RecordWords locale={locale}>{chunks}</RecordWords>,
                                })
                              : tShared.rich('home.evidenceCovers', {
                                  date: shortDate(covers.iso),
                                  when: (chunks) => <span className="tabular-nums">{chunks}</span>,
                                })}
                          </span>
                        )}
                      </p>
                    )}
                    <h3 className="mt-1 text-lg leading-tight font-bold text-ink">
                      {/* min-h-11: a one-line headline measured 22px tall on
                          the desktop build, under rule 7's 44px floor (it is
                          not a link inside a sentence). */}
                      <Link
                        href={`/bills/${slug}`}
                        className="inline-flex min-h-11 items-center underline decoration-line-strong underline-offset-4 hover:decoration-ink"
                      >
                        {bill.ai_headline ?? bill.short_title ?? bill.title}
                      </Link>
                    </h3>
                    <p className="mt-1 text-sm text-ink-2">
                      <span className="tabular-nums">{formatCitation(bill.bill_type, bill.bill_number)}</span>
                      {parent ? (
                        <>
                          {' · '}
                          <Link
                            href={`/questions/${parent.id}`}
                            className="inline-flex min-h-11 items-center underline underline-offset-2 hover:text-ink"
                          >
                            {locale === 'es' ? parent.name.es : parent.name.en}
                          </Link>
                        </>
                      ) : (
                        bill.last_action_text && (
                          <>
                            {' · '}
                            {/* The record's own sentence: English in both
                                locales, as every bill page prints it, and
                                set off as a quotation on the Spanish edition
                                (components/RecordWords.tsx). */}
                            <RecordWords locale={locale}>{bill.last_action_text}</RecordWords>
                            {bill.last_action_date && (
                              <>
                                {' '}
                                <time dateTime={bill.last_action_date} className="tabular-nums">
                                  {shortDate(bill.last_action_date)}
                                </time>
                              </>
                            )}
                          </>
                        )
                      )}
                    </p>
                    {liveChamber && <CallHubRouting chamber={liveChamber} />}
                    <div className="mt-auto flex flex-wrap items-center gap-x-5 gap-y-2 pt-3">
                      {/* "Read + call" opens the bill AT its call panel, the
                          same deep link Big Question cards use (SY-10). */}
                      <Link
                        href={`/bills/${slug}#act`}
                        data-call-hub-cta=""
                        className={`inline-flex min-h-12 items-center gap-2 px-5 ${CALL_BUTTON}`}
                      >
                        <Phone className="h-4 w-4 flex-none" aria-hidden />
                        {tShared('moments.readCall')}
                      </Link>
                      {announcement && (
                        /* Out to the official record: a new tab with
                           noopener, the site's convention for every such
                           link (components/FloorEvidence.tsx), and the
                           shipped words (home.evidenceLink). */
                        <a
                          href={announcement.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-ink underline underline-offset-4"
                        >
                          {tShared('home.evidenceLink')}
                          <ExternalLink className="h-4 w-4 flex-none" aria-hidden />
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </>
          ) : quiet ? (
            <div className="mt-6">
              {/* The shipped quiet-week words (funnel invariant I3), judged
                  on the visitor's clock after hydration, never at build. */}
              <UrgencyEmptyState
                {...freshness}
                floorSignals={{
                  checkedAt: floorSignalsCheckedAt(),
                  sourcesHealthy: floorSourcesPosture() === 'quiet',
                }}
              />
            </div>
          ) : null}

          {/* The escape hatch (H15): every active bill, whatever the week. */}
          <Link
            href="/bills"
            className="mt-6 inline-flex min-h-11 items-center gap-2 font-semibold text-ink underline underline-offset-4"
          >
            {tShared('reps.nextSeeAll', { count: formatCount(total, locale) })}
            <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
          </Link>
        </section>

        <div className="min-w-0 empty:hidden xl:self-start">
          <CallHubReach />
        </div>
      </div>
    </div>
  );
}
