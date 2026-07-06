import type { Metadata } from 'next';
import { Info } from 'lucide-react';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { ZipForm } from '@/components/ZipForm';
import { AddressForm } from '@/components/AddressForm';
import { RepCard } from '@/components/RepCard';
import { Link } from '@/i18n/navigation';
import { districtsForZip, repsForDistrict } from '@/lib/core';
import { parseDistrictParam } from '@/lib/district';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'reps' });
  return { title: t('title') };
}

export default async function RepsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ zip?: string; district?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { zip, district: districtParam } = await searchParams;
  const t = await getTranslations('reps');

  const candidates = zip && /^\d{5}$/.test(zip) ? districtsForZip(zip) : [];

  // Address refinement lands here as ?district=NY-12 - only the derived
  // district, never the address. A param that names no actual House seat
  // (or arrives without a valid ZIP) is ignored and the ZIP's candidate
  // districts render as usual.
  const parsed = zip && /^\d{5}$/.test(zip) ? parseDistrictParam(districtParam) : null;
  const refined =
    parsed && repsForDistrict(parsed).some((r) => r.type === 'rep') ? parsed : null;
  const refinedOutsideZip =
    !!refined &&
    candidates.length > 0 &&
    !candidates.some((c) => c.state === refined.state && c.district === refined.district);

  const districts = refined ? [refined] : candidates;

  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <h1 className="font-display text-4xl font-bold">{t('title')}</h1>
      <p className="mt-2 max-w-prose text-ink-soft">{t('sub')}</p>

      {!zip && (
        <div className="mt-8 rounded-card border border-line bg-surface p-6 shadow-lift max-w-xl">
          <p className="mb-4 font-medium">{t('noZip')}</p>
          <ZipForm autoFocus />
        </div>
      )}

      {zip && districts.length === 0 && (
        <div className="mt-8 rounded-card border border-clay/30 bg-clay-soft p-6 max-w-xl" role="alert">
          <p className="font-medium text-ink">{t('zipNotFound')}</p>
          <div className="mt-4">
            <ZipForm />
          </div>
        </div>
      )}

      {refined && zip && (
        <div className="mt-6 max-w-prose rounded-card border border-booth/40 bg-booth-soft p-4 text-sm">
          <p className="flex gap-2">
            <Info className="h-5 w-5 shrink-0 text-ink-soft" aria-hidden />
            <span>
              {t('refinedNote')}
              {refinedOutsideZip && <> {t('refinedOutsideZip', { zip })}</>}
            </span>
          </p>
          <p className="mt-2 pl-7">
            <Link href={`/reps?zip=${zip}`} className="underline underline-offset-2">
              {t('showAllDistricts', { zip })}
            </Link>
          </p>
        </div>
      )}

      {!refined && districts.length > 1 && zip && (
        <>
          <p className="mt-6 flex max-w-prose gap-2 rounded-card border border-booth/40 bg-booth-soft p-4 text-sm">
            <Info className="h-5 w-5 shrink-0 text-ink-soft" aria-hidden />
            {t('multiDistrict')}
          </p>
          <AddressForm zip={zip} />
        </>
      )}

      {districts.map((d) => {
        const reps = repsForDistrict(d);
        const noSenators = reps.every((r) => r.type !== 'sen');
        return (
          <section key={`${d.state}-${d.district}`} className="mt-10" aria-label={`${d.state} ${d.district}`}>
            <h2 className="font-display text-2xl font-bold">
              {d.district === 0
                ? t('atLargeHeading', { state: d.state })
                : t('districtHeading', { state: d.state, district: d.district })}
            </h2>
            {noSenators && (
              <p className="mt-3 flex max-w-prose gap-2 rounded-card border border-booth/40 bg-booth-soft p-4 text-sm">
                <Info className="h-5 w-5 shrink-0 text-ink-soft" aria-hidden />
                {t('delegateNote', { state: d.state })}
              </p>
            )}
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              {reps.map((r) => (
                <RepCard key={r.bioguide} rep={r} />
              ))}
            </div>
          </section>
        );
      })}

      {zip && districts.length > 0 && (
        <p className="mt-10 text-sm text-ink-faint">
          ZIP {zip} ·{' '}
          <Link href="/reps" className="underline underline-offset-2">
            {t('changeZip')}
          </Link>
        </p>
      )}
    </div>
  );
}
