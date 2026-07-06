'use client';

import { useSyncExternalStore } from 'react';
import { Clock } from 'lucide-react';
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
 */
export function OfficeHoursNote() {
  const t = useTranslations('bill');
  const hydrated = useHydrated();
  if (!hydrated) return null;

  const status = officeHoursStatus();
  return (
    <div
      role="status"
      className="flex gap-2 rounded-control bg-brass-soft p-4 text-sm"
      data-office-hours={status}
    >
      <Clock className="h-5 w-5 shrink-0 text-ink-soft" aria-hidden />
      <div>
        <p className="font-semibold">{t('officeHoursTitle')}</p>
        <p className="mt-0.5 text-ink-soft">
          {status === 'open' ? t('officeHoursOpenBody') : t('officeHoursClosedBody')}
        </p>
      </div>
    </div>
  );
}
