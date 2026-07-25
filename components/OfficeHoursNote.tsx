'use client';

import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { officeHoursStatus } from '@/lib/office-hours';

// Same hydration gate as StalenessNote: the verdict depends on the visitor's
// real clock, so the server render (and the hydration pass) must stay
// neutral - only the post-hydration client render is allowed to say "open"
// or "closed", or a stale SSG page would freeze whichever verdict was true
// at build time.
const emptySubscribe = () => () => {};
const useHydrated = () =>
  useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );

/*
 * S7 call-moment slice: a quiet, honest note about typical Congressional
 * office hours (Eastern only - see lib/office-hours.ts for the scoping
 * rationale). The after-hours case points AT voicemail as the plus ("the
 * gentlest first call"), never as an apology - offices tally a voicemail
 * exactly like a live call (docs/ideation/2026-07-05-build-gtm-strategy.md
 * §5). No fake per-office data: this is a generic, honest guide only.
 *
 * COLOR: this note used to sit on a warm amber-ish ground. Amber is now spent
 * on exactly one fact - a bill standing on the floor calendar, with the date
 * printed beside it - and "offices are usually open 9 to 5 Eastern" is not
 * that fact. So it is a recessed `wash` note in ink: the same quiet register
 * the system gives every other aside. Its `role="status"` is what makes the
 * open/closed flip reach a screen reader, not its fill.
 */
export function OfficeHoursNote() {
  const t = useTranslations('bill');
  const hydrated = useHydrated();
  if (!hydrated) return null;

  const status = officeHoursStatus();
  return (
    <div
      role="status"
      className="rounded-control bg-wash p-4 text-sm"
      data-office-hours={status}
    >
      <p className="font-bold text-ink">{t('officeHoursTitle')}</p>
      <p className="mt-0.5 text-ink-2">
        {status === 'open' ? t('officeHoursOpenBody') : t('officeHoursClosedBody')}
      </p>
    </div>
  );
}
