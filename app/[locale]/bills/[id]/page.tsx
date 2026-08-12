import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { setRequestLocale, getTranslations, getFormatter } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { getPathname, Link } from '@/i18n/navigation';
import { ActionPanel } from '@/components/ActionPanel';
import { BillJourney } from '@/components/BillJourney';
import { CoverageSection } from '@/components/CoverageSection';
import { FloatingCallButton } from '@/components/FloatingCallButton';
import { DecodedSections } from '@/components/DecodedSections';
import { JsonLd } from '@/components/JsonLd';
import { ReadReceipt } from '@/components/ReadReceipt';
import { SharePanel } from '@/components/SharePanel';
import { TldrStrip } from '@/components/TldrStrip';
import { WalkthroughDisclosure } from '@/components/call-walkthrough/WalkthroughDisclosure';
import { Chip, FloorVotePanel, Stamp } from '@/components/system';
import { coverageCheckedAt, coverageTier, getCoverage } from '@/lib/coverage';
import { StalenessNote } from '@/components/StalenessNote';
import { billSlug, getAllBills, getBill, localizeBill } from '@/lib/core';
import { formatCitation } from '@/lib/format';
import { dataAsOfString, getFreshness } from '@/lib/freshness';
import { hreflangAlternates } from '@/lib/hreflang';
import {
  deriveJourney,
  floorCalendarChamber,
  floorPendingChamber,
  liveCallTarget,
  statusKeyFor,
} from '@/lib/journey';
import { buildBillJsonLd } from '@/lib/jsonld';
import { getMomentsForBill } from '@/lib/moments';
import { isSignalFresh } from '@/lib/signal-window';
import { SITE_ORIGIN } from '@/lib/site';

/*
 * THE BILL PAGE — a desk, not a scroll.
 *
 * Two columns, always: a reading column and a "Make your call" rail that
 * sticks across every row of the grid, so the call is on screen at every
 * scroll depth. A single-column bill page got a previous build rejected;
 * this constraint is written down in DESIGN.md and is not a preference.
 *
 * The grid opens IMMEDIATELY under the h1. Everything that describes the
 * bill rather than doing the job — the status tracker, the sync stamp, the
 * official legal title — sits below the reading column or inside a
 * disclosure, so the reading column and the rail both break the first
 * screen instead of starting a thousand pixels down.
 *
 * DATA-GATED LOUDNESS: at most one full-bleed green enamel band, and only
 * when the record itself states one of the two dated floor facts amber is
 * allowed to carry — this bill stands on a floor calendar
 * (`floorCalendarChamber`), or a floor vote on it is still ahead
 * (`floorPendingChamber`) — with the date of that action, and inside the
 * signal window. Both gates live in lib/journey.ts and both are stricter than
 * `status === "floor_vote"` on purpose; the amber-gate rationale lives with
 * the functions, and the freshness half with `isSignalFresh`.
 */

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

/** The page's one wrapper. 70rem holds 33rem of reading + a 25rem rail. */
// Was max-w-[70rem] with a clamped gutter, which put this page's content on a
// DIFFERENT left edge from the header and footer at every width — and the
// disagreement flipped sign across the breakpoints (+16px at 1024, −32px at
// 1440). max-w-5xl px-4 is the site rail every other route already sits on,
// and the two-track grid still fits exactly: 1024 − 32 = 992 = 528 + 64 + 400.
const WRAP = 'mx-auto w-full max-w-5xl px-4';

/**
 * WHICH of the two dated floor facts the band is standing on — the same split
 * the homepage crown carries (`FloorFeatureKind` in components/system/
 * FloorVotePanel.tsx). `calendar` is a placement the record printed; `pending`
 * is a floor vote still ahead of the bill.
 */
type FloorFactKind = 'calendar' | 'pending';

/*
 * The band's copy, one key per (fact × chamber) — a table rather than nested
 * ternaries, because there are four sentences now and every one of them is a
 * claim about the record. The gate above decides both coordinates from the
 * record's own sentence; nothing here decides anything, it only looks up copy.
 *
 * The chip keys are EXACTLY the ones the homepage crown looks up (see
 * FLOOR_LABEL_KEYS in app/[locale]/page.tsx), so a bill crowned "Floor vote
 * pending in the Senate" reads the identical sentence one click later. All
 * eight keys exist in EN and ES.
 */
const FLOOR_COPY = {
  calendar: {
    house: {
      chip: 'bill.floor.calendarHouse',
      headline: 'bill.floor.headlineHouse',
      status: 'bills.status.floor_vote',
      meta: 'bill.floor.meta',
    },
    senate: {
      chip: 'bill.floor.calendarSenate',
      headline: 'bill.floor.headlineSenate',
      status: 'bills.status.floor_vote',
      meta: 'bill.floor.meta',
    },
  },
  pending: {
    house: {
      chip: 'bill.floor.pendingHouse',
      headline: 'bill.floor.headlinePendingHouse',
      status: 'bill.floor.statusPending',
      meta: 'bill.floor.metaPending',
    },
    senate: {
      chip: 'bill.floor.pendingSenate',
      headline: 'bill.floor.headlinePendingSenate',
      status: 'bill.floor.statusPending',
      meta: 'bill.floor.metaPending',
    },
  },
} as const;

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
  /*
   * Bill dates arrive as bare `YYYY-MM-DD` — a calendar day, with no time and
   * no zone. `new Date("2026-05-07")` parses that as UTC midnight, so
   * formatting it in the server's local zone renders "May 6" west of
   * Greenwich. That was already wrong for the introduced/last-action lines;
   * it becomes unacceptable inside the amber chip, whose entire licence is
   * that the date beside the claim is correct. UTC in, UTC out.
   */
  const fmtDate = (d: string) =>
    format.dateTime(new Date(d), {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
  const fmtShort = (d: string) =>
    format.dateTime(new Date(d), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  /* The stamp is the SYNC instant, not a calendar day, and it has to read
     identically to `dataAsOfString`'s sentence beside it — so it is formatted
     in the same zone that helper uses (the runtime's), never forced to UTC. */
  const fmtStamp = (iso: string) =>
    format.dateTime(new Date(iso), { year: 'numeric', month: 'short', day: 'numeric' });
  // KTD-1: the one accessor (and one phrasing helper) behind every "as of"
  // claim - no surface reads data/sync-state.json or assembles the stamp.
  const dataAsOf = await dataAsOfString(locale);
  const checkedAt = getFreshness().checkedAt;

  const citation = formatCitation(bill.bill_type, bill.bill_number);
  const displayTitle = bill.ai_headline ?? bill.short_title ?? bill.title;
  const hasDecode = Boolean(bill.ai_summary || bill.ai_sections);
  // The provenance ritual's status fragment, through the label gate — which
  // reads the date as well as the sentence since N3 (see statusLabelKey below).
  const statusKey = statusKeyFor(bill.status, bill.last_action_text, bill.last_action_date);
  // Headlines often already name the bill; don't repeat the citation (same
  // rule the action panel uses for call-log labels).
  const norm = (x: string) => x.toLowerCase().replace(/[.\s]/g, '');
  const shareText = norm(displayTitle).includes(norm(citation))
    ? displayTitle
    : `${citation} — ${displayTitle}`;
  // The reading-history label, built by the SAME rule (and the same middot)
  // ActionPanel uses for call-log labels — the civic record prints read
  // rows directly above call rows, and two labelling idioms in one list
  // would read as two different products.
  //
  // BOTH locales' labels, at render time (2026-08-04 walkthrough P1:
  // /es/record printed stored English titles verbatim). The record lives
  // only in localStorage, so the locale it will one day be READ in is
  // unknowable at write time — capture both here, where the counterpart
  // corpus is already on disk, rather than ever resolving labels over the
  // network from a page whose contents are private to the device.
  const recordLabelFor = (l: string) => {
    const b = localizeBill(raw, l);
    const dt = b.ai_headline ?? b.short_title ?? b.title;
    return norm(dt).includes(norm(citation)) ? dt : `${citation} · ${dt}`;
  };
  const recordLabels = { en: recordLabelFor('en'), es: recordLabelFor('es') };
  const recordLabel = recordLabelFor(locale);
  // Canonical, slug-only share URL: no query params, no stance, no
  // locale-tracking params. The origin lives in lib/site.ts (rename in flight).
  const shareUrl = `${SITE_ORIGIN}${getPathname({ locale, href: `/bills/${id}` })}`;

  // Article (+ FAQPage when the decode structure supports it) — lib/jsonld.ts.
  const jsonLd = await buildBillJsonLd(bill, locale, id);

  /*
   * The one loud band, or nothing at all. THREE halves of the gate, and every
   * one of them is load-bearing: one of the record's own FLOOR facts earns the
   * claim, the date earns the amber, and `isSignalFresh` earns the present
   * tense.
   *
   * The freshness half was missing until 2026-08-09, and it was the whole of
   * that defect. The band asserts "This bill is queued for a vote of the full
   * Senate" — a claim about right now — over placements of literally unlimited
   * age: /en/bills/s-1776-118 rendered it, with an amber chip, off a
   * 118th-Congress placement dated 2024-09-24, for a Congress that has since
   * ended. 261 of the corpus's 313 dated calendar placements sit outside the
   * 14-day window, so the loudest surface on the page was mostly making a
   * claim its own date refuted. Same lib the homepage crown gates on
   * (lib/signal-window.ts → lib/urgency.mjs), so the two surfaces cannot
   * disagree about what "now" means; the window's rationale lives with
   * isSignalFresh itself.
   *
   * WHICH FACT — the second half of the 2026-08-09 owner ruling, which this
   * page had not yet been given (2026-08-11). Amber may carry either of two
   * dated floor facts: a calendar PLACEMENT, or a floor vote still PENDING
   * (cloture filed, motion to proceed made, proceedings postponed, a rule
   * reported — the fail-closed allow-list in lib/journey.ts). The homepage
   * crown reads both (`selectFloorVoteFeature`); this page read only the
   * first, so a bill the homepage crowned "Floor vote pending in the Senate"
   * lost the band, the amber and the claim one click later and printed the
   * weaker "Floor activity" over the identical record — the promise
   * evaporating between two surfaces reading the same row. H.R. 3633's Senate
   * cloture motion of 2026-08-08 is today's live example.
   *
   * The two facts are mutually exclusive by construction (FLOOR_SETTLED is
   * floorPendingChamber's rule 0, and a placement is checked first anyway), so
   * this is still ONE band carrying ONE dated fact — never two.
   *
   * An aged or settled record falls to the page's ordinary paper state, which
   * is the honest result and needs no new copy.
   */
  const floorFresh = Boolean(
    bill.status === 'floor_vote' && bill.last_action_date && isSignalFresh(bill.last_action_date)
  );
  const calendarChamber = floorFresh ? floorCalendarChamber(bill.last_action_text) : null;
  // Only asked when there is no placement: a placement is the stronger,
  // plainer claim and wins the tie, exactly as it does in the crown's ranking.
  const pendingChamber =
    floorFresh && !calendarChamber ? floorPendingChamber(bill.last_action_text) : null;
  const floorChamber = calendarChamber ?? pendingChamber;
  const floorKind: FloorFactKind = calendarChamber ? 'calendar' : 'pending';
  const floorCopy = floorChamber ? FLOOR_COPY[floorKind][floorChamber] : null;

  /*
   * THE STATUS LABEL — this page's refinement on top of the shared gate.
   *
   * WHAT MOVED (N3, owner ruling 2026-08-11). Half of what this comment used
   * to justify now lives in `statusKeyFor` itself. That function took a status
   * and an action text and NO CLOCK, so it could say "this record is a
   * placement" but never "and that is still true today" — and it printed the
   * present-tense "On the floor calendar" on 305 of the corpus's 322 dated
   * placements whose own record had shown nothing for a median of 140 days.
   * It now takes `last_action_date` and answers a third key,
   * `floor_vote_stale` ("Placed on the calendar"): the same specific fact, in
   * the tense the date supports. Every surface gets that, not just this page.
   *
   * WHAT STAYS HERE, AND WHY. The floor-COPY table above (`FLOOR_COPY`) is a
   * different and stronger claim than a status key: it names a chamber and,
   * in the `pending` case, asserts that a vote is still ahead — a sentence
   * assembled from `floorPendingChamber`'s allow-list, which the shared gate
   * deliberately does not read (a status label is a category; the allow-list
   * is a claim about what happens next). So the page still prints its own
   * stronger label when the fresh floor gate found one, and falls back to the
   * shared key otherwise.
   *
   * The consequence, stated rather than hidden: /bills and the embeds print
   * "Floor activity" for a fresh PENDING bill while this page prints "Floor
   * vote pending". Both are true of the same record; this one is simply the
   * stronger of the two, and it is the one the crown promised. The placement
   * case no longer diverges at all — both surfaces now read the same clock.
   */
  const statusLabelKey = floorCopy ? floorCopy.status : `bills.status.${statusKey}`;

  // The bigger question this bill is a vehicle of, if any — live and stale
  // moments only (lib/moments.ts owns that rule). Read-time, off the same
  // list /questions reads; on the overwhelming majority of bills this is empty
  // and the header renders exactly as it did before.
  const parentMoments = getMomentsForBill(id);

  return (
    <>
      <JsonLd id="bill-jsonld" data={jsonLd} />

      <div className={WRAP}>
        <p className="pt-3">
          <Link
            href="/bills"
            className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-go visited:text-go-deep hover:text-go-deep hover:underline"
          >
            <ArrowLeft className="h-4 w-4 flex-none" aria-hidden />
            {t('bill.allBills')}
          </Link>
        </p>

        {/* NOTE — the reference mockup also runs the "your five minutes"
            gauge here, above the h1. It is deliberately NOT on this page.
            Measured at 1440x900 against live data: it costs 92px of the
            first screen, and on a bill carrying the green band that pushed
            the call rail's top to y=860 against a 900px fold — 40px of a
            358px panel. Without it the rail lands at ~768 (the same number
            the reference measured for itself) and on a quiet bill at ~540.
            The first screen is the product, the gauge repeats a promise the
            homepage already makes, and the primitive has no responsive
            label mode, so four labels on a 358px phone track truncate to
            nothing. If it comes back, it belongs BELOW the h1. */}

        {/* BILL HEADER. Tight by design: the plain-language claim is the
            headline, the designation captions it, the AI label sits with the
            content it labels (above the fold at 390px), and 27 words of
            statute-speak that no first-time caller reads before deciding are
            folded into a disclosure. */}
        <header className="pt-6 pb-4">
          <h1 className="max-w-[24ch] text-h1-bill font-extrabold text-ink">{displayTitle}</h1>
          {/* THE PROVENANCE RITUAL (2026-08 design pick C1): one utility
              voice for ALL metadata, same order every page — bill ·
              congress · status · latest action · the AI label. The stamp
              voice extended, no new font. The old
              AI chip's whole sentence rides here VERBATIM in its own span:
              funnel invariant I1 pins `bill.aiLabel` on this page, and this
              position is first-contact, above the fold at 390px. Status
              routes through statusKeyFor — the label can never outrun the
              record — except where the fresh floor gate above has already
              read a stronger, dated fact out of that same record, in which
              case it prints THAT (see statusLabelKey). */}
          <p className="mt-3 max-w-read border-t-[3px] border-ink pt-2 text-2xs font-extrabold tracking-[0.14em] text-ink-2 uppercase">
            <span className="tabular-nums">{citation}</span>
            <span aria-hidden> · </span>
            <span>{t('bill.congressLabel', { congress: bill.congress_number })}</span>
            <span aria-hidden> · </span>
            <span>{t(statusLabelKey)}</span>
            {bill.last_action_date && (
              <>
                <span aria-hidden> · </span>
                <span className="tabular-nums">
                  {t('bill.lastAction')} {fmtShort(bill.last_action_date)}
                </span>
              </>
            )}
            {hasDecode && (
              <>
                <span aria-hidden> · </span>
                <span>{t('bill.aiLabel')}</span>
              </>
            )}
          </p>
          {bill.short_title && (
            <p className="mt-2 text-sm text-ink-2">{`“${bill.short_title}”`}</p>
          )}
          {(bill.issue_tags ?? []).length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {(bill.issue_tags ?? []).slice(0, 2).map((tag) => (
                <Chip key={tag} tone="tag">
                  {t(`categories.${tag}`)}
                </Chip>
              ))}
            </div>
          )}
          {/* PART OF A BIGGER QUESTION (repositioning spec §7.2). Until now
              a bill page said nothing about the Moment it is a vehicle of —
              the link existed in one direction only. It lands here, after
              the chips and above the statute-speak, because it is context
              for the claim in the h1, not a task.
              Quiet on purpose: a hairline rule and an ink link, never green.
              Green is the call, and this page already spends its one green
              affordance on the rail; a second one competing for the eye
              would make the reader choose between reading and calling. */}
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
          <details className="group mt-4 max-w-read">
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold text-ink hover:text-go-deep [&::-webkit-details-marker]:hidden">
              <span
                aria-hidden
                className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-stamp border-[1.5px] border-ink text-xs font-extrabold leading-none"
              >
                <span className="group-open:hidden">+</span>
                <span className="hidden group-open:inline">{'–'}</span>
              </span>
              {t('bill.officialDisclosure')}
            </summary>
            <div className="space-y-2 pb-2 text-sm text-ink-2">
              <p>
                <b className="font-semibold text-ink">{t('bill.officialTitle')}:</b> {bill.title}
              </p>
              {bill.introduced_date && (
                <p className="tabular-nums">
                  <b className="font-semibold text-ink">{t('bill.introduced')}:</b>{' '}
                  <time dateTime={bill.introduced_date}>{fmtDate(bill.introduced_date)}</time>
                </p>
              )}
              {bill.congress_gov_url && (
                <a
                  href={bill.congress_gov_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-go underline visited:text-go-deep hover:text-go-deep"
                >
                  {t('bill.viewOfficial')}
                  <ExternalLink className="h-4 w-4 flex-none" aria-hidden />
                </a>
              )}
            </div>
          </details>
        </header>
      </div>

      {/* THE ONE LOUD, DATA-GATED BAND. Full-bleed, so it is a direct child
          of the full-width main and NOT of the max-width wrapper. It sits
          under the h1 rather than over it so the outline still opens on the
          bill's own name. With no fresh dated floor fact — a placement OR a
          pending vote — this element does not exist and the page is all
          paper. Still exactly one band, and it prints whichever of the two
          facts the gate above actually read. */}
      {floorCopy && bill.last_action_date && (
        <FloorVotePanel
          status={bill.status}
          dateLabel={fmtShort(bill.last_action_date)}
          calendarLabel={t(floorCopy.chip)}
          identifier={citation}
          headline={t(floorCopy.headline)}
          href="#act"
          ctaLabel={t('bill.floor.cta')}
          meta={t(floorCopy.meta)}
        />
      )}

      <div className={`${WRAP} pb-16`}>
        {/* THE DESK: reading column + call rail. The rail spans every row, so
            a sticky item is not confined to row 1 and holds to the page foot. */}
        <div className="grid max-w-read gap-8 pt-6 min-[62rem]:max-w-none min-[62rem]:grid-cols-[minmax(0,var(--measure-read))_minmax(20rem,25rem)] min-[62rem]:items-start min-[62rem]:justify-between min-[62rem]:gap-x-[clamp(2rem,4vw,4rem)] min-[62rem]:gap-y-8">
          <section
            aria-labelledby="decoded"
            className="min-w-0 min-[62rem]:col-start-1 min-[62rem]:row-start-1"
          >
            {/* Records this bill in the visitor's own reading history
                (localStorage, this device only). Renders no markup — see
                components/ReadReceipt.tsx. */}
            <ReadReceipt slug={id} label={recordLabel} labels={recordLabels} />
            <div className="border-t-[3px] border-ink pt-4">
              <h2 id="decoded" className="text-h2 font-extrabold text-ink">
                {t('bill.decoded')}
              </h2>
            </div>
            {hasDecode ? (
              <>
                <p className="mt-3 text-sm text-ink-2">{t('bill.aiLede')}</p>
                <TldrStrip bill={bill} />
                <DecodedSections bill={bill} />
                <p className="mt-6 text-sm text-ink-2">
                  {t('bill.aiDisclaimer')}
                  {bill.congress_gov_url && (
                    <>
                      {' '}
                      <a
                        href={bill.congress_gov_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-go underline visited:text-go-deep hover:text-go-deep"
                      >
                        {t('bill.viewOfficial')}
                      </a>
                    </>
                  )}
                </p>
              </>
            ) : (
              <p className="mt-3 text-ink-2">{t('bills.decodedPending')}</p>
            )}
          </section>

          {/* THE CALL RAIL. Sticky across every row on the desk; in flow, in
              the read → pick → edit → call order, below it. */}
          <div className="min-w-0 min-[62rem]:sticky min-[62rem]:top-4 min-[62rem]:col-start-2 min-[62rem]:row-span-full min-[62rem]:flex min-[62rem]:max-h-[calc(100dvh-2rem)] min-[62rem]:self-start">
            <ActionPanel
              slug={id}
              identifier={citation}
              title={bill.ai_headline ?? bill.short_title ?? bill.title}
              recordLabels={recordLabels}
              liveTarget={liveCallTarget(bill)}
            />
          </div>

          {/* THE STATUS TRACKER, below the reading column: it describes the
              bill's history, and the decode and the call are the job. The
              stamp straddles its closing rule and certifies the dates inside
              it — and it is the only place the sync date is printed. */}
          <section aria-labelledby="journey-h" className="relative min-[62rem]:col-start-1">
            <h2 id="journey-h" className="text-h3 font-extrabold text-ink">
              {t('bill.sec.journey')}
            </h2>
            <div
              role="group"
              aria-label={t('bill.trackerLabel')}
              className="mt-4 rounded-control border-2 border-ink px-4 pt-4 pb-12"
            >
              <BillJourney
                journey={deriveJourney(bill)}
                billType={bill.bill_type}
                introducedLabel={bill.introduced_date ? fmtShort(bill.introduced_date) : undefined}
                currentLabel={
                  bill.last_action_date ? fmtShort(bill.last_action_date) : undefined
                }
              />
              {bill.last_action_date && (
                <p className="mt-3 max-w-note text-sm text-ink-2">
                  <span className="font-semibold text-ink">{t('bill.lastAction')}:</span>{' '}
                  <time dateTime={bill.last_action_date} className="tabular-nums">
                    {fmtDate(bill.last_action_date)}
                  </time>
                  {bill.last_action_text && <>{` — ${bill.last_action_text}`}</>}
                  {/* R2: this page urges a call — the staleness caveat
                      continues the tracker's own sentence, client-side. */}
                  <StalenessNote checkedAt={checkedAt} />
                </p>
              )}
            </div>
            <Stamp
              label={t('bill.stampLabel')}
              dateLabel={fmtStamp(checkedAt)}
              srLabel={dataAsOf}
            />
          </section>

          {/* For the hesitant: what a call actually looks like, on demand,
              collapsed so it never displaces the rail. */}
          <div className="min-[62rem]:col-start-1">
            <WalkthroughDisclosure />
          </div>

          {/* Pass the page along — a quiet utility after the whole task. */}
          <div className="min-[62rem]:col-start-1">
            <SharePanel url={shareUrl} text={shareText} />
          </div>
        </div>

        {/* Read — how the bill is being covered (third-party articles + lean).
            `checkedAt` is when the news sweep last LOOKED at this bill, read
            here rather than inside the client component so data/coverage.json
            never reaches the browser. It is a different clock from the "Data
            as of" stamp above (the Congress.gov bill sync) and from the
            article dates below (the press) — three clocks, three labels. */}
        <CoverageSection
          articles={coverage}
          tier={coverageTier(coverage)}
          checkedAt={coverageCheckedAt(id)}
        />
      </div>

      {/* Keeps the call reachable while reading; yields whenever the rail is
          on screen. On the desk that is the whole grid — but the coverage
          section and the footer sit OUTSIDE it, so the rail scrolls away at
          the page foot and this is what carries the call the rest of the way.
          Measured, not assumed: tests/call-action.spec.ts asserts both ends. */}
      <FloatingCallButton />
    </>
  );
}
