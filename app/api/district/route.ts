import { NextRequest, NextResponse } from 'next/server';
import { parseCensusResponse } from '@/lib/district';
import { callerIp, createRateLimiter, readRostraKey } from '@/lib/ratelimit';

/*
 * Street address -> single House district, for split-ZIP refinement.
 * Stateless by design: the address is read from the request body, held in
 * memory for one upstream call, and discarded. Nothing is stored.
 *
 * POST, not GET, on purpose: GET query strings are routinely written to
 * server/CDN/proxy access logs, and POST bodies are not. A street address
 * must never land in any log - ours or a host's - so it travels only in
 * the body. For the same reason the catch paths below log NOTHING, not
 * even the error object: upstream fetch errors can embed the request URL,
 * which contains the address.
 *
 * We proxy the U.S. Census Bureau's public geocoder (no API key, no new
 * secrets) rather than calling it from the browser, so the visitor's own
 * IP address never reaches census.gov.
 */

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';
// Benchmark, vintage, and layer verified against the live service (2026-07):
// Public_AR_Current + Current_Current exposes "119th Congressional Districts".
// The layer name tracks the sitting Congress; the parser matches it by
// pattern, but this request string needs a bump when the vintage rolls over.
//
// Two-clock model (S24, docs/solutions/two-clock-district-boundaries.md):
// this literal answers "who represents you now," which stays correct through
// Jan 3, 2027 regardless of the 2025-26 mid-decade redistricting wave (House
// terms run Jan 3 -> Jan 3; a new state map does not unseat a sitting
// member). NO SWAP IS NEEDED before then. The mandatory bump to "120th
// Congressional Districts" IS required before Jan 3, 2027 though, and is
// tripwired so it can't be forgotten: scripts/check-rollover-tripwire.mjs
// (lib/rollover-tripwire.mjs), run weekly from refresh-legislators.yml,
// starts a loud ::warning on/after 2026-12-01. Ballot-facing/next-term
// district content (a second, Nov-2026-map-based dataset) is a separate
// clock this route does not serve and is not currently a Rostra feature.
const CENSUS_QUERY = {
  benchmark: 'Public_AR_Current',
  vintage: 'Current_Current',
  layers: '119th Congressional Districts',
  format: 'json',
};

// Rate limit: 10 requests / 10 min per caller (a little looser than scripts:
// address typos legitimately take a few tries — same limit as always). As of
// S11 this is enforced with short-lived rate-limit counters in the Upstash
// counters database (sha256(ip + rotating salt), durable across instances),
// degrading to the per-instance in-memory window when unconfigured or
// unreachable — see lib/ratelimit.ts. The address itself never gets anywhere
// near the limiter: only the caller hash does.
const limiter = createRateLimiter({ route: 'district', max: 10, windowSec: 600 });

export async function POST(req: NextRequest) {
  readRostraKey(req.headers); // dormant tenancy hook (S18/S19): recognized, no behavior yet

  const ip = callerIp(req.headers);
  if (await limiter.isLimited(ip)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  let body: { address?: unknown; zip?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const address = typeof body.address === 'string' ? body.address.trim() : '';
  const zip = typeof body.zip === 'string' ? body.zip.trim() : '';
  if (address.length < 3 || address.length > 120 || !/^\d{5}$/.test(zip)) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  let payload: unknown;
  try {
    const params = new URLSearchParams({ address: `${address}, ${zip}`, ...CENSUS_QUERY });
    const res = await fetch(`${CENSUS_URL}?${params}`, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('upstream_status');
    payload = await res.json();
  } catch {
    // Timeout, network failure, or a non-200: degrade softly. The client
    // keeps the all-candidate-districts view, so nothing is blocked.
    return NextResponse.json({ error: 'unavailable' }, { status: 502 });
  }

  const parsed = parseCensusResponse(payload);
  if (parsed.status === 'no_match') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (parsed.status === 'unrecognized') {
    return NextResponse.json({ error: 'unavailable' }, { status: 502 });
  }
  return NextResponse.json(parsed.district);
}
