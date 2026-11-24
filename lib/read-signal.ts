import { pageShapeForPath } from './page-shape';

/*
 * THE READING SIGNAL, browser half (step 2 of the owner's answer of
 * 2026-11-23, 12:23 PM ET, card `people`, option b: a first-party "someone
 * read this" signal). components/ReadSignal.tsx mounts it once per page load
 * on Oravan's main-site pages (app/[locale]/layout.tsx); /embed has its own
 * layout and never loads it (hard rule 12).
 *
 * WHAT IT SENDS, AND WHEN — the whole of it:
 *   - at most ONE request per page load, to this site's own /api/seen. A
 *     "page load" is the browser loading Oravan's document: opening the site
 *     in a tab, or reloading it. Moving between pages by Oravan's own links
 *     is a client-side navigation and loads nothing, and a language switch,
 *     which remounts the layout and so this component, does not send again
 *     either: the once-only flag below lives at module scope, which lasts
 *     exactly as long as the loaded document (third independent check,
 *     2026-11-24);
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
 *
 * OLDER BROWSERS: /api/seen counts a signal only when the request carries
 * `Sec-Fetch-Site: same-origin`, and Safari before 16.4 sends no
 * `Sec-Fetch-*` headers, so its signals arrive and are dropped. A browser
 * that ignores `keepalive` sends an ordinary fetch, which can be cancelled
 * if the page is closed at that instant. Both lose a signal; neither adds
 * one, so the count can only undercount them.
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

/** Whether this page load has sent its one signal. */
export interface ReadSignalOnce {
  sent: boolean;
}

/**
 * THIS page load's flag: module scope, so it outlives an unmount and
 * remount of the component (a language switch remounts the layout) and
 * resets only when the browser loads the document again. Never persisted.
 */
const thisPageLoad: ReadSignalOnce = { sent: false };

/**
 * Arm the signal. Returns a function that disarms it (React's effect
 * cleanup). After the one send, every listener is removed. `once` defaults
 * to this page load's flag; tests pass their own.
 */
export function armReadSignal(
  env: ReadSignalEnv,
  locales: readonly string[],
  once: ReadSignalOnce = thisPageLoad,
): () => void {
  let listening = false;
  const options: AddEventListenerOptions = { passive: true, capture: true };
  if (once.sent) return () => {};

  const onAct: Listener = (event) => {
    if (once.sent || event.isTrusted === false) return;
    if (env.document.visibilityState !== 'visible') return;
    once.sent = true;
    disarm();
    env.send(READ_SIGNAL_PATH, pageShapeForPath(env.window.location.pathname, locales));
  };
  const onVisibility: Listener = () => {
    if (env.document.visibilityState === 'visible') listen();
  };
  function listen(): void {
    if (listening || once.sent) return;
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
