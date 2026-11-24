import type { NextRequest } from 'next/server';
import { readCappedBody } from '@/lib/capped-body';
import { callerIp, createRateLimiter, limiterAddress, noteReaderAddress } from '@/lib/ratelimit';
import { isPageviewSurface, isSelfDeclaredCrawler, noteRead } from '@/lib/usage';

/*
 * The reading signal's one receiver (step 2 of the owner's answer of
 * 2026-11-23, 12:23 PM ET, card `people`, option b: a first-party "someone
 * read this" signal). lib/read-signal.ts, running on Oravan's own main-site
 * pages and never on /embed, sends at most one POST here per page load,
 * after the page is visible and the person first scrolls, clicks, taps or
 * presses a key. Its body is the page's SHAPE ('bill', never which bill) as
 * plain text, and nothing else: no cookie exists to send, the request goes
 * out with no Referer (referrerPolicy 'no-referrer'), and the message
 * carries no identifier and no timing (the server and the host's logs still
 * see when it arrives, as for any request).
 *
 * WHAT THIS ROUTE DOES WITH IT, AND NOTHING ELSE:
 *   1. Answers 204 with no body, every time — accepted, refused, rate-limited
 *      or malformed alike — so the answer says nothing about what was
 *      counted.
 *   2. Counts it only if ALL of these hold; otherwise drops it silently:
 *        - `Sec-Fetch-Site: same-origin`, which a browser sets itself and a
 *          page on another site cannot forge, so no other site can make its
 *          visitors' browsers inflate this count. Safari before 16.4 sends
 *          no `Sec-Fetch-*` headers at all, so a signal from it is dropped
 *          here: this count UNDERcounts those browsers, never overcounts
 *          them (the same browsers step 1's browser test counts as not a
 *          browser, lib/usage.ts);
 *        - the User-Agent does not name a crawler (lib/usage.ts's list);
 *        - the body is at most MAX_BODY_BYTES and is EXACTLY one of
 *          PAGEVIEW_SURFACES, minus 'short' (a redirect, never a page a
 *          script runs on) — no 'other' fallback, so a made-up value is not
 *          counted. The body is read through lib/capped-body.ts, which stops
 *          past the cap, so a chunked body with no Content-Length is never
 *          read whole;
 *        - the caller is under this route's own per-address limit
 *          (SEEN_MAX = 5 per SEEN_WINDOW_SEC = 10 minutes, keyed like every
 *          limiter here on a salted hash that rotates daily,
 *          lib/ratelimit.ts). For IPv6 the limit keys on the address's /64
 *          (lib/ratelimit.ts limiterAddress), because one IPv6 customer
 *          holds a whole /64 and could otherwise send each signal from a
 *          new address (the third independent check, 2026-11-24); IPv4 keys on the
 *          full address. A real page load sends one signal, so 5 covers a
 *          person reading five pages in ten minutes; a sixth in that window
 *          is not added to the total or the sketch. The limit was 60 in the
 *          first draft; the second 2026-11-23 review showed that let one
 *          address add ~8,640 a day to the total.
 *   3. DROPS the shape — it was only a validity check — and increments ONE
 *      daily total with no dimension (lib/usage.ts noteRead, no argument),
 *      then, in a SEPARATE call, adds the address to the day's third sketch
 *      (lib/ratelimit.ts noteReaderAddress). Neither key holds a page shape,
 *      and the total holds no address. (The first draft kept one count per
 *      shape; the 2026-11-23 independent review noted the digest only
 *      printed their sum, so it became one total before merge.)
 *
 * WHAT REMAINS SPOOFABLE, said plainly as the digest says it: a program can
 * send these headers and this body directly. The limit bounds what one IPv4
 * address, or one IPv6 /64, can add to the total: at most 5 per 10
 * minutes, so about 720 a UTC day (a window that straddles the daily salt
 * rotation can add 5 more). The sketch counts each address once a day
 * however often it sends, so one IPv4 address moves it by one; a program
 * rotating addresses inside one IPv6 /64 can add each accepted signal as a
 * new address, so at most the same ~720 a day. A network holding many /64s
 * (a home /56 has 256; a /48, free from tunnel brokers, has 65,536) gets
 * that allowance per /64, so the read row is not abuse-resistant.
 *
 * WHY THE SKETCH KEEPS THE FULL ADDRESS (not the /64), decided 2026-11-24:
 * the limit already caps a rotating /64 at the bound above; the three daily
 * sketches must count the same unit, or the digest's "read" row cannot be
 * compared with its "browser" row (step 1's two sketches count full
 * addresses); and /privacy and /llms.txt say each sketch counts
 * "addresses", which a /64 is not.
 * Like every count here it is an operating signal, never audited.
 *
 * Nothing is logged. Static pages stay static: this is a route handler, the
 * kind CLAUDE.md rule 2 already lists, and the script that calls it runs in
 * the browser after the prerendered page has loaded.
 */

/** At most this many counted signals per address per window. (Not exported: a route file exports only handlers.) */
const SEEN_MAX = 5;
/** The window, in seconds (10 minutes). */
const SEEN_WINDOW_SEC = 600;

const limiter = createRateLimiter({ route: 'seen', max: SEEN_MAX, windowSec: SEEN_WINDOW_SEC });

/** Longest accepted body, in bytes; the longest page shape is 15 characters. */
const MAX_BODY_BYTES = 64;

function nothing(): Response {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest): Promise<Response> {
  if (req.headers.get('sec-fetch-site') !== 'same-origin') return nothing();
  if (isSelfDeclaredCrawler(req.headers.get('user-agent'))) return nothing();
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return nothing();

  const body = await readCappedBody(req.body, MAX_BODY_BYTES);
  if (body === null) return nothing();
  if (!isPageviewSurface(body) || body === 'short') return nothing();
  // The shape has done its one job (a validity check) and goes no further.

  const ip = callerIp(req.headers);
  // The limit keys on the /64 for IPv6 (see the header); the sketch below
  // keeps the full address.
  if (await limiter.isLimited(limiterAddress(ip))) return nothing();

  // Two calls, never one key: a dimensionless total, then the address into
  // the sketch. Both never throw.
  await noteRead();
  await noteReaderAddress(ip);
  return nothing();
}
