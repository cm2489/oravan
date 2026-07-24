import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { MomentCard, type MomentTeaser } from '@/components/MomentCard';
import { StalenessNote } from '@/components/StalenessNote';
import { getMoments, type MomentWithState } from '@/lib/moments';
import { latestVehicleAction, momentDek } from '@/lib/moments-ui';
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
    vehicleCount: m.vehicles.length,
    updatedDate: latestVehicleAction(m.vehicles),
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
  return { title: t('indexTitle'), alternates: hreflangAlternates(locale, '/moments') };
}

export default async function MomentsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('moments');
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
    <div className="mx-auto max-w-5xl px-4 py-12">
      <h1 className="font-display text-4xl font-bold">{t('indexTitle')}</h1>
      <p className="mt-2 max-w-prose text-ink-soft">{t('indexSub')}</p>
      <p className="mt-1 max-w-prose text-xs text-ink-faint">
        {dataAsOf}
        <StalenessNote checkedAt={freshness.checkedAt} />
      </p>

      <section className="mt-10" aria-labelledby="moments-live">
        <h2 id="moments-live" className="font-display text-2xl font-bold">
          {t('liveHeading')}
        </h2>
        <p className="mt-1 text-sm text-ink-soft">{t('liveSub')}</p>

        {live.length > 0 ? (
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {live.map((m) => (
              <MomentCard key={m.id} moment={toTeaser(m, locale)} />
            ))}
          </div>
        ) : (
          <div className="mt-6 rounded-card border border-line bg-paper-deep p-6">
            <p className="font-semibold">{t('emptyTitle')}</p>
            <p className="mt-1.5 max-w-prose text-sm text-ink-soft">{t('emptyBody')}</p>
            <Link
              href="/bills"
              className="mt-4 inline-flex min-h-11 items-center font-semibold underline underline-offset-4"
            >
              {t('browseBillsCta')}
            </Link>
          </div>
        )}

        {/* Scarcity note (spec §4.3 / mockup annotation 6): the cap keeps
            curation honest — count reflects moments actually reading as
            live right now, not the stored total, which can also include
            settled or stale entries the file keeps for the record. */}
        <p className="mt-4 text-sm text-ink-faint">{t('scarcityNote', { count: live.filter((m) => m.state === 'live').length })}</p>
      </section>

      {settled.length > 0 && (
        <section className="mt-12 border-t border-line pt-8" aria-labelledby="moments-settled">
          <h2 id="moments-settled" className="font-display text-xl font-semibold text-ink-soft">
            {t('settledHeading')}
          </h2>
          <p className="mt-1 text-sm text-ink-faint">{t('settledSub')}</p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 opacity-90">
            {settled.map((m) => (
              <MomentCard key={m.id} moment={toTeaser(m, locale)} />
            ))}
          </div>
        </section>
      )}

      {/* Criteria explainer — the mockup's "How Moments get made →" link
          (spec §3.1) points here: this page is the criteria's one home. */}
      <section id="how" className="mt-12 border-t border-line pt-8" aria-labelledby="how-heading">
        <h2 id="how-heading" className="font-display text-xl font-semibold">
          {t('howMadeHeading')}
        </h2>
        <p className="mt-2 max-w-prose text-sm text-ink-soft">{t('howMadeBody')}</p>
        <ul className="mt-4 max-w-prose space-y-2 text-sm text-ink-soft">
          <li>{t('howMadeRule1')}</li>
          <li>{t('howMadeRule2')}</li>
          <li>{t('howMadeRule3')}</li>
          <li>{t('howMadeRule4')}</li>
        </ul>
      </section>
    </div>
  );
}
