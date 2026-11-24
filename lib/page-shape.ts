/*
 * The page-shape mapping, with NO imports (2026-11-23, moved here from
 * lib/usage.ts unchanged). It lives on its own so the reading signal's
 * browser script (lib/read-signal.ts, step 2 of the owner's answer of
 * 2026-11-23, card `people`) can name the shape of the page it runs on with
 * exactly the rule proxy.ts counts page views by, without pulling the
 * counters client into the browser bundle. lib/usage.ts re-exports it as
 * pageviewSurfaceForPath and checks at compile time that every shape it can
 * return is in PAGEVIEW_SURFACES, the closed vocabulary
 * scripts/check-key-namespaces.mjs pins.
 */

/** Every shape pageShapeForPath can return. 'short' is not one: only proxy.ts's own redirect counts as 'short'. */
export type PageShape =
  | 'home'
  | 'bills-index'
  | 'bill'
  | 'questions-index'
  | 'question'
  | 'reps'
  | 'member'
  | 'record'
  | 'nominations'
  | 'today'
  | 'other';

/**
 * Map a request path to its route-template label. The path is read, matched,
 * and DROPPED — only the returned label ever travels onward, and every
 * unmatched shape (including a 404 under app/[locale]/[...rest]) returns
 * 'other' rather than inventing a label from the path itself.
 *
 * `locales` is next-intl's own list (proxy.ts passes routing.locales), so a
 * leading /es is stripped before matching rather than being counted as a
 * separate surface — the locale must never become a key segment
 * (CONTENT_IDENTIFIER names it in every registry, usage included).
 *
 * Bare /nominations is 'other' on purpose: there is no nominations index
 * route (only app/[locale]/nominations/[slug]), so that path 404s, and
 * counting a 404 as the nominations surface would overstate it.
 *
 * The two labels added 2026-09-27 (SY-49) match their routes' exact depth,
 * and a deeper path under either is 'other' — neither route has a child
 * segment, so /reps/<id>/<anything> and /today/<date>/<anything> are 404s:
 *   - /reps/<bioguide> is 'member' (app/[locale]/reps/[bioguide]). The
 *     bioguide segment is matched and dropped like every other segment; it
 *     never travels onward.
 *   - /today AND /today/<date> are both 'today'. They are one template, not
 *     two: app/[locale]/today/page.tsx renders the newest brief and its dated
 *     twin renders the identical derivation for a named day (that file's own
 *     header), so splitting them would count a date, which is content.
 * The three older segment labels ('bill', 'question', 'nominations') keep
 * their original any-depth match — unchanged here on purpose, so their
 * series stay comparable across this change.
 */
export function pageShapeForPath(pathname: string, locales: readonly string[] = []): PageShape {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments.length > 0 && locales.includes(segments[0])) segments.shift();
  const [head, second, third] = segments;
  if (head === undefined) return 'home';
  switch (head) {
    case 'bills':
      return second === undefined ? 'bills-index' : 'bill';
    case 'questions':
      return second === undefined ? 'questions-index' : 'question';
    case 'nominations':
      return second === undefined ? 'other' : 'nominations';
    case 'reps':
      if (second === undefined) return 'reps';
      return third === undefined ? 'member' : 'other';
    case 'today':
      return third === undefined ? 'today' : 'other';
    case 'record':
      return second === undefined ? 'record' : 'other';
    default:
      return 'other';
  }
}
