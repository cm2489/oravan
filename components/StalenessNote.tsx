'use client';

import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { freshnessState } from '@/lib/freshness-state';

// Same hydration gate as UrgencyEmptyState: false on the server and the
// hydration render, true after — no state in an effect, no mismatch.
const emptySubscribe = () => () => {};
const useHydrated = () =>
  useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );

/*
 * R2 / KTD-2: the staleness note that still works when the sync is dead.
 * UrgencyEmptyState covers the EMPTY band, but a band that was hot at build
 * time keeps its baked cards forever if the pipeline dies - so every surface
 * that urges action mounts this sentinel INSIDE its "Data as of" stamp line.
 * It renders nothing while the data is fresh (and pre-hydration, so the
 * prerendered HTML never carries a clock-dependent verdict); once the
 * visitor's own clock says the last check is past the claim window, a quiet
 * caveat continues the stamp's own sentence. One line, one date: the old
 * two-line version repeated the date and read as a malfunction banner on
 * every core surface (2026-07 critique, unanimous).
 */
export function StalenessNote({ checkedAt }: { checkedAt: string }) {
  const t = useTranslations('freshness');
  const hydrated = useHydrated();

  if (!hydrated || freshnessState(checkedAt) === 'fresh') return null;

  return <span role="status"> — {t('staleNote')}</span>;
}
