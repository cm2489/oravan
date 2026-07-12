import { NextRequest } from 'next/server';
import { expect, test } from '@playwright/test';
// Relative import (not '@/'): app/api/district/route.ts is already proven
// require()-able in a unit spec (tests/upstash-privacy.spec.ts's own
// comment) — this route has no ESM-only dependency either (no
// @anthropic-ai/sdk, no mcp-handler), so it doesn't need the heavier e2e
// harness action-panel required.
import { GET as tenantImpressionsGet } from '../app/api/tenant/impressions/route';
import { dayKey } from '../lib/embed-referrer';
import { impressionDayKey } from '../lib/impressions';
import { mintCapabilityToken, tenantKey, tokenHash, tokenIndexKey, type TenantRecord } from '../lib/tenancy';
import { COUNTERS_URL, MockUpstash, TENANCY_URL, installUpstashFetch, setUpstashEnv } from './upstash-mock';

/*
 * S20 (F6): the tenant-authenticated read path, GET /api/tenant/impressions.
 * Driven directly against the real route module (see the import comment
 * above for why that's possible here but not for /api/script).
 */

test.describe.configure({ mode: 'serial' }); // shared env + global-fetch swaps

let restoreFetch: (() => void) | null = null;
let restoreEnv: (() => void) | null = null;

test.afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  restoreEnv?.();
  restoreEnv = null;
});

function seedTenant(mock: MockUpstash, tenantId: string, overrides: Partial<TenantRecord> = {}): string {
  const token = mintCapabilityToken();
  const hash = tokenHash(token);
  const record: TenantRecord = {
    tenantId,
    tokenHash: hash,
    tier: 'pro',
    domainAllowlist: [],
    orgName: 'Tenant Read Fixture Org',
    attribution: 'required',
    createdAt: new Date().toISOString(),
    subscriptionId: `sub_${tenantId}`,
    subscriptionStatus: 'active',
    tosAcceptedAt: new Date().toISOString(),
    ...overrides,
  };
  mock.exec(['SET', tenantKey(tenantId), JSON.stringify(record)]);
  mock.exec(['SET', tokenIndexKey(hash), tenantId]);
  return token;
}

function req(opts: { token?: string; ip?: string; months?: string } = {}): NextRequest {
  const url = new URL('http://localhost/api/tenant/impressions');
  if (opts.months !== undefined) url.searchParams.set('months', opts.months);
  const headers: Record<string, string> = { 'x-forwarded-for': opts.ip ?? '198.51.100.50' };
  if (opts.token !== undefined) headers['x-oravan-key'] = opts.token;
  return new NextRequest(url, { headers });
}

// --- auth: the same fail-closed, non-distinguishing doctrine as resolveTenantAccess ---

test('missing token -> 403 unauthorized, without ever touching the tenancy database', async () => {
  restoreEnv = setUpstashEnv();
  const tenancy = new MockUpstash();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: tenancy, [COUNTERS_URL]: counters });

  const res = await tenantImpressionsGet(req({ ip: '198.51.100.60' }));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'unauthorized' });
  expect(tenancy.commands).toHaveLength(0);
});

test('bad/unknown token -> 403 unauthorized (same shape as missing)', async () => {
  restoreEnv = setUpstashEnv();
  const tenancy = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: tenancy });

  const res = await tenantImpressionsGet(req({ token: 'never-issued-token', ip: '198.51.100.61' }));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'unauthorized' });
});

test('revoked/inactive-subscription tenant -> 403 unauthorized (indistinguishable from a bad token)', async () => {
  restoreEnv = setUpstashEnv();
  const tenancy = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: tenancy });

  const token = seedTenant(tenancy, 'cus_read_inactive', { subscriptionStatus: 'canceled' });
  const res = await tenantImpressionsGet(req({ token, ip: '198.51.100.62' }));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'unauthorized' });
});

test('a momentarily-unreachable tenancy database -> 403 unauthorized (fails closed, same as a bad token)', async () => {
  restoreEnv = setUpstashEnv();
  const tenancy = new MockUpstash();
  tenancy.failWithStatus = 503;
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: tenancy });

  const res = await tenantImpressionsGet(req({ token: 'does-not-matter', ip: '198.51.100.63' }));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'unauthorized' });
});

test('active tenant with NO tosAcceptedAt still authorizes — unlike resolveTenantAccess, this gate has no ToS check', async () => {
  restoreEnv = setUpstashEnv();
  const tenancy = new MockUpstash();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: tenancy, [COUNTERS_URL]: counters });

  const token = seedTenant(tenancy, 'cus_read_no_tos', { tosAcceptedAt: undefined });
  const res = await tenantImpressionsGet(req({ token, ip: '198.51.100.64' }));
  expect(res.status).toBe(200);
});

// --- cross-tenant isolation -------------------------------------------------------

test("cross-tenant read refusal: tenant B's token can never see tenant A's data — asserted on the exact MGET key arguments", async () => {
  restoreEnv = setUpstashEnv();
  const tenancy = new MockUpstash();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: tenancy, [COUNTERS_URL]: counters });

  const tokenA = seedTenant(tenancy, 'cus_tenant_a');
  const tokenB = seedTenant(tenancy, 'cus_tenant_b');
  // "today" (UTC), not a hardcoded date — readImpressionsWindow's default
  // `now` is the real wall clock, and months=1 only ever asks for the
  // current (partial) month's days.
  counters.exec(['SET', impressionDayKey('cus_tenant_a', dayKey()), '500']);
  counters.exec(['SET', impressionDayKey('cus_tenant_b', dayKey()), '7']);

  const resA = await tenantImpressionsGet(req({ token: tokenA, ip: '198.51.100.70', months: '1' }));
  const bodyA = await resA.json();
  expect(bodyA.total).toBe(500);

  const resB = await tenantImpressionsGet(req({ token: tokenB, ip: '198.51.100.71', months: '1' }));
  const bodyB = await resB.json();
  expect(bodyB.total).toBe(7);

  // The exact MGET key arguments: each request only ever asked for ITS OWN
  // tenant's keys — not just "got the right total by coincidence".
  const mgets = counters.commands.filter((c) => c[0] === 'MGET');
  expect(mgets).toHaveLength(2);
  for (const key of mgets[0].slice(1)) expect(key).toContain('cus_tenant_a');
  for (const key of mgets[1].slice(1)) expect(key).toContain('cus_tenant_b');
  expect(mgets[0].join(' ')).not.toContain('cus_tenant_b');
  expect(mgets[1].join(' ')).not.toContain('cus_tenant_a');

  // tenantId is deliberately never echoed in either response body.
  expect(JSON.stringify(bodyA)).not.toContain('cus_tenant_a');
  expect(JSON.stringify(bodyB)).not.toContain('cus_tenant_b');
});

// --- rate limiting: per-IP first (unconditional), then per-tenant ----------------

test('burst past the per-IP limiter (20/10min) -> 429 rate_limited, before ever touching the tenancy database', async () => {
  restoreEnv = setUpstashEnv();
  const tenancy = new MockUpstash();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: tenancy, [COUNTERS_URL]: counters });

  const ip = '198.51.100.80';
  let last;
  for (let i = 0; i < 21; i++) {
    last = await tenantImpressionsGet(req({ ip })); // no token — proves the IP gate runs first regardless
  }
  expect(last!.status).toBe(429);
  expect(await last!.json()).toEqual({ error: 'rate_limited' });
});

test('burst past the per-tenant limiter (60/10min) -> 429 rate_limited', async () => {
  restoreEnv = setUpstashEnv();
  const tenancy = new MockUpstash();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: tenancy, [COUNTERS_URL]: counters });

  const token = seedTenant(tenancy, 'cus_read_burst');
  let last;
  // A distinct caller IP per request (the per-IP limiter's own 20/10min cap
  // is a different limiter/threshold — this isolates the per-TENANT gate).
  for (let i = 0; i < 61; i++) {
    last = await tenantImpressionsGet(req({ token, ip: `198.51.100.${100 + i}` }));
  }
  expect(last!.status).toBe(429);
  expect(await last!.json()).toEqual({ error: 'rate_limited' });
});

// --- read failure: loud, never a silently-wrong number ---------------------------

test('counters-database failure during read -> 503 temporarily_unavailable, never a silently-wrong number', async () => {
  restoreEnv = setUpstashEnv();
  const tenancy = new MockUpstash();
  const counters = new MockUpstash();
  counters.failWithStatus = 500;
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: tenancy, [COUNTERS_URL]: counters });

  const token = seedTenant(tenancy, 'cus_read_down');
  const res = await tenantImpressionsGet(req({ token, ip: '198.51.100.90' }));
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
});

// --- successful shape --------------------------------------------------------------

test('a successful read: Cache-Control private/no-store, disclosure + measurementBasis present, tenantId never echoed', async () => {
  restoreEnv = setUpstashEnv();
  const tenancy = new MockUpstash();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: tenancy, [COUNTERS_URL]: counters });

  const token = seedTenant(tenancy, 'cus_read_shape');
  const res = await tenantImpressionsGet(req({ token, ip: '198.51.100.95', months: '2' }));
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('private, no-store');

  const body = await res.json();
  expect(body.measurementBasis).toBe('best_effort_spoofable');
  expect(typeof body.disclosure).toBe('string');
  expect(body.disclosure).toContain('best-effort');
  expect(body.disclosure).toContain('spoofable');
  expect(typeof body.asOf).toBe('string');
  expect(Array.isArray(body.months)).toBe(true);
  expect(body.months).toHaveLength(2);
  expect(typeof body.total).toBe('number');
  expect(JSON.stringify(body)).not.toContain('cus_read_shape');
});

test('?months is clamped into [1,13], never a 400 (a reporting-window selector, not a validated content shape)', async () => {
  restoreEnv = setUpstashEnv();
  const tenancy = new MockUpstash();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: tenancy, [COUNTERS_URL]: counters });

  const token = seedTenant(tenancy, 'cus_read_clamp');
  const tooMany = await tenantImpressionsGet(req({ token, ip: '198.51.100.96', months: '999' }));
  expect(tooMany.status).toBe(200);
  expect((await tooMany.json()).months).toHaveLength(13);

  const garbage = await tenantImpressionsGet(req({ token, ip: '198.51.100.97', months: 'not-a-number' }));
  expect(garbage.status).toBe(200);
  expect((await garbage.json()).months).toHaveLength(13); // default
});
