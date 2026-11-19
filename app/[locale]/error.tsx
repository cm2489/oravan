'use client';

import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { getPathname } from '@/i18n/navigation';
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

/*
 * EVERY WAY OUT IS A FULL PAGE LOAD (2026-11-18). This boundary renders
 * because the running app crashed, and nothing here may ask that app to
 * render again. Measured on /reps with a saved ZIP: the crashing page's own
 * members lookup (a server action) answers BEHIND this screen, and from then
 * on the next render of the router's root fails (React #310), whatever
 * starts it. `reset()` ("Try again"), a client-side link ("Go home") and a
 * reset after the erase each took the whole document down to the framework's
 * "This page couldn't load", in every run measured on 2026-11-18, and so did
 * the header's links and Back. With no saved ZIP they worked, which is why
 * this stayed hidden. A full load starts a new app, so
 * all three load the page: Try again reloads it (the screen's own advice,
 * "Reloading usually fixes it"), Go home loads the home page of this
 * language, and the erase reloads after erasing.
 */
const reload = () => window.location.reload();

export default function LocaleError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('errorBoundary');
  const locale = useLocale();
  const tImpact = useTranslations('impact');
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    // Digest only — never the message, which can carry user-entered text.
    console.error('[oravan] render error', error.digest ?? '(no digest)');
  }, [error]);

  // The rest of the page stays up around this screen (the header, the
  // footer, the language switch), and every link there is the router's:
  // a click would ask the crashed app to render (see "EVERY WAY OUT"). So
  // while this screen is up, a click on a link, and Back or Forward, become
  // full page loads. Both listeners capture, so they run before the router's
  // own: React's at the root for clicks, Next.js's popstate handler on the
  // window.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      // A click meant for a new tab or window is the browser's, as always.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
      // Loading the link's address is what the browser does for any link the
      // router does not take (another site's, the skip link's #main), so this
      // asks nothing of them that their default would not.
      e.preventDefault();
      e.stopPropagation();
      window.location.assign(link.href);
    }
    function onPopState(e: PopStateEvent) {
      e.stopImmediatePropagation();
      reload(); // the address is already the entry Back or Forward chose
    }
    window.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPopState, true);
    return () => {
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPopState, true);
    };
  }, []);

  return (
    <article className="mx-auto max-w-read px-4 py-16" role="alert">
      <h1 className="text-h1 font-extrabold text-ink">{t('title')}</h1>
      <p className="mt-4 text-lede text-ink-2">{t('body')}</p>
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={reload}
          className="ring-edge inline-flex min-h-12 items-center justify-center rounded-control border-2 border-ink bg-urgent px-6 font-bold text-ink transition-colors hover:bg-urgent-deep"
        >
          {t('retry')}
        </button>
        {/* A plain link, not the router's: a full page load on purpose
            (see "EVERY WAY OUT" above). */}
        <a
          href={getPathname({ locale: locale as Parameters<typeof getPathname>[0]['locale'], href: '/' })}
          className="ring-gap inline-flex min-h-12 items-center justify-center rounded-control border-2 border-ink px-6 font-bold text-ink no-underline transition-colors hover:bg-wash"
        >
          {t('home')}
        </a>
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
                // The current history entry is emptied as well: it may hold
                // the ZIP the members page last showed (lib/members-entry.ts).
                // The erase already made every entry's copy unreadable (its
                // tag is gone); this removes the copy itself from the one
                // entry a page can rewrite. With no address, Next's own
                // replaceState only carries its router keys over and does not
                // touch the router. A refusal (Safari limits how often it may
                // be called) must never stop the reload.
                try {
                  window.history.replaceState(null, '');
                } catch {
                  /* the tag already covers this entry */
                }
                reload();
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
