import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { MomentCard, type MomentTeaser } from '@/components/MomentCard';
import { StalenessNote } from '@/components/StalenessNote';
import { Chip } from '@/components/system';
import { getMoments, vehicleKind, type MomentWithState } from '@/lib/moments';
import { latestVehicleAction, momentDek } from '@/lib/moments-ui';
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
  // moment off every index (spec §4.3). 'stale' still renders inside the
  // live section (with its own quiet badge on the card): it's dropped from
  // the homepage strip and search pinning, not from this page.
  const all = getMoments();
  const live = all.filter((m) => m.state === 'live' || m.state === 'stale');
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
          of an AI-drafted summary, so the label sits above the grid. */}
      <p className="mt-5">
        <Chip tone="ai" marker={t('common.aiMarker')} className="max-w-read">
          {t('moments.aiNote')}
        </Chip>
      </p>
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
            curation honest — count reflects moments actually reading as
            live right now, not the stored total, which can also include
            settled or stale entries the file keeps for the record. */}
        <p className="mt-6 max-w-read text-sm text-ink-2">
          {t('moments.scarcityNote', { count: live.filter((m) => m.state === 'live').length })}
        </p>
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
          <li className="border-t border-line-strong py-3 text-sm text-ink-2">{t('moments.howMadeRule2')}</li>
          <li className="border-t border-line-strong py-3 text-sm text-ink-2">{t('moments.howMadeRule3')}</li>
          <li className="border-t border-line-strong py-3 text-sm text-ink-2">{t('moments.howMadeRule4')}</li>
        </ul>
      </section>
    </div>
  );
}
