import type { Metadata } from 'next';
import { ArrowRight } from 'lucide-react';
import { setRequestLocale, getFormatter, getTranslations } from 'next-intl/server';
import { Link, getPathname } from '@/i18n/navigation';
import { JsonLd } from '@/components/JsonLd';
import { ZipForm } from '@/components/ZipForm';
import { HomeScreencast } from '@/components/HomeScreencast';
import { NewsLens } from '@/components/NewsLens';
import { StalenessNote } from '@/components/StalenessNote';
import { UrgencyEmptyState } from '@/components/UrgencyEmptyState';
import { AiMark, Chip, FloorVotePanel, Stamp, selectFloorVoteFeature } from '@/components/system';
import { billSlug, getAllBills, getNewsBills, getTopActions, hasActNow } from '@/lib/core';
import type { Bill } from '@/lib/types';
import { formatCitation } from '@/lib/format';
import { dataAsOfString, getFreshness } from '@/lib/freshness';
import { hreflangAlternates } from '@/lib/hreflang';
import { floorCalendarChamber } from '@/lib/journey';
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
 * 1. ONE GREEN SLAB, and it is the FloorVotePanel — since 2026-08-01 worn as
 *    a crown: on a hot week the week's masthead fuses onto the panel's top
 *    and the two are ONE full-bleed green ground (the "green crown", owner
 *    decision; the masthead goes green only because the panel under it
 *    earned it, and on a quiet week it reverts to ruled paper). Green is
 *    still the page's only DATA-EARNED shape change: no panel, no green
 *    ground anywhere. The hero, the act zone, privacy and the support band
 *    are all ruled paper and none of them may take a ground of their own — a
 *    shape change that happens for four reasons carries no data.
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
 * 4. THE GO-MARK APPEARS ONCE, MEASURING. Hero C's SECOND BEAT — "Then make
 *    it count." — is the measured promise, and the stroke under it survives
 *    under that clause (2026-07-31 fork). The act zone's route gauge was its
 *    twin until 2026-08-01, when the owner retired the drawing (two redraws
 *    never made it read); the printed durations carry that honesty now.
 *
 * The act zone (section[aria-labelledby="act-zone"]) is where the call
 * apparatus was consolidated: one titled zone opened by the 3px ink rule,
 * with the route, the walkthrough, the transcript and the why-call teaser as
 * its hairline-ruled body — instead of four call sections scattered down the
 * page. "Natural next step" made literal in the page structure.
 */

/** The five minutes, in seconds. The `seconds` figures are what the printed
 *  `how*Dur` strings claim (0:30 / 1:00 / 1:00 / 2:30 — 5:00 total); they
 *  stay here as the record of that arithmetic even though the route gauge
 *  that drew them was retired on 2026-08-01. */
const ROUTE = [
  { key: 1, seconds: 30 },
  { key: 2, seconds: 60 },
  { key: 3, seconds: 60 },
  { key: 4, seconds: 150 },
] as const;

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
 *
 * Density pass 2026-08-01 (owner finding): the card stretches to its grid
 * row and must carry real information down its whole height — status,
 * summary teaser, topic, last action — with the exit pinned to the foot
 * (`mt-auto`). The kicker is the citation + status, not "The official text"
 * again: the enamel header already says that 40px up. `dateLabel` arrives
 * pre-formatted from the parent because the UTC-pinning rule for
 * `last_action_date` lives there, beside billDate() — not duplicated here.
 */
async function SpecimenAside({ bill, dateLabel }: { bill: Bill; dateLabel: string | null }) {
  const t = await getTranslations('home');
  const tShared = await getTranslations();
  const official = bill.title.length > 180 ? `${bill.title.slice(0, 180)}…` : bill.title;
  return (
    <aside
      className="flex min-w-0 flex-col overflow-hidden rounded-control border-2 border-ink"
      aria-labelledby="specimen-title"
    >
      <h2
        id="specimen-title"
        className="bg-ink-deep px-5 py-3 text-xs font-bold tracking-[0.06em] text-paper uppercase leading-tight"
      >
        {t('specimenTitle')}
      </h2>
      <div className="flex flex-1 flex-col p-4 md:p-6">
        <p className="text-2xs font-extrabold tracking-[0.1em] text-ink-2 uppercase tabular-nums">
          {formatCitation(bill.bill_type, bill.bill_number)} ·{' '}
          {tShared(`bills.status.${bill.status}`)}
        </p>
        <p className="mt-2 font-reading text-base text-ink-2">{official}</p>
        <p className="mt-4 border-t-[1.5px] border-line pt-4 text-2xs font-extrabold tracking-[0.1em] text-ink-2 uppercase">
          {t('specimenPlain')}
        </p>
        {/* `tint` means DECODED-FOR-YOU here, the same way it means "your own
            words" in the transcript: the plain-words half of the pair. */}
        <p className="mt-2 rounded-control bg-tint p-3 font-reading text-lg text-ink">
          {bill.ai_headline}
        </p>
        {/* The decode's opening, clamped: an honest teaser for the exit link
            below it, in the reading voice like every decoded sentence. md+
            only — it exists to fill the card's stretched grid row, and on a
            phone the card is content-height, so here it would be pure
            scroll (mobile-density audit, 2026-08-01). */}
        {bill.ai_summary && (
          <p className="mt-3 hidden font-reading text-base text-ink-2 md:line-clamp-4">
            {bill.ai_summary}
          </p>
        )}
        <div className="mt-auto pt-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t-[1.5px] border-line pt-4 text-sm text-ink-2">
            {bill.issue_tags?.[0] && (
              <Chip tone="tag">{tShared(`categories.${bill.issue_tags[0]}`)}</Chip>
            )}
            {dateLabel && (
              <span className="tabular-nums">{tShared('bills.updated', { date: dateLabel })}</span>
            )}
          </div>
          <p className="mt-3">
            <Chip tone="ai" marker={t('aiMarker')}>
              {t('aiReviewed')}
            </Chip>
          </p>
          <Link
            href={`/bills/${billSlug(bill)}`}
            className="mt-3 inline-flex min-h-11 items-center gap-1.5 font-semibold text-go underline underline-offset-4 hover:text-go-deep"
          >
            {t('specimenCta')}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </div>
    </aside>
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
  // The selector guarantees the feature's own last action says "Placed on …
  // Calendar", so the chamber is read out of that sentence — the same
  // derivation the bill page's amber gate uses — and the panel's claim names
  // the TRUE chamber (a House bill can stand on the Senate's calendar).
  const featureChamber = feature ? floorCalendarChamber(feature.last_action_text) : null;
  // The week wears its green crown (masthead fused onto the panel) exactly
  // when the panel itself renders — same condition, one name, so the seam
  // classes below can never disagree with the crown's presence.
  const crowned = Boolean(feature?.last_action_date);

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
        {/* THE GO-MARK AS A STROKE: the same 6px bar at the same 3px cap
            the route gauge is built from, drawn under the SECOND BEAT —
            because that clause is the thing being measured. The first
            beat is the truth promise and takes no mark. It is a
            pseudo-element, never the <Gauge> component. */}
        {/* FULL WIDTH, ABOVE THE COLUMNS (owner finding 2026-08-01). The
            stroked beat cannot wrap (the bar has to be one continuous mark),
            and inside the old 1.1fr column it could not FIT either: at every
            md+ width the beat set wider than the column (637px against a
            590px column at 1024, measured) and ran under the specimen card.
            The h1 now spans the hero measure, where both locales' beats
            clear with room; the two-column split starts below it. */}
        {/* One step below the --text-h1 floor under 360px, and only
            there. MEASURED: "Luego haz que cuente." sets 330px at the 32px
            floor — 42px past the 288px content box of a 320px screen, which
            is a WCAG 1.4.10 reflow failure, not a taste call. At 26px it
            sets 268px. English fits at either size; this fires for both so
            the two locales cannot drift apart typographically. */}
        {/* TWO LINES AT md+, BROKEN AT THE CLAUSE (owner directive
            2026-08-01: "Understand it in plain words." never breaks). Two
            things make that true, and both are needed. (1) `data-clause-lock`
            opts the h1 out of the global `text-wrap: balance` at md+ (the
            unlayered rule in globals.css — a layered utility cannot beat
            it): balance prefers the evener mid-clause break ("…in plain /
            words. Then…") over the clause-clean one whenever the first
            clause is the longest line — balance was the breaker, not the
            width. (2) md:text-h1-bill (56px
            cap, the next rung down): on the --text-h1 track the ES clause
            sets wider than the measure between ~768–830px (741px against a
            704px measure at 768), so the clause-clean break needs the
            smaller rung to hold at EVERY md width — measured EN 733px /
            ES 772px against 992px at the cap. Below md the phone keeps the
            mobile-density-pass text-h1 floor, balance, and its three-line
            stack, unchanged. */}
        <h1
          data-clause-lock
          className="text-h1 font-extrabold max-[22.5rem]:text-[1.625rem] md:text-h1-bill"
        >
          {t('heroTitle')}{' '}
          <span className="relative inline-block whitespace-nowrap after:absolute after:right-[0.08em] after:bottom-[-0.12em] after:left-[0.02em] after:h-[6px] after:rounded-stamp after:bg-go after:content-['']">
            {t('heroTitleGo')}
          </span>
        </h1>

        {/* No md:items-start: the columns stretch to one height, which is
            what lets the specimen card fill its block to the foot. */}
        <div className="mt-8 grid gap-8 md:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] md:gap-16">
          <div className="min-w-0">
            <p className="max-w-read text-lede text-pretty text-ink-2">{t('heroSub')}</p>

            {/* AI at first contact, as a CREDIT LINE under the lede (owner
                pick 6C, 2026-08-01): the disclosure qualifies the lede's
                promise, so it sits with those words as two lines of small
                metadata — read order promise -> disclosure -> action — and
                the button below stands alone. The middot fragments keep the
                second line reading as metadata, not a second paragraph. The
                old bordered chip here was the page's largest AI label and
                outweighed the button it sat over. */}
            <p className="mt-4 flex max-w-[52ch] items-start gap-2 text-xs text-ink-2">
              <AiMark>{t('aiMarker')}</AiMark>
              <span className="pt-0.5">
                <span className="block">{t('heroAiLead')}</span>
                <span className="block">{t('heroAiMeta')}</span>
              </span>
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

          {specimen && (
            <SpecimenAside
              bill={specimen}
              dateLabel={specimen.last_action_date ? billDate(specimen.last_action_date) : null}
            />
          )}
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
          // THE SEAM (owner pick 8B, 2026-08-01): when the green crown
          // follows, the band drops its own bottom border and the two slabs
          // meet flush on the crown's single bright-green rule — no white
          // sliver. On a crownless week the band keeps both edges.
          className={`on-dark mt-2 ${crowned ? 'border-t-[3px]' : 'border-y-[3px]'} border-line-strong bg-ink-deep py-8 text-paper md:py-14`}
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
            <p className="mt-1 max-w-note text-sm text-pretty text-ink-pale">{t('momentsSub')}</p>
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
            {/* The dek under each entry is AI-drafted summary text; /moments
                labels it, so the front door must too. At the band's FOOT and
                in sentence case (owner, 2026-08-01 — the bold-uppercase
                version at the top read as shouting); every entry still lands
                on a labeled surface one click away. */}
            <p className="mt-2 max-w-read text-xs text-pretty text-ink-pale">
              {tShared('moments.aiNote')}
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
        {/* THE MASTHEAD (M3 "green crown", owner decision 2026-08-01): the
            section opens as a dateline row — heading with the Stamp pressed
            across the row's closing hairline, sub beneath — instead of a
            heading floating in the white strip between the ink band and the
            green panel. On a HOT week the masthead is the TOP OF THE GREEN
            SLAB ITSELF: one full-bleed ground carrying masthead + featured
            bill (FloorVotePanel renders `flush` inside it), so the heading
            carries green only because the panel below earned it. On a QUIET
            week it renders as ruled paper and no green exists anywhere — the
            color law's data gate is intact, and this is still ONE green
            ground, extended, never a second one. The masthead outranks the
            panel's headline (h2-loud over the panel's h2) in both states.
            The Stamp lives here now — still once per page, still the sole
            printed sync date; it certifies the whole week, panel included. */}
        {/* EXACTLY ONE. The panel gates itself on floor_vote + a printed date;
            selectFloorVoteFeature() above holds the cap AND the calendar gate
            (the record's own "Placed on … Calendar" sentence — home.weekNote
            promises exactly that fact, so a cloture motion or a rejected
            motion to proceed can never wear the crown). The date printed is
            the calendar-PLACEMENT date the corpus actually holds — no bill in
            data/bills.json carries a forward-looking scheduled-vote date, so
            no mark here claims one. */}
        {feature?.last_action_date ? (
          // Seam 8B: flush against the band above (no margin), joined by the
          // crown's own 3px top rule in the band's bright link green — one
          // luminous line where ink meets enamel. When the band is absent
          // (no live Big Questions) the crown sits on paper instead and
          // keeps the quiet deep-green edge and its small offset.
          <div
            className={`border-y-[3px] bg-go-deep ${
              liveMoments.length > 0 ? 'border-t-go-bright border-b-go' : 'mt-2 border-go'
            }`}
          >
            <div className="mx-auto max-w-5xl px-4 pt-6 md:pt-8">
              {/* Below md the wrapped heading and the sub would both cross
                  the stamp's straddle band (±~30px around the rule), so the
                  row reserves it vertically: pb-8 keeps the heading's last
                  line above the stamp's top half, mt-8 on the sub clears its
                  bottom half. At md+ the one-line heading sits far left of
                  the stamp and the tight rhythm returns. */}
              <div className="relative border-b-[1.5px] border-paper/35 pb-8 md:pb-3">
                <h2 id="top-actions" className="text-h2-loud font-extrabold text-paper">
                  {t('topTitle')}
                </h2>
                <Stamp label={t('stampLabel')} dateLabel={stampDate} srLabel={dataAsOf} />
              </div>
              <p className="mt-8 max-w-read text-pretty leading-dark tracking-dark text-go-pale md:mt-4">
                {t('topSub')}
              </p>
            </div>
            <FloorVotePanel
              flush
              headingLevel={3}
              status={feature.status}
              dateLabel={billDate(feature.last_action_date)}
              calendarLabel={tShared(
                featureChamber === 'senate' ? 'bill.floor.calendarSenate' : 'bill.floor.calendarHouse'
              )}
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
          </div>
        ) : (
          <div className="mx-auto max-w-5xl px-4 pt-8 md:pt-10">
            {/* Same straddle-band reservation as the hot-week masthead. */}
            <div className="relative border-b-[1.5px] border-line-strong pb-8 md:pb-3">
              <h2 id="top-actions" className="text-h2-loud font-extrabold">
                {t('topTitle')}
              </h2>
              <Stamp label={t('stampLabel')} dateLabel={stampDate} srLabel={dataAsOf} />
            </div>
            <p className="mt-8 max-w-read text-pretty text-ink-2 md:mt-4">{t('topSub')}</p>
          </div>
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
          {/* No opening rule of its own (owner, 2026-08-01): the green slab
              directly above already closes the featured half, and a hairline
              60px under that 3px edge read as clutter. The rows' own
              border-b rules carry the listing's structure. */}
          {listed.length > 0 && (
            <div className="mt-6">
              {/* These headlines are `ai_headline` — decoded text. The hero's
                  AI chip is scoped to "the bill and the script" and the panel
                  above carries its own, so without this the only unlabeled
                  AI content on the page was the part that reads most like
                  editorial copy. The label sits with the content, per DESIGN.md. */}
              <p>
                <Chip tone="ai" marker={t('aiMarker')}>
                  {t('aiReviewed')}
                </Chip>
              </p>
              {listed.map((b) => {
                return (
                  <article
                    key={billSlug(b)}
                    className="grid gap-3 border-b-[1.5px] border-line-strong py-6"
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
              nothing at all while the data is fresh. Gated on the SAME
              condition as the panel itself: a note that says "the green
              panel marks one fact" on a week with no green panel is a false
              claim (owner finding 2026-08-01), so the panel-less week gets
              the sentence without the panel in it. */}
          <p className="mt-8 max-w-note text-sm text-ink-2">
            {feature?.last_action_date ? t('weekNote') : t('weekNoteQuiet')}
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
          THE ACT ZONE (2026-07-31; rebuilt 2026-08-01, owner picks round 3).
          One titled zone under the page's third and last 3px ink rule, and
          the rule now opens BOTH columns at once: left holds the heading,
          the sub, and the five minutes as a numbered list; right holds the
          SCREENCAST WALKTHROUGH (HomeScreencast — real frames of the real
          flow, owner pick 2A, raised level with the heading) with the
          why-call teaser beneath it (owner item 4). The two demo disclosures
          this replaced are gone (owner item 3); the transcript's reassurance
          survives as the note under the player. Ruled paper, no third
          ground. */}
      {/* THE FIVE MINUTES, AS NUMBERS ONLY (owner decision 2026-08-01,
          round 3): the route gauge is gone. It was redrawn twice — four
          per-leg bars, then one stacked track — and neither read as a
          measurement to a fresh eye, so the printed durations and the 5:00
          total now carry the honesty alone. The hero stroke is the page's
          one remaining go-mark. A REAL sequence, so the list numbers are
          information, not scaffolding: the order is the order you do the
          steps in. */}
      <section className="mx-auto max-w-5xl px-4 pt-8 md:pt-16" aria-labelledby="act-zone">
        <div className="grid gap-8 border-t-[3px] border-ink pt-4 md:grid-cols-2 md:items-start md:gap-12">
          <div>
            <h2 id="act-zone" className="text-h2 font-extrabold">
              {t('actTitle')}
            </h2>
            <p className="mt-2 max-w-note text-pretty text-ink-2">{t('actSub')}</p>
            <ol className="mt-8 list-none">
              {ROUTE.map(({ key }) => (
                <li
                  key={key}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 border-t border-line-strong py-4 md:gap-x-4"
                >
                  <span className="text-sm font-extrabold text-ink-2 tabular-nums">{key}</span>
                  <div>
                    <h3 className="text-lg font-bold leading-tight">{t(`how${key}Title`)}</h3>
                    {/* mobile-density pass: the title + duration carry the
                        leg on a phone; the explainer joins at md. */}
                    <p className="mt-1 hidden max-w-read text-ink-2 md:block">
                      {t(`how${key}Body`)}
                    </p>
                  </div>
                  <span className="text-xs font-bold tracking-[0.06em] whitespace-nowrap text-ink-2 tabular-nums">
                    {t(`how${key}Dur`)}
                  </span>
                </li>
              ))}
            </ol>
            <p className="flex flex-wrap items-baseline gap-4 border-t-[1.5px] border-ink pt-3 text-sm text-ink-2">
              <b className="text-lg font-extrabold text-ink tabular-nums">{t('routeTotal')}</b>
              <span>{t('routeTotalNote')}</span>
            </p>
          </div>
          {/* The walkthrough beside the steps it plays out, top-aligned
              with the zone heading (owner pick 2A), and the why-call teaser
              directly under it (owner item 4) — the column that used to be
              half dead space now answers "show me" and then "does it
              work?". why-title stays an h3: it is a subsection of this
              zone's h2. */}
          <div>
            <HomeScreencast />
            <div className="mt-8 border-t-[1.5px] border-line-strong pt-6">
              <h3 id="why-title" className="text-h3 font-extrabold">
                {t('whyTitle')}
              </h3>
              <p className="mt-3 max-w-note text-pretty text-ink-2">{t('whyBody')}</p>
              <Link
                href="/why-call"
                className="mt-4 inline-flex min-h-11 items-center gap-1.5 font-semibold text-go underline underline-offset-4 hover:text-go-deep"
              >
                {t('whyCta')}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Privacy + support, one closing two-column band (owner direction
          2026-08-01): the page's terms, side by side under the third 3px ink
          rule — "Private by design" left, the support ask right — instead of
          two stacked sections that each ran a half-empty screen. Both
          headings sit at the same rung (text-h2; privacy dropped from
          h2-loud) so neither reads subordinate. The columns do not
          bottom-align and should not: this is ruled paper, not cards. Each
          half keeps its own <section> — donate.spec.ts reads
          section[aria-labelledby="support-title"], and the privacy
          guarantees stay a ruled list, which is how a document states terms.
          §6 rules unchanged: the support half is gated on the same
          DONATE_URL constant as every donate affordance (setting it back to
          null darkens all of them at once, and this band quietly becomes the
          privacy column alone); link-out only, never a payment field here;
          the not-tax-deductible line is the required truthful framing. Ruled
          paper, no new ground: this page still changes ground exactly
          once. */}
      <div className="mx-auto max-w-5xl px-4 pt-8 pb-10 md:pt-16 md:pb-16">
        <div
          className={`grid gap-10 border-t-[3px] border-ink pt-6 ${
            DONATE_URL ? 'md:grid-cols-2 md:items-start md:gap-12' : ''
          }`}
        >
          <section aria-labelledby="privacy-title">
            <h2 id="privacy-title" className="text-h2 font-extrabold">
              {t('privacyTitle')}
            </h2>
            <p className="mt-3 max-w-note text-pretty text-ink-2">{t('privacyBody')}</p>
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
          </section>
          {DONATE_URL && (
            <section aria-labelledby="support-title">
              <h2 id="support-title" className="text-h2 font-extrabold">
                {t('supportTitle')}
              </h2>
              <p className="mt-3 max-w-note text-pretty text-ink-2">{t('supportBody')}</p>
              <a
                href={DONATE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-5 inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-ink px-5 py-3 font-bold text-ink no-underline hover:bg-ink hover:text-paper"
              >
                {t('supportCta')}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </a>
              <p className="mt-2 max-w-note text-sm text-ink-2">{t('supportNote')}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
