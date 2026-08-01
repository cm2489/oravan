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
import { SharePanel } from '@/components/SharePanel';
import { TldrStrip } from '@/components/TldrStrip';
import { WalkthroughDisclosure } from '@/components/call-walkthrough/WalkthroughDisclosure';
import { Chip, FloorVotePanel, Stamp } from '@/components/system';
import { coverageTier, getCoverage } from '@/lib/coverage';
import { StalenessNote } from '@/components/StalenessNote';
import { billSlug, getAllBills, getBill, localizeBill } from '@/lib/core';
import { formatCitation } from '@/lib/format';
import { dataAsOfString, getFreshness } from '@/lib/freshness';
import { hreflangAlternates } from '@/lib/hreflang';
import { buildBillJsonLd } from '@/lib/jsonld';
import { getMomentsForBill } from '@/lib/moments';
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
 * when this bill genuinely stands on a floor calendar with the date it got
 * there. See `floorCalendarChamber` below — the gate is stricter than
 * `status === "floor_vote"` on purpose.
 */

/*
 * Every bill/moment is enumerated by generateStaticParams below, so an id
 * that is not in that list does not exist. Without this, Next serves an
 * unknown slug as a cached 200 carrying the site's own <title> — a soft 404
 * that crawlers index as a real Oravan page. false makes the router 404 it.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return routing.locales.flatMap((locale) =>
    getAllBills().map((b) => ({ locale, id: billSlug(b) }))
  );
}

/*
 * THE AMBER GATE, and why it is narrower than the status field.
 *
 * `status: "floor_vote"` is DERIVED from action text, and the corpus proves
 * the derivation is looser than the claim amber makes. Of the 217 bills
 * carrying `floor_vote` right now, 203 say "Placed on <the Union / the House
 * / Senate Legislative> Calendar" — a real, dated calendar placement. The
 * other 14 do not: five of them read "Motion to proceed to consideration of
 * measure REJECTED in Senate". Printing "On the Senate floor calendar ·
 * Apr 29 2026" over a rejected motion is a false claim, and the color law's
 * "no date, no amber" rule exists to stop exactly this class of lie.
 *
 * So the band renders only when the bill's own last action says, in
 * Congress's words, that it was placed on a calendar — and the chamber is
 * read out of that same sentence rather than guessed from the bill type
 * (a House bill can sit on the Senate Legislative Calendar). Everything
 * else gets a paper page, which is the honest result.
 *
 * `last_action_date` is the PLACEMENT date. Nothing here claims a scheduled
 * vote date; the corpus holds none (see the ⚠️ ruling in DESIGN.md).
 */
function floorCalendarChamber(actionText: string | null): 'house' | 'senate' | null {
  if (!actionText) return null;
  const match = /placed on (?:the )?(senate legislative|union|house|senate)\s+calendar/i.exec(
    actionText
  );
  if (!match) return null;
  return /senate/i.test(match[1]) ? 'senate' : 'house';
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
  // Headlines often already name the bill; don't repeat the citation (same
  // rule the action panel uses for call-log labels).
  const norm = (x: string) => x.toLowerCase().replace(/[.\s]/g, '');
  const shareText = norm(displayTitle).includes(norm(citation))
    ? displayTitle
    : `${citation} — ${displayTitle}`;
  // Canonical, slug-only share URL: no query params, no stance, no
  // locale-tracking params. The origin lives in lib/site.ts (rename in flight).
  const shareUrl = `${SITE_ORIGIN}${getPathname({ locale, href: `/bills/${id}` })}`;

  // Article (+ FAQPage when the decode structure supports it) — lib/jsonld.ts.
  const jsonLd = await buildBillJsonLd(bill, locale, id);

  // The one loud band, or nothing at all. Both halves of the gate are
  // load-bearing: the calendar sentence earns the claim, the date earns the
  // amber. A quiet bill is an unbroken paper column, which is the point.
  const calendarChamber =
    bill.status === 'floor_vote' && bill.last_action_date
      ? floorCalendarChamber(bill.last_action_text)
      : null;

  // The bigger question this bill is a vehicle of, if any — live and stale
  // moments only (lib/moments.ts owns that rule). Read-time, off the same
  // list /moments reads; on the overwhelming majority of bills this is empty
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
          <p className="mt-3 text-sm font-semibold text-ink-2 tabular-nums">
            <span>{citation}</span>
            <span aria-hidden> · </span>
            <span>{t('bill.congressLabel', { congress: bill.congress_number })}</span>
            {bill.short_title && (
              <>
                <span aria-hidden> · </span>
                <span className="font-normal">{`“${bill.short_title}”`}</span>
              </>
            )}
          </p>
          {(hasDecode || (bill.issue_tags ?? []).length > 0) && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {/* AI content is labeled at FIRST contact, never in a footnote. */}
              {hasDecode && (
                <Chip tone="ai" marker={t('bill.aiMarker')}>
                  {t('bill.aiLabel')}
                </Chip>
              )}
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
                    href={`/moments/${m.id}`}
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
          bill's own name. With no dated calendar placement this element does
          not exist and the page is all paper. */}
      {calendarChamber && bill.last_action_date && (
        <FloorVotePanel
          status={bill.status}
          dateLabel={fmtShort(bill.last_action_date)}
          calendarLabel={
            calendarChamber === 'senate'
              ? t('bill.floor.calendarSenate')
              : t('bill.floor.calendarHouse')
          }
          identifier={citation}
          headline={
            calendarChamber === 'senate'
              ? t('bill.floor.headlineSenate')
              : t('bill.floor.headlineHouse')
          }
          href="#act"
          ctaLabel={t('bill.floor.cta')}
          meta={t('bill.floor.meta')}
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
                billType={bill.bill_type}
                status={bill.status}
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

        {/* Read — how the bill is being covered (third-party articles + lean) */}
        <CoverageSection articles={coverage} tier={coverageTier(coverage)} />
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
