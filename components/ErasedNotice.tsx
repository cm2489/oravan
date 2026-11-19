'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from '@/i18n/navigation';

/*
 * "ALL LOCAL DATA ERASED." AFTER THE ERROR SCREEN'S ERASE (2026-11-18).
 *
 * The error screen (app/[locale]/error.tsx) erases and then reloads the page,
 * because the app that crashed cannot be asked to render again. The reload
 * used to land with focus on nothing and no word that the erase was done: a
 * screen-reader user heard silence. So, just before reloading, the error
 * screen leaves one mark in the reloaded entry's own history state, under
 * ERASED_MARK, that says only "an erase just happened". Nothing about the
 * visitor, nothing in storage, nothing sent anywhere.
 *
 * Here, once, on the page that loads: the mark is read, removed from the
 * entry at once (so Reload and Back never say it again), and the record
 * page's own confirmation (`impact.erased`, the words the record's erase
 * already says, in both languages) is shown at the top of the page and
 * focused, so it is read out. It goes when the visitor moves to another page.
 */

export const ERASED_MARK = 'oravanErased';

/*
 * ONCE, ON ONE PAGE (2026-11-19). The line used to be kept for the whole
 * visit and hidden only when the address differed from the first page's: a
 * move away and Back showed it again, and a language switch (which mounts
 * the layout afresh, at the same path under /es) showed it and took focus
 * again. Now it belongs to the page it was shown on, path and language (as
 * the router has them, so it is gone in the same render that draws the next
 * page; the part after `#` does not make another page): it is focused once,
 * and the first time the page is anything else it is gone for the rest of
 * the visit, whatever comes back.
 */
type Phase = 'unread' | 'showing' | 'gone';
let phase: Phase = 'unread';
let shownAt = '';
const listeners = new Set<() => void>();

function visibleOn(page: string): boolean {
  if (phase === 'unread') {
    const state = window.history.state as Record<string, unknown> | null;
    phase = state?.[ERASED_MARK] === true ? 'showing' : 'gone';
    shownAt = page;
  }
  return phase === 'showing' && shownAt === page;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function done() {
  phase = 'gone';
  for (const cb of listeners) cb();
}

export function ErasedNotice() {
  const t = useTranslations('impact');
  // Read so this redraws on every move to another page or language.
  const pathname = usePathname();
  const locale = useLocale();
  const page = `${locale}:${pathname}`;
  const show = useSyncExternalStore(subscribe, () => visibleOn(page), () => false);
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (phase !== 'showing') return;
    if (shownAt !== page) {
      done();
      return;
    }
    if (!show) return;
    // Once: this runs again only when the page changes, and then the line is
    // already gone for good (above).
    try {
      const { [ERASED_MARK]: _mark, ...rest } = (window.history.state ?? {}) as Record<string, unknown>;
      void _mark;
      window.history.replaceState(rest, '');
    } catch {
      /* the mark stays in this one entry; it says nothing about the visitor */
    }
    ref.current?.focus();
  }, [show, page]);

  if (!show) return null;
  return (
    <div className="mx-auto max-w-5xl px-4 pt-6">
      <p ref={ref} role="status" tabIndex={-1} data-erased-notice="" className="text-sm font-medium">
        {t('erased')}
      </p>
    </div>
  );
}
