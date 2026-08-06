import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { setRequestLocale, getTranslations, getFormatter } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { ActionPanel } from '@/components/ActionPanel';
import { StalenessNote } from '@/components/StalenessNote';
import { Chip } from '@/components/system';
import { getNomination, type Nomination } from '@/lib/core/nominations';
import { dataAsOfString, getFreshness } from '@/lib/freshness';
import { hreflangAlternates } from '@/lib/hreflang';
import { liveCallTargetForNomination } from '@/lib/journey';
import { getMomentsForNomination } from '@/lib/moments';

/*
 * THE SENATE NOMINATION PAGE — the surface that makes a nomination a callable
 * action, and the thing app/api/script's nomination branch exists to serve.
 *
 * WHY IT IS NOT THE BILL PAGE, SHORTER. The bill page's whole first screen is
 * the DECODE: a model's plain-language rewrite of text nobody can read, with
 * the AI label sitting on it at first contact. A nomination has no decode and
 * will not get one — Congress.gov's own description is already one plain
 * English sentence naming the person, the post, and whom they would replace,
 * so a rewrite would spend money to restate a readable sentence and would open
 * a new AI-provenance surface about a named private citizen (the full argument
 * lives in lib/nomination-script.ts's header). Take the decode out of the bill
 * page and what is left is exactly this page: the record, verbatim, and the
 * call.
 *
 * The ONE piece of AI on this page is therefore the call script, inside the
 * rail, where ActionPanel already labels it — and `nominations.noDecodeNote`
 * states the absence out loud, because every other page on this site carries a
 * decode and an unexplained absence reads as a gap in our pipeline rather than
 * as a choice.
 *
 * THE RAIL IS components/ActionPanel.tsx, UNCHANGED. That is deliberate and it
 * is what N3 built toward: the panel already branches on
 * `liveTarget.soleChamber` for all three nomination sentences (how confirmation
 * works, the Senate-is-the-call line, and the honest account of what a House
 * call can do), and its `rank()` deliberately ignores that field so the House
 * member keeps his row, his dial and his outcome buttons. Every nomination
 * behavior this page needs was already written, tested, and shipped dark.
 *
 * ── WHICH NOMINATIONS GET A PAGE, AND WHY THERE IS NO generateStaticParams ──
 *
 * Any nomination in data/nominations.json resolves here; anything else 404s
 * through notFound(), INSIDE the locale boundary, so a Spanish visitor gets
 * the Spanish not-found page with chrome and the right `lang` rather than the
 * bare English root one (the same defect app/[locale]/bills/[id] fixed on
 * 2026-08-04 — its comment is the canonical version).
 *
 * This route deliberately declares NO generateStaticParams, which is the same
 * place every other route in this app ends up: measured on the production
 * build of 2026-08-06, `/[locale]/bills/[id]`, `/[locale]/questions/[id]` and
 * every other page render on demand (`ƒ`) despite declaring params. What the
 * corpus would have offered to prebuild here is the set of nominations a
 * Moment cites, and TODAY THAT IS EMPTY.
 *
 * An empty list is the one configuration Next mis-reads: it classifies the
 * route as fully static (`●`), then tries to prerender each request as it
 * arrives and throws DYNAMIC_SERVER_USAGE — a 500 on every nomination URL,
 * including the 404 path. Verified against a real production build before
 * this landed, which is the only reason it is written down here rather than
 * rediscovered. Declaring no params says the true thing (nothing is prebuilt),
 * costs nothing (this route was `ƒ` either way), and cannot flip behavior the
 * day a Moment cites its first nomination.
 *
 * A nomination NO moment cites is still a real government record and still
 * renders — but it is marked `noindex`, because it is not part of this site's
 * curated index and 857 orphan pages in a search index would be a claim about
 * editorial scope that nobody made. `follow` stays true: the links on it
 * (Congress.gov, /questions) are all worth following.
 */

const WRAP = 'mx-auto w-full max-w-5xl px-4';

/**
 * The page's headline: Congress.gov's description sentence, VERBATIM, English
 * in both locales.
 *
 * It stays English on /es by the same rule the article titles in
 * data/coverage.json follow (README, "Known v1 caveats"): a government-sourced
 * value is quoted, not translated, because translating it would put Oravan's
 * words inside quotation marks that belong to the Senate.
 * `nominations.noDecodeNote` renders directly beneath it and is what makes
 * that legible to a Spanish reader rather than broken.
 *
 * The 14 civilian records with no description (all Foreign Service promotion
 * lists) fall back to the citation. They can never reach the call path anyway
 * — app/api/script refuses them, since the description is the only thing a
 * script could be grounded in.
 */
function headlineFor(n: Nomination, untitled: string): string {
  return n.nominee_description ?? untitled;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const nomination = getNomination(slug);
  if (!nomination) return {};
  const t = await getTranslations({ locale, namespace: 'nominations' });
  const title = `${nomination.citation} — ${headlineFor(nomination, t('untitled', { citation: nomination.citation }))}`;
  const cited = getMomentsForNomination(slug).length > 0;
  return {
    title,
    description: t('metaDescription'),
    alternates: hreflangAlternates(locale, `/nominations/${slug}`),
    // See the header: reachable, but not part of the curated index unless a
    // Moment cites it.
    robots: { index: cited, follow: true },
  };
}

export default async function NominationPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const nomination = getNomination(slug);
  if (!nomination) notFound();

  const t = await getTranslations();
  const format = await getFormatter();
  // date-only strings => UTC, or every date on this page reads a day early for
  // every viewer west of Greenwich.
  const fmtDate = (d: string) =>
    format.dateTime(new Date(d), { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const fmtShort = (d: string) =>
    format.dateTime(new Date(d), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

  const dataAsOf = await dataAsOfString(locale);
  const freshness = getFreshness();

  const untitled = t('nominations.untitled', { citation: nomination.citation });
  const headline = headlineFor(nomination, untitled);

  /*
   * The routing fact, from the ONE derivation (lib/journey.ts, pinned by
   * tests/journey.unit.spec.ts suite 7): the Senate, at every live stage, and
   * NOTHING at all once the nomination is confirmed, returned, withdrawn, or
   * unclassified. Passed straight to ActionPanel, which turns null into the
   * rep list exactly as it has always rendered it — no routing claim, no
   * nomination copy, and no implication that a call still matters.
   */
  const liveTarget = liveCallTargetForNomination(nomination);

  /*
   * The civic-record label, in BOTH locales at render time (the /es/record
   * defect of 2026-08-04: stored English labels printed verbatim on the
   * Spanish page). Both are the same string here, and that is correct rather
   * than lazy — the citation and the receiving body are the government's own
   * values, so there is no Spanish version of them to store.
   *
   * The label is deliberately the citation and the ORGANIZATION, never a
   * nominee's name pulled out of the description sentence. Splitting that
   * sentence on its first comma would be a heuristic over 857 records of
   * unverified shape, in a list the visitor keeps on their own device and
   * cannot correct.
   */
  const recordLabel = nomination.organization
    ? `${nomination.citation} · ${nomination.organization}`
    : nomination.citation;
  const recordLabels = { en: recordLabel, es: recordLabel };

  // The bigger question this nomination is a vehicle of, if any — live and
  // stale only, the same rule and the same read-time scan the bill page uses.
  const parentMoments = getMomentsForNomination(slug);

  return (
    <div className={WRAP}>
      <p className="pt-3">
        <Link
          href="/questions"
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-go visited:text-go-deep hover:text-go-deep hover:underline"
        >
          <ArrowLeft className="h-4 w-4 flex-none" aria-hidden />
          {t('moments.crumb')}
        </Link>
      </p>

      <header className="pt-6 pb-4">
        <h1 className="max-w-[36ch] text-h1-bill font-extrabold text-ink">{headline}</h1>
        {/* THE PROVENANCE RITUAL, the bill page's own line in the bill page's
            own voice and order: citation · receiving body · status · latest
            action. No AI label rides here — unlike a bill headline, nothing
            above this line was written by a model. */}
        <p className="mt-3 max-w-read border-t-[3px] border-ink pt-2 text-2xs font-extrabold tracking-[0.14em] text-ink-2 uppercase">
          <span className="tabular-nums">{nomination.citation}</span>
          {nomination.organization && (
            <>
              <span aria-hidden> · </span>
              <span>{nomination.organization}</span>
            </>
          )}
          <span aria-hidden> · </span>
          <span>{t(`nominations.status.${nomination.status}`)}</span>
          {nomination.last_action_date && (
            <>
              <span aria-hidden> · </span>
              <span className="tabular-nums">
                {t('bill.lastAction')} {fmtShort(nomination.last_action_date)}
              </span>
            </>
          )}
        </p>

        {/* The absence of a decode, stated where a decode would have been —
            immediately under the headline it would have replaced. */}
        <p className="mt-4 max-w-read text-sm text-ink-2">{t('nominations.noDecodeNote')}</p>

        {parentMoments.length > 0 && (
          <ul className="mt-4 max-w-read border-t border-line pt-1">
            {parentMoments.map((m) => (
              <li key={m.id}>
                <Link
                  href={`/questions/${m.id}`}
                  className="inline-flex min-h-11 items-center text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
                >
                  {t('moments.partOf', { name: locale === 'es' ? m.name.es : m.name.en })}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </header>

      <div className="pb-16">
        {/* THE DESK: the record on the left, the call rail on the right. Same
            grid the bill page uses, and the rail spans every row so a sticky
            item holds to the page foot. */}
        <div className="grid max-w-read gap-8 pt-2 min-[62rem]:max-w-none min-[62rem]:grid-cols-[minmax(0,var(--measure-read))_minmax(20rem,25rem)] min-[62rem]:items-start min-[62rem]:justify-between min-[62rem]:gap-x-[clamp(2rem,4vw,4rem)] min-[62rem]:gap-y-8">
          <section
            aria-labelledby="record-h"
            className="min-w-0 min-[62rem]:col-start-1 min-[62rem]:row-start-1"
          >
            <div className="border-t-[3px] border-ink pt-4">
              <h2 id="record-h" className="text-h2 font-extrabold text-ink">
                {t('nominations.recordHeading')}
              </h2>
            </div>
            <p className="mt-3 max-w-read text-sm text-ink-2">{t('nominations.recordLede')}</p>

            {/* The Executive Calendar mark, under the same law the bill card's
                amber follows: the NUMBER earns the mark, the date earns the
                amber. "Calendar No. DESK" and the Privileged-Nomination
                placement both arrive here as null and get no chip — printing
                "Calendar No. NaN" beside a real Senate claim, or an
                unqualified "on the calendar" over an unnumbered placement,
                are the two ways this could over-claim. */}
            {nomination.exec_calendar_number !== null && nomination.last_action_date && (
              <p className="mt-4">
                <Chip tone="urgent" dateLabel={fmtShort(nomination.last_action_date)}>
                  {t('nominations.onExecCalendar', { number: nomination.exec_calendar_number })}
                </Chip>
              </p>
            )}

            <dl className="mt-4 max-w-read">
              {nomination.received_date && (
                <div className="border-t border-line py-3">
                  <dt className="text-2xs leading-tight font-extrabold tracking-[0.1em] text-ink-2 uppercase">
                    {t('nominations.receivedLabel')}
                  </dt>
                  <dd className="mt-1 text-sm text-ink tabular-nums">
                    <time dateTime={nomination.received_date}>
                      {fmtDate(nomination.received_date)}
                    </time>
                  </dd>
                </div>
              )}
              {nomination.last_action_text && (
                <div className="border-t border-line py-3">
                  <dt className="text-2xs leading-tight font-extrabold tracking-[0.1em] text-ink-2 uppercase">
                    {t('nominations.lastActionLabel')}
                  </dt>
                  <dd className="mt-1 text-sm text-ink">
                    {nomination.last_action_date && (
                      <>
                        <time dateTime={nomination.last_action_date} className="tabular-nums">
                          {fmtDate(nomination.last_action_date)}
                        </time>
                        {' — '}
                      </>
                    )}
                    {nomination.last_action_text}
                    {/* This page urges a call — the staleness caveat continues
                        the record's own sentence, client-side. */}
                    <StalenessNote checkedAt={freshness.checkedAt} />
                  </dd>
                </div>
              )}
            </dl>

            <p className="mt-4 max-w-read text-xs text-ink-2">{dataAsOf}</p>

            <p className="mt-4">
              <a
                href={nomination.congress_gov_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-go underline visited:text-go-deep hover:text-go-deep"
              >
                {t('nominations.viewOfficial')}
                <ExternalLink className="h-4 w-4 flex-none" aria-hidden />
              </a>
            </p>
          </section>

          {/* THE CALL RAIL — components/ActionPanel.tsx, unmodified. See the
              file header for why nothing about it needed to change. */}
          <div className="min-w-0 min-[62rem]:sticky min-[62rem]:top-4 min-[62rem]:col-start-2 min-[62rem]:row-span-full min-[62rem]:flex min-[62rem]:max-h-[calc(100dvh-2rem)] min-[62rem]:self-start">
            <ActionPanel
              slug={slug}
              identifier={nomination.citation}
              title={headline}
              recordLabels={recordLabels}
              liveTarget={liveTarget}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
