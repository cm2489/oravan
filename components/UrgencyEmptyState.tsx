'use client';

import { useSyncExternalStore } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { emptyStateVerdict, type FreshnessSignals } from '@/lib/freshness-state';
import { SIGNAL_STALE_HOURS } from '@/lib/docket.mjs';

/** The floor-schedule half of the verdict: every source answered for itself,
 *  and the file carrying their answers was refreshed inside the same window the
 *  ladder trusts a T0 claim for. */
function floorSignalsHealthy(
  { checkedAt, sourcesHealthy }: { checkedAt: string | null; sourcesHealthy: boolean },
  now: number = Date.now()
): boolean {
  if (!sourcesHealthy) return false;
  const stamp = checkedAt ? Date.parse(checkedAt) : NaN;
  if (!Number.isFinite(stamp)) return false;
  return now - stamp <= SIGNAL_STALE_HOURS * 3_600_000;
}

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
 *    AND the sync cursor/corpus itself shows real recent progress - a real
 *    quiet week, said plainly instead of backfilled from rank.
 *  - data stale: either the last successful check is older than its claim
 *    window, or the sync cursor / newest known activity has gone dark past
 *    the wider dead window (lib/freshness-state.ts's emptyStateVerdict has
 *    the full threshold reasoning) - an empty list might just mean "we
 *    haven't actually looked lately," and the copy says that, not "quiet."
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
export function UrgencyEmptyState({
  checkedAt,
  completeThrough,
  newestAction,
  floorSignals,
}: FreshnessSignals & {
  /**
   * THE FOURTH SIGNAL (critic A-5, 2026-08-12): what the chamber-schedule
   * sources said about THEMSELVES on the last hourly run.
   *
   * The three signals above measure our nightly bill sync. This one measures
   * the hourly floor-schedule fetch, and it exists because a quiet week and a
   * broken fetch look identical from here: `docs.house.gov/billsthisweek` 404s
   * during a recess AND would 404 if its URL scheme ever changed — which is
   * exactly how the AP RSS feed died in this codebase's own dead-feed log. So
   * `sourcesHealthy` is true only when EVERY source came back `ok` (it named
   * measures) or `quiet` (it, or the other source cross-checking it, says the
   * chamber is not meeting). Anything else — a fetch error, a 404 nothing
   * corroborates — is a statement about US, and it collapses to data_stale.
   *
   * `checkedAt` is re-diffed here rather than upstream for the same reason the
   * rest of this component is client-side: a server-rendered verdict freezes
   * at build time, and a workflow that quietly died would read as fresh
   * forever.
   *
   * Optional, and its absence changes nothing: a caller with no floor-schedule
   * context (the /bills band, /reps) keeps exactly today's three-signal
   * verdict.
   */
  floorSignals?: { checkedAt: string | null; sourcesHealthy: boolean };
}) {
  const t = useTranslations('freshness');
  const format = useFormatter();
  const hydrated = useHydrated();

  const date = format.dateTime(new Date(checkedAt), { year: 'numeric', month: 'long', day: 'numeric' });

  if (!hydrated) {
    // Pre-hydration / no-JS: state the plain fact, judge nothing.
    return (
      <div role="status" className="rounded-control bg-wash p-6">
        <p className="max-w-read text-sm text-ink-2">{t('dataAsOf', { date })}</p>
      </div>
    );
  }

  const floorStale = floorSignals ? !floorSignalsHealthy(floorSignals) : false;
  const staleVerdict =
    floorStale || emptyStateVerdict({ checkedAt, completeThrough, newestAction }) === 'data_stale';
  return (
    <div role="status" className="rounded-control bg-wash p-6">
      <p className="text-lg font-bold text-ink">
        {staleVerdict ? t('dataStaleTitle') : t('quietWeekTitle')}
      </p>
      <p className="mt-1 max-w-read text-sm text-ink-2">
        {staleVerdict ? t('dataStaleBody', { date }) : t('quietWeekBody')}
      </p>
    </div>
  );
}
