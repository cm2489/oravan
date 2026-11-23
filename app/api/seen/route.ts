import type { NextRequest } from 'next/server';
import { readCappedBody } from '@/lib/capped-body';
import { callerIp, createRateLimiter, noteReaderAddress } from '@/lib/ratelimit';
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
 *          visitors' browsers inflate this count;
 *        - the User-Agent does not name a crawler (lib/usage.ts's list);
 *        - the body is at most MAX_BODY_BYTES and is EXACTLY one of
 *          PAGEVIEW_SURFACES, minus 'short' (a redirect, never a page a
 *          script runs on) — no 'other' fallback, so a made-up value is not
 *          counted. The body is read through lib/capped-body.ts, which stops
 *          past the cap, so a chunked body with no Content-Length is never
 *          read whole;
 *        - the caller is under this route's own per-IP limit (60 per 10
 *          minutes, keyed like every limiter here on a salted hash that
 *          rotates daily, lib/ratelimit.ts). A real page sends one signal
 *          per load.
 *   3. DROPS the shape — it was only a validity check — and increments ONE
 *      daily total with no dimension (lib/usage.ts noteRead, no argument),
 *      then, in a SEPARATE call, adds the address to the day's third sketch
 *      (lib/ratelimit.ts noteReaderAddress). Neither key holds a page shape,
 *      and the total holds no address. (The first draft kept one count per
 *      shape; the 2026-11-23 independent review noted the digest only
 *      printed their sum, so it became one total before merge.)
 *
 * WHAT REMAINS SPOOFABLE, said plainly as the digest says it: a program can
 * send these headers and this body directly. The per-IP limit bounds what
 * one address can add to the total, and the sketch counts each address once
 * a day however often it sends, so inflating either takes many addresses.
 * Like every count here it is an operating signal, never audited.
 *
 * Nothing is logged. Static pages stay static: this is a route handler, the
 * kind CLAUDE.md rule 2 already lists, and the script that calls it runs in
 * the browser after the prerendered page has loaded.
 */

const limiter = createRateLimiter({ route: 'seen', max: 60, windowSec: 600 });

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
  if (await limiter.isLimited(ip)) return nothing();

  // Two calls, never one key: a dimensionless total, then the address into
  // the sketch. Both never throw.
  await noteRead();
  await noteReaderAddress(ip);
  return nothing();
}
