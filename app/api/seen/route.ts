import type { NextRequest } from 'next/server';
import { callerIp, createRateLimiter, noteReaderAddress } from '@/lib/ratelimit';
import { isPageviewSurface, isSelfDeclaredCrawler, noteRead } from '@/lib/usage';

/*
 * The reading signal's one receiver (step 2 of the owner's answer of
 * 2026-11-23, 12:23 PM ET, card `people`, option b: a first-party "someone
 * read this" signal). lib/read-signal.ts, running on Oravan's own main-site
 * pages and never on /embed, sends at most one POST here per page load,
 * after the page is visible and the person first scrolls, taps or presses a
 * key. Its body is the page's SHAPE ('bill', never which bill) as plain
 * text, and nothing else: no cookie exists to send, the request goes out
 * with no Referer (referrerPolicy 'no-referrer'), and it carries no
 * identifier and no timing.
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
 *        - the body is at most 32 characters and is EXACTLY one of
 *          PAGEVIEW_SURFACES, minus 'short' (a redirect, never a page a
 *          script runs on) — no 'other' fallback, so a made-up value is not
 *          filed anywhere;
 *        - the caller is under this route's own per-IP limit (60 per 10
 *          minutes, keyed like every limiter here on a salted hash that
 *          rotates daily, lib/ratelimit.ts). A real page sends one signal
 *          per load.
 *   3. Increments ONE counter for that page shape and UTC day
 *      (lib/usage.ts noteRead), and, in a SEPARATE call, adds the address to
 *      the day's third sketch (lib/ratelimit.ts noteReaderAddress). The two
 *      are never joined: the counter holds no address, and the sketch holds
 *      no page shape.
 *
 * WHAT REMAINS SPOOFABLE, said plainly as the digest says it: a program can
 * send these headers and this body directly. The per-IP limit bounds what
 * one address can add to the per-shape count, and the sketch counts each
 * address once a day however often it sends, so inflating either takes many
 * addresses. Like every count here it is an operating signal, never audited.
 *
 * Nothing is logged. Static pages stay static: this is a route handler, the
 * kind CLAUDE.md rule 2 already lists, and the script that calls it runs in
 * the browser after the prerendered page has loaded.
 */

const limiter = createRateLimiter({ route: 'seen', max: 60, windowSec: 600 });

/** Longest accepted body; the longest page shape is 15 characters. */
const MAX_BODY_CHARS = 32;

function nothing(): Response {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest): Promise<Response> {
  if (req.headers.get('sec-fetch-site') !== 'same-origin') return nothing();
  if (isSelfDeclaredCrawler(req.headers.get('user-agent'))) return nothing();
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_CHARS) return nothing();

  let body: string;
  try {
    body = await req.text();
  } catch {
    return nothing();
  }
  if (body.length > MAX_BODY_CHARS) return nothing();
  if (!isPageviewSurface(body) || body === 'short') return nothing();
  const surface = body;

  const ip = callerIp(req.headers);
  if (await limiter.isLimited(ip)) return nothing();

  // Two calls, never one: the shape goes to the counter, the address to the
  // sketch. Both never throw.
  await noteRead(surface);
  await noteReaderAddress(ip);
  return nothing();
}
