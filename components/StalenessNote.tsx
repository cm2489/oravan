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
 * that urges action mounts this sentinel beside the recency claim it
 * qualifies. It renders nothing while the data is fresh (and pre-hydration,
 * so the prerendered HTML never carries a clock-dependent verdict); once the
 * visitor's own clock says the last check is past the claim window, a quiet
 * caveat continues that line's own sentence.
 *
 * PLACEMENT, amended 2026-08-12. This used to read "INSIDE its 'Data as of'
 * stamp line", and on five of the six mounts that is still literally where it
 * is - those pages print the sync date as running text and the caveat extends
 * it. The homepage is the exception and the reason for the amendment: its
 * sync date is the absolutely-positioned <Stamp>, which cannot carry trailing
 * text, and hanging the note off the far-below week-note line instead put the
 * caveat one full green panel and a whole bill listing beneath "Moving in
 * Congress this week" - the claim it exists to qualify. It now rides the
 * masthead's `topSub`, directly under the rule the Stamp straddles. The rule
 * that actually matters was never "the stamp line"; it is: sit with the
 * claim, and stay ONE PER PAGE.
 *
 * ONE PER PAGE is a ruling, not a preference. One line, one date: the old
 * two-line version repeated the date and read as a malfunction banner on
 * every core surface (2026-07 critique, unanimous). Repeating this note per
 * claim re-opens that ruling and needs the owner's word.
 */
export function StalenessNote({ checkedAt }: { checkedAt: string }) {
  const t = useTranslations('freshness');
  const hydrated = useHydrated();

  if (!hydrated || freshnessState(checkedAt) === 'fresh') return null;

  return <span role="status"> — {t('staleNote')}</span>;
}
