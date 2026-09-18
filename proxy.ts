import type { NextFetchEvent, NextRequest } from 'next/server';
import createProxy from 'next-intl/middleware';
import { routing } from './i18n/routing';
import { isCountablePageviewRequest, notePageview, pageviewSurfaceForPath } from './lib/usage';

// Next.js 16: middleware.ts -> proxy.ts. next-intl's handler still only does
// locale negotiation/redirects here - no auth, no session, no cookie (see
// i18n/routing.ts's localeCookie: false), nothing about a visitor stored.
const handler = createProxy(routing);

/*
 * The one thing this file does BEYOND locale negotiation (site-counter,
 * 2026-09): increment a first-party, server-side page-view counter.
 *
 * What travels onward is a route-TEMPLATE label from a closed 9-member
 * union - 'bill', not which bill - and a UTC date. The path is matched and
 * dropped inside lib/usage.ts's pageviewSurfaceForPath; no path, query,
 * locale, referer, IP, User-Agent, or cookie reaches a key, and nothing
 * per-visitor is stored or derivable (no identity exists here to store).
 * lib/usage.ts is the single registry and carries the full argument;
 * scripts/check-key-namespaces.mjs gates it in CI.
 *
 * ORDERING IS DELIBERATE. next-intl's handler runs FIRST and its response
 * is what gets returned; the counter write is handed to
 * NextFetchEvent.waitUntil, which is the middleware equivalent of the
 * `after()` every other usage writer uses - it runs after the response is
 * dispatched, so a slow or unreachable counters database costs a visitor
 * nothing. Every failure mode is swallowed: notePageview never throws by
 * contract, the .catch is a second belt, and a runtime without waitUntil
 * (or a throwing one) degrades to an uncounted view rather than a broken
 * page load. A page must never fail because a counter did.
 */
export default function proxy(req: NextRequest, event: NextFetchEvent) {
  const res = handler(req);
  if (isCountablePageviewRequest(req)) {
    try {
      event.waitUntil(notePageview(pageviewSurfaceForPath(req.nextUrl.pathname, routing.locales)).catch(() => {}));
    } catch {
      // No waitUntil available (or it refused) - drop the count, never the page.
    }
  }
  return res;
}

// /embed is excluded (S13): those routes have no [locale] URL segment (see
// app/embed/layout.tsx) - locale there is a widget-local query param + an
// in-widget toggle, not a path prefix. Letting next-intl's middleware match
// /embed/* would try to locale-redirect a path structure that doesn't have
// one, and would risk setting next-intl's locale cookie on a route whose
// whole privacy claim is zero cookies, ever. It also keeps the page-view
// counter off the embeds entirely, which is what keeps
// embeds.docsPrivacyNoData ("No visitor data reaches Oravan beyond an
// ordinary page load") true word for word on a tenant's own site.
//
// The exclusion is `embed/|embed$` - the exact /embed segment - NOT the bare
// prefix `embed`: a prefix silently swallows every future route that merely
// STARTS with those letters. S16's /embeds configurator page (a normal
// [locale] page that needs this middleware) is how that trap was found: with
// the old prefix form, /embeds never got locale-rewritten and 404'd.
export const config = {
  matcher: '/((?!api|_next|_vercel|embed/|embed$|.*\\..*).*)',
};
