'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';

/*
 * "See how a call works" on bill pages: a compact native <details> disclosure
 * (same idiom as RepCard's local-offices list) that sits right under the
 * inline call prompt — the hesitation moment — without pushing the call
 * button anywhere.
 *
 * Collapsed costs nothing: the CallWalkthrough chunk is code-split and only
 * imported once the visitor opens the disclosure (~1,000 SSG bill pages ship
 * without it), and the open-gate also means its timers never run while
 * hidden. Opening mounts it fresh, so the demo always starts at scene 1.
 *
 * Accessibility: <summary> is a native disclosure button (Enter/Space, state
 * announced), the global :focus-visible outline applies, and min-h-11 keeps
 * the target at 44px+.
 */

const CallWalkthrough = dynamic(
  () => import('./CallWalkthrough').then((m) => m.CallWalkthrough),
  { ssr: false }
);

export function WalkthroughDisclosure() {
  const t = useTranslations('walkthrough');
  const [open, setOpen] = useState(false);

  return (
    <details
      data-walkthrough-disclosure
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="mt-3 rounded-card border border-line bg-surface px-5"
    >
      <summary className="min-h-11 cursor-pointer select-none py-3 font-semibold marker:text-ink-faint hover:text-night">
        {t('disclosure')}
      </summary>
      <div className="pb-6 pt-2">{open && <CallWalkthrough />}</div>
    </details>
  );
}
