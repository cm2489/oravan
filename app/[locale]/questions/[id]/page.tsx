import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ExternalLink } from 'lucide-react';
import { setRequestLocale, getTranslations, getFormatter } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { settledDecision, statusKeyFor } from '@/lib/journey';
import { routing } from '@/i18n/routing';
import { ActionPanel } from '@/components/ActionPanel';
import { CallTabTarget } from '@/components/CallTabTarget';
import { CALL_PANEL_ANCHOR, STILL_OPEN_ID, questionCallTarget, questionHasPanel } from '@/lib/call-tab';
import { billCallPanelProps } from '@/lib/bill-call-panel';
import { settledDecisionDate } from '@/lib/settled-votes';
import { settledOutcomeSentence, statusWord } from '@/lib/status-word';
import { MomentQuietNote } from '@/components/MomentQuietNote';
import { MomentRecordRow } from '@/components/MomentRecordRow';
import { MomentStatusLine } from '@/components/MomentStatusLine';
import { MomentStillOpenRail } from '@/components/MomentStillOpenRail';
import { MomentTimeline, type TimelineVehicle } from '@/components/MomentTimeline';
import { MomentNominationCard } from '@/components/MomentNominationCard';
import { MomentVehicleCard } from '@/components/MomentVehicleCard';
import { ConcurrentExplainer } from '@/components/ConcurrentExplainer';
import { StalenessNote } from '@/components/StalenessNote';
import { Chip } from '@/components/system';
import { getBill, localizeBill } from '@/lib/core';
// Imported DIRECTLY, never through the lib/core barrel — that module's header
// forbids the barrel so no bundle pays for data/nominations.json (~520 KB) by
// accident. This page renders one, so it pays for it deliberately.
import { getNomination } from '@/lib/core/nominations';
import { getCoverage, normalizeSource } from '@/lib/coverage';
import { formatCitation } from '@/lib/format';
import { adoptedConcurrentReading } from '@/lib/concurrent-explainer';
import { dataAsOfString, getFreshness } from '@/lib/freshness';
import { hreflangAlternates } from '@/lib/hreflang';
import {
  RENDER_DAY_CAP,
  VERBATIM_MODE,
  getCurrentSummary,
  getRevisions,
  isAiSummary,
} from '@/lib/moment-updates';
import {
  QUALIFYING_SIGNAL_TYPES,
  getLiveMoments,
  getMoment,
  getMoments,
  lastReviewedDay,
  vehicleKind,
} from '@/lib/moments';
import {
  bothNoteKey,
  linkHost,
  momentDek,
  questionVehicles,
  revisionReasons,
  vehicleCtaHref,
  type QuestionVehicle,
} from '@/lib/moments-ui';
import { questionStatus } from '@/lib/moment-status.mjs';
import { LIVE_CAP } from '@/lib/moments-gate.mjs';

const localeText = (l: { en: string; es: string }, locale: string): string =>
  locale === 'es' ? l.es : l.en;

/* Content links are green — green means GO, and a link goes somewhere.
   Navigation chrome (the crumb) stays ink, per the color law's split. */
const CONTENT_LINK =
  'inline-flex min-h-11 items-center gap-2 font-bold text-go underline transition-colors hover:text-go-deep';

/*
 * THE PAGE'S ONE WRAPPER — the site rail every other route sits on, and the
 * reason this page can hold two columns at all. Identical string to
 * app/[locale]/bills/[id]/page.tsx and app/[locale]/nominations/[slug]/page.tsx:
 * 1024 − 32 = 992 = 528 (33rem of reading) + 64 + 400 (a 25rem rail). This page
 * used to be a centered max-w-3xl article; nothing about that container was
 * this page's own, and adopting the site's two-panel rail is what puts the
 * vehicles beside the narrative instead of a screen below it.
 */
const WRAP = 'mx-auto w-full max-w-5xl px-4';

/*
 * THE DESK — the same grid string as the bill page and the nomination page
 * apart from the leading spacing utility and the ROW gap: one track of
 * `--measure-read` and one of 20–25rem, opening at the site's 62rem
 * breakpoint, `items-start`, `justify-between`, and the same clamped column
 * gutter. No new tokens, no new breakpoint.
 *
 * THREE CHILDREN, IN READING ORDER (wireframes v2, 2026-09-29). Source order
 * is the phone's reading order, and the rail has to sit in the MIDDLE of it:
 *
 *   LEAD   what Congress is deciding, then the bills (col 1, row 1);
 *   RAIL   the call — the bill page's own call panel on a one-bill question
 *          ("the panel right after the decoded answer", question-single),
 *          or the desk-only "Still open to a call" list on a several-bills
 *          question (col 2, rows 1–2, sticky);
 *   REST   where it stands, what's moved, why this question exists (col 1,
 *          row 2).
 *
 * So on a phone the panel follows the question's answer and its bill
 * directly, as it follows the decode on a bill page (rule 8), and on the desk
 * it rides beside the whole column.
 *
 * WHY THE RAIL SPANS TWO NAMED ROWS AND NOT `row-span-full`. `grid-row: 1 /
 * -1` resolves against the EXPLICIT grid, which is empty when the rows are
 * implicit, so it would collapse to row 1 and the sticky box could never
 * travel past the lead. `row-start-1 row-span-2` names both rows. What rides
 * in the rail is always short beside the column — the panel is capped at the
 * window's height and scrolls inside itself, as on the bill page, and the
 * desk list is one short row per open measure — so the rail never pushes a
 * row taller than its column content, and no gap opens in the column. The
 * old page's rail of full cards was the reason it used one row; those cards
 * now sit in the column.
 *
 * NO ROW GAP. Every section keeps its own `mt-12` rhythm, exactly as when the
 * column was one child; a row gap would add to it between LEAD and REST. The
 * panel carries its own `mt-12` on a phone for the same reason.
 */
const DESK =
  'grid max-w-read gap-x-8 min-[62rem]:max-w-none min-[62rem]:grid-cols-[minmax(0,var(--measure-read))_minmax(20rem,25rem)] min-[62rem]:items-start min-[62rem]:justify-between min-[62rem]:gap-x-[clamp(2rem,4vw,4rem)]';

/* The rail's place on the desk: column 2, both rows, sticky 1rem from the top
   of the window (the bill page's `sticky top-4 self-start`). */
const RAIL =
  'min-w-0 min-[62rem]:sticky min-[62rem]:top-4 min-[62rem]:col-start-2 min-[62rem]:row-start-1 min-[62rem]:row-span-2 min-[62rem]:self-start';

/*
 * TRUE 404s INSIDE THE LOCALE BOUNDARY (Phase-1 P1 pair, 2026-08-04).
 * `dynamicParams = false` rejected unknown slugs at the ROUTING layer —
 * above the locale boundary — so a Spanish visitor following a dropped bill
 * link got the bare English root not-found (no chrome, lang="en"): the
 * bilingual-parity hard rule broken exactly where a re-synced corpus
 * produces dead links. `true` + the getBill()/getMoments() notFound() guard
 * below keeps the SAME anti-soft-404 posture (notFound() sends a real 404
 * status, never a cached 200 with the site's own title — the original
 * comment's fear) while rendering app/[locale]/not-found.tsx with header,
 * footer, and the right lang.
 */
export const dynamicParams = true;

export function generateStaticParams() {
  return routing.locales.flatMap((locale) => getMoments().map((m) => ({ locale, id: m.id })));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}): Promise<Metadata> {
  const { locale, id } = await params;
  const moment = getMoment(id);
  if (!moment || moment.state === 'retired') return {};
  const title = localeText(moment.name, locale);
  const description = momentDek(localeText(moment.summary, locale));
  return {
    title,
    description,
    alternates: hreflangAlternates(locale, `/questions/${id}`),
    openGraph: {
      title,
      description,
      siteName: 'Oravan',
      type: 'website',
      locale: locale === 'es' ? 'es_ES' : 'en_US',
      alternateLocale: locale === 'es' ? 'en_US' : 'es_ES',
    },
    // summary_large_image is TRUE again (Wave B ruling #3, 2026-08-04): the
    // per-question OG card ships beside this file — the same commit that
    // makes the claim makes it honest.
    twitter: { card: 'summary_large_image' },
  };
}

export default async function MomentPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const moment = getMoment(id);
  // A retired moment (a stored owner decision, spec §4.3) is off every
  // index AND off this page — the same 404 treatment as an unknown id,
  // since Next has no built-in 410 primitive to reach for here.
  if (!moment || moment.state === 'retired') notFound();

  const t = await getTranslations();
  const format = await getFormatter();
  // `review_by` is a date-only string — format in UTC or it reads a day early
  // for every viewer west of Greenwich.
  const fmtDate = (d: string) =>
    format.dateTime(new Date(d), { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const dataAsOf = await dataAsOfString(locale);
  const freshness = getFreshness();

  const name = localeText(moment.name, locale);
  const summary = localeText(moment.summary, locale);
  const isSettled = moment.state === 'settled';

  // Same count, same predicate, as /questions and the homepage band: live AND
  // past-review (lib/moments.ts getLiveMoments — review dates no longer hide).
  const liveCount = getLiveMoments().length;

  /*
   * WHERE IT STANDS, FROM THE RECORD (Big Questions v2, 2026-09-24). One line
   * per vehicle and one for the question, derived at build time from each
   * vehicle's corpus record through lib/moment-status.mjs — no model, no
   * prose written at open time, so nothing here carries the AI chip: it is the
   * record, mapped to fixed copy. The question's line is its most advanced
   * LIVE vehicle's. When
   * every vehicle has reached the end of its path the question is in
   * EXPLAINER mode: it stays up, the cards read as what happened, and no card
   * promises a call about a finished vehicle (each card's CTA below asks its
   * own line's `terminal`).
   */
  const vehicles = questionVehicles(moment);
  const { mode: statusMode, lead } = questionStatus(vehicles.map((s) => s.line));
  const explainer = statusMode === 'explainer';

  // ── The live layer (v2 spec §7) ────────────────────────────────────────
  const summaryRevision = getCurrentSummary(id);
  const revisions = getRevisions(id);
  // The revision disclosure lists the PRIOR revisions; with only one on file
  // there is no history to disclose and the <details> never renders.
  const priorRevisions = revisions.slice(0, -1).reverse();

  // AI labeling is DATA-GATED here the way MomentTimeline gates it: the chip
  // appears only when a model actually wrote the sentence it stands over
  // (pre-launch audit 2026-07-25, constitution-08 — the seed revisions are
  // stamped `hand-authored`, and a chip over human text is over-labeling,
  // which erodes the label exactly as under-labeling does).
  //
  // The CURRENT summary decides the chip and the disclaimer, because both sit
  // directly above and below the passage they describe (first contact). The
  // history is checked separately so that a hand-authored current summary
  // over an AI history still labels the AI text — no summary a model wrote
  // ever renders unlabeled.
  const currentIsAi = summaryRevision ? isAiSummary(summaryRevision) : false;
  const historyIsAi = priorRevisions.some(isAiSummary);

  /*
   * WHAT THE GRID IS CALLED, AND WHAT IT PROMISES.
   *
   * "The bills" and its lede ("Each opens the full plain-language decode…")
   * are both false over a nomination: it is not a bill, and it carries no
   * decode by design (lib/nomination-script.ts's header). A single neutral
   * word for both would have been the easy fix and the wrong one — this
   * product names things concretely, and "the vehicles" is repo jargon no
   * reader outside this file uses.
   *
   * So the heading and its lede are chosen by what the moment actually holds,
   * the same three-way MomentCard's count line uses and for the same reason:
   * a mixed moment has no true short sentence that names only one kind.
   *
   * WHAT EACH LEDE MAY PROMISE (2026-08-06). All three say a card opens a
   * record, which is true of every card of either kind. Only the CALL FLOW is
   * conditional, and only on a nomination: the Senate has finished with one,
   * or its record never described it, and the page behind that card is a rail
   * reading "No call to make" — `nominationHasCallScript`, app/api/script's
   * own 422 refusal conjunction (lib/journey.ts), is the predicate for it, and
   * `nominationCtaKey` below asks the same one per card.
   *
   *   - `vehiclesLede` (bill-only) promises the call flow flat, and may only
   *     while every bill in the set still has a decision open. Since
   *     2026-09-28 (owner, Q9 "a") a settled bill's page shows a record-only
   *     panel with no call, so a set holding one prints
   *     `vehiclesLedeSomeSettled`, which carries the condition — the same
   *     one-"no" question `bothNoteKey` asks for the note under the grid.
   *   - `vehiclesLedeNominations` and `vehiclesLedeMixed` carry the condition.
   *     The mixed one said "Each opens the record and the call flow" until
   *     this change, which is the same false universal the nominations lede
   *     dropped one commit earlier and `moments.bothNoteSomeNoCall` dropped
   *     the commit after. Corrected IN PLACE rather than behind a variant,
   *     because the ternary above prints it only on a set that holds a
   *     nomination — there is no bill-only render of it to protect.
   *
   * The condition is written as a RULE, not as an observation about this
   * grid, so it does not read as a hint that some card here is callable on a
   * set where none is. Pinned in tests/moments-ui.unit.spec.ts.
   */
  const kinds = new Set(moment.vehicles.map(vehicleKind));
  const vehiclesKey =
    kinds.has('bill') && kinds.has('nomination')
      ? { heading: 'vehiclesHeadingMixed', lede: 'vehiclesLedeMixed' }
      : kinds.has('nomination')
        ? { heading: 'vehiclesHeadingNominations', lede: 'vehiclesLedeNominations' }
        : {
            heading: 'vehiclesHeading',
            lede:
              bothNoteKey(moment.vehicles) === 'moments.bothNoteSomeNoCall'
                ? 'vehiclesLedeSomeSettled'
                : 'vehiclesLede',
          };

  // Citation + Congress.gov actions page per vehicle, resolved here so the
  // timeline stays a pure renderer and never reaches into the bill corpus.
  //
  // NOMINATION SLUGS ARE SKIPPED — getBill() misses, and that is the correct
  // outcome rather than a gap to fill: the live layer that feeds this timeline
  // is bill-only end to end (scripts/moment-updates-map.mjs's momentVehicles()
  // filters to kind==='bill', and lib/moment-updates-gate.mjs requires every
  // stored vehicle to resolve in data/bills.json), so no nomination can ever
  // have a row here to caption. A nomination-only Moment renders the empty
  // ledger this section already renders when no revision exists, which is
  // honest rather than empty-shaped.
  const timelineVehicles: Record<string, TimelineVehicle | undefined> = {};
  for (const v of moment.vehicles) {
    const raw = getBill(v.slug);
    if (!raw) continue;
    timelineVehicles[v.slug] = {
      citation: formatCitation(raw.bill_type, raw.bill_number),
      // Congress.gov's own full list of actions for the bill — the place the
      // honest overflow line ("N further recorded actions this day") sends a
      // reader who wants everything the cap held back.
      actionsUrl: raw.congress_gov_url ? `${raw.congress_gov_url}/all-actions` : null,
    };
  }

  /*
   * STILL OPEN, OR KEPT AS THE RECORD — AND WHERE THE CALL GOES (wireframes
   * v2, 2026-09-29, question-single.html and question-multi.html; the index's
   * "Where the Call tab goes"). `open` is each card's own "Read + call"
   * decision (lib/moments-ui.ts questionVehicles: billCtaKey /
   * nominationCtaKey over the inputs the grid always passed), so the list a
   * vehicle sits in, the label on its button and the Call tab's target are
   * one decision read three ways.
   *
   *   one open bill  → the bill page's own call panel sits on this page (Q6
   *                    b), with exactly the props /bills/[id] computes
   *                    (lib/bill-call-panel.ts). The card's "Read + call" and
   *                    the header's Call tab both land on it (#act).
   *   several open   → a "Still open" list with a stable id (#still-open).
   *                    Each card lands on its own bill's panel; the Call tab
   *                    lands on the list.
   *   nothing open   → no call on this page; the Call tab goes to the hub.
   *
   * Settled vehicles sit below the open ones as record-only rows, each with
   * one status word from the closed set (lib/status-word.ts) and the record's
   * outcome sentence (page 1, rule 6: a settled decision shows no call
   * apparatus).
   */
  const openVehicles = vehicles.filter((v) => v.open);
  const recordVehicles = vehicles.filter((v) => !v.open);
  const callableKinds = openVehicles.map((v) => v.kind);
  const panel = questionHasPanel(callableKinds)
    ? billCallPanelProps(openVehicles[0].vehicle.slug, locale, { t, fmtDate })
    : null;
  // Declared under the same condition the panel renders under, so the tab
  // never points at a panel that is not there (the bill page's rule). `open`
  // already means the record settles nothing, so a one-bill question always
  // gets its panel; the guard only keeps the two from ever disagreeing.
  const callTabHref = questionHasPanel(callableKinds) && !panel ? null : questionCallTarget(callableKinds);

  // Group headings print when they tell the reader something: both whenever
  // both groups are on the page, and "Still open" whenever the Call tab lands
  // on it. A one-bill question with nothing settled prints neither.
  const stillOpenHeading = openVehicles.length > 0 && (recordVehicles.length > 0 || !panel);
  // The AI label covers the cards' decoded headlines and yes-or-no lines. A
  // record row prints neither (its words are the record's), so a section of
  // rows alone carries no label: a label over text a model did not write is
  // over-labeling, which erodes the label (constitution-08).
  const anyCard = openVehicles.length > 0 || recordVehicles.some((v) => v.kind === 'nomination');

  /** One vehicle's card, exactly as the grid rendered it — plus its chamber
   *  tag and the screen-reader words on its button — landing on this page's
   *  panel when the panel is here, and on the vehicle's own panel otherwise. */
  const vehicleCard = ({ vehicle: v, line, group, ctaKey, kind }: QuestionVehicle) => {
    /* ONE LIST, TWO CARDS. The branch is on the vehicle's KIND, read through
       the one normalizer (lib/moments.ts vehicleKind — absent means 'bill',
       stated in exactly one place), never on the shape of the slug.
       MomentNominationCard is MomentVehicleCard's sibling and not its
       generalization; the reasoning is in its own header. Both render at
       identical weight with the identical call button, so a mixed list never
       reads as recommending one vehicle over the other. */
    if (kind === 'nomination') {
      const nomination = getNomination(v.slug);
      if (!nomination) return null;
      return (
        <MomentNominationCard
          key={v.slug}
          slug={v.slug}
          citation={nomination.citation}
          description={nomination.nominee_description}
          organization={nomination.organization}
          status={nomination.status}
          lastActionDate={nomination.last_action_date}
          receivedDate={nomination.received_date}
          execCalendarNumber={nomination.exec_calendar_number}
          role={localeText(v.role, locale)}
          /* "Read + call" is a promise about the page this button opens, so
             it is asked of the RECORD (nominationCtaKey): a nomination the
             Senate has finished with, or one its record never described,
             opens a page whose entire rail is "No call to make". */
          ctaLabel={t(ctaKey)}
          /* "Read + call" lands ON the call panel, anything else at the
             page's top — one decision, read off the same key as the label
             (SY-10; vehicleCtaHref). */
          ctaHref={vehicleCtaHref(`/nominations/${v.slug}`, ctaKey)}
          statusLine={line}
          noDecodeNote={t('nominations.noDecodeNote')}
        />
      );
    }
    const raw = getBill(v.slug);
    if (!raw) return null;
    const bill = localizeBill(raw, locale);
    const identifier = formatCitation(bill.bill_type, bill.bill_number);
    const coverageCount = new Set(getCoverage(v.slug).map((a) => normalizeSource(a.source))).size;
    // An adopted concurrent resolution's card says what that means, as its
    // bill page does (lib/concurrent-explainer.ts).
    const concurrentReading = adoptedConcurrentReading(raw);
    return (
      <MomentVehicleCard
        key={v.slug}
        slug={v.slug}
        identifier={identifier}
        headline={bill.ai_headline}
        title={bill.short_title ?? bill.title}
        status={bill.status}
        statusKey={statusKeyFor(bill)}
        tags={bill.issue_tags ?? []}
        lastActionDate={bill.last_action_date}
        coverageCount={coverageCount}
        role={localeText(v.role, locale)}
        ctaLabel={t(ctaKey)}
        /* "Read + call" opens the call panel (#act) instead of the bill's top
           (SY-10) — and when that panel is on THIS page, it opens this one.
           "Read the bill" opens the bill page's top. Same key as the label. */
        ctaHref={panel ? CALL_PANEL_ANCHOR : vehicleCtaHref(`/bills/${v.slug}`, ctaKey)}
        ctaContext={ctaKey === 'moments.readCall' ? t('moments.readCallAbout', { citation: identifier }) : undefined}
        /* The chamber it started in, where the list used to group by chamber
           (owner, 2026-09-24: "House and Senate movement should always be
           recorded under a single Big Question even if they may have
           different names"). */
        tag={t(`moments.status.group.${group}`)}
        statusLine={line}
        calendarLabel={t('bills.onCalendar')}
        explainer={concurrentReading ? <ConcurrentExplainer reading={concurrentReading} /> : undefined}
      />
    );
  };

  /** One settled vehicle: its citation, one status word, the record's
   *  outcome sentence (the settled box's, `bill.settled.*`) and a way to read
   *  it. A nomination keeps its record card. */
  const recordRow = (qv: QuestionVehicle) => {
    if (qv.kind === 'nomination') {
      const card = vehicleCard(qv);
      return card ? <li key={qv.vehicle.slug}>{card}</li> : null;
    }
    const raw = getBill(qv.vehicle.slug);
    if (!raw) return null;
    const bill = localizeBill(raw, locale);
    const settled = settledDecision(raw);
    const date = settledDecisionDate(raw);
    const word = statusWord(raw);
    const concurrentReading = adoptedConcurrentReading(raw);
    return (
      <MomentRecordRow
        key={qv.vehicle.slug}
        slug={qv.vehicle.slug}
        identifier={formatCitation(bill.bill_type, bill.bill_number)}
        word={word}
        wordLabel={t(`bills.statusWord.${word}`)}
        /* The settled box's sentence where the bill page reads the decision as
           over; otherwise (a settled QUESTION's vehicle the record still
           holds open) the vehicle's own status line from the record. */
        outcome={
          settled ? (
            <p>{settledOutcomeSentence(t, settled, date ? fmtDate(date) : null)}</p>
          ) : (
            <MomentStatusLine line={qv.line} />
          )
        }
        explainer={concurrentReading ? <ConcurrentExplainer reading={concurrentReading} /> : undefined}
        readLabel={t('moments.readBill')}
      />
    );
  };

  /* The desk's short list of the same open vehicles (several-bills questions
     only; the one-bill question's rail is its panel). */
  const railItems = panel
    ? []
    : openVehicles.flatMap(({ vehicle: v, line, ctaKey, kind }) => {
        const identifier =
          kind === 'nomination'
            ? getNomination(v.slug)?.citation
            : (() => {
                const raw = getBill(v.slug);
                return raw ? formatCitation(raw.bill_type, raw.bill_number) : undefined;
              })();
        if (!identifier) return [];
        return [
          {
            key: v.slug,
            identifier,
            statusLine: line,
            href: vehicleCtaHref(kind === 'nomination' ? `/nominations/${v.slug}` : `/bills/${v.slug}`, ctaKey),
            ctaLabel: t(ctaKey),
            ctaContext: t('moments.readCallAbout', { citation: identifier }),
          },
        ];
      });

  return (
    <article className={`${WRAP} pt-12 pb-16`}>
      {callTabHref && <CallTabTarget href={callTabHref} />}
      {/* 1 · Moment header — full width, above the desk. It names the question
             and dates the record; both columns below answer to it. */}
      <p className="flex flex-wrap items-center gap-3 text-sm">
        <Link
          href="/questions"
          className="inline-flex min-h-11 items-center font-semibold text-ink-2 underline transition-colors hover:text-ink"
        >
          {t('moments.crumb')}
        </Link>
        <span className="text-2xs leading-tight font-extrabold tracking-[0.1em] text-ink-2 uppercase">
          {isSettled ? t('moments.settledBadge') : t('moments.liveBadge')}
        </span>
        <Chip tone="tag">{t(`categories.${moment.category}`)}</Chip>
      </p>

      {/* The wrapper is 70rem now, so the h1 needs the same measure bound the
          bill page's h1 carries — an unbounded display line across a 5xl rail
          is not a heading, it is a banner. Same utility, same value. */}
      <h1 className="mt-4 max-w-[24ch] text-h1-bill font-extrabold text-ink">{name}</h1>
      <p className="mt-5 max-w-read text-xs text-ink-2">
        {dataAsOf}
        <StalenessNote checkedAt={freshness.checkedAt} />
      </p>

      {/* The record's own status for the whole question. The staleBanner that
          stood here ("scheduled review passed…") is gone: a lapsed review date
          is the owner's curation reminder, sent by the nightly watcher, and
          the currency a reader needs is this line — re-derived from the
          record on every build — plus the "Summary updated" date printed
          under the summary it describes. */}
      {lead && (
        <section aria-labelledby="record-status" className="mt-6 max-w-read">
          <h2
            id="record-status"
            className="text-2xs leading-tight font-extrabold tracking-[0.1em] text-ink-2 uppercase"
          >
            {t('moments.status.label')}
          </h2>
          <MomentStatusLine line={lead} size="md" className="mt-2" />
          {explainer && <p className="mt-2 text-sm text-ink-2">{t('moments.status.explainer')}</p>}
        </section>
      )}

      {/* THE DESK — three children in reading order (see DESK): the LEAD
          (what Congress is deciding, then the bills), the RAIL (the call),
          then the REST (where it stands, what's moved, why this question
          exists). Below 62rem they stack in exactly that order, so on a phone
          the call panel follows the question's answer and its bill directly;
          on the desk the rail rides beside the whole column. */}
      <div className={`mt-12 ${DESK}`}>
        {/* THE LEAD (2 · 3). Each section keeps its own mt-12 rhythm. */}
        <div className="min-w-0 min-[62rem]:col-start-1 min-[62rem]:row-start-1">
          {/* 2 · The Moment entry's own summary — the page's one reading passage,
              and so the one place Besley is spent. Provenance, spelled out because
              this page renders two passages with DIFFERENT provenance and the
              comment here has twice named it wrong: this one comes from
              data/moments.json, whose name, summary and role sentences are
              AI-written (scripts/moment-draft.mjs) and reach the page through a
              merge into that file, after check-moments.mjs's gates pass — which
              is all moments.howMadeBody promises: automated gates before it
              publishes. The "Where it stands" revision further down is written
              nightly by the collector (scripts/moment-updates.mjs), gate-checked
              and published with no merge at all. Never let the two blur — the
              difference is the path to the page, not the authorship. */}
          <section aria-labelledby="deciding" className="border-t-[3px] border-ink pt-4">
            <h2 id="deciding" className="text-h2 font-extrabold text-ink">
              {isSettled || explainer ? t('moments.decidingSettled') : t('moments.decidingLive')}
            </h2>
            {isSettled && <p className="mt-4 max-w-read font-semibold text-ink">{t('moments.settledBanner')}</p>}
            {/* AI labeled at FIRST contact — directly above the passage it
                labels. This chip stood in the header over the dek; the dek was
                the summary's own first sentence rendered twice within one mobile
                screen (2026-08 review), so the duplicate render dropped and the
                label moved down with the passage. */}
            <p className="mt-4">
              <Chip tone="ai" marker={t('common.aiMarker')}>
                {t('bill.aiChip')}
              </Chip>
            </p>
            <p className="mt-4 max-w-read font-reading text-lg text-ink">{summary}</p>
            <p className="mt-5 max-w-note text-xs font-semibold text-ink-2">{t('bill.aiDisclaimer')}</p>
            {/* When this summary last changed — the honest replacement for
                hiding a question past its review date. `reviewed` when a
                change set it, else the day it opened. */}
            <p className="mt-2 max-w-note text-xs text-ink-2">
              {t('moments.status.lastReviewed', { date: fmtDate(lastReviewedDay(moment)) })}
            </p>
          </section>

          {/* 3 · The bills — STILL OPEN, THEN KEPT AS THE RECORD (wireframes
              v2, 2026-09-29). Open vehicles are cards whose "Read + call"
              lands on a call panel; settled ones are rows that show the record
              and a way to read it, with nothing that dials. The grouping by
              chamber this replaced survives as each card's "Started in the
              House / Senate" tag. */}
          <section className="mt-12 border-t border-line pt-4" aria-labelledby="vehicles-h">
            <h2 id="vehicles-h" className="text-h2 font-extrabold text-ink">
              {t(`moments.${vehiclesKey.heading}`)}
            </h2>
            <p className="mt-2 max-w-note text-sm text-ink-2">{t(`moments.${vehiclesKey.lede}`)}</p>
            {/* Every card leads with an AI-decoded headline and carries the
                vehicle's `role` — what a yes and a no vote do — which is
                model-written too (scripts/moment-draft.mjs, CLAUDE.md's
                2026-08-07 amendment), and the card's button drives a call. So
                the note names both pieces (pre-launch audit 2026-07-25,
                constitution-05; widened 2026-08-09), and it is not gated on a
                decode: the gate requires a `role` on every vehicle. The "where
                there is one" clause keeps the headline half honest on a card
                that fell back to its official title. It is gated on a CARD
                being here at all: a settled vehicle's record row prints no AI
                text (see `anyCard`). */}
            {anyCard && (
              <p className="mt-5">
                <Chip tone="ai" marker={t('common.aiMarker')} className="max-w-note">
                  {t('moments.vehiclesAiNote')}
                </Chip>
              </p>
            )}

            {/* STILL OPEN. One card per row: the reading column is one card
                wide at every width now that the cards live in it (the rail
                is the call). Authoring order, as data/moments.json lists them. */}
            {openVehicles.length > 0 && (
              <div className="mt-6" data-still-open>
                {stillOpenHeading && (
                  <h3 id={STILL_OPEN_ID} className="border-b border-line pb-2 text-sm font-bold text-ink">
                    {t('moments.stillOpenHeading', { count: openVehicles.length })}
                  </h3>
                )}
                <div className="mt-4 grid gap-4">{openVehicles.map(vehicleCard)}</div>
              </div>
            )}

            {/* SETTLED · KEPT AS THE RECORD. Rows, not cards: the record's
                word, its outcome sentence and "Read the bill" (rule 6). */}
            {recordVehicles.length > 0 && (
              <div className="mt-8" data-record-list>
                <h3 className="border-b border-line pb-2 text-sm font-bold text-ink">
                  {t('moments.settledGroupHeading', { count: recordVehicles.length })}
                </h3>
                <ul className="list-none">{recordVehicles.map(recordRow)}</ul>
              </div>
            )}

            {/* "Every link above opens the same call flow" was printed here
                unconditionally — true of a bill card whose decision is still
                open, and false of a settled bill (record-only panel since
                2026-09-28) and of a nomination card whose page has no call
                script waiting on it. Asked of the SET, because that is what
                the sentence quantifies over (lib/moments-ui.ts bothNoteKey). A
                set whose every vehicle can be called keeps
                `moments.bothNote` byte for byte. */}
            <p className="mt-6 max-w-note text-sm text-ink-2">{t(bothNoteKey(moment.vehicles))}</p>
          </section>
        </div>

        {/* THE RAIL — the call.

            ONE OPEN BILL: the bill page's own call panel (Q6 b; Q5 a, one
            call route, inline), in the bill page's own rail wrapper — sticky,
            capped at the window's height with the panel scrolling inside it
            on the desk — and, on a phone, in flow right after the bills with
            the column's own 3rem rhythm. No floating "Make the call" button
            here: the wireframe draws none on a question page (see the PR).

            SEVERAL OPEN: the short "Still open to a call" list, on the desk
            only (display: none below 62rem, where the column's list is the
            list). */}
        {panel && (
          <div className={`mt-12 ${RAIL} min-[62rem]:mt-0 min-[62rem]:flex min-[62rem]:max-h-[calc(100dvh-2rem)]`}>
            <ActionPanel {...panel} />
          </div>
        )}
        {!panel && railItems.length > 0 && (
          <div className={`hidden ${RAIL} min-[62rem]:block`}>
            <MomentStillOpenRail heading={t('moments.stillOpenRailHeading')} items={railItems} />
          </div>
        )}

        {/* THE REST: where it stands, what's moved, why this question exists.
            (The section numbers in the comments below are the old page's.) */}
        <div className="min-w-0 min-[62rem]:col-start-1 min-[62rem]:row-start-2">
          {/* 3 · "Where it stands" — the machine-written state summary (v2 spec
              §7). It sits BELOW the summary section above on purpose: the
              issue stays front-and-center and dated motion is subordinate to it.
              Renders NOTHING when no revision exists — an empty placeholder
              promising a summary later is a claim about our pipeline, not about
              Congress, and this surface only makes the second kind of claim.

              THE EDITORIAL LAW (owner-settled 2026-07-25, v2 §2): "Truth about
              the record, attribution about the spin… When the record is silent —
              motive, likelihood, what it really means — Oravan's voice stops, and
              named sources speak or nobody does. Speculation never wears our
              voice." The gate lints this text in BOTH languages before it can
              land; what the page owes the law is the labeling and the receipts —
              the AI chip above the passage, the standing disclaimer under it, and
              the dated record of every time the summary was rewritten. */}
          {/* VERBATIM_MODE hides this entire block: unlike a timeline item, a
              summary has no government record to fall back to, so the honest
              off-state is silence (the section is already absent when no revision
              exists — see lib/moment-updates.ts). */}
          {summaryRevision && !VERBATIM_MODE && (
            <section aria-labelledby="where-it-stands" className="mt-12 border-t border-line pt-4">
              <h2 id="where-it-stands" className="text-h2 font-extrabold text-ink">
                {t('moments.updates.whereHeading', { date: fmtDate(summaryRevision.as_of_day) })}
              </h2>
              {/* AI labeled at FIRST contact — above the passage, never in a
                  footnote. Reuses the page's own chip pattern, and appears only
                  when a model wrote the passage below it (see `currentIsAi`). */}
              {currentIsAi && (
                <p className="mt-4">
                  <Chip tone="ai" marker={t('common.aiMarker')} className="max-w-read">
                    {t('moments.updates.summaryAiChip')}
                  </Chip>
                </p>
              )}
              {/* Franklin, not Besley: the reading voice is spent on the ONE
                  passage above (a bill's decoded prose and the words a caller
                  says aloud). This is Oravan stating where the record currently
                  stands — its own voice, in its own font, and visibly
                  subordinate to the section it follows. */}
              <p className="mt-4 max-w-read text-md text-ink">
                {localeText(summaryRevision.text, locale)}
              </p>
              {/* The standing caveat describes AI text ("AI-drafted summary…"),
                  so it travels with the chip: both are claims about how the
                  passage above was written. */}
              {currentIsAi && (
                <p className="mt-5 max-w-note text-xs font-semibold text-ink-2">{t('bill.aiDisclaimer')}</p>
              )}

              {/* The site's existing native-disclosure idiom (WalkthroughDisclosure):
                  the browser's own marker is kept and merely toned, so the
                  affordance survives with no client JavaScript and no icon. */}
              {priorRevisions.length > 0 && (
                <details className="mt-5 max-w-read rounded-control border border-line-strong bg-paper px-4 pb-2">
                  <summary className="min-h-11 cursor-pointer py-3 text-sm font-bold text-ink select-none marker:text-ink-2 hover:text-go-deep">
                    {t('moments.updates.revisionsToggle', { count: priorRevisions.length })}
                  </summary>
                  {/* The label follows the AI text. When the current summary is
                      hand-authored the chip above is gone, and any model-written
                      version in the history would otherwise render with no label
                      at all — so it moves here, once, over the list it describes.
                      Still one AI chip per section (v2 spec §7), never two. */}
                  {!currentIsAi && historyIsAi && (
                    <p className="mt-1 mb-2">
                      <Chip tone="ai" marker={t('common.aiMarker')} className="max-w-read">
                        {t('moments.updates.summaryAiChip')}
                      </Chip>
                    </p>
                  )}
                  <ol className="mt-2 list-none">
                    {priorRevisions.map((rev) => {
                      /* changed_because holds the collector's machine tokens
                         ('seed', 'updates:+2', 'status:sjres-185-119
                         floor_vote→committee'). This line used to print them, so
                         the page read "Rewritten because seed" — and the Spanish
                         page read the same English token (audit constitution-07).
                         Each token is now a message key; a token this build does
                         not recognize renders nothing at all, and a revision with
                         no recognized token loses the line rather than leaking
                         one. The tokens themselves stay in the data, where they
                         are an audit trail, and stay out of the DOM entirely —
                         the status form carries the raw bill-status enum. */
                      const reasons = revisionReasons(rev.changed_because).map((r) =>
                        t(`moments.updates.reason.${r.key}`, r.values),
                      );
                      return (
                        <li key={rev.id} className="border-t border-line py-3">
                          <p className="text-xs font-bold text-ink-2 tabular-nums">
                            {t('moments.updates.revisionAsOf', { date: fmtDate(rev.as_of_day) })}
                          </p>
                          <p className="mt-1 max-w-read text-sm text-ink">
                            {localeText(rev.text, locale)}
                          </p>
                          {reasons.length > 0 && (
                            <p className="mt-1 max-w-read text-xs text-ink-2">
                              <span className="font-semibold">
                                {t('moments.updates.revisionReasonLabel')}
                              </span>{' '}
                              {reasons.join(' · ')}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </details>
              )}
            </section>
          )}

          {/* 4 · "What's moved" — the dated timeline. The lede carries the client
              sentinel, because a quiet ledger has two possible causes and only
              one of them is Congress's: "nothing moved" is server-rendered from
              the record, "we couldn't check" is the visitor's own clock talking
              (v2 spec §3). */}
          <section aria-labelledby="whats-moved" className="mt-12 border-t border-line pt-4">
            <h2 id="whats-moved" className="text-h2 font-extrabold text-ink">
              {t('moments.updates.timelineHeading')}
            </h2>
            <p className="mt-2 max-w-read text-sm text-ink-2">
              {t('moments.updates.timelineLede', { cap: RENDER_DAY_CAP })}
              <MomentQuietNote checkedAt={freshness.checkedAt} dateLabel={fmtDate(freshness.checkedAt)} />
            </p>
            <MomentTimeline momentId={id} locale={locale} vehicles={timelineVehicles} />
          </section>

          {/* 6 · Why this Moment exists — the column's last section, as the
                 wireframes draw it (v2, 2026-09-29). It sat in the rail under
                 the cards until the rail became the call. */}
          <section className="mt-12 border-t border-line pt-4" aria-labelledby="why-h">
            <h2 id="why-h" className="text-xs leading-tight font-extrabold tracking-[0.1em] text-ink-2 uppercase">
              {t('moments.whyHeading')}
            </h2>
            <p className="mt-3 max-w-note text-sm text-ink-2">{t('moments.whyCriteria')}</p>

            <p className="mt-5 text-sm font-bold text-ink">{t('moments.signalLabel')}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2">
              {/* the signal is a LABEL — an ink mark. The evidence beside it is a
                  set of links, so it is set as links, in the go tone. */}
              <Chip tone="tag">
                {QUALIFYING_SIGNAL_TYPES.includes(moment.qualifying_signal.type)
                  ? t(`moments.signalType.${moment.qualifying_signal.type}`)
                  : moment.qualifying_signal.type}
              </Chip>
              {moment.qualifying_signal.refs.map((ref, i) => (
                <a
                  key={ref}
                  href={ref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${CONTENT_LINK} text-sm`}
                >
                  {t('moments.evidenceLink', { index: i + 1 })}
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              ))}
            </div>

            {/* Hand-curated institutional grounding (v2 spec §5): the CRS / CBO /
                GAO material a reader can check the summaries against. Auto-
                discovery of CRS reports was refuted, so these are added by hand
                when a moment opens and host-allowlisted by the moments gate —
                which is why the row renders only when a moment actually carries
                them, and why nothing is invented to fill it. Ink label, green
                links: the label is a mark, the evidence goes somewhere. */}
            {moment.context_refs && moment.context_refs.length > 0 && (
              <>
                <p className="mt-5 text-sm font-bold text-ink">{t('moments.updates.refsLabel')}</p>
                <ul className="mt-2 max-w-note list-none">
                  {moment.context_refs.map((ref) => (
                    <li
                      key={ref.url}
                      className="flex flex-wrap items-baseline gap-x-3 border-t border-line py-2"
                    >
                      <span className="text-2xs leading-tight font-extrabold tracking-[0.1em] text-ink-2 uppercase">
                        {t(`moments.updates.refKind.${ref.kind}`)}
                      </span>
                      <a
                        href={ref.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`${CONTENT_LINK} text-sm`}
                      >
                        {ref.title ? localeText(ref.title, locale) : linkHost(ref.url)}
                        <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>
      </div>

      {/* 7 · How this page is made, and the lifecycle note — full width below
             the desk, in the order they had inside the "why" section. */}
      <p className="mt-12">
        <Link href="/questions#how" className={`${CONTENT_LINK} text-sm`}>
          {t('moments.howMadeLink')} →
        </Link>
      </p>

      {!isSettled && (
        <p className="mt-5 max-w-read border-t border-line pt-4 text-sm text-ink-2">
          {t('moments.lifecycleLive')}
        </p>
      )}

      {/* 8 · Browse-all affordance (scarcity) */}
      <p className="mt-12 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-line pt-4">
        <Link href="/questions" className={CONTENT_LINK}>
          {t('moments.browseAll')} →
        </Link>
        <span className="text-xs text-ink-2">{t('moments.scarcityNote', { count: liveCount, cap: LIVE_CAP })}</span>
      </p>
    </article>
  );
}
