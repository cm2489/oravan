import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import createProxy from 'next-intl/middleware';
import { routing } from './i18n/routing';
import { callerIp, noteDistinctAddress } from './lib/ratelimit';
import { decodeShortAddressIndex, shortAddressTarget } from './lib/short-address';
import { isCountablePageviewRequest, notePageview, pageviewSurfaceForPath, type PageviewSurface } from './lib/usage';

// Next.js 16: middleware.ts -> proxy.ts. next-intl's handler still only does
// locale negotiation/redirects here - no auth, no session, no cookie (see
// i18n/routing.ts's localeCookie: false), nothing about a visitor stored.
const handler = createProxy(routing);

/*
 * Short addresses for bills (/hr9340 -> the bill page; lib/short-address.ts
 * carries the full argument). Which bills exist is a ~3 KB bitset that
 * next.config.ts encodes from data/bills.json at BUILD time and inlines here
 * as SHORT_ADDRESS_INDEX; it is decoded once per server instance, and each
 * request costs one pattern test and one bit test. The corpus itself never
 * enters this bundle. This is the one piece of per-request work proxy.ts
 * does beyond locale negotiation and the two counts below, and it is named
 * as such where CLAUDE.md rule 2's exceptions are named
 * (tests/static-rendering.spec.ts).
 */
const SHORT_ADDRESS_INDEX = decodeShortAddressIndex(process.env.SHORT_ADDRESS_INDEX);

/*
 * 307, not 308. A 308 is permanent: browsers cache it with no expiry, so a
 * reader who opened /hr1 once would keep landing on H.R. 1 of the 119th
 * Congress after bill numbers restart in January 2027 (card d2, the owner's
 * decision still to come). A 307 is not cached unless told to be, and
 * `no-store` says so explicitly, so the day the Congress constant changes,
 * every short address follows it. The target is a bare path: the request's
 * query string is dropped, never forwarded (rule 1: a shared link never
 * carries a stance). `noindex` keeps the short form itself out of search
 * results; the bill page's own canonical URL is unchanged.
 */
function shortAddressRedirect(req: NextRequest, target: string): NextResponse {
  const url = new URL(target, req.nextUrl.origin);
  const res = NextResponse.redirect(url, 307);
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('X-Robots-Tag', 'noindex');
  return res;
}

/*
 * The two things this file does BEYOND locale negotiation, both after the
 * response is on its way out:
 *
 * 1. (site-counter, 2026-09) increment a first-party, server-side page-view
 *    counter. What travels onward is a route-TEMPLATE label from a closed
 *    union (lib/usage.ts's PAGEVIEW_SURFACES; scripts/check-key-namespaces.mjs
 *    holds the canonical list, so the count lives there and nowhere else) -
 *    'bill', not which bill - and a UTC date. The path is matched and dropped
 *    inside lib/usage.ts's pageviewSurfaceForPath; no path, query, locale,
 *    referer, IP, User-Agent, or cookie reaches that key, and nothing
 *    per-visitor is stored in it. lib/usage.ts is the single registry and
 *    carries the full argument.
 *
 * 2. (daily distinct-address count, owner rulings 2026-09-25 and
 *    2026-09-27) add a salted hash of the caller's address to ONE site-wide
 *    HyperLogLog sketch for the UTC day. The salt is the sketch's own, used
 *    for nothing else and deleted when its UTC day ends - not the rate
 *    limiter's. It is the only thing here derived from the caller, and it is
 *    deliberately joined to nothing: no path, no page label, no locale - the
 *    sketch has no dimension at all, so it can never say which page an
 *    address read. A sketch keeps register maxima, never the hash or the
 *    address. lib/ratelimit.ts is its registry and carries the full
 *    argument, including its honest limits.
 *
 * scripts/check-key-namespaces.mjs gates both in CI.
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
  const shortTarget =
    req.method === 'GET' || req.method === 'HEAD'
      ? shortAddressTarget(req.nextUrl.pathname, routing.locales, routing.defaultLocale, SHORT_ADDRESS_INDEX)
      : null;
  const res = shortTarget ? shortAddressRedirect(req, shortTarget) : handler(req);
  if (isCountablePageviewRequest(req)) {
    // A short-address redirect counts as the 'short' template (owner, card
    // d3, 2026-09-26: "one number a day, nothing about who"): which bill it
    // named is dropped here like every other path segment.
    const surface: PageviewSurface = shortTarget ? 'short' : pageviewSurfaceForPath(req.nextUrl.pathname, routing.locales);
    try {
      event.waitUntil(notePageview(surface).catch(() => {}));
    } catch {
      // No waitUntil available (or it refused) - drop the count, never the page.
    }
    // Separate waitUntil, separate try: the two counts never share a fate,
    // and the address is read here and handed straight to the one registry
    // that may hash it - it is never passed alongside the page label.
    try {
      event.waitUntil(noteDistinctAddress(callerIp(req.headers)).catch(() => {}));
    } catch {
      // Same rule: drop the count, never the page.
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
// counter AND the daily distinct-address sketch off the embeds entirely -
// a tenant's visitors are never added to it - which is what keeps
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
