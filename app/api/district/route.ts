import { NextRequest, NextResponse } from 'next/server';
import { CENSUS_VINTAGE, SITTING_CONGRESS_LAYER, parseCensusResponse } from '@/lib/district';
import { callerIp, createRateLimiter, readOravanKey } from '@/lib/ratelimit';

/*
 * Street address -> single House district, for split-ZIP refinement.
 * Stateless by design: the address is read from the request body, held in
 * memory for one upstream call, and discarded. Nothing is stored.
 *
 * POST, not GET, on purpose: GET query strings are routinely written to
 * server/CDN/proxy access logs, and POST bodies are not. A street address
 * must never land in any log - ours or a host's - so it travels only in
 * the body, on BOTH hops: the visitor's browser POSTs it here, and this
 * route POSTs it on to the Census geocoder as a form body (owner,
 * 2026-09-29: "POST yes"; before that the upstream hop was a GET with the
 * address in its query string). The address never appears in any URL. For
 * the same reason the catch paths below log NOTHING, not even the error
 * object: an upstream fetch error can still describe the request.
 *
 * We proxy the U.S. Census Bureau's public geocoder (no API key, no new
 * secrets) rather than calling it from the browser, so the visitor's own
 * IP address never reaches census.gov.
 */

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';
// Which Congress's map to ask for, and which Census vintage carries it, are
// decided in lib/district.ts (SITTING_CONGRESS, CENSUS_VINTAGE), next to the
// parser that refuses any other Congress's layer. The Jan 3, 2027 swap is
// one edit there, and a Census vintage change can make this route degrade
// (502, the client keeps the all-candidate-districts view) but never name
// the wrong member.
//
// Why (2026-09-28): this query used to ask for vintage Current_Current and
// trusted `layers` to pin "119th Congressional Districts". The Census rolled
// Current_Current to the 120th Congress; asked for a layer it no longer has,
// the geocoder ignored `layers` and answered with every layer it did have,
// the 120th's among them, and the old parser took it. The route was answering
// with the NEXT Congress's district: the Texas Capitol (1100 Congress Ave,
// 78701) came back TX-10, and the district it sits in today is TX-37.
//
// Two-clock model (S24, docs/solutions/two-clock-district-boundaries.md):
// this route answers "who represents you now", which is the 119th
// Congress's map until the 120th is sworn in on Jan 3, 2027, whatever the
// 2025-26 mid-decade redistricting wave does (House terms run Jan 3 ->
// Jan 3; a new state map does not unseat a sitting member). The swap to the
// 120th lands ON that date, not before, and is tripwired so it can't be
// forgotten: scripts/check-rollover-tripwire.mjs (lib/rollover-tripwire.mjs),
// run weekly from refresh-legislators.yml, warns from 2026-12-01 and opens
// one issue naming SITTING_CONGRESS and CENSUS_VINTAGE. Ballot-facing/
// next-term district content (a second, Nov-2026-map-based dataset) is a
// separate clock this route does not serve and is not currently a Oravan
// feature.
const CENSUS_QUERY = {
  benchmark: 'Public_AR_Current',
  vintage: CENSUS_VINTAGE,
  layers: SITTING_CONGRESS_LAYER,
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
  readOravanKey(req.headers); // dormant tenancy hook (S18/S19): recognized, no behavior yet

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
    // A form body, not a query string: the geocoder answers a POST exactly as
    // it answers the GET (checked live with landmark addresses, 2026-09-28/29),
    // and the address stays out of every URL on this hop too.
    const params = new URLSearchParams({ address: `${address}, ${zip}`, ...CENSUS_QUERY });
    const res = await fetch(CENSUS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params,
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
