import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ExternalLink } from 'lucide-react';
import { setRequestLocale, getTranslations, getFormatter } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { statusKeyFor } from '@/lib/journey';
import { routing } from '@/i18n/routing';
import { MomentQuietNote } from '@/components/MomentQuietNote';
import { MomentTimeline, type TimelineVehicle } from '@/components/MomentTimeline';
import { MomentVehicleCard } from '@/components/MomentVehicleCard';
import { StalenessNote } from '@/components/StalenessNote';
import { Chip } from '@/components/system';
import { getBill, localizeBill } from '@/lib/core';
import { getCoverage, normalizeSource } from '@/lib/coverage';
import { formatCitation } from '@/lib/format';
import { dataAsOfString, getFreshness } from '@/lib/freshness';
import { hreflangAlternates } from '@/lib/hreflang';
import {
  RENDER_DAY_CAP,
  VERBATIM_MODE,
  getCurrentSummary,
  getRevisions,
  isAiSummary,
} from '@/lib/moment-updates';
import { getMoment, getMoments, type QualifyingSignalType } from '@/lib/moments';
import { linkHost, momentDek, revisionReasons } from '@/lib/moments-ui';

const localeText = (l: { en: string; es: string }, locale: string): string =>
  locale === 'es' ? l.es : l.en;

const SIGNAL_TYPES: QualifyingSignalType[] = ['tier0_floor', 'tier0_scheduled', 'tier0_most_viewed', 'press'];

/* Content links are green — green means GO, and a link goes somewhere.
   Navigation chrome (the crumb) stays ink, per the color law's split. */
const CONTENT_LINK =
  'inline-flex min-h-11 items-center gap-2 font-bold text-go underline transition-colors hover:text-go-deep';

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
  const isStale = moment.state === 'stale';

  const liveCount = getMoments().filter((m) => m.state === 'live').length;

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

  // Does the vehicles grid actually print AI text? A decoded headline is
  // model-written; the official title it falls back to is not (see the chip
  // beside the grid below). Resolved through the SAME localize call the cards
  // render with, so the answer is about this locale's headlines, not English's.
  const vehicleHeadlinesAreAi = moment.vehicles.some((v) => {
    const raw = getBill(v.slug);
    return raw ? Boolean(localizeBill(raw, locale).ai_headline) : false;
  });

  // Citation + Congress.gov actions page per vehicle, resolved here so the
  // timeline stays a pure renderer and never reaches into the bill corpus.
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

  return (
    <article className="mx-auto max-w-3xl px-4 pt-12 pb-16">
      {/* 1 · Moment header */}
      <p className="flex flex-wrap items-center gap-3 text-sm">
        <Link
          href="/questions"
          className="inline-flex min-h-11 items-center font-semibold text-ink-2 underline transition-colors hover:text-ink"
        >
          {t('moments.crumb')}
        </Link>
        <span className="text-2xs leading-tight font-extrabold tracking-[0.1em] text-ink-2 uppercase">
          {isSettled ? t('moments.settledBadge') : isStale ? t('moments.staleBadge') : t('moments.liveBadge')}
        </span>
        <Chip tone="tag">{t(`categories.${moment.category}`)}</Chip>
      </p>

      <h1 className="mt-4 text-h1-bill font-extrabold text-ink">{name}</h1>
      <p className="mt-5 max-w-read text-xs text-ink-2">
        {dataAsOf}
        <StalenessNote checkedAt={freshness.checkedAt} />
      </p>

      {/* Late is not urgent: a review that lapsed is an ink caveat opened by
          the "stop and read this" rule, never amber and never `alert`. */}
      {isStale && (
        <p className="mt-6 max-w-read border-t-[3px] border-ink bg-wash px-4 py-3 text-sm text-ink-2">
          {t('moments.staleBanner', { date: fmtDate(moment.review_by) })}
        </p>
      )}

      {/* 2 · The Moment entry's own summary — the page's one reading passage,
          and so the one place Besley is spent. Provenance, spelled out because
          this page renders two passages with DIFFERENT provenance and the
          comment here used to name only one of them: this one comes from
          data/moments.json, which is hand-authored and merged by the owner —
          the explicit carve-out in CLAUDE.md's 2026-07-25 amendment, and what
          moments.howMadeBody promises. The "Where it stands" revision further
          down is the opposite: machine-written, gate-checked, published with
          no human step. Never let the two blur. */}
      <section aria-labelledby="deciding" className="mt-12 border-t-[3px] border-ink pt-4">
        <h2 id="deciding" className="text-h2 font-extrabold text-ink">
          {isSettled ? t('moments.decidingSettled') : t('moments.decidingLive')}
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
      </section>

      {/* 3 · "Where it stands" — the machine-written state summary (v2 spec
          §7). It sits BELOW the hand-authored section above on purpose: the
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

      {/* 5 · The vehicles */}
      <section className="mt-12 border-t border-line pt-4" aria-labelledby="vehicles-h">
        <h2 id="vehicles-h" className="text-h2 font-extrabold text-ink">
          {t('moments.vehiclesHeading')}
        </h2>
        <p className="mt-2 max-w-read text-sm text-ink-2">{t('moments.vehiclesLede')}</p>
        {/* Every card below leads with an AI-decoded headline, and the card's
            CTA is the phone call — so this was the one place on the site where
            unlabeled AI text sat directly on the control that drives a call
            (pre-launch audit 2026-07-25, constitution-05). The label is the
            same sentence /bills prints over the same decoded headlines, in the
            same chip, at first contact — above the grid, never in a footnote.
            DATA-GATED like every other AI chip here: a vehicle whose decode is
            still pending falls back to its official title, which is not AI
            text, so a grid with no decode in it carries no label. */}
        {vehicleHeadlinesAreAi && (
          <p className="mt-5">
            <Chip tone="ai" marker={t('common.aiMarker')} className="max-w-read">
              {t('bills.aiNote')}
            </Chip>
          </p>
        )}

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {moment.vehicles.map((v) => {
            const raw = getBill(v.slug);
            if (!raw) return null;
            const bill = localizeBill(raw, locale);
            const coverageCount = new Set(getCoverage(v.slug).map((a) => normalizeSource(a.source))).size;
            return (
              <MomentVehicleCard
                key={v.slug}
                slug={v.slug}
                identifier={formatCitation(bill.bill_type, bill.bill_number)}
                headline={bill.ai_headline}
                title={bill.short_title ?? bill.title}
                status={bill.status}
                statusKey={statusKeyFor(bill.status, bill.last_action_text)}
                tags={bill.issue_tags ?? []}
                lastActionDate={bill.last_action_date}
                coverageCount={coverageCount}
                role={localeText(v.role, locale)}
                ctaLabel={isSettled ? t('moments.readBill') : t('moments.readCall')}
                calendarLabel={t('bills.onCalendar')}
              />
            );
          })}
        </div>

        <p className="mt-6 max-w-read text-sm text-ink-2">{t('moments.bothNote')}</p>
      </section>

      {/* 6 · Why this Moment exists */}
      <section className="mt-12 border-t border-line pt-4" aria-labelledby="why-h">
        <h2 id="why-h" className="text-xs leading-tight font-extrabold tracking-[0.1em] text-ink-2 uppercase">
          {t('moments.whyHeading')}
        </h2>
        <p className="mt-3 max-w-read text-sm text-ink-2">{t('moments.whyCriteria')}</p>

        <p className="mt-5 text-sm font-bold text-ink">{t('moments.signalLabel')}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2">
          {/* the signal is a LABEL — an ink mark. The evidence beside it is a
              set of links, so it is set as links, in the go tone. */}
          <Chip tone="tag">
            {SIGNAL_TYPES.includes(moment.qualifying_signal.type)
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
            <ul className="mt-2 max-w-read list-none">
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

        <p className="mt-5">
          <Link href="/questions#how" className={`${CONTENT_LINK} text-sm`}>
            {t('moments.howMadeLink')} →
          </Link>
        </p>

        {!isSettled && (
          <p className="mt-5 max-w-read border-t border-line pt-4 text-sm text-ink-2">
            {t('moments.lifecycleLive')}
          </p>
        )}
      </section>

      {/* 7 · Browse-all affordance (scarcity) */}
      <p className="mt-12 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-line pt-4">
        <Link href="/questions" className={CONTENT_LINK}>
          {t('moments.browseAll')} →
        </Link>
        <span className="text-xs text-ink-2">{t('moments.scarcityNote', { count: liveCount })}</span>
      </p>
    </article>
  );
}
