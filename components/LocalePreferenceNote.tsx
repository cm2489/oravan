'use client';

import { useState, useSyncExternalStore } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { readLocaleChoice, rememberLocaleChoice } from '@/lib/locale-pref';

/*
 * "¿Prefieres español?" — the language-preference note (blind teardown
 * 2026-08-02, finding #4: three fresh sessions with Accept-Language es /
 * es-MX / es-419 all received the English homepage with no suggestion, so a
 * Spanish-only visitor must spot the header pill to discover the site's
 * deepest feature).
 *
 * CLIENT-SIDE ON PURPOSE. `i18n/routing.ts` sets `localeDetection: false`
 * deliberately: a server-side redirect would read Accept-Language per
 * request on an otherwise fully static site (cache-splitting every page)
 * and negotiate for the visitor instead of with them. This note reads
 * `navigator.languages` in the browser, suggests, and lets the visitor
 * decide — nothing is sent anywhere, which is the same privacy posture as
 * everything else personal here.
 *
 * Renders ONLY on the EN locale for a Spanish-preferring browser, and never
 * again after dismissal (localStorage flag — per CLAUDE.md, personalization
 * lives in localStorage; this one-bit flag deliberately does not join
 * lib/local's Prefs object because eraseAll() clearing it would resurrect
 * the banner for the exact visitor who asked it to go away).
 *
 * The note's own strings are in SPANISH (the target reader's language, the
 * same rule as the hero's "Ver en español" link) with lang="es" on the
 * container so screen readers switch voices. Keys exist in both catalogs
 * for the parity gate; the EN file carries the same Spanish strings by
 * design.
 */

const DISMISS_KEY = 'oravan.esNote.dismissed';

/** Browser-only check, SSR-safe: the server snapshot is always false, so the
 *  static HTML never carries the note and hydration cannot mismatch — it
 *  appears in the first client render for a Spanish-preferring browser.
 *
 *  An explicit language choice (lib/locale-pref.ts) outranks the browser's
 *  own configuration in BOTH directions (2026-08-04 walkthrough P1 —
 *  "Spanish is a mode you must re-enter"): a visitor who chose Español gets
 *  the one-tap way back on every bare-URL entry even from an
 *  English-configured browser, and one who explicitly chose English is not
 *  re-suggested Spanish just because their OS speaks it. */
function readPrefersEs(): boolean {
  try {
    if (window.localStorage.getItem(DISMISS_KEY)) return false;
  } catch {
    // storage blocked: suggest anyway this session, never persist
  }
  const chosen = readLocaleChoice();
  if (chosen === 'es') return true;
  if (chosen === 'en') return false;
  return (navigator.languages ?? [navigator.language]).some((l) =>
    (l || '').toLowerCase().startsWith('es')
  );
}

const subscribeNever = () => () => {};

export function LocalePreferenceNote() {
  const locale = useLocale();
  const pathname = usePathname();
  const t = useTranslations('langNote');
  const [dismissed, setDismissed] = useState(false);
  const prefersEs = useSyncExternalStore(subscribeNever, readPrefersEs, () => false);

  const show = locale === 'en' && prefersEs && !dismissed;
  if (!show) return null;

  function dismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // storage blocked: dismissal lasts the session only
    }
  }

  return (
    <div lang="es" className="border-b-[1.5px] border-line-strong bg-wash">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-1.5">
        <p className="text-sm">
          <Link
            href={pathname}
            locale="es"
            hrefLang="es"
            onClick={() => rememberLocaleChoice('es')}
            className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-go underline underline-offset-4 hover:text-go-deep"
          >
            {t('cta')}
            <ArrowRight className="h-4 w-4 flex-none" aria-hidden />
          </Link>
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('dismiss')}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-control text-ink-2 hover:bg-paper hover:text-ink"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
