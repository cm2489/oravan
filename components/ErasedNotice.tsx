'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
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

/** Read once per page load, before anything else touches the entry. */
let markedOnLoad: boolean | null = null;
function readMark(): boolean {
  if (markedOnLoad === null) {
    const state = window.history.state as Record<string, unknown> | null;
    markedOnLoad = state?.[ERASED_MARK] === true;
  }
  return markedOnLoad;
}

const subscribeNever = () => () => {};

export function ErasedNotice() {
  const t = useTranslations('impact');
  const pathname = usePathname();
  const marked = useSyncExternalStore(subscribeNever, readMark, () => false);
  const [shownOn] = useState(pathname);
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!marked) return;
    try {
      const { [ERASED_MARK]: _mark, ...rest } = (window.history.state ?? {}) as Record<string, unknown>;
      void _mark;
      window.history.replaceState(rest, '');
    } catch {
      /* the mark stays in this one entry; it says nothing about the visitor */
    }
    ref.current?.focus();
  }, [marked]);

  if (!marked || pathname !== shownOn) return null;
  return (
    <div className="mx-auto max-w-5xl px-4 pt-6">
      <p ref={ref} role="status" tabIndex={-1} data-erased-notice="" className="text-sm font-medium">
        {t('erased')}
      </p>
    </div>
  );
}
