import { pageShapeForPath } from './page-shape';

/*
 * THE READING SIGNAL, browser half (step 2 of the owner's answer of
 * 2026-11-23, 12:23 PM ET, card `people`, option b: a first-party "someone
 * read this" signal). components/ReadSignal.tsx mounts it once per page load
 * on Oravan's main-site pages (app/[locale]/layout.tsx); /embed has its own
 * layout and never loads it (hard rule 12).
 *
 * WHAT IT SENDS, AND WHEN — the whole of it:
 *   - at most ONE request per page load, to this site's own /api/seen;
 *   - only once the page is visible AND the person first acts on it: a
 *     mouse-wheel or touch scroll, a tap or click, or a key press. These are
 *     input events a person makes; a programmatic scroll (restoring the
 *     position on Back, jumping to a #anchor) is not one of them, and an
 *     event a script fabricates (isTrusted false) is ignored;
 *   - a body of one word, the page's SHAPE as lib/page-shape.ts names it
 *     ('bill', never which bill), as plain text.
 *
 * WHAT IT NEVER DOES: set or read a cookie; write localStorage or
 * sessionStorage; make or keep an identifier; measure or send time; send a
 * Referer (the request says referrerPolicy 'no-referrer', which a
 * navigator.sendBeacon call cannot say — that is why this uses fetch with
 * keepalive, the same fire-and-forget delivery); contact any other origin.
 * credentials 'omit' means the browser attaches no cookie even if one ever
 * existed.
 */

export const READ_SIGNAL_PATH = '/api/seen';

/** Input events only a person makes. See the comment above for why not 'scroll'. */
export const READ_SIGNAL_EVENTS = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const;

type Listener = (event: { isTrusted?: boolean }) => void;
type Target = {
  addEventListener(type: string, listener: Listener, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: Listener, options?: EventListenerOptions | boolean): void;
};

export interface ReadSignalEnv {
  document: Target & { visibilityState: string };
  window: Target & { location: { pathname: string } };
  send: (path: string, body: string) => void;
}

/**
 * Arm the signal. Returns a function that disarms it (React's effect
 * cleanup). After the one send, every listener is removed.
 */
export function armReadSignal(env: ReadSignalEnv, locales: readonly string[]): () => void {
  let sent = false;
  let listening = false;
  const options: AddEventListenerOptions = { passive: true, capture: true };

  const onAct: Listener = (event) => {
    if (sent || event.isTrusted === false) return;
    if (env.document.visibilityState !== 'visible') return;
    sent = true;
    disarm();
    env.send(READ_SIGNAL_PATH, pageShapeForPath(env.window.location.pathname, locales));
  };
  const onVisibility: Listener = () => {
    if (env.document.visibilityState === 'visible') listen();
  };
  function listen(): void {
    if (listening || sent) return;
    listening = true;
    for (const type of READ_SIGNAL_EVENTS) env.window.addEventListener(type, onAct, options);
  }
  function disarm(): void {
    env.document.removeEventListener('visibilitychange', onVisibility, true);
    if (!listening) return;
    listening = false;
    for (const type of READ_SIGNAL_EVENTS) env.window.removeEventListener(type, onAct, true);
  }

  if (env.document.visibilityState === 'visible') listen();
  else env.document.addEventListener('visibilitychange', onVisibility, { capture: true });
  return disarm;
}

/** The one network call: same-origin, no cookie, no Referer, no cache, fire and forget. */
export function sendReadSignal(path: string, body: string): void {
  try {
    void fetch(path, {
      method: 'POST',
      body,
      headers: { 'content-type': 'text/plain' },
      keepalive: true,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    }).catch(() => {});
  } catch {
    // No fetch, or it refused: send nothing, never break the page.
  }
}
