import { useTranslations } from 'next-intl';

export default function Loading() {
  const t = useTranslations('common');
  return (
    <div className="mx-auto max-w-5xl px-4 py-12" role="status" aria-label={t('loading')}>
      <div className="h-9 w-64 animate-pulse rounded-control bg-paper-deep" />
      <div className="mt-3 h-5 w-full max-w-prose animate-pulse rounded-control bg-paper-deep" />
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-48 animate-pulse rounded-card bg-paper-deep" />
        ))}
      </div>
      <span className="sr-only">{t('loading')}</span>
    </div>
  );
}
