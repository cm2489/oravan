'use client';

import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { eraseAll } from '@/lib/local';

/*
 * Segment-level error boundary. Scoped to [locale] on purpose: a throw here is
 * caught below the layout, so the header, the footer and the language switch
 * all survive and the visitor is still somewhere rather than staring at white.
 *
 * The most likely cause of a client throw on this site is a malformed
 * localStorage entry, and /record is where "erase everything on this device"
 * lives. This boundary used to render only retry + home and leave the escape
 * hatch to the surviving header nav — reasoning that holds for every page
 * EXCEPT the one it mattered most for. When the page that throws IS /record,
 * the header link walks straight back into the same throw and `reset()`
 * re-renders the same tree: no exit, while the copy went on advising one. So
 * the erase control lives here now, and tests/record.spec.ts pins that it
 * does.
 *
 * Calling eraseAll() from a boundary that rendered BECAUSE parsing threw is
 * safe by construction: lib/local.ts's erase path only calls `removeItem`,
 * inside a try/catch, and reads nothing. There is no shape of stored data it
 * can choke on.
 *
 * IT ASKS FIRST, exactly the way /record asks. The escape hatch used to fire
 * eraseAll() on a SINGLE click, which is the wrong bargain in the one place
 * the button is easiest to reach by accident: this boundary most often
 * renders for reasons that have nothing to do with stored data — a chunk
 * fetch that 404s against a just-deployed build is the common one — so the
 * reader destroys a real civic record (every call, every read, their ZIP and
 * interests) to fix a problem a reload would have fixed. The identical
 * eraseAll() on /record has always sat behind a two-step confirm that says
 * out loud that it cannot be undone; there is no argument for the same
 * destruction being cheaper here, and a good one for it being dearer.
 *
 * THE CONFIRM IS THE RECORD PAGE'S OWN, not a second copy of it: `impact`'s
 * eraseConfirm / confirmErase / cancel, read straight out of the same
 * message namespace ImpactPageClient reads. Zero new strings in either
 * language, so the two flows cannot drift into telling a reader two
 * different things about the same irreversible act — and the ES review gap
 * flagged below does not widen, because these three strings are the record
 * page's already-shipped copy. Reusing them costs nothing an error boundary
 * has to worry about either: `useTranslations` is already imported here, the
 * whole message catalogue is in the client bundle (app/[locale]/layout.tsx
 * provides it un-narrowed), and the confirm adds one `useState` and no
 * import at all.
 *
 * ⚠️ The Spanish strings for `errorBoundary` are NOT yet reviewed by a native
 * speaker — see the standing ES review gap in docs/es-script-spotcheck.md. They
 * are machine-drafted and must go through the reviewer before this is treated
 * as finished copy. That gap now covers `body` (rewritten), `eraseHelp` and
 * `erase` as well.
 */
export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errorBoundary');
  const tImpact = useTranslations('impact');
  const [confirming, setConfirming] = useState(false);

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

      {/* THE ESCAPE HATCH, third and quietest. Reloading fixes almost
          everything, so retry keeps the green; erasing is the last resort and
          it is destructive, so it sits below the pair on a line of its own,
          in the same trash-icon idiom the civic record's erase block uses.
          border-line-strong is on paper here, which is the side of the
          contrast ledger where it passes. */}
      <p className="mt-10 max-w-note text-sm text-ink-2">{t('eraseHelp')}</p>
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="ring-gap mt-3 inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-line-strong bg-paper px-4 py-2.5 font-bold text-ink transition-colors hover:border-ink hover:bg-wash"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
          {t('erase')}
        </button>
      ) : (
        /* The record page's confirm, verbatim — including its focus move.
           Opening the confirm unmounts the trigger, so without this the
           keyboard reader's focus falls to <body> in a tree that has already
           lost its page once. Cancel keeps bg-paper for the same contrast
           reason it does on /record: border-line-strong needs paper on at
           least one side. */
        <div className="mt-3">
          <p className="max-w-note text-sm font-medium">{tImpact('eraseConfirm')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              ref={(el) => el?.focus()}
              onClick={() => {
                eraseAll();
                reset();
              }}
              className="ring-gap inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-ink bg-ink-deep px-4 py-2.5 font-bold text-paper"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              {tImpact('confirmErase')}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="ring-gap min-h-12 rounded-control border-2 border-line-strong bg-paper px-4 py-2.5 font-bold text-ink transition-colors hover:border-ink"
            >
              {tImpact('cancel')}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
