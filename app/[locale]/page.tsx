import type { Metadata } from 'next';
import { ArrowRight } from 'lucide-react';
import { setRequestLocale, getFormatter, getTranslations } from 'next-intl/server';
import { Link, getPathname } from '@/i18n/navigation';
import { JsonLd } from '@/components/JsonLd';
import { ZipForm } from '@/components/ZipForm';
import { HomeWalkthroughDisclosure } from '@/components/call-walkthrough/HomeWalkthroughDisclosure';
import { NewsLens } from '@/components/NewsLens';
import { StalenessNote } from '@/components/StalenessNote';
import { UrgencyEmptyState } from '@/components/UrgencyEmptyState';
import { Chip, FloorVotePanel, Gauge, Stamp, selectFloorVoteFeature } from '@/components/system';
import { billSlug, getAllBills, getNewsBills, getTopActions, hasActNow } from '@/lib/core';
import type { Bill } from '@/lib/types';
import { formatCitation } from '@/lib/format';
import { dataAsOfString, getFreshness } from '@/lib/freshness';
import { hreflangAlternates } from '@/lib/hreflang';
import { buildSiteJsonLd } from '@/lib/jsonld';
import { getLiveMoments } from '@/lib/moments';
import { momentDek } from '@/lib/moments-ui';
import { latestUpdateDay } from '@/lib/moment-updates';
import { DONATE_URL, SITE_ORIGIN } from '@/lib/site';

/*
 * THE HOME SURFACE — hero C, the truth-first flip (owner decisions of record,
 * 2026-07-31; spec docs/ideation/2026-07-26-truth-first-repositioning.md §0).
 *
 * The arc is UNDERSTAND -> ACT -> TRUST -> SUPPORT. Understanding is the front
 * door; the call is the natural next step, demoted but never buried. Four
 * things on this page are load-bearing and must survive any future edit:
 *
 * 1. ONE GREEN SLAB, and it is the FloorVotePanel. Green is the page's only
 *    DATA-EARNED shape change: on a quiet week the panel does not render and
 *    no green ground exists anywhere. The hero, the act zone, privacy and the
 *    support band are all ruled paper and none of them may take a ground of
 *    their own — a shape change that happens for four reasons carries no data.
 *
 *    The Big Questions band is the ONE sanctioned exception (owner,
 *    2026-07-24) and it is deliberately INK, not green: it needed weight, and
 *    ink buys weight without spending a colour the data gate governs. THE
 *    2026-07-31 FLIP MOVED IT ABOVE THE WEEK and changed nothing about that
 *    law: the colour law governs how many grounds a page has and what earns
 *    green, never their order. So the page still has two full-bleed grounds,
 *    still exactly one green one, and green still means only ever "a vote is
 *    on the calendar." (The site footer is the page's back cover and is exempt.)
 *
 * 2. EXACTLY ONE BILL takes that panel, chosen by selectFloorVoteFeature().
 *    The corpus is HOT — every bill in this week's shortlist currently
 *    carries `floor_vote` — so the cap is the entire mechanism. Everything
 *    else in the week is a plain ruled listing.
 *
 * 3. EVERY CALLABLE BILL LINK stays inside section[aria-labelledby=
 *    "top-actions"]. The funnel and freshness specs both read that boundary,
 *    and the panel carries a bill link — which is why that section is
 *    full-width with the max-width wrapper INSIDE it. The id is frozen; only
 *    the heading copy moved ("Worth a call this week" -> "Moving in Congress
 *    this week"), because the section stopped being an assignment.
 *
 * 4. THE GO-MARK STILL APPEARS TWICE, BOTH TIMES MEASURING. The 2026-07-31
 *    fork: a pure truth h1 has no measured promise in it and would have cost
 *    the hero stroke its meaning. Hero C's SECOND BEAT — "Then make it count."
 *    — is still the measured promise, so the stroke survives legitimately
 *    under that clause, and the route gauge in the act zone is the other.
 *
 * The act zone (section[aria-labelledby="act-zone"]) is where the call
 * apparatus was consolidated: one titled zone opened by the 3px ink rule,
 * with the route, the walkthrough, the transcript and the why-call teaser as
 * its hairline-ruled body — instead of four call sections scattered down the
 * page. "Natural next step" made literal in the page structure.
 */

/** The five minutes, in seconds. The gauge is drawn from these numbers, so
 *  the drawing can never disagree with the durations printed beside it. */
const ROUTE = [
  { key: 1, seconds: 30 },
  { key: 2, seconds: 60 },
  { key: 3, seconds: 60 },
  { key: 4, seconds: 150 },
] as const;
const ROUTE_TOTAL = ROUTE.reduce((sum, leg) => sum + leg.seconds, 0); // 300

// Homepage had zero metadata override before this pass — no canonical, no
// hreflang alternates — so every locale's title/description fell through to
// the root layout's generic default, silently, and only the bill detail page
// (PR #30) had any alternates at all. Returning only `alternates` here lets
// the layout's title/description keep flowing through unchanged.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  // S21: the "what moved this week" feed (lib/core/feed.ts) mirrors this
  // page's own "Act now" section, so the RSS discovery link lives here —
  // one <link rel="alternate" type="application/rss+xml"> per locale,
  // pointing at that locale's own static feed route
  // (app/feed/whats-moving.xml or app/es/feed/whats-moving.xml).
  const feedPath = locale === 'es' ? '/es/feed/whats-moving.xml' : '/feed/whats-moving.xml';
  return {
    alternates: {
      ...hreflangAlternates(locale, '/'),
      types: { 'application/rss+xml': `${SITE_ORIGIN}${feedPath}` },
    },
  };
}

/*
 * THE DECODED SPECIMEN — the product's core move shown, not told: one clause
 * of a real bill's official text, then its plain-words decode, AI-labeled.
 * It replaced the phone transcript in the hero on 2026-07-31, because the
 * transcript answered a fear the visitor has not been given a reason to feel
 * yet; it now sits in the act zone, immediately before the ask.
 *
 * REAL CORPUS DATA, NEVER FICTION. It renders only when the chosen bill
 * actually carries a decode, so a corpus that has not been decoded yet shows
 * nothing here rather than an invented example.
 */
async function SpecimenAside({ bill }: { bill: Bill }) {
  const t = await getTranslations('home');
  const official = bill.title.length > 180 ? `${bill.title.slice(0, 180)}…` : bill.title;
  return (
    <aside
      className="min-w-0 overflow-hidden rounded-control border-2 border-ink"
      aria-labelledby="specimen-title"
    >
      <h2
        id="specimen-title"
        className="bg-ink-deep px-5 py-3 text-xs font-bold tracking-[0.06em] text-paper uppercase leading-tight"
      >
        {t('specimenTitle')}
      </h2>
      <div className="p-4 md:p-6">
        <p className="text-2xs font-extrabold tracking-[0.1em] text-ink-2 uppercase">
          {t('specimenOfficial')} · {formatCitation(bill.bill_type, bill.bill_number)}
        </p>
        <p className="mt-2 rounded-control p-3 font-reading text-base text-ink-2">{official}</p>
        <p className="mt-4 border-t-[1.5px] border-line pt-4 text-2xs font-extrabold tracking-[0.1em] text-ink-2 uppercase">
          {t('specimenPlain')}
        </p>
        {/* `tint` means DECODED-FOR-YOU here, the same way it means "your own
            words" in the transcript: the plain-words half of the pair. */}
        <p className="mt-2 rounded-control bg-tint p-3 font-reading text-lg text-ink">
          {bill.ai_headline}
        </p>
        <p className="mt-3">
          <Chip tone="ai" marker={t('aiMarker')}>
            {t('aiReviewed')}
          </Chip>
        </p>
        <Link
          href={`/bills/${billSlug(bill)}`}
          className="mt-4 inline-flex min-h-11 items-center gap-1.5 font-semibold text-go underline underline-offset-4 hover:text-go-deep"
        >
          {t('specimenCta')}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </aside>
  );
}

/*
 * The relocated phone transcript — the fear, named and answered, immediately
 * before the ask instead of before the reading. Same keys, new position and
 * new form: a native <details> disclosure (mobile-density pass), because a
 * three-turn transcript was ~800px of every phone scroll on the way to
 * something the visitor had not asked for yet. The heading id is unchanged.
 */
async function TranscriptDisclosure() {
  const t = await getTranslations('home');
  return (
    <details className="min-w-0 max-w-xl overflow-hidden rounded-control border-2 border-ink">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <h2 id="call-demo-title" className="text-lg font-extrabold">
          {t('demoTitle')}
        </h2>
        <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
      </summary>
      <div className="border-t-[1.5px] border-line-strong p-4 md:p-6">
        <p className="rounded-control p-3 font-reading text-lg text-ink-2">
          <b className="font-sans font-bold text-ink">{t('demoStafferLabel')}</b>{' '}
          {t('demoStafferOpen')}
        </p>
        {/* `tint` means YOURS — the caller's own words. */}
        <p className="mt-2 rounded-control bg-tint p-3 font-reading text-lg text-ink">
          <b className="font-sans font-bold text-go-deep">{t('demoYouLabel')}</b>{' '}
          {t('demoYouLine')}
        </p>
        <p className="mt-2 rounded-control p-3 font-reading text-lg text-ink-2">
          <b className="font-sans font-bold text-ink">{t('demoStafferLabel')}</b>{' '}
          {t('demoStafferClose')}
        </p>
        <p className="mt-4 max-w-note border-t-[1.5px] border-line pt-4 text-sm text-ink-2">
          <strong className="font-semibold text-ink">{t('demoNoteLead')}</strong> {t('demoNote')}
        </p>
      </div>
    </details>
  );
}

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('home');
  const tShared = await getTranslations();
  const format = await getFormatter();
  const top = getTopActions(4, locale);
  const news = getNewsBills(locale, 6);
  const total = getAllBills().length;
  const freshness = getFreshness();
  const dataAsOf = await dataAsOfString(locale);
  // AE3: the quiet-week claim keys on the floor alone. In the rare state
  // where a bill clears the floor but isn't decoded yet, the shortlist is
  // empty AND the week is not quiet — render neither cards nor a false
  // claim; /bills (linked in this section) shows it under "Act now".
  const quiet = !hasActNow();
  const jsonLd = await buildSiteJsonLd(locale);
  // The Big Questions band (data + code still say `moment` — the label
  // changed on 2026-07-31, the route and the internal names did not; spec
  // §0.2). Only renders when a live entry exists, so a quiet week shows
  // nothing rather than a band faking fullness.
  const liveMoments = getLiveMoments();

  // DATA-GATED LOUDNESS. One call, at the data layer, so the cap-to-one can
  // never be broken by a component that cannot see its siblings. `feature`
  // is null on a week with no floor-calendar bill — and then the page is an
  // unbroken paper column, which is the point.
  const feature = selectFloorVoteFeature(top);
  const listed = top.filter((b) => b !== feature);

  // The hero's specimen keys on the same bill the week's panel features, so
  // the front door's example and its headline act are the same fact. Falls
  // back through the week's shortlist and then the news lens; a bill with no
  // decode is never shown as a decode.
  const specimenBill = feature ?? top[0] ?? news[0] ?? null;
  const specimen = specimenBill?.ai_headline ? specimenBill : null;

  /*
   * A bill's own calendar date, e.g. "Jul 20, 2026" / "20 jul 2026".
   *
   * PINNED TO UTC ON PURPOSE. `last_action_date` is a bare `YYYY-MM-DD`, so
   * `new Date()` reads it as UTC midnight — formatted in any negative-offset
   * zone it prints the DAY BEFORE (verified: 2026-07-20 rendered "Jul 19,
   * 2026" on an America/New_York build machine). Amber is only legal with a
   * TRUE printed date, and a listing's "last action" is a claim about a real
   * day, so both are formatted in UTC and never drift with the builder's
   * clock.
   */
  const billDate = (iso: string) =>
    format.dateTime(new Date(iso), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });

  /*
   * The stamp's date. Deliberately NOT pinned to UTC: its screen-reader
   * sentence is dataAsOfString(), which goes through the shared formatter,
   * and a visible date that disagreed with its own accessible name by a day
   * would be worse than either convention. `checkedAt` is a full timestamp,
   * not a bare date, so it does not have the midnight problem above.
   */
  const stampDate = format.dateTime(new Date(freshness.checkedAt), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <div>
      <JsonLd id="site-jsonld" data={jsonLd} />

      {/* ---------------------------------------------------------------
          HERO — the truth promise on the left, the product's core move shown
          on the right. Paper, not a dark slab: the only ground change on this
          page belongs to the green panel below.
          --------------------------------------------------------------- */}
      <div className="mx-auto max-w-5xl px-4 pt-5 pb-6 md:pt-16 md:pb-12">
        <div className="grid gap-8 md:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] md:items-start md:gap-16">
          <div className="min-w-0">
            {/* THE GO-MARK AS A STROKE: the same 6px bar at the same 3px cap
                the route gauge is built from, drawn under the SECOND BEAT —
                because that clause is the thing being measured. The first
                beat is the truth promise and takes no mark. It is a
                pseudo-element, never the <Gauge> component. */}
            {/* One step below the --text-h1 floor under 360px, and only
                there. MEASURED: the stroked beat cannot wrap (the bar has to
                be one continuous mark), and the Spanish clause "Luego haz que
                cuente." sets 330px at the 32px floor — 42px past the 288px
                content box of a 320px screen, which is a WCAG 1.4.10 reflow
                failure, not a taste call. At 26px it sets 268px. English
                fits at either size; this fires for both so the two locales
                cannot drift apart typographically. */}
            <h1 className="max-w-[18ch] text-h1 font-extrabold max-[22.5rem]:text-[1.625rem]">
              {t('heroTitle')}{' '}
              <span className="relative inline-block whitespace-nowrap after:absolute after:right-[0.08em] after:bottom-[-0.12em] after:left-[0.02em] after:h-[6px] after:rounded-stamp after:bg-go after:content-['']">
                {t('heroTitleGo')}
              </span>
            </h1>

            <p className="mt-6 max-w-read text-lede text-ink-2">{t('heroSub')}</p>

            {/* AI at first contact: the decoded words are this page's whole
                content, so the label sits with the promise, above the fold. */}
            <p className="mt-5 max-w-[44ch]">
              <Chip tone="ai" marker={t('aiMarker')}>
                {t('heroAi')}
              </Chip>
            </p>

            {/* THE PROMOTED PRIMARY (2026-07-31): straight to what is moving.
                Understanding is the front door, so the filled control is the
                one that leads to reading — not the one that asks for a ZIP.
                Same-page jump, no navigation. */}
            <a
              href="#top-actions"
              className="ring-gap mt-6 inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-go bg-go px-6 py-3 font-bold text-paper no-underline hover:border-go-deep hover:bg-go-deep"
            >
              {t('heroJump')}
              <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
            </a>

            {/* ZIP demoted BY POSITION, not by removal — every key untouched
                (they are shared with the bill-page dialog and the embed
                widget). It stays in the hero and stays page-wide-locatable,
                which is what keeps the ZIP-first funnel invariant true at the
                same click count. */}
            <div className="mt-8 border-t-[1.5px] border-line pt-6">
              <ZipForm />
            </div>

            {/* Thumb-reachable language switch (2026-07 critique round 2):
                the header pill sits in the least reachable corner on mobile,
                and the one control a Spanish-dominant visitor needs most
                shouldn't. The link text is in the TARGET language — the EN
                page says "Ver en español" — hence lang/hreflang on the link,
                not the page. Complements the header pill, never replaces it. */}
            <p className="mt-4 max-w-note text-sm">
              <Link
                href="/"
                locale={locale === 'es' ? 'en' : 'es'}
                lang={locale === 'es' ? 'en' : 'es'}
                hrefLang={locale === 'es' ? 'en' : 'es'}
                className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-go underline underline-offset-4 hover:text-go-deep"
              >
                {t('heroLocaleLink')}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </p>
          </div>

          {specimen && <SpecimenAside bill={specimen} />}
        </div>
      </div>

      {/* ---------------------------------------------------------------
          BIG QUESTIONS — the dominant truth band, and since 2026-07-31 it
          sits ABOVE the week. The 2026-07-24 ruling ("discovery sits UNDER
          the week: you look for a subject after you have seen what is
          actually moving") was reversed by the truth-first decision: the
          front door now leads with the question a visitor already arrived
          holding, and the week is what that question turns into. It
          disappears entirely when nothing reads as live, and then the truth
          claim survives in the hero — carried by copy, not by a band faking
          fullness.

          DARK ENAMEL, NOT GREEN (owner, 2026-07-24, unchanged by the flip).
          It read as an afterthought as ruled paper, so it needed real weight.
          Green was the obvious way to give it that and is the wrong one:
          green here would fire every week regardless of data, and the whole
          point of the green panel below is that it only appears when a vote
          is actually on the calendar. Ink enamel buys the weight and spends
          no green, so the page still has exactly ONE green slab and it is
          still data-earned.

          The scarcity line rides with the promotion: at the front door,
          "never more than 6" IS the credibility claim — it is the visible
          proof that someone said no. */}
      {liveMoments.length > 0 && (
        <section
          className="on-dark mt-2 border-y-[3px] border-line-strong bg-ink-deep py-8 text-paper md:py-14"
          aria-labelledby="moments-strip-title"
        >
          <div className="mx-auto max-w-5xl px-4">
            <div className="flex flex-wrap items-baseline justify-between gap-4">
              <h2 id="moments-strip-title" className="text-h2 font-extrabold text-paper">
                {t('momentsTitle')}
              </h2>
              <Link
                href="/moments"
                className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-go-bright underline underline-offset-4 hover:text-paper"
              >
                {t('momentsCta')}
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>
            <p className="mt-1 max-w-note text-sm text-ink-pale">{t('momentsSub')}</p>
            {/* The dek under each entry is AI-drafted summary text. /moments
                labels it; this band did not, so the same sentences appeared
                labeled on one surface and unlabeled on the front door. */}
            <p className="mt-3 max-w-note text-2xs font-bold tracking-[0.06em] text-ink-pale uppercase">
              {tShared('moments.aiNote')}
            </p>
            <ul className="mt-6 list-none border-t-[1.5px] border-line-strong">
              {liveMoments.map((m) => (
                <li key={m.id} className="border-b-[1.5px] border-line-strong">
                  <Link
                    href={`/moments/${m.id}`}
                    className="flex min-h-11 flex-wrap items-baseline gap-x-3 gap-y-1 py-5 text-paper no-underline hover:underline hover:decoration-go-bright hover:decoration-[3px]"
                  >
                    <span className="text-lg font-bold">
                      {locale === 'es' ? m.name.es : m.name.en}
                    </span>
                    <span className="max-w-note text-sm text-ink-pale">
                      {momentDek(locale === 'es' ? m.summary.es : m.summary.en)}
                    </span>
                    {/* Live-layer recency (v2 slice S5): only when a recorded
                        update exists — never a synthesized date. ink-pale on
                        ink-deep is 10.82:1. */}
                    {latestUpdateDay(m.id) && (
                      <span className="text-xs font-semibold text-ink-pale tabular-nums">
                        {t('momentsUpdated', {
                          date: billDate(latestUpdateDay(m.id) as string),
                        })}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
            {/* True live count, never the stored total: the file also holds
                settled and stale entries, and the claim is about today. */}
            <p className="mt-4 text-sm font-semibold text-ink-pale">
              {tShared('moments.scarcityNote', { count: liveMoments.length })}
            </p>
          </div>
        </section>
      )}

      {/* ---------------------------------------------------------------
          THE WEEK. Full-width by construction: the green panel is full-bleed
          and it MUST stay inside this section (the funnel + freshness specs
          read this boundary), so the max-width wrapper is inside, around the
          section's other children. The id `top-actions` is frozen.
          --------------------------------------------------------------- */}
      <section aria-labelledby="top-actions">
        <div className="mx-auto max-w-5xl px-4 pt-8 md:pt-16">
          <div className="border-t-[3px] border-ink pt-4">
            <h2 id="top-actions" className="text-h2 font-extrabold">
              {t('topTitle')}
            </h2>
          </div>
          <p className="mt-2 max-w-note text-ink-2">{t('topSub')}</p>
        </div>

        {/* EXACTLY ONE. The panel gates itself on floor_vote + a printed date;
            selectFloorVoteFeature() above holds the cap. The date printed is
            the calendar-PLACEMENT date the corpus actually holds — no bill in
            data/bills.json carries a forward-looking scheduled-vote date, so
            no mark here claims one. */}
        {feature?.last_action_date && (
          <FloorVotePanel
            className="mt-6"
            headingLevel={3}
            status={feature.status}
            dateLabel={billDate(feature.last_action_date)}
            calendarLabel={t('floorCalendar')}
            identifier={formatCitation(feature.bill_type, feature.bill_number)}
            headline={feature.ai_headline ?? feature.short_title ?? feature.title}
            href={getPathname({ locale, href: `/bills/${billSlug(feature)}` })}
            ctaLabel={t('floorCta')}
            meta={
              <>
                {feature.issue_tags?.[0] && (
                  <Chip tone="tag" ground="go">
                    {tShared(`categories.${feature.issue_tags[0]}`)}
                  </Chip>
                )}
                <Chip tone="ai" ground="go" marker={t('aiMarker')}>
                  {t('aiReviewed')}
                </Chip>
              </>
            }
          />
        )}

        <div className="mx-auto max-w-5xl px-4">
          {/* The rest of the week is a plain ruled listing, not a card. Two
              reasons, the same reason twice: a bordered box indents its own
              content by border + padding, which would put these headlines
              ~33px right of the green panel's headline directly above — two
              items in one list on two different left edges. And "listed
              plainly" is what the note below promises, so the distance
              between the panel and these rows is the whole distance between
              scheduled and not. */}
          {listed.length > 0 && (
            <div className="mt-6 border-t-[1.5px] border-line-strong">
              {/* These headlines are `ai_headline` — decoded text. The hero's
                  AI chip is scoped to "the bill and the script" and the panel
                  above carries its own, so without this the only unlabeled
                  AI content on the page was the part that reads most like
                  editorial copy. The label sits with the content, per DESIGN.md. */}
              <p className="pt-4">
                <Chip tone="ai" marker={t('aiMarker')}>
                  {t('aiReviewed')}
                </Chip>
              </p>
              {listed.map((b, i) => {
                const isLast = i === listed.length - 1;
                return (
                  <article
                    key={billSlug(b)}
                    // the stamp straddles this row's closing rule, so a
                    // stamped row reserves ~48px of clearance and an
                    // unstamped one stays tight
                    className={`relative grid gap-3 border-b-[1.5px] border-line-strong py-6 ${
                      isLast ? 'pb-12' : ''
                    }`}
                  >
                    <h3 className="max-w-[36ch] text-h3 font-extrabold">
                      <Link
                        href={`/bills/${billSlug(b)}`}
                        className="inline-flex min-h-11 items-center text-ink no-underline visited:text-ink-2 hover:underline hover:decoration-go hover:decoration-[3px]"
                      >
                        {b.ai_headline ?? b.short_title ?? b.title}
                      </Link>
                    </h3>
                    <p className="text-sm font-semibold text-ink-2 tabular-nums">
                      {formatCitation(b.bill_type, b.bill_number)}
                    </p>
                    <div className="flex flex-wrap items-center gap-4 text-sm text-ink-2">
                      {b.issue_tags?.[0] && (
                        <Chip tone="tag">{tShared(`categories.${b.issue_tags[0]}`)}</Chip>
                      )}
                      <span>{tShared(`bills.status.${b.status}`)}</span>
                      {b.last_action_date && (
                        <span className="tabular-nums">
                          {tShared('bills.updated', { date: billDate(b.last_action_date) })}
                        </span>
                      )}
                    </div>
                    {/* ONCE PER PAGE, and the sole printed sync date: the
                        "Data as of" line that used to sit under the section
                        heading is gone, so this mark carries information
                        rather than repeating something said 300px away. */}
                    {isLast && (
                      <Stamp
                        label={t('stampLabel')}
                        dateLabel={stampDate}
                        srLabel={dataAsOf}
                      />
                    )}
                  </article>
                );
              })}
            </div>
          )}

          {quiet && top.length === 0 && (
            <div className="mt-6">
              <UrgencyEmptyState {...freshness} />
            </div>
          )}

          {/* The note says what the loudness means, and the client-side stale
              caveat continues its sentence — one line, one claim; renders
              nothing at all while the data is fresh. */}
          <p className="mt-8 max-w-note text-sm text-ink-2">
            {t('weekNote')}
            <StalenessNote checkedAt={freshness.checkedAt} />
          </p>

          {/* The section closes with its exit: a full-width row under the
              listing, not a link floating beside the intro where it reads as
              decoration. */}
          <Link
            href="/bills"
            className="mt-6 flex min-h-12 w-full items-center justify-center gap-2 rounded-control border-2 border-ink px-4 py-3 font-bold text-ink no-underline hover:bg-ink hover:text-paper"
          >
            {t('seeAll', { count: total })}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </section>

      {/* In the news — coverage-led discovery, kept as ruled paper inside the
          measure. It closes the truth half: the questions, then the week,
          then the coverage that is the quietest of the three. It renders
          nothing when a sync leaves no cross-spectrum or neutral coverage to
          feature. */}
      {news.length > 0 && (
        <div className="mx-auto max-w-5xl px-4 pt-8 md:pt-16">
          <NewsLens bills={news} />
        </div>
      )}

      {/* ---------------------------------------------------------------
          THE ACT ZONE (2026-07-31). One consolidated zone instead of four
          scattered call sections. It is opened by the page's third and last
          3px ink rule; everything below it until privacy is its hairline
          body. Ruled paper, no third ground.
          --------------------------------------------------------------- */}
      <section className="mx-auto max-w-5xl px-4 pt-8 md:pt-16" aria-labelledby="act-zone">
        <div className="border-t-[3px] border-ink pt-4">
          <h2 id="act-zone" className="text-h2 font-extrabold">
            {t('actTitle')}
          </h2>
        </div>
        <p className="mt-2 max-w-note text-ink-2">{t('actSub')}</p>
      </section>

      {/* THE FIVE MINUTES, DRAWN TO SCALE — the act zone's first body block
          and the page's other go-mark. Each leg's bar is that step's true
          share of five minutes, computed from ROUTE, so the drawing cannot
          drift from the durations printed beside it. Three legs are barely
          marks — the call itself is half the time, which is the honest shape
          of the job. */}
      {/* `id="how"` lives on the HEADING only. Putting it on the section too
          made aria-labelledby="how" resolve to the section itself, whose
          accessible name then became its entire text — which starts "Your ZIP
          code…" and collided with the hero's ZIP field in every getByLabel
          query. One id, one owner. */}
      <section className="mx-auto max-w-5xl px-4 pt-8 md:pt-16" aria-labelledby="how">
        <div className="border-t-[1.5px] border-line-strong pt-4">
          <h2 id="how" className="text-h3 font-extrabold">
            {t('howTitle')}
          </h2>
        </div>
        <ol className="mt-8 grid list-none gap-6">
          {ROUTE.map(({ key, seconds }) => (
            <li
              key={key}
              className="grid gap-2 md:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)] md:items-start md:gap-x-6"
            >
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3">
                <h3 className="text-lg font-bold leading-tight">{t(`how${key}Title`)}</h3>
                <span className="text-xs font-bold tracking-[0.06em] whitespace-nowrap text-ink-2 tabular-nums">
                  {t(`how${key}Dur`)}
                </span>
              </div>
              <div>
                <Gauge
                  id={`route-leg-${key}`}
                  hideLabel
                  label={t('routeGaugeLabel', {
                    duration: t(`how${key}Dur`),
                    total: t('routeTotal'),
                  })}
                  total={ROUTE_TOTAL}
                  segments={[{ id: `leg-${key}`, value: seconds }]}
                />
                {/* mobile-density pass: the duration + the gauge carry the leg
                    on a phone; the explainer joins at md. */}
                <p className="mt-3 hidden max-w-read text-ink-2 md:block">{t(`how${key}Body`)}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-6 flex flex-wrap items-baseline gap-4 border-t-[1.5px] border-ink pt-3 text-sm text-ink-2">
          <b className="text-lg font-extrabold text-ink tabular-nums">{t('routeTotal')}</b>
          <span>{t('routeTotalNote')}</span>
        </p>
      </section>

      {/* The two demos, as disclosures (mobile-density pass): a phone scene
          and a three-turn transcript were ~2,000px of every scroll. Open = the
          full experience, closed = one honest row each. Native
          details/summary keeps both semantic and keyboard-reachable, and the
          summaries clear 44px. */}
      <section className="mx-auto max-w-5xl px-4 pt-8 md:pt-16" aria-labelledby="walkthrough-title">
        <HomeWalkthroughDisclosure />
        <div className="mt-4">
          <TranscriptDisclosure />
        </div>
      </section>

      {/* Why calling works — the act zone's closing teaser, a quiet block. It
          used to be a dark enamel card, which at a squint made it the page's
          second heavy mass and took the meaning out of the one ground change
          that carries data. */}
      <section className="mx-auto max-w-5xl px-4 pt-8 md:pt-16" aria-labelledby="why-title">
        <div className="grid gap-6 md:grid-cols-[1.1fr_1fr] md:items-start md:gap-12">
          <h2 id="why-title" className="text-h3 font-extrabold">
            {t('whyTitle')}
          </h2>
          <div>
            <p className="max-w-note text-ink-2">{t('whyBody')}</p>
            <Link
              href="/why-call"
              className="mt-4 inline-flex min-h-11 items-center gap-1.5 font-semibold text-go underline underline-offset-4 hover:text-go-deep"
            >
              {t('whyCta')}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </div>
      </section>

      {/* Privacy, as ruled paper. The claim does not need a dark ground to
          land: it is opened by the same 3px ink rule that opens the week and
          the act zone, and the three guarantees are set as a ruled list, which
          is how a document states terms. */}
      <section className="mx-auto max-w-5xl px-4 pt-8 md:pt-16" aria-labelledby="privacy-title">
        <div className="grid gap-6 border-t-[3px] border-ink pt-6 md:grid-cols-[1.1fr_1fr] md:items-start md:gap-12">
          <h2 id="privacy-title" className="text-h2-loud font-extrabold">
            {t('privacyTitle')}
          </h2>
          <div>
            <p className="max-w-note text-ink-2">{t('privacyBody')}</p>
            <ul className="mt-5 max-w-note list-none">
              {(['privacyPoint1', 'privacyPoint2', 'privacyPoint3'] as const).map((k) => (
                <li
                  key={k}
                  className="border-t border-line-strong py-3 text-sm text-ink-2 last:border-b"
                >
                  {t(k)}
                </li>
              ))}
            </ul>
            <Link
              href="/privacy"
              className="mt-4 inline-flex min-h-11 items-center gap-1.5 font-semibold text-go underline underline-offset-4 hover:text-go-deep"
            >
              {t('privacyCta')}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </div>
      </section>

      {/* §6 support band — gated on the same DONATE_URL constant as every
          donate affordance (setting it back to null darkens all of them at
          once). Link-out only, never a payment field here; copy leads with
          the no-tracking mission, and the not-tax-deductible line is the
          required truthful framing. It is ruled paper now, not a full-bleed
          wash band: this page changes ground exactly once. */}
      {DONATE_URL && (
        <section
          className="mx-auto max-w-5xl px-4 pt-8 pb-10 md:pt-16 md:pb-16"
          aria-labelledby="support-title"
        >
          <div className="flex flex-wrap items-start justify-between gap-6 border-t-[1.5px] border-line pt-8">
            <div className="max-w-note">
              <h2 id="support-title" className="text-h2 font-extrabold">
                {t('supportTitle')}
              </h2>
              <p className="mt-2 text-ink-2">{t('supportBody')}</p>
            </div>
            <div>
              <a
                href={DONATE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-ink px-5 py-3 font-bold text-ink no-underline hover:bg-ink hover:text-paper"
              >
                {t('supportCta')}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </a>
              <p className="mt-2 max-w-note text-sm text-ink-2">{t('supportNote')}</p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
