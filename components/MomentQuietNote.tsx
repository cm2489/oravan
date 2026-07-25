'use client';

import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { freshnessState } from '@/lib/freshness-state';

// Same hydration gate as StalenessNote / UrgencyEmptyState: false on the
// server and on the hydration render, true after — no state in an effect, no
// mismatch.
const emptySubscribe = () => () => {};
const useHydrated = () =>
  useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );

/*
 * "Nothing moved" and "we couldn't check" are DIFFERENT SENTENCES
 * (docs/ideation/2026-07-25-moments-v2.md §3) — and this component exists
 * because only one of them is knowable at build time.
 *
 * The quiet-day lines themselves ("nothing recorded yet today" vs. a past
 * day's plain "nothing recorded") are server-rendered by
 * components/MomentTimeline.tsx off the reader's own `isToday` flag: they are
 * statements about the RECORD, which does not change between the build and
 * the visitor. This sentinel carries the other sentence — the one about OUR
 * PIPELINE — and it cannot be baked, for the same reason StalenessNote
 * cannot: a verdict computed at build time would freeze as "fresh" forever
 * on a ~1,000-page static site the moment the sync dies, which is precisely
 * the silent failure the KTD-2 beacon pattern was introduced to close.
 *
 * So: renders nothing while the visitor's own clock says the last check is
 * inside the claim window, and nothing pre-hydration (the prerendered HTML
 * never carries a clock-dependent claim). Once the check has gone stale it
 * CONTINUES the timeline lede's sentence — one line, one date, the same
 * grammar as StalenessNote — so a reader knows an empty ledger below may be
 * our silence rather than Congress's.
 *
 * `dateLabel` arrives pre-localized from the server, the same discipline the
 * design system's primitives use for every date: the formatter and the clock
 * stay on one side of the boundary.
 */
export function MomentQuietNote({ checkedAt, dateLabel }: { checkedAt: string; dateLabel: string }) {
  const t = useTranslations('moments.updates');
  const hydrated = useHydrated();

  if (!hydrated || freshnessState(checkedAt) === 'fresh') return null;

  return <span role="status"> — {t('checkGapNote', { date: dateLabel })}</span>;
}
