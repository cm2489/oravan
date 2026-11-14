'use client';

import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { easternDay } from '@/lib/eastern-day';

/*
 * The newest row of a quiet timeline: "Nothing recorded yet today." while it
 * is still that day, "Nothing recorded." once it is not.
 *
 * WHY THIS IS NOT SERVER-RENDERED. The Big Question pages are prerendered, so
 * the server's "today" is the day of the BUILD. "Yet today" is a claim about
 * the reader's day, and a prerendered page is read for hours after it was
 * built: from midnight Eastern until the next deploy the old copy printed
 * "November 13, 2026 — Nothing recorded yet today." on November 14. (The file
 * header of components/MomentQuietNote.tsx used to call these lines
 * "statements about the RECORD, which does not change between the build and
 * the visitor"; the row's DATE is such a statement, the word "today" is not.)
 *
 * So the prerendered HTML carries only what stays true at any hour — the
 * row's own printed date and the plain past-tense line — and the visitor's
 * own clock upgrades it to "yet today" only while the visitor's Eastern day
 * IS the row's day. The same rule as MomentQuietNote: the prerendered HTML
 * never carries a clock-dependent claim.
 *
 * `useSyncExternalStore` with a null server snapshot is the hydration gate
 * the sibling components use: the hydration render matches the server HTML,
 * the next render reads the clock, no effect, no mismatch. The subscription
 * re-reads the clock every 30 seconds so a tab left open across midnight
 * stops saying "yet today" without a reload.
 */
const subscribe = (onChange: () => void) => {
  const id = setInterval(onChange, 30_000);
  return () => clearInterval(id);
};
const visitorDay = () => easternDay(Date.now());
const serverDay = () => null;

export function MomentQuietDay({ day }: { day: string }) {
  const t = useTranslations('moments.updates');
  const today = useSyncExternalStore(subscribe, visitorDay, serverDay);

  return <span>{today === day ? t('quietToday') : t('quietDay')}</span>;
}
