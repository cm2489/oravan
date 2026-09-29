import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { setRequestLocale, getFormatter, getTranslations } from 'next-intl/server';
import { Link, getPathname } from '@/i18n/navigation';
import { JsonLd } from '@/components/JsonLd';
import { ZipForm } from '@/components/ZipForm';
import { HeroSavedZip } from '@/components/HeroSavedZip';
import { HomeLatestVote } from '@/components/HomeLatestVote';
import { NewsLens } from '@/components/NewsLens';
import { RememberLocaleLink } from '@/components/RememberLocaleLink';
import { StalenessNote } from '@/components/StalenessNote';
import { UrgencyEmptyState } from '@/components/UrgencyEmptyState';
import { FloorEvidence } from '@/components/FloorEvidence';
import { AiMark, FloorVotePanel, Stamp, selectFloorVoteFeature, type ChipGround } from '@/components/system';
import {
  billSlug,
  getAllBills,
  getFloorFeatureCandidates,
  getNewsBills,
  getTopActions,
  hasActNow,
} from '@/lib/core';
import type { Bill } from '@/lib/types';
import { formatCitation } from '@/lib/format';
import { dataAsOfString, getFreshness } from '@/lib/freshness';
import { hreflangAlternates } from '@/lib/hreflang';
import { glossaryTag } from '@/components/glossary-tags';
import {
  announcementFor,
  chamberNextMeeting,
  chamberSession,
  floorSessionSource,
  floorSignalsCheckedAt,
  floorSourcesPosture,
} from '@/lib/docket';
import { statusKeyFor } from '@/lib/journey';
import { buildSiteJsonLd } from '@/lib/jsonld';
import { homeQuestionRows, leadTally } from '@/lib/home';
import { billStatusLine, type StatusLine } from '@/lib/moment-status.mjs';
import { getMomentsForBill } from '@/lib/moments';
import { LIVE_CAP } from '@/lib/moments-gate.mjs';
import { momentDek } from '@/lib/moments-ui';
import { votesForBill } from '@/lib/votes';
import { DONATE_URL, SITE_ORIGIN } from '@/lib/site';

/*
 * THE HOME SURFACE — option B, "this week first, then Big Questions".
 *
 * Owner, 2026-09-29, typed: "Home Page - Option B, This week first, then Big
 * Questions." The v2 grayscale wireframe of the same day
 * (oravan-private-docs/wireframes-2026-09-29/home.html) draws the order this
 * file builds, top to bottom:
 *
 *   hero → this week (led by the floor item) → Big Questions → in the news
 *   → the official text, decoded → how a call works → does calling work?
 *   · private by design · free for everyone → footer
 *
 * It reverses the 2026-07-31 truth-first flip's ORDER only (that flip put the
 * Big Questions band above the week; tests/moments.spec.ts pinned it and now
 * pins the new order). Everything else that flip decided still stands:
 * understanding is the front door and the call is the natural next step,
 * demoted but never buried (Constitution v2, rule 8).
 *
 * WHAT MUST SURVIVE ANY FUTURE EDIT:
 *
 * 1. ONE LOUD BLOCK, DATA-EARNED. The week's lead is the green FloorVotePanel,
 *    and on a crowned week the masthead fuses onto it (the "green crown",
 *    2026-08-01): one full-bleed green ground, and it exists only because the
 *    record holds a live floor fact. A quiet week is ruled paper, and says so
 *    (rule 6). The Big Questions band keeps its ink enamel (owner 2026-07-24;
 *    colour is a later pass, so the rebuild does not restyle it here).
 *
 * 2. EXACTLY ONE BILL takes that panel, chosen by selectFloorVoteFeature()
 *    over getFloorFeatureCandidates() — the WHOLE decoded floor pool, never
 *    the 4-row shortlist (the 2026-08-09 lesson: a rank-4 cut decided whether
 *    the crown appeared at all).
 *
 * 3. EVERY CALLABLE BILL LINK stays inside the week's section. The funnel spec
 *    reads that boundary through its `data-front-door="week"` hook, and the
 *    Big Questions band through `data-front-door="questions"` (test hooks,
 *    not rules): from either, a decoded, AI-labeled answer is one click away
 *    (funnel I1). The `top-actions` id is the hero jump's target and a hook
 *    freshness.spec.ts and moments.spec.ts still read.
 *
 * 4. EVERY ROW IS ONE WHOLE-ROW LINK (the wireframe's "none is a 21-px
 *    target"): the week's rows and the Big Questions rows stretch their
 *    headline link over the row (`after:absolute after:inset-0`); the news
 *    rows are block links (components/NewsLens.tsx `rows`).
 *
 * 5. ONE QUIET AI LABEL PER BLOCK, linking to how this is made (card a9;
 *    page 2, Copy). The hero's is the one exception: it carries no link,
 *    because a link there would become the hero's first action, and the
 *    hero's first action has to lead to understanding
 *    (tests/home-fold.spec.ts, rule 8).
 */

/** The five minutes, in seconds. The `seconds` figures are what the printed
 *  `how*Dur` strings claim (0:30 / 1:00 / 1:00 / 2:30 — 5:00 total). */
const ROUTE = [
  { key: 1, seconds: 30 },
  { key: 2, seconds: 60 },
  { key: 3, seconds: 60 },
  { key: 4, seconds: 150 },
] as const;

/*
 * The crown's amber chip, one key per (fact × chamber). `selectFloorVoteFeature`
 * returns both coordinates from the one sentence it read, so nothing here
 * decides anything; it only looks up the copy. All keys exist in EN and ES.
 */
const FLOOR_LABEL_KEYS = {
  announced: { house: 'bill.floor.announcedHouse', senate: 'bill.floor.announcedSenate' },
  calendar: { house: 'bill.floor.calendarHouse', senate: 'bill.floor.calendarSenate' },
  pending: { house: 'bill.floor.pendingHouse', senate: 'bill.floor.pendingSenate' },
} as const;

/** Where every block's AI label points: the published AI-content policy. */
const HOW_MADE_HREF = '/citations#ai-policy';

/** The status-label key for a bill — one call site, so a change to
 *  statusKeyFor's signature lands on one line of this file. */
const statusLabelKey = (b: Bill) => statusKeyFor(b.status, b.last_action_text, b.last_action_date);

// Returning only `alternates` lets the layout's title/description keep
// flowing through unchanged. The RSS discovery link lives here because the
// "what moved this week" feed mirrors this page's week.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const feedPath = locale === 'es' ? '/es/feed/whats-moving.xml' : '/feed/whats-moving.xml';
  return {
    alternates: {
      ...hreflangAlternates(locale, '/'),
      types: { 'application/rss+xml': `${SITE_ORIGIN}${feedPath}` },
    },
  };
}

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('home');
  const tShared = await getTranslations();
  const tLine = await getTranslations('homeLine');
  const format = await getFormatter();
  const top = getTopActions(4, locale);
  const newsRaw = getNewsBills(locale, 7);
  const total = getAllBills().length;
  const freshness = getFreshness();
  const dataAsOf = await dataAsOfString(locale);
  // AE3: the quiet-week claim keys on the floor alone. In the rare state
  // where a bill clears the floor but isn't decoded yet, the shortlist is
  // empty AND the week is not quiet — render neither rows nor a false claim.
  const quiet = !hasActNow();
  const jsonLd = await buildSiteJsonLd(locale);
  // The Big Questions (data + code still say `moment`), newest record action
  // first (lib/home.ts). Only live entries, so a quiet stretch shows no band
  // rather than a band faking fullness.
  const questions = homeQuestionRows();

  /*
   * DATA-GATED LOUDNESS. One call, at the data layer, so the cap-to-one can
   * never be broken by a component that cannot see its siblings. `feature` is
   * null on a week where the record shows no live floor fact. The selector
   * reads four things, in rung order: the chamber's own published floor
   * schedule naming this bill (ruling V1, quoted with its date and URL), a
   * floor vote still ahead in the record, or the record's own "Placed on …
   * Calendar" sentence — and, for the two record facts, whether that chamber
   * is meeting (rulings D1+D2). An announcement the chamber's own vote has
   * already spent is not live (D13, inside `announcementFor`).
   */
  const feature = selectFloorVoteFeature(
    getFloorFeatureCandidates(locale),
    (b) => announcementFor(b, billSlug(b)),
    (c) => chamberSession(c)
  );
  const signalsCheckedAt = floorSignalsCheckedAt();
  // Slug equality, NEVER reference equality: localizeBill() returns a fresh
  // object on /es, so the crown's own bill would otherwise be listed again
  // under it on the Spanish page (tests/landing.spec.ts drives both locales).
  const featureSlug = feature ? billSlug(feature.bill) : null;
  const listed = top.filter((b) => billSlug(b) !== featureSlug);
  /*
   * THE DATE THE CHIP PRINTS. On `calendar`/`pending` it is the date of the
   * action itself; on `announced` it is the ANNOUNCING DOCUMENT's own
   * publication date, because that is the dated fact the panel quotes.
   * Neither is a scheduled-vote date; the corpus holds none.
   */
  const crownDate =
    feature?.kind === 'announced'
      ? (feature.announcement?.published ?? null)
      : (feature?.bill.last_action_date ?? null);
  const crowned = Boolean(feature && crownDate);
  // The floor item's Big Question, when its bill is a live question's vehicle
  // (the wireframe's "Big Question: Paying college athletes"), and the newest
  // roll call the record holds on it (the wireframe's "Latest vote").
  const featureQuestion = featureSlug
    ? (getMomentsForBill(featureSlug).find((m) => m.state === 'live') ?? null)
    : null;
  const latestRollCall = featureSlug ? (votesForBill(featureSlug)[0] ?? null) : null;

  /*
   * THE QUIET WEEK THAT CAN SAY WHY (owner ruling A-3, 2026-08-15): both
   * chambers out of session, both with a next meeting in the file, and the
   * digest carrying its own publication date. Anything short of all four
   * falls to `weekNoteQuiet`. It self-heals: `chamberSession` decays to
   * `unknown` when the file stops being rewritten.
   */
  const digestSource = floorSessionSource();
  const senateNextMeeting = chamberNextMeeting('senate');
  const houseNextMeeting = chamberNextMeeting('house');
  const recessWeek =
    !crowned &&
    chamberSession('senate') === 'out_of_session' &&
    chamberSession('house') === 'out_of_session' &&
    senateNextMeeting !== null &&
    houseNextMeeting !== null &&
    Boolean(digestSource?.published)
      ? {
          published: digestSource!.published!,
          senate: senateNextMeeting,
          house: houseNextMeeting,
        }
      : null;

  /*
   * THE SPECIMEN (H07, kept by the owner's mark): one real bill's official
   * title beside its plain-words decode. It prefers a DECODED bill that is not
   * the crown's feature (the 2026-08-02 teardown: one headline three times
   * read as "one story"), falling back to the feature only when nothing else
   * carries a decode. Real corpus data, never fiction: no decode, no block.
   */
  const specimenBill =
    top.find((b) => billSlug(b) !== featureSlug && b.ai_headline) ?? feature?.bill ?? null;
  const specimen = specimenBill?.ai_headline ? specimenBill : null;
  // In the news: a short list (owner: three items, H16), without the crown's
  // bill, which the week already headlines.
  const news = newsRaw.filter((b) => b.slug !== featureSlug).slice(0, 3);

  /*
   * A bill's own calendar date, e.g. "Sep 24, 2026". PINNED TO UTC ON
   * PURPOSE: `last_action_date` is a bare `YYYY-MM-DD`, which `new Date()`
   * reads as UTC midnight — formatted in a negative-offset zone it prints the
   * day before. A printed "last action" is a claim about a real day.
   */
  const billDate = (iso: string) =>
    format.dateTime(new Date(iso), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  /** The short form a row's status line carries ("Sep 24"), also UTC. */
  const rowDate = (iso: string) =>
    format.dateTime(new Date(iso), { month: 'short', day: 'numeric', timeZone: 'UTC' });

  /* A chamber's next meeting: the digest's OWN line first (English, marked
     `lang="en"`, ruling V4), our derived date only when it printed none. */
  const meetingText = (meeting: { iso: string | null; label: string | null }) =>
    meeting.label ?? billDate(meeting.iso!);
  const meetingTag = (meeting: { iso: string | null; label: string | null }) =>
    meeting.label
      ? function VerbatimMeeting(chunks: ReactNode) {
          return <span lang="en">{chunks}</span>;
        }
      : function DerivedMeeting(chunks: ReactNode) {
          return <span className="tabular-nums">{chunks}</span>;
        };

  /*
   * The stamp's date. Deliberately NOT pinned to UTC: its screen-reader
   * sentence is dataAsOfString(), which goes through the shared formatter,
   * and `checkedAt` is a full timestamp, so it has no midnight problem.
   */
  const stampDate = format.dateTime(new Date(freshness.checkedAt), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  /*
   * THE SHORT STATUS LINE a row prints: the closed vocabulary of
   * lib/moment-status.mjs, in its short homepage form (`homeLine.*`), then
   * the record's date. Nothing here reads the record a second way.
   */
  const statusLine = (line: StatusLine, tally: { yeas: number; nays: number } | null) => {
    const words = tLine(line.key, {
      chamber: line.chamber ?? 'other',
      law: line.law ?? 'none',
      tally: tally ? 'yes' : 'none',
      yeas: tally?.yeas ?? 0,
      nays: tally?.nays ?? 0,
    });
    return (
      <>
        {words}
        {line.date && (
          <>
            {' · '}
            <time dateTime={line.date} className="tabular-nums">
              {rowDate(line.date)}
            </time>
          </>
        )}
      </>
    );
  };

  /*
   * ONE QUIET AI LABEL PER BLOCK (card a9): the AI mark, one short line, and
   * a link to how this is made. Each ground keeps its own contrast-checked
   * tokens: ink-2 on paper (7.87:1), ink-pale on the ink band (10.82:1),
   * go-pale on the green enamel (6.86:1).
   */
  const AI_LINE_TEXT: Record<ChipGround, string> = {
    paper: 'text-ink-2',
    ink: 'text-ink-pale',
    go: 'text-go-pale',
  };
  const AI_LINK: Record<ChipGround, string> = {
    paper: 'text-go hover:text-go-deep',
    ink: 'text-go-bright hover:text-paper',
    go: 'text-paper hover:decoration-[3px]',
  };
  const aiLine = (text: string, ground: ChipGround = 'paper', className = 'mt-3') => (
    <p className={`flex max-w-read items-start gap-2 text-xs ${AI_LINE_TEXT[ground]} ${className}`}>
      <AiMark ground={ground}>{t('aiMarker')}</AiMark>
      <span className="pt-0.5">
        {text}{' '}
        <Link
          href={HOW_MADE_HREF}
          className={`font-semibold underline underline-offset-4 ${AI_LINK[ground]}`}
        >
          {t('aiHowMade')}
        </Link>
      </span>
    </p>
  );

  return (
    <div>
      <JsonLd id="site-jsonld" data={jsonLd} />

      {/* ---------------------------------------------------------------
          HERO (H01–H06). The truth promise, one AI line, the jump to the
          week directly below, then the ZIP block — which, with a ZIP saved
          in this browser, names the reader's members instead
          (components/HeroSavedZip.tsx). Paper, never a ground of its own.
          --------------------------------------------------------------- */}
      <div data-hero="" className="mx-auto max-w-5xl px-4 pt-5 pb-6 md:pt-16 md:pb-12">
        {/* THE GO-MARK AS A STROKE under the second beat, the measured
            promise. Full width above the columns: the stroked beat cannot
            wrap, and "Understand it in plain words." never breaks (owner,
            2026-08-01) — `data-clause-lock` opts the h1 out of the global
            balance at md+, and md:text-h1-bill is the rung that holds the
            clause-clean break in both locales. Below 360px one step down,
            so "Luego haz que cuente." fits a 320px screen (WCAG 1.4.10). */}
        <h1
          data-clause-lock
          className="text-h1 font-extrabold max-[22.5rem]:text-[1.625rem] md:text-h1-bill"
        >
          {t('heroTitle')}{' '}
          <span className="relative inline-block whitespace-nowrap after:absolute after:right-[0.08em] after:bottom-[-0.12em] after:left-[0.02em] after:h-[6px] after:rounded-stamp after:bg-go after:content-['']">
            {t('heroTitleGo')}
          </span>
        </h1>

        <div className="mt-6 grid gap-4 md:mt-8 md:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] md:gap-16">
          <div className="min-w-0">
            <p className="max-w-read text-lede text-pretty text-ink-2">{t('heroSub')}</p>

            {/* The one AI line (H02 folded in, card a9). No "How this is
                made" link HERE, unlike every other block: it would be the
                hero's first action, and that has to lead to understanding
                (tests/home-fold.spec.ts, rule 8). */}
            <p className="mt-4 flex max-w-[52ch] items-start gap-2 text-xs text-ink-2">
              <AiMark>{t('aiMarker')}</AiMark>
              <span className="pt-0.5">{t('aiHero')}</span>
            </p>

            {/* ONE PRIMARY (fold pass 2026-09-24, finding B3): the filled
                control is the jump to what is moving, and the ZIP submit is
                the secondary outline. The fold is MEASURED at 390×844 and
                390×664 in both locales (tests/home-fold.spec.ts). */}
            <a
              href="#top-actions"
              className="ring-gap mt-5 inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-go bg-go px-6 py-3 font-bold text-paper no-underline hover:border-go-deep hover:bg-go-deep"
            >
              {t('heroJump')}
              <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
            </a>
          </div>

          <div className="min-w-0">
            {/* The ZIP path stays in the hero, demoted, never buried (rule
                8). With a ZIP saved in this browser, the block names the
                members instead and nothing else on the page changes. */}
            <HeroSavedZip>
              <ZipForm submitTone="secondary" inline />
            </HeroSavedZip>

            {/* THE TRUST LINE ON A PHONE (H05): the header carries it at lg+. */}
            <p className="mt-3 text-xs text-ink-2 lg:hidden">
              {tShared('common.trustLine1')} {tShared('common.trustLine2')}
            </p>

            {/* Thumb-reachable language switch. The link text is in the
                TARGET language, hence lang/hreflang on the link.
                RememberLocaleLink records the explicit choice on-device.
                mt-8, MEASURED (2026-09-29): with option B's one-line AI
                credit the hero is shorter, and at mt-4 this link's top sat at
                660px on a 390×664 phone — under the thumb bar (615–664),
                which tests/home-fold.spec.ts forbids. At mt-8 it starts
                below that fold in both locales (EN 676px, ES 697px), as it
                did before (672px). With a ZIP saved it starts in the same
                place or lower: below md the members block is never shorter
                than the form it replaces (components/HeroSavedZip.tsx). */}
            <p className="mt-8 max-w-note text-sm">
              <RememberLocaleLink
                href="/"
                locale={locale === 'es' ? 'en' : 'es'}
                lang={locale === 'es' ? 'en' : 'es'}
                hrefLang={locale === 'es' ? 'en' : 'es'}
                className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-go underline underline-offset-4 hover:text-go-deep"
              >
                {t('heroLocaleLink')}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </RememberLocaleLink>
            </p>
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------------------
          THIS WEEK (H11, H12, H14, H15). First, straight after the hero,
          led by the floor item when the record has one. Full-width by
          construction: the green panel is full-bleed and MUST stay inside
          this section, so the max-width wrapper is inside it.
          --------------------------------------------------------------- */}
      <section aria-labelledby="top-actions" data-front-door="week">
        {crowned && feature && crownDate ? (
          // THE GREEN CROWN (2026-08-01): on a hot week the masthead is the
          // top of the green slab itself, one ground, earned by the panel.
          <div className="mt-2 border-y-[3px] border-go bg-go-deep">
            <div className="mx-auto max-w-5xl px-4 pt-6 md:pt-8">
              {/* Below md the heading and the next line would cross the
                  stamp's straddle band, so the row reserves it: pb-8 here,
                  mt-8 on the line after. */}
              <div className="relative border-b-[1.5px] border-paper/35 pb-8 md:pb-3">
                <h2 id="top-actions" className="text-h2-loud font-extrabold text-paper">
                  {t('topTitle')}
                </h2>
                <Stamp label={t('stampLabel')} dateLabel={stampDate} srLabel={dataAsOf} />
              </div>
              {/* G10: the staleness line, under the stamp, only when the data
                  runs late. Still one per page. */}
              <StalenessNote
                checkedAt={freshness.checkedAt}
                standalone
                className="mt-8 max-w-read text-sm font-semibold text-paper md:mt-4"
              />
              {aiLine(t('aiWeek'), 'go', 'mt-8 md:mt-4')}
            </div>
            <FloorVotePanel
              flush
              headingLevel={3}
              status={feature.bill.status}
              kind={feature.kind}
              dateLabel={billDate(crownDate)}
              /*
               * THE EVIDENCE, on the announced kind only: the chamber's
               * sentence quoted VERBATIM IN ENGLISH in both locales, under a
               * localized framing sentence (ruling V4), with its document,
               * date, link and "as of" stamp (critic A-1).
               */
              evidence={
                feature.kind === 'announced' && feature.announcement ? (
                  <FloorEvidence
                    announcement={feature.announcement}
                    checkedAt={signalsCheckedAt}
                  />
                ) : undefined
              }
              // The latest roll call the record holds on the bill, quoted
              // (components/HomeLatestVote.tsx). The wireframe's second
              // column; absent when the bill has no stored roll call.
              aside={latestRollCall ? <HomeLatestVote rollCall={latestRollCall} /> : undefined}
              // The chip prints the fact the selector actually found, in the
              // chamber the record itself names.
              calendarLabel={tShared(FLOOR_LABEL_KEYS[feature.kind][feature.chamber])}
              identifier={formatCitation(feature.bill.bill_type, feature.bill.bill_number)}
              headline={
                feature.bill.ai_headline ?? feature.bill.short_title ?? feature.bill.title
              }
              href={getPathname({ locale, href: `/bills/${billSlug(feature.bill)}` })}
              ctaLabel={t('floorCta')}
              meta={
                <>
                  {feature.bill.issue_tags?.[0] && (
                    <span>{tShared(`categories.${feature.bill.issue_tags[0]}`)}</span>
                  )}
                  {featureQuestion && (
                    <span>
                      {t.rich('floorQuestion', {
                        name: locale === 'es' ? featureQuestion.name.es : featureQuestion.name.en,
                        link: (chunks) => (
                          <Link
                            href={`/questions/${featureQuestion.id}`}
                            className="inline-flex min-h-11 items-center font-semibold text-paper underline underline-offset-4 hover:decoration-[3px]"
                          >
                            {chunks}
                          </Link>
                        ),
                      })}
                    </span>
                  )}
                </>
              }
            />
          </div>
        ) : (
          <div className="mx-auto max-w-5xl px-4 pt-8 md:pt-10">
            {/* Same straddle-band reservation as the crowned masthead. */}
            <div className="relative border-b-[1.5px] border-line-strong pb-8 md:pb-3">
              <h2 id="top-actions" className="text-h2-loud font-extrabold">
                {t('topTitle')}
              </h2>
              <Stamp label={t('stampLabel')} dateLabel={stampDate} srLabel={dataAsOf} />
            </div>
            <StalenessNote
              checkedAt={freshness.checkedAt}
              standalone
              className="mt-8 max-w-read text-sm font-semibold text-ink md:mt-4"
            />
            {aiLine(t('aiWeek'), 'paper', 'mt-8 md:mt-4')}
          </div>
        )}

        <div className="mx-auto max-w-5xl px-4">
          {/* The rest of the week: ruled rows, unboxed (card a9), each ONE
              whole-row link. The status line is the record's, in the short
              vocabulary the Big Questions rows use (lib/home.ts). */}
          {listed.length > 0 && (
            <ul className="mt-6 list-none border-t-[1.5px] border-line-strong md:grid md:grid-cols-3 md:gap-x-10">
              {listed.map((b) => {
                const line = billStatusLine(b);
                return (
                  <li
                    key={billSlug(b)}
                    className="relative border-b-[1.5px] border-line-strong py-4"
                  >
                    <p className="text-sm font-semibold text-ink-2">
                      {statusLine(line, leadTally(line, b))}
                    </p>
                    <h3 className="mt-1 max-w-[36ch] text-lg leading-tight font-bold">
                      <Link
                        href={`/bills/${billSlug(b)}`}
                        className="text-ink no-underline visited:text-ink-2 after:absolute after:inset-0 after:content-[''] hover:underline hover:decoration-go hover:decoration-[3px]"
                      >
                        {b.ai_headline ?? b.short_title ?? b.title}
                      </Link>
                    </h3>
                    <p className="mt-1 text-sm text-ink-2 tabular-nums">
                      {formatCitation(b.bill_type, b.bill_number)}
                      {b.issue_tags?.[0] && ` · ${tShared(`categories.${b.issue_tags[0]}`)}`}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}

          {quiet && top.length === 0 && (
            <div className="mt-6">
              {/* The fourth signal (critic A-5): if the sources cannot vouch
                  for themselves, this empty week reads as OUR data being
                  stale — never as "Congress published no schedule". */}
              <UrgencyEmptyState
                {...freshness}
                floorSignals={{
                  checkedAt: signalsCheckedAt,
                  sourcesHealthy: floorSourcesPosture() === 'quiet',
                }}
              />
            </div>
          )}

          {/* THE QUIET-WEEK NOTE, on crownless weeks only (the green-panel
              explainer was cut, UX inventory H13, 2026-09-28). A crownless
              week admits it is quiet, and in the one recess the record can
              explain, says why. */}
          {!crowned && (
            <p
              data-week-note={recessWeek ? 'recess' : 'standard'}
              className="mt-6 max-w-note text-sm text-ink-2"
            >
              {recessWeek
                ? t.rich('weekNoteRecess', {
                    published: billDate(recessWeek.published),
                    senate: meetingText(recessWeek.senate),
                    house: meetingText(recessWeek.house),
                    senateWhen: meetingTag(recessWeek.senate),
                    houseWhen: meetingTag(recessWeek.house),
                    term: glossaryTag('pro-forma-session'),
                  })
                : t('weekNoteQuiet')}
            </p>
          )}

          {/* The section closes with its two exits, side by side: every
              active bill, and the day's brief (H14; Today is off the tab bar,
              so this is its one tap from home). */}
          <p className="mt-4 flex flex-wrap gap-x-6">
            <Link
              href="/bills"
              className="inline-flex min-h-11 items-center gap-1.5 font-bold text-go underline underline-offset-4 hover:text-go-deep"
            >
              {t('seeAll', { count: total })}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <Link
              href="/today"
              className="inline-flex min-h-11 items-center gap-1.5 font-bold text-go underline underline-offset-4 hover:text-go-deep"
            >
              {t('todayBrief')}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </p>
        </div>
      </section>

      {/* ---------------------------------------------------------------
          BIG QUESTIONS (H08–H10), after the week (option B). Newest record
          action first, each row one whole-row link with the question, its
          first sentence and the record's short status line. It disappears
          entirely when nothing reads as live (tests/moments.spec.ts pins
          that), and the scarcity line stays: "never more than N" is the
          visible proof that someone said no.
          --------------------------------------------------------------- */}
      {questions.length > 0 && (
        <section
          className="on-dark mt-10 border-y-[3px] border-line-strong bg-ink-deep py-8 text-paper md:mt-16 md:py-12"
          aria-labelledby="moments-strip-title"
          data-front-door="questions"
        >
          <div className="mx-auto max-w-5xl px-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4">
              <h2 id="moments-strip-title" className="text-h2 font-extrabold text-paper">
                {t('momentsTitle')}
              </h2>
              <Link
                href="/questions"
                className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-go-bright underline underline-offset-4 hover:text-paper"
              >
                {t('momentsCta')}
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>
            <p className="mt-1 max-w-note text-sm text-pretty text-ink-pale">{t('momentsSub')}</p>
            {aiLine(t('aiQuestions'), 'ink')}
            <ul className="mt-6 list-none border-t-[1.5px] border-line-strong md:grid md:grid-cols-2 md:gap-x-14">
              {questions.map(({ moment: m, lead, tally }) => (
                <li key={m.id} className="relative border-b-[1.5px] border-line-strong py-4">
                  <h3 className="text-lg leading-tight font-bold">
                    <Link
                      href={`/questions/${m.id}`}
                      className="text-paper no-underline after:absolute after:inset-0 after:content-[''] hover:underline hover:decoration-go-bright hover:decoration-[3px]"
                    >
                      {locale === 'es' ? m.name.es : m.name.en}
                    </Link>
                  </h3>
                  <p className="mt-1 max-w-note text-sm text-ink-pale">
                    {momentDek(locale === 'es' ? m.summary.es : m.summary.en)}
                  </p>
                  {lead && (
                    <p className="mt-1 text-sm font-semibold text-ink-pale">
                      {statusLine(lead, tally)}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            {/* True live count, never the stored total. */}
            <p className="mt-4 text-sm font-semibold text-ink-pale">
              {tShared('moments.scarcityNote', { count: questions.length, cap: LIVE_CAP })}
            </p>
          </div>
        </section>
      )}

      {/* IN THE NEWS (H16): three rows, each saying why it is here, from
          stored evidence only. Renders nothing when a sync leaves no
          coverage to feature. */}
      {news.length > 0 && (
        <div className="mx-auto max-w-5xl px-4 pt-10 md:pt-16">
          <NewsLens bills={news} rows note={aiLine(t('aiNews'))} />
        </div>
      )}

      {/* THE OFFICIAL TEXT, DECODED (H07, kept by the owner's mark): the
          product's core move shown, not told — one real bill's official
          title, then its plain-words decode, AI-labeled. After the news
          since option B (live had it beside the hero). */}
      {specimen && (
        <section
          className="mx-auto max-w-5xl px-4 pt-10 md:pt-16"
          aria-labelledby="specimen-title"
        >
          <div className="border-t-[1.5px] border-line-strong pt-6">
            <h2 id="specimen-title" className="text-h2 font-extrabold">
              {t('specimenTitle')}
            </h2>
            <div className="mt-4 grid gap-6 md:grid-cols-2 md:gap-12">
              <div className="min-w-0">
                <p className="text-2xs font-extrabold tracking-[0.1em] text-ink-2 uppercase tabular-nums">
                  {formatCitation(specimen.bill_type, specimen.bill_number)} ·{' '}
                  {tShared(`bills.status.${statusLabelKey(specimen)}`)} · {t('specimenOfficial')}
                </p>
                <p className="mt-2 font-reading text-lg text-ink-2">
                  {specimen.title.length > 180 ? `${specimen.title.slice(0, 180)}…` : specimen.title}
                </p>
              </div>
              <div className="min-w-0 border-t-[1.5px] border-line pt-4 md:border-t-0 md:border-l-[1.5px] md:pt-0 md:pl-12">
                <p className="text-2xs font-extrabold tracking-[0.1em] text-ink-2 uppercase">
                  {t('specimenPlain')}
                </p>
                {/* `tint` means DECODED-FOR-YOU: the plain-words half of the pair. */}
                <p className="mt-2 rounded-control bg-tint p-3 font-reading text-lg text-ink">
                  {specimen.ai_headline}
                </p>
                {aiLine(t('aiSpecimen'))}
                <Link
                  href={`/bills/${billSlug(specimen)}`}
                  className="mt-2 inline-flex min-h-11 items-center gap-1.5 font-semibold text-go underline underline-offset-4 hover:text-go-deep"
                >
                  {t('specimenCta')}
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* HOW A CALL WORKS (H17): step titles and times only (the four step
          bodies are dropped, as in the wireframe), the 5:00 total, and the
          calm line. A real sequence, so the numbers are information. The
          screencast stays off (H18, cut 2026-09-28; its component and
          strings are kept, unmounted). */}
      <section className="mx-auto max-w-5xl px-4 pt-10 md:pt-16" aria-labelledby="act-zone">
        <div className="border-t-[3px] border-ink pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="act-zone" className="text-h2 font-extrabold">
              {t('callTitle')}
            </h2>
            <p className="text-sm text-ink-2">
              <b className="font-extrabold text-ink tabular-nums">{t('routeTotal')}</b>{' '}
              {t('routeTotalNote')}
            </p>
          </div>
          <ol className="mt-6 list-none md:grid md:grid-cols-4 md:gap-x-8">
            {ROUTE.map(({ key }) => (
              <li
                key={key}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 border-t border-line-strong py-4 md:grid-cols-[auto_minmax(0,1fr)] md:border-b"
              >
                <span className="text-sm font-extrabold text-ink-2 tabular-nums" aria-hidden="true">
                  {key}
                </span>
                <h3 className="text-lg leading-tight font-bold">{t(`how${key}Title`)}</h3>
                <span className="text-xs font-bold tracking-[0.06em] whitespace-nowrap text-ink-2 tabular-nums md:col-start-2">
                  <span className="sr-only">{t('howTakes', { duration: t(`how${key}Dur`) })}</span>
                  <span aria-hidden="true">{t(`how${key}Dur`)}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-4 max-w-read text-pretty text-ink-2">
            <b className="font-bold text-ink">{t('demoNoteLead')}</b> {t('demoNote')}
          </p>
        </div>
      </section>

      {/* WHY CALLING WORKS · PRIVATE BY DESIGN · FREE FOR EVERYONE (H19, H20,
          H21, kept by the owner's marks): one closing band, three columns at
          md+, under the page's last 3px ink rule. Each keeps its own
          <section>. §6 rules unchanged for the support half: gated on the one
          DONATE_URL constant, a link out only, never a payment field here,
          and the not-tax-deductible line is the required truthful framing. */}
      <div className="mx-auto max-w-5xl px-4 pt-10 pb-8 md:pt-16 md:pb-16">
        <div
          className={`grid gap-10 border-t-[3px] border-ink pt-6 md:items-start md:gap-12 ${
            DONATE_URL ? 'md:grid-cols-3' : 'md:grid-cols-2'
          }`}
        >
          <section aria-labelledby="why-title">
            <h2 id="why-title" className="text-h2 font-extrabold">
              {t('whyTitle')}
            </h2>
            <p className="mt-3 max-w-note text-pretty text-ink-2">{t('whyBody')}</p>
            <Link
              href="/why-call"
              className="mt-4 inline-flex min-h-11 items-center gap-1.5 font-semibold text-go underline underline-offset-4 hover:text-go-deep"
            >
              {t('whyCta')}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </section>
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
                <span className="sr-only"> {t('supportOpens')}</span>
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
