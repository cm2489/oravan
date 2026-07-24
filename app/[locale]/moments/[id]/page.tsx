import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ExternalLink } from 'lucide-react';
import { setRequestLocale, getTranslations, getFormatter } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { MomentVehicleCard } from '@/components/MomentVehicleCard';
import { StalenessNote } from '@/components/StalenessNote';
import { getBill, localizeBill } from '@/lib/core';
import { getCoverage, normalizeSource } from '@/lib/coverage';
import { formatCitation } from '@/lib/format';
import { dataAsOfString, getFreshness } from '@/lib/freshness';
import { hreflangAlternates } from '@/lib/hreflang';
import { getMoment, getMoments, type QualifyingSignalType } from '@/lib/moments';
import { momentDek } from '@/lib/moments-ui';

const localeText = (l: { en: string; es: string }, locale: string): string =>
  locale === 'es' ? l.es : l.en;

const SIGNAL_TYPES: QualifyingSignalType[] = ['tier0_floor', 'tier0_scheduled', 'tier0_most_viewed', 'press'];

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
    alternates: hreflangAlternates(locale, `/moments/${id}`),
    openGraph: {
      title,
      description,
      siteName: 'Oravan',
      type: 'website',
      locale: locale === 'es' ? 'es_ES' : 'en_US',
      alternateLocale: locale === 'es' ? 'en_US' : 'es_ES',
    },
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
  const fmtDate = (d: string) =>
    format.dateTime(new Date(d), { year: 'numeric', month: 'long', day: 'numeric' });
  const dataAsOf = await dataAsOfString(locale);
  const freshness = getFreshness();

  const name = localeText(moment.name, locale);
  const dek = momentDek(localeText(moment.summary, locale));
  const summary = localeText(moment.summary, locale);
  const isSettled = moment.state === 'settled';
  const isStale = moment.state === 'stale';

  const liveCount = getMoments().filter((m) => m.state === 'live').length;

  return (
    <article className="mx-auto max-w-3xl px-4 pt-12 pb-16">
      {/* 1 · Moment header */}
      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink-faint">
        <Link href="/moments" className="text-ink-faint underline underline-offset-4 hover:text-ink">
          {t('moments.crumb')}
        </Link>
        <span aria-hidden>·</span>
        <span className="uppercase tracking-wide">
          {isSettled ? t('moments.settledBadge') : isStale ? t('moments.staleBadge') : t('moments.liveBadge')}
        </span>
        <span className="rounded-full bg-brass-soft px-2.5 py-1 text-xs font-medium normal-case text-ink">
          {t(`categories.${moment.category}`)}
        </span>
      </p>

      <h1 className="mt-3 font-display text-3xl md:text-4xl font-bold leading-tight">{name}</h1>
      <p className="mt-2.5 max-w-prose text-[1.0625rem] text-ink-soft">{dek}</p>
      <p className="mt-2 max-w-prose text-xs text-ink-faint">
        {dataAsOf}
        <StalenessNote checkedAt={freshness.checkedAt} />
      </p>

      {isStale && (
        <p className="mt-3 max-w-prose rounded-control border border-line bg-paper-deep px-4 py-3 text-sm text-ink-soft">
          {t('moments.staleBanner', { date: fmtDate(moment.review_by) })}
        </p>
      )}

      {/* 2 · AI-drafted, human-reviewed summary */}
      <section aria-labelledby="deciding" className="mt-8 rounded-card border border-line bg-paper-deep p-6 md:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="deciding" className="font-display text-2xl font-bold">
            {isSettled ? t('moments.decidingSettled') : t('moments.decidingLive')}
          </h2>
          <span className="rounded-full bg-brass-soft px-2.5 py-1 text-xs font-semibold text-ink">
            {t('bill.aiChip')}
          </span>
        </div>
        {isSettled && <p className="mt-3 font-semibold text-ink">{t('moments.settledBanner')}</p>}
        <p className="mt-3.5 max-w-prose text-ink">{summary}</p>
        <p className="mt-4 text-xs font-medium text-ink-soft">{t('bill.aiDisclaimer')}</p>
      </section>

      {/* 3 · The vehicles */}
      <section className="mt-10" aria-labelledby="vehicles-h">
        <h2 id="vehicles-h" className="font-display text-2xl font-bold">
          {t('moments.vehiclesHeading')}
        </h2>
        <p className="mt-1.5 max-w-prose text-sm text-ink-soft">{t('moments.vehiclesLede')}</p>

        <div className="mt-5 grid gap-5 sm:grid-cols-2">
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
                tags={bill.issue_tags ?? []}
                lastActionDate={bill.last_action_date}
                coverageCount={coverageCount}
                role={localeText(v.role, locale)}
                ctaLabel={isSettled ? t('moments.readBill') : t('moments.readCall')}
              />
            );
          })}
        </div>

        <p className="mt-4 max-w-prose text-sm text-ink-faint">{t('moments.bothNote')}</p>
      </section>

      {/* 4 · Why this Moment exists */}
      <section className="mt-10 rounded-card border border-line bg-surface p-6" aria-labelledby="why-h">
        <h2 id="why-h" className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
          {t('moments.whyHeading')}
        </h2>
        <p className="mt-2.5 max-w-prose text-[0.9375rem] text-ink-soft">{t('moments.whyCriteria')}</p>

        <p className="mt-4 text-sm font-semibold text-ink">{t('moments.signalLabel')}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1.5 text-xs font-medium text-ink-soft">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
            {SIGNAL_TYPES.includes(moment.qualifying_signal.type)
              ? t(`moments.signalType.${moment.qualifying_signal.type}`)
              : moment.qualifying_signal.type}
          </span>
          {moment.qualifying_signal.refs.map((ref, i) => (
            <a
              key={ref}
              href={ref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1.5 text-xs font-medium text-ink-soft hover:text-ink"
            >
              {t('moments.evidenceLink', { index: i + 1 })}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          ))}
        </div>

        <Link
          href="/moments#how"
          className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-ink underline underline-offset-4"
        >
          {t('moments.howMadeLink')} →
        </Link>

        {!isSettled && (
          <p className="mt-4 border-t border-line pt-4 text-sm italic text-ink-faint">
            {t('moments.lifecycleLive')}
          </p>
        )}
      </section>

      {/* 5 · Browse-all affordance (scarcity) */}
      <p className="mt-8 flex flex-wrap items-baseline gap-2 text-[0.9375rem]">
        <Link
          href="/moments"
          className="inline-flex min-h-11 items-center font-semibold text-ink underline underline-offset-4"
        >
          {t('moments.browseAll')} →
        </Link>
        <span className="text-xs text-ink-faint">{t('moments.scarcityNote', { count: liveCount })}</span>
      </p>
    </article>
  );
}
