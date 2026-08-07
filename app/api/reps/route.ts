import { NextRequest, NextResponse } from 'next/server';
import { districtsForZip, repsForDistrict, vacancyForDistrict } from '@/lib/core';
import { callerIp, createRateLimiter, readOravanKey } from '@/lib/ratelimit';

/*
 * ZIP -> representatives. Pure lookup over static data; nothing logged,
 * nothing stored.
 *
 * Rate limit: 300 requests / 10 min per caller — deliberately the loosest
 * per-window ceiling of any per-IP limiter here (script 8, feedback 8,
 * district 10, brand 5, tenant-impressions 20, all per 10 min; MCP's 60/60s
 * is a machine-agent surface with its own 1,000/day companion). Two things
 * make this route different from all of them:
 *
 *   1. It protects INVOCATION COUNT, not spend. There is no upstream call
 *      and no Anthropic token behind it — the whole handler is an in-memory
 *      read of build-time-baked JSON. What's worth bounding is a scripted
 *      walk of the ZIP space against our compute, not a cost leak.
 *   2. It is the ONLY rate-limited route that fires on PAGE RENDER rather
 *      than an explicit user action: components/ActionPanel.tsx (every bill
 *      page, from an effect, whenever a ZIP is already stored),
 *      components/embed/ActionPanelWidget.tsx and
 *      components/embed/RepLookupWidget.tsx all call it without the visitor
 *      doing anything at all. A ceiling sized like /api/script's would trip
 *      on ordinary browsing.
 *
 * 300 is MEASURED, not picked. The route was instrumented with max=100000
 * and a 600s rolling per-key counter, and the FULL Playwright suite was run
 * against it once (2,456 tests, 3 projects, 4 workers). Browser tests send
 * no x-forwarded-for, so callerIp() answers 'unknown' for every one of them
 * and the entire suite lands on a SINGLE counter key — the worst case this
 * limit has to survive. Observed: peak 105 hits inside one rolling 600s
 * window, 1 distinct key, 105 reps requests in the whole run. 300 is ~2.9x
 * that, which absorbs CI's `retries: 2` (vs. 1 locally) and leaves room for
 * new ZIP-bearing specs before this number needs thinking about again. In
 * human terms it is one lookup every two seconds sustained, from a surface
 * that fires at most once per page view.
 *
 * PRIVACY (CLAUDE.md, "no logs linking network addresses to political
 * positions"): ONLY callerIp(req.headers) is passed to the limiter. The ZIP
 * is read AFTER the gate and never reaches a counter key, a log, or an
 * error body — a trip answers the same bare {error:'rate_limited'} the
 * other routes do, with no Retry-After and nothing caller-derived on it.
 * (/api/script's citizen path discloses retryAfterSec so the panel can
 * degrade honestly; that is a deliberate exception there, not the house
 * shape, and a render-triggered lookup has no such copy to degrade.) The
 * ZIP staying out of the key is mechanical, not a matter of care:
 * scripts/check-key-namespaces.mjs's CONTENT_IDENTIFIER gained `\bzip\b`
 * with this change, so a `${zip}` interpolation in lib/ratelimit.ts fails
 * CI.
 */
const limiter = createRateLimiter({ route: 'reps', max: 300, windowSec: 600 });

export async function GET(req: NextRequest) {
  readOravanKey(req.headers); // dormant tenancy hook (S18/S19): recognized, no behavior yet

  const ip = callerIp(req.headers);
  if (await limiter.isLimited(ip)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const zip = req.nextUrl.searchParams.get('zip') ?? '';
  if (!/^\d{5}$/.test(zip)) {
    return NextResponse.json({ error: 'bad_zip' }, { status: 400 });
  }
  const districts = districtsForZip(zip);
  const seen = new Set<string>();
  const reps = districts
    .flatMap((d) => repsForDistrict(d))
    .filter((r) => (seen.has(r.bioguide) ? false : (seen.add(r.bioguide), true)));
  // Fact only (state + district) - `since` is pipeline bookkeeping for
  // de-duplicating alerts across weekly runs, not surfaced as an
  // authoritative event date to API consumers.
  const vacancies = districts
    .map((d) => vacancyForDistrict(d))
    .filter((v): v is NonNullable<typeof v> => Boolean(v))
    .map((v) => ({ state: v.state, district: v.district }));
  return NextResponse.json({ reps, multiDistrict: districts.length > 1, vacancies });
}
