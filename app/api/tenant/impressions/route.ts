import { NextRequest, NextResponse } from 'next/server';
import { readImpressionsWindow } from '@/lib/impressions';
import { callerIp, createRateLimiter, createTenantRateLimiter, readOravanKey } from '@/lib/ratelimit';
import { activeTenantForImpression } from '@/lib/tenancy';

/*
 * A tenant reading their OWN monthly aggregate impression counts (S20, F6).
 * Auth: X-Oravan-Key (readOravanKey, reused verbatim from lib/ratelimit.ts —
 * no new header parsing), authorized via activeTenantForImpression — NOT
 * resolveTenantAccess. Same reasoning as the write path (lib/tenancy.ts's
 * own doc comment): tosAcceptedAt is an AI-consent gate for the action
 * panel / /api/script, and the ToS URL isn't yet configured in Stripe, so
 * every tenant provisioned before that lands has it unset. Reading your own
 * metering shouldn't be blocked by an unrelated, unconfigured field.
 *
 * Bad/missing/revoked token, an inactive subscription, and a momentarily-
 * unreachable tenancy database all collapse to the SAME
 * 403 {error:'unauthorized'} — activeTenantForImpression already fails
 * closed to null for all four, and this route never distinguishes them
 * further (identical fail-closed, non-distinguishing doctrine as
 * resolveTenantAccess, for the same token-probing reason).
 *
 * Rate limiting, composed in the same order /api/script uses: per-IP first
 * (unconditional — protects the tenancy-database lookup from anonymous
 * token-guessing regardless of DB health), then per-tenant once a token
 * resolves. Numbers are disclosed as tunable, not derived from real demand
 * — same honesty framing S19 already used for its own limiter numbers
 * (zero live tenant traffic exists yet).
 *
 * tenantId is deliberately NEVER echoed in the response body — the whole
 * point of the capability-token model is the tenant never handles their own
 * internal id; the response is already scoped to them via the token.
 * Cache-Control: private, no-store — authenticated per-tenant data must
 * never sit in a shared cache.
 *
 * DELIBERATE WRITE/READ ASYMMETRY: unlike every Upstash WRITE in this repo
 * (which fails open, silently, to an in-memory fallback), this READ fails
 * LOUD — an unconfigured or erroring counters database returns
 * 503 {error:'temporarily_unavailable'}, never a confidently-wrong number
 * computed from a per-instance fallback that would badly undercount a
 * serverless fleet's real total. See lib/impressions.ts's
 * readImpressionsWindow doc comment.
 */

const DISCLOSURE =
  'Server-side, daily-bucketed page-load counts, best-effort. Unauthenticated public writes are spoofable by design — this is an indicator of embed traffic, not an audited or fraud-proof metric. Retained 400 days.';

const ipLimiter = createRateLimiter({ route: 'tenant-impressions', max: 20, windowSec: 600 });
const tenantLimiter = createTenantRateLimiter({ route: 'tenant-impressions-read', max: 60, windowSec: 600 });

/** ?months=1..13, default 13 (current partial + 12 complete). Out-of-range/garbage clamps, never 400s — a reporting-window selector, not a validated content shape. */
function clampMonths(raw: string | null): number {
  const n = raw === null ? 13 : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) return 13;
  return Math.min(13, Math.max(1, n));
}

export async function GET(req: NextRequest) {
  const ip = callerIp(req.headers);
  if (await ipLimiter.isLimited(ip)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const token = readOravanKey(req.headers);
  const tenant = await activeTenantForImpression(token);
  if (!tenant) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 403 });
  }

  if (await tenantLimiter.isLimited(tenant.tenantId)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const months = clampMonths(req.nextUrl.searchParams.get('months'));
  const result = await readImpressionsWindow(tenant.tenantId, months);
  if (!result.ok) {
    return NextResponse.json({ error: 'temporarily_unavailable' }, { status: 503 });
  }

  return NextResponse.json(
    {
      months: result.months,
      total: result.total,
      asOf: new Date().toISOString(),
      measurementBasis: 'best_effort_spoofable',
      disclosure: DISCLOSURE,
    },
    { headers: { 'Cache-Control': 'private, no-store' } }
  );
}
