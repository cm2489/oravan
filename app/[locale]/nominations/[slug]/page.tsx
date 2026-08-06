import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { setRequestLocale, getTranslations, getFormatter } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { ActionPanel } from '@/components/ActionPanel';
import { StalenessNote } from '@/components/StalenessNote';
import { Chip } from '@/components/system';
import {
  getNomination,
  isTerminalNominationStatus,
  type Nomination,
} from '@/lib/core/nominations';
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
 * THE RAIL IS components/ActionPanel.tsx. Most of what it needed was already
 * written, tested and shipped dark by N3: the panel branches on
 * `liveTarget.soleChamber` for all three nomination sentences (how confirmation
 * works, the Senate-is-the-call line, and the honest account of what a House
 * call can do), and its `rank()` deliberately ignores that field so the House
 * member keeps his row, his dial and his outcome buttons.
 *
 * This header read "UNCHANGED" until 2026-08-06, and that was the shape of two
 * defects rather than an achievement. The panel's static fallback template says
 * "I support this bill" in so many words, and its 422 branch could not tell the
 * route's deliberate refusal from an outage — so a nomination inherited a
 * bill's script and a hiccup's error message. It now takes a `kind` prop and
 * distinguishes the refusal; see fallbackFor() and the `refused` error state
 * there. And a nomination with no ask to make — one the Senate has finished
 * with, or one the record describes too thinly to write a script from — gets no
 * rail at all; see NoAskPanel below.
 *
 * The rail also carries the SECOND nomination audience as of 2026-08-06: the
 * House member's own script, reached from the House member's own row. The
 * `house` audience had shipped in lib/nomination-script.ts and in the route
 * three commits earlier with nothing asking for it, so the page told a reader
 * their representative could press their senators and then handed them a script
 * addressed to a senator. See HouseScriptSlot in components/ActionPanel.tsx.
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

/** The same 8px-box-with-a-2px-edge geometry components/ActionPanel.tsx states
 *  for its own title bar. Restated rather than imported so this server page
 *  does not reach into a `'use client'` module for a string; the two must stay
 *  equal, because the closed panel below IS the call rail's other state and a
 *  different corner would read as a different object. */
const INNER_RADIUS = 'calc(var(--radius-control)-2px)';

/*
 * THE PANEL WITH NO ASK — what stands where the call rail stands when this page
 * has no ask to make, and the reason it is a whole different panel rather than
 * a disabled rail (blocker 1b, 2026-08-06).
 *
 * TWO CALLERS, ONE RULE. The Senate is done with this nomination (below), or
 * the record carries no description and so there are no words to put in a
 * caller's mouth (see `noScript` in the page body). Different sentences,
 * identical conclusion: nothing on this page should ask the reader to take a
 * position, and nothing should hand them a dial. The panel takes its title and
 * its body as props precisely so the two cases can say different true things
 * inside the same object.
 *
 * ── THE FIRST CALLER: THE CLOSED RECORD ────────────────────────────────────
 *
 * Before this, ActionPanel rendered on every nomination in the corpus,
 * confirmed ones included. On PN11-1 — Scott Bessent, Secretary of the
 * Treasury, confirmed 2025-01-27 — a reader could pick a position, receive a
 * ready-to-read script, and be handed three phone numbers, eighteen months
 * after the vote. That is the manufactured action app/api/script's own comment
 * says it refuses to write, rebuilt one layer up out of the panel's fallback
 * path.
 *
 * The precedent is the bill path's terminal handling: lib/journey.ts maps
 * `signed`/`vetoed` to a plain past-tense sentence (nowSigned: "the President
 * signed it. It's law.") and sets `showTrailer: false` — the record speaks and
 * the forward-looking apparatus turns off. This is that rule applied to the
 * one surface where the apparatus is a call: no stance control, no AI script,
 * no fallback template, no dial, and the sentence saying what happened
 * standing exactly where the ask used to be.
 *
 * It keeps the rail's silhouette (2px ink edge, ink title bar) on purpose. The
 * page is a desk in both states, and a reader who has seen a live nomination
 * should recognize this panel as the same thing, closed.
 *
 * ── THE SECOND CALLER: NOTHING TO WRITE A SCRIPT FROM ──────────────────────
 *
 * 14 of the 859 civilian records — the Foreign Service promotion lists — carry
 * no description sentence, and that sentence is the only thing a nomination
 * script is ever grounded in (lib/nomination-script.ts's header; there is no
 * decode to fall back on, by design). app/api/script therefore answers 422 for
 * them, correctly. The page nonetheless rendered the full rail on the live ones,
 * so the only thing a reader could do there was pick a position and be told no —
 * an honest refusal at the end of a control that could never do anything else.
 *
 * The panel's own rule settles it, and it is a rule about the READER rather
 * than about the record: "offering a dial with nothing to say is the thing that
 * makes a first-time caller hang up" (components/ActionPanel.tsx, the foot). No
 * words, no apparatus. What this case must NOT do is borrow the closed
 * record's sentences — the Senate can still act on these, and
 * `nominations.closed.*` would be false. Hence a second title and body rather
 * than a second use of the first.
 */
function NoAskPanel({ title, body }: { title: string; body: string }) {
  return (
    <section
      aria-labelledby="no-ask"
      className="w-full rounded-control border-2 border-ink bg-paper"
    >
      <h2
        id="no-ask"
        className="bg-ink-deep px-5 py-3 text-xs leading-tight font-bold tracking-[0.06em] text-paper uppercase"
        style={{ borderRadius: `${INNER_RADIUS} ${INNER_RADIUS} 0 0` }}
      >
        {title}
      </h2>
      <p className="max-w-note p-4 text-md text-ink md:p-6">{body}</p>
    </section>
  );
}

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
 * lists) fall back to the citation. They never reach the call path: the live
 * ones are gated out of the rail here (`noScript`) and app/api/script refuses
 * them besides, since the description is the only thing a script could be
 * grounded in.
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
   * IS THERE A CALL TO MAKE AT ALL? Asked of the TERMINAL SET, not of
   * `liveTarget`, and the difference is deliberate: liveCallTargetForNomination
   * also returns null for `unclassified`, which means the record did not state
   * a stage — not that the nomination is over. Those keep the rail (the call
   * may well be worth making; app/api/script refuses to put words in the
   * caller's mouth about a stage it cannot read, and the panel says so through
   * `bill.scriptNotCallable`). Only confirmed / returned / withdrawn are
   * finished, and only they lose the apparatus.
   */
  const closed = isTerminalNominationStatus(nomination.status);

  /*
   * …AND IS THERE ANYTHING TO SAY IF THERE IS? The 14 description-less records
   * (all Foreign Service promotion lists; exactly one of them is live in the
   * corpus of 2026-08-06, the other 13 already confirmed) can never receive a
   * script — see NoAskPanel's second half.
   *
   * GATED ON `liveTarget`, NOT ON `closed`, and that is the load-bearing line:
   * an `unclassified` nomination has a null liveTarget, so a description-less
   * unclassified record falls through to the RAIL and keeps the route's 422
   * refusal as its answer. Two reasons, both deliberate. First, the copy below
   * says the nomination is still before the Senate, which is exactly what a
   * non-null liveTarget asserts and exactly what `unclassified` does not.
   * Second, `unclassified` is the one status that keeps the rail on purpose
   * (see the block above), and it is what keeps components/ActionPanel.tsx's
   * `refused` branch — blocker 2 of 2026-08-06 — reachable at all. Gating this
   * on `closed` instead would have retired that branch in the same stroke that
   * fixed this one.
   */
  const noScript = !closed && !!liveTarget && !nomination.nominee_description;

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

          {/* THE CALL RAIL — or, when this page has no ask to make, the panel
              that stands in its place: the Senate is finished with this one, or
              the record says too little to write a script from. See NoAskPanel
              above for why neither gets the apparatus. */}
          {closed || noScript ? (
            <div className="min-w-0 min-[62rem]:sticky min-[62rem]:top-4 min-[62rem]:col-start-2 min-[62rem]:row-span-full min-[62rem]:self-start">
              <NoAskPanel
                title={t(closed ? 'nominations.closedTitle' : 'nominations.noScriptTitle')}
                body={
                  closed
                    ? t(`nominations.closed.${nomination.status}`)
                    : t('nominations.noScriptBody')
                }
              />
            </div>
          ) : (
            <div className="min-w-0 min-[62rem]:sticky min-[62rem]:top-4 min-[62rem]:col-start-2 min-[62rem]:row-span-full min-[62rem]:flex min-[62rem]:max-h-[calc(100dvh-2rem)] min-[62rem]:self-start">
              <ActionPanel
                slug={slug}
                identifier={nomination.citation}
                title={headline}
                recordLabels={recordLabels}
                liveTarget={liveTarget}
                /* The kind is stated, never derived from `liveTarget` — see
                   the prop's own comment. On this page liveTarget is null for
                   `unclassified` too, and that record is still a nomination. */
                kind="nomination"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
