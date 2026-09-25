import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { glossaryTag } from '@/components/glossary-tags';
import { MomentCard, type MomentTeaser } from '@/components/MomentCard';
import { StalenessNote } from '@/components/StalenessNote';
import { AiNote } from '@/components/system';
import { getMoments, momentClaimsVehicles, vehicleKind, type MomentWithState } from '@/lib/moments';
import { latestVehicleAction, momentDek, momentStatus } from '@/lib/moments-ui';
import { latestUpdateDay } from '@/lib/moment-updates';
import { dataAsOfString, getFreshness } from '@/lib/freshness';
import { hreflangAlternates } from '@/lib/hreflang';

const localeText = (l: { en: string; es: string }, locale: string): string =>
  locale === 'es' ? l.es : l.en;

function toTeaser(m: MomentWithState, locale: string): MomentTeaser {
  return {
    id: m.id,
    name: localeText(m.name, locale),
    dek: momentDek(localeText(m.summary, locale)),
    category: m.category,
    // BY KIND, not a total — see MomentCard's countLine: no single sentence is
    // true of a moment holding both a bill and a nomination. Counted through
    // the one normalizer (absent `kind` means 'bill'), never off the slug.
    billCount: m.vehicles.filter((v) => vehicleKind(v) === 'bill').length,
    nominationCount: m.vehicles.filter((v) => vehicleKind(v) === 'nomination').length,
    // A recorded live-layer update is a stronger recency claim than a
    // vehicle's last action date (it is OUR record of the event, dated to
    // the legislative day); fall back to the bill-derived date otherwise.
    updatedDate: latestUpdateDay(m.id) ?? latestVehicleAction(m.vehicles),
    state: m.state,
    status: momentStatus(m.vehicles).lead,
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'moments' });
  return { title: t('indexTitle'), alternates: hreflangAlternates(locale, '/questions') };
}

export default async function MomentsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const freshness = getFreshness();
  const dataAsOf = await dataAsOfString(locale);

  // Retired moments never render here — a stored owner decision that takes a
  // moment off every index (spec §4.3).
  //
  // PAST-REVIEW RENDERS AS LIVE (owner, 2026-09-24). From 2026-09-18 (#252) a
  // `stale` entry — one whose review_by had passed — sat in its own "Under
  // review" section, which on the day every review date had lapsed left this
  // page with zero live questions while Congress was voting on all six. The
  // review date is a curation reminder, not a signal about the record, so it
  // now does that job where the owner will see it: scripts/moment-watch.mjs
  // flags a past-review question in the standing moment-review issue, and the
  // question's own page says when a person last reviewed its summary. What a
  // READER needs to know about currency is carried by each card's status line,
  // re-derived from the official record on every build (lib/moment-status.mjs).
  // `momentClaimsVehicles` is the same live-or-stale predicate the backlink,
  // the homepage band and search pinning read.
  const all = getMoments();
  const live = all.filter(momentClaimsVehicles);
  const settled = all.filter((m) => m.state === 'settled');

  return (
    <div className="mx-auto max-w-5xl px-4 pt-12 pb-16">
      <h1 className="text-h1-bill font-extrabold text-ink">{t('moments.indexTitle')}</h1>
      <p className="mt-4 max-w-read text-lede text-ink-2">{t('moments.indexSub')}</p>
      <p className="mt-3 max-w-read text-xs text-ink-2">
        {dataAsOf}
        <StalenessNote checkedAt={freshness.checkedAt} />
      </p>
      {/* AI labeled at first contact: every dek below is the first sentence
          of an AI-drafted summary, so the label sits above the grid — as a
          caption (AiNote), not the six lines of tracked capitals the chip
          made of this sentence. */}
      <AiNote marker={t('common.aiMarker')} className="mt-2 max-w-read">
        {t('moments.aiNote')}
      </AiNote>
      {/* The privacy line (v2 spec §7): threaded through, never a banner. It
          sits beside the AI note because the two are the same disclosure —
          here is what a machine wrote, and here is what nobody recorded about
          you reading it. Stated once, in ink, in the calm register: no
          "unlike them", no adversary, no claim about any named competitor. */}
      <p className="mt-3 max-w-read text-sm text-ink-2">{t('moments.updates.privacyNote')}</p>

      {/* The section that asks something of the reader takes the full 3px ink
          rule; the record below it takes a hairline. `line` is a separator
          tone, never a component edge. */}
      <section className="mt-12 border-t-[3px] border-ink pt-4" aria-labelledby="moments-live">
        <h2 id="moments-live" className="text-h2 font-extrabold text-ink">
          {t('moments.liveHeading')}
        </h2>
        <p className="mt-2 max-w-read text-sm text-ink-2">{t('moments.liveSub')}</p>

        {live.length > 0 ? (
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {live.map((m) => (
              <MomentCard key={m.id} moment={toTeaser(m, locale)} />
            ))}
          </div>
        ) : (
          /* Opened by the same 3px ink rule that opens a section — the page
             already knows that mark means "stop and read this". A wash
             ground with no side edges, so no `line-strong`-on-wash edge is
             ever asked to clear 3:1 (it lands at 2.97). */
          <div className="mt-6 max-w-read border-t-[3px] border-ink bg-wash p-6">
            <p className="text-lg font-bold text-ink">{t('moments.emptyTitle')}</p>
            <p className="mt-2 text-sm text-ink-2">{t('moments.emptyBody')}</p>
            <p className="mt-5">
              <Link
                href="/bills"
                className="inline-flex min-h-12 items-center justify-center rounded-control border-2 border-ink bg-paper px-5 text-sm font-bold text-ink transition-colors hover:bg-ink hover:text-paper"
              >
                {t('moments.browseBillsCta')}
              </Link>
            </p>
          </div>
        )}

        {/* Scarcity note (spec §4.3 / mockup annotation 6): the cap keeps
            curation honest — the count is the moments actually reading as
            live right now, which is now exactly the grid above it. Suppressed
            at zero, where the empty state has already said the same thing in
            words and "never more than 6" would be a boast about an empty
            shelf; the homepage band takes the same posture, disappearing
            rather than printing a nought. */}
        {live.length > 0 && (
          <p className="mt-6 max-w-read text-sm text-ink-2">
            {t('moments.scarcityNote', { count: live.length })}
          </p>
        )}
      </section>

      {settled.length > 0 && (
        <section className="mt-12 border-t border-line pt-4" aria-labelledby="moments-settled">
          <h2 id="moments-settled" className="text-h3 font-bold text-ink-2">
            {t('moments.settledHeading')}
          </h2>
          <p className="mt-2 max-w-read text-sm text-ink-2">{t('moments.settledSub')}</p>
          {/* No opacity dimmer: quieter is carried by the heading's weight and
              the hairline rule, never by washing out real text. */}
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {settled.map((m) => (
              <MomentCard key={m.id} moment={toTeaser(m, locale)} />
            ))}
          </div>
        </section>
      )}

      {/* Criteria explainer — the mockup's "How Moments get made →" link
          (spec §3.1) points here: this page is the criteria's one home. */}
      <section id="how" className="mt-12 border-t border-line pt-4" aria-labelledby="how-heading">
        <h2 id="how-heading" className="text-h3 font-bold text-ink">
          {t('moments.howMadeHeading')}
        </h2>
        <p className="mt-3 max-w-read text-sm text-ink-2">{t('moments.howMadeBody')}</p>
        {/* A ruled list, which is how a document states terms — not bullets. */}
        <ul className="mt-5 max-w-read list-none">
          <li className="border-t border-line-strong py-3 text-sm text-ink-2">{t('moments.howMadeRule1')}</li>
          {/* Rule 2 is the one place in the whole product where "cloture" and
              "the Senate Executive Calendar" are already written into
              hand-authored copy, so it is the glossary's first wiring site
              (issue #181). The tags carry the link INSIDE the sentence; the
              sentence itself is unchanged in both languages. */}
          <li className="border-t border-line-strong py-3 text-sm text-ink-2">
            {t.rich('moments.howMadeRule2', {
              cloture: glossaryTag('cloture'),
              execCalendar: glossaryTag('executive-calendar'),
            })}
          </li>
          <li className="border-t border-line-strong py-3 text-sm text-ink-2">{t('moments.howMadeRule3')}</li>
          <li className="border-t border-line-strong py-3 text-sm text-ink-2">{t('moments.howMadeRule4')}</li>
        </ul>
      </section>
    </div>
  );
}
