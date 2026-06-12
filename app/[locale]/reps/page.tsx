import type { Metadata } from 'next';
import { Info } from 'lucide-react';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { ZipForm } from '@/components/ZipForm';
import { RepCard } from '@/components/RepCard';
import { Link } from '@/i18n/navigation';
import { districtsForZip, repsForDistrict } from '@/lib/data';

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
  searchParams: Promise<{ zip?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { zip } = await searchParams;
  const t = await getTranslations('reps');

  const districts = zip && /^\d{5}$/.test(zip) ? districtsForZip(zip) : [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <h1 className="font-display text-4xl font-bold">{t('title')}</h1>
      <p className="mt-2 max-w-prose text-ink-soft">{t('sub')}</p>

      {!zip && (
        <div className="mt-8 rounded-card border border-line bg-white p-6 shadow-lift max-w-xl">
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

      {districts.length > 1 && (
        <p className="mt-6 flex max-w-prose gap-2 rounded-card border border-booth/40 bg-booth-soft p-4 text-sm">
          <Info className="h-5 w-5 shrink-0 text-ink-soft" aria-hidden />
          {t('multiDistrict')}
        </p>
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
