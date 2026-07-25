'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

/*
 * Segment-level error boundary. Scoped to [locale] on purpose: a throw here is
 * caught below the layout, so the header, the footer and the language switch
 * all survive and the visitor is still somewhere rather than staring at white.
 *
 * The Impact link is not decoration. The most likely cause of a client throw on
 * this site is a malformed localStorage entry (lib/local.ts now guards the
 * shapes it knows, but the erase control is the user-facing escape hatch), and
 * /impact is where "erase everything on this device" lives.
 *
 * ⚠️ The Spanish strings for `errorBoundary` are NOT yet reviewed by a native
 * speaker — see the standing ES review gap in docs/es-script-spotcheck.md. They
 * are machine-drafted and must go through the reviewer before this is treated
 * as finished copy.
 */
export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errorBoundary');

  useEffect(() => {
    // Digest only — never the message, which can carry user-entered text.
    console.error('[oravan] render error', error.digest ?? '(no digest)');
  }, [error]);

  return (
    <article className="mx-auto max-w-read px-4 py-16" role="alert">
      <h1 className="text-h1 font-extrabold text-ink">{t('title')}</h1>
      <p className="mt-4 text-lede text-ink-2">{t('body')}</p>
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="ring-gap inline-flex min-h-12 items-center justify-center rounded-control border-2 border-go bg-go px-6 font-bold text-paper transition-colors hover:border-go-deep hover:bg-go-deep"
        >
          {t('retry')}
        </button>
        <Link
          href="/"
          className="ring-gap inline-flex min-h-12 items-center justify-center rounded-control border-2 border-ink px-6 font-bold text-ink no-underline transition-colors hover:bg-wash"
        >
          {t('home')}
        </Link>
      </div>
    </article>
  );
}
