'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';

/*
 * "See how a call works" in the homepage act zone (truth-first flip,
 * 2026-07-31 + the mobile-density pass): the walkthrough became a native
 * <details> disclosure because an auto-playing phone scene was ~1,200px of
 * every phone scroll, on the way to something the visitor had not asked for
 * yet. Open = the full demo; closed = one honest row.
 *
 * SAME OPEN-GATE AS THE BILL PAGE's WalkthroughDisclosure, and for the same
 * two reasons: the CallWalkthrough chunk is code-split so a collapsed
 * homepage never downloads it, and the component's scene timers cannot run
 * while nobody can see them. Opening mounts it fresh, so the demo always
 * starts at scene 1 — which is also what keeps tests/call-walkthrough.spec.ts
 * deterministic. It carries the same `data-walkthrough-disclosure` hook.
 *
 * The heading keeps its id (`walkthrough-title`): it is this section's
 * aria-labelledby target, and it is a real <h2> inside the <summary>, so the
 * outline still sees the block that the disclosure hides.
 */

const CallWalkthrough = dynamic(
  () => import('./CallWalkthrough').then((m) => m.CallWalkthrough),
  { ssr: false }
);

export function HomeWalkthroughDisclosure() {
  const t = useTranslations('home');
  const [open, setOpen] = useState(false);

  return (
    <details
      data-walkthrough-disclosure
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="overflow-hidden rounded-control border-2 border-ink"
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <h2 id="walkthrough-title" className="text-lg font-extrabold">
          {t('walkthroughTitle')}
        </h2>
        <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
      </summary>
      <div className="border-t-[1.5px] border-line-strong p-4 md:p-6">
        <p className="max-w-note text-ink-2">{t('walkthroughSub')}</p>
        <div className="mt-6">{open && <CallWalkthrough />}</div>
      </div>
    </details>
  );
}
