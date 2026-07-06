'use client';

import { useSyncExternalStore } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { emptyStateVerdict } from '@/lib/freshness-state';

// The React-idiomatic hydration gate: server snapshot (and the hydration
// render) reads false, the first client snapshot reads true. No state, no
// effect, no cascading render — and SSR HTML always matches hydration HTML.
const emptySubscribe = () => () => {};
const useHydrated = () =>
  useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );

/*
 * KTD-2 / AE3: renders when "Act now" (or "worth a call this week") has zero
 * bills clearing the urgency floor. Which of the two honest messages shows
 * depends on whether the data itself is trustworthy right now:
 *  - quiet week: floor cleared no bills, but the corpus was checked recently
 *    - a real quiet week, said plainly instead of backfilled from rank.
 *  - data stale: the last successful check is older than the claim window,
 *    so an empty list might just mean "we haven't looked lately" - the copy
 *    says that, not "quiet."
 *
 * This must stay a client component: the site is largely static-generated,
 * so a server-rendered verdict freezes at build time and a dead sync would
 * read as "fresh" forever to anyone loading the page after deploys stop.
 *
 * The verdict is computed only after hydration. The prerendered HTML (and
 * the hydration render, so they always match) carries verdict-neutral copy -
 * just the checked date - because the build machine's clock can't speak for
 * the visitor's: baked "quiet week" HTML would flash (or, with JS off,
 * permanently claim) quiet on long-dead data.
 */
export function UrgencyEmptyState({ checkedAt }: { checkedAt: string }) {
  const t = useTranslations('freshness');
  const format = useFormatter();
  const hydrated = useHydrated();

  const date = format.dateTime(new Date(checkedAt), { year: 'numeric', month: 'long', day: 'numeric' });

  if (!hydrated) {
    // Pre-hydration / no-JS: state the plain fact, judge nothing.
    return (
      <div role="status" className="rounded-card border border-line bg-paper-deep p-6">
        <p className="max-w-prose text-sm text-ink-soft">{t('dataAsOf', { date })}</p>
      </div>
    );
  }

  const staleVerdict = emptyStateVerdict(checkedAt) === 'data_stale';
  return (
    <div role="status" className="rounded-card border border-line bg-paper-deep p-6">
      <p className="font-display text-lg font-semibold text-ink">
        {staleVerdict ? t('dataStaleTitle') : t('quietWeekTitle')}
      </p>
      <p className="mt-1 max-w-prose text-sm text-ink-soft">
        {staleVerdict ? t('dataStaleBody', { date }) : t('quietWeekBody')}
      </p>
    </div>
  );
}
