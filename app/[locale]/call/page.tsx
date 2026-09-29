import type { Metadata } from 'next';
import { ArrowRight, Phone } from 'lucide-react';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { CALL_BUTTON } from '@/components/call-button';
import { CallHubReach, CallHubRouting } from '@/components/CallHubReach';
import { StalenessNote } from '@/components/StalenessNote';
import { UrgencyEmptyState } from '@/components/UrgencyEmptyState';
import { Chip } from '@/components/system';
import { billSlug, getAllBills, getTopActions, hasActNow } from '@/lib/core';
import {
  announcementFor,
  chamberSession,
  coversDisplay,
  floorSignalsCheckedAt,
  floorSourcesPosture,
} from '@/lib/docket';
import { formatCitation } from '@/lib/format';
import { dataAsOfString, getFreshness } from '@/lib/freshness';
import { hreflangAlternates } from '@/lib/hreflang';
import { liveCallTarget } from '@/lib/journey';
import { getMomentsForBill } from '@/lib/moments';

/*
 * /call — THE CALL HUB (owner, 2026-09-29, "nav 1"; wireframes v2,
 * call-hub.html; UX decision Q1 "c", a small Call hub).
 *
 * Where the Call tab lands when no open bill is in context: home, the lists,
 * Reps, Today, the flat pages, a settled bill page and a member page (the
 * index's "Where the Call tab goes" table; lib/call-tab.ts). It lists this
 * week's callable bills, then — once a ZIP is saved on this device — who a
 * call would reach.
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
 * THE PATH: Call tab → "Read + call" → a stance is a script on screen, three
 * interactions; with a saved ZIP the numbers are already under it. A headline
 * opens the bill's decoded answer at the top instead (truth first, I1).
 */

const HUB_ROWS = 5;

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
  const total = getAllBills().length;
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
    <div className="mx-auto max-w-5xl px-4 py-12">
      <h1 className="text-h1-bill font-extrabold text-ink">{t('title')}</h1>
      <p className="mt-4 max-w-read text-lede text-ink-2">{t('lede')}</p>

      <div className="mt-10 grid gap-12 min-[62rem]:grid-cols-[minmax(0,var(--measure-read))_minmax(18rem,22rem)] min-[62rem]:justify-between">
        <section aria-labelledby="week-h" className="min-w-0">
          <h2 id="week-h" className="text-h2 font-extrabold text-ink">
            {t('weekTitle')}
          </h2>
          <p className="mt-2 text-xs text-ink-2">
            {dataAsOf}
            <StalenessNote checkedAt={freshness.checkedAt} />
          </p>

          {rows.length > 0 ? (
            <>
              {/* One quiet AI label for the whole list (card a9, G12): every
                  headline below is AI-decoded; the record lines are not. */}
              <p className="mt-4">
                <Chip tone="ai" marker={tShared('common.aiMarker')}>
                  {t('aiNote')}
                </Chip>
              </p>
              <ol className="mt-4 grid list-none border-b border-line">
                {rows.map(({ bill, slug, announcement, liveChamber, covers, parent }) => (
                  <li key={slug} data-call-hub-row={slug} className="border-t border-line py-5">
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
                            {t('floorFor', {
                              date: covers.verbatim ? covers.label : shortDate(covers.iso),
                            })}
                          </span>
                        )}
                      </p>
                    )}
                    <h3 className="mt-1 text-lg leading-tight font-bold text-ink">
                      <Link
                        href={`/bills/${slug}`}
                        className="underline decoration-line-strong underline-offset-4 hover:decoration-ink"
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
                                locales, as every bill page prints it. */}
                            <span lang="en">{bill.last_action_text}</span>
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
                    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
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
                        <a
                          href={announcement.url}
                          className="inline-flex min-h-11 items-center text-sm font-semibold text-ink underline underline-offset-4"
                        >
                          {t('readSource')}
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
            {tShared('reps.nextSeeAll', { count: total })}
            <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
          </Link>
        </section>

        <div className="min-w-0">
          <CallHubReach />
        </div>
      </div>
    </div>
  );
}
