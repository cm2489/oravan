import { NextRequest, NextResponse } from 'next/server';
import { parseCensusResponse } from '@/lib/district';

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
const CENSUS_QUERY = {
  benchmark: 'Public_AR_Current',
  vintage: 'Current_Current',
  layers: '119th Congressional Districts',
  format: 'json',
};

// Light per-IP rate limit (in-memory, per instance), following app/api/script.
// A little looser than scripts: address typos legitimately take a few tries.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 10;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) return true;
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // crude memory cap
  return false;
}

export async function POST(req: NextRequest) {
  const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();
  if (rateLimited(ip)) {
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
