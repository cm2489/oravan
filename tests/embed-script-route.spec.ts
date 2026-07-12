import { expect, test } from '@playwright/test';
import { E2E_TENANT_TOKEN, E2E_TENANT_TOKEN_INACTIVE, E2E_TENANT_TOKEN_NO_TOS } from './fixtures/e2e-tenant';

/*
 * S19 — /api/script's LIVE three-way X-Oravan-Key gate, driven directly at
 * the real running server (request fixture, not a browser page): the route
 * cannot be require()d in a unit spec (it transitively pulls an ESM-only
 * dependency — confirmed empirically: "Cannot use import statement outside
 * a module" when attempted directly, the same limitation
 * tests/upstash-privacy.spec.ts already documents for script/MCP), so this
 * is the only way to pin the ROUTE's own HTTP-level behavior rather than
 * the underlying modules it calls (already thoroughly unit-tested in
 * tests/tenancy.unit.spec.ts, tests/ratelimit.unit.spec.ts, and the AE5
 * embed-originating test in tests/upstash-privacy.spec.ts).
 *
 * There is no live ANTHROPIC_API_KEY in this sandbox, so a request that
 * passes the ENTIRE gate still can't succeed — it reaches real generation
 * and fails there (502 generation_failed). That is the DECISIVE proof used
 * throughout: 403 means the gate itself rejected the request; 502 means
 * every check passed and the route reached Anthropic. tests/e2e-server.mjs
 * points UPSTASH_TENANCY_REST_URL/TOKEN at a tiny fake backend seeding the
 * fixture tenants this file presents tokens for
 * (tests/fixtures/e2e-tenant.ts) — counters/cache stay unconfigured, same
 * as every other e2e test in this suite.
 *
 * Every request carries a distinct synthetic x-forwarded-for so this
 * file's own per-IP-limiter traffic never interferes with itself across
 * Playwright's parallel workers/projects (mirrors tests/helpers.ts's
 * nextMcpCallerIp, widened to a private /8 for a much larger address space
 * since this file's requests run across two projects × multiple tests).
 */

const SLUG = 'sjres-99-119';

function nextIp(): string {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return `10.${octet()}.${octet()}.${octet()}`;
}

test('citizen path unchanged: absent X-Oravan-Key behaves exactly as before S19 (no live ANTHROPIC_API_KEY in this sandbox -> 502)', async ({
  request,
}) => {
  const res = await request.post('/api/script', {
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
    data: { slug: SLUG, stance: 'support', locale: 'en' },
  });
  expect(res.status()).toBe(502);
  expect(await res.json()).toEqual({ error: 'generation_failed' });
});

test('embed-originating, garbage/unresolvable token: 403 unauthorized, fail-closed - never silently downgraded to the citizen path', async ({
  request,
}) => {
  const res = await request.post('/api/script', {
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': nextIp(),
      'x-oravan-key': 'totally-made-up-token-that-cannot-resolve',
    },
    data: { slug: SLUG, stance: 'oppose', locale: 'en' },
  });
  expect(res.status()).toBe(403);
  expect(await res.json()).toEqual({ error: 'unauthorized' });
});

test('embed-originating, revoked/inactive tenant token: 403 unauthorized - the SAME outcome as a bad token (deliberately not distinguished)', async ({
  request,
}) => {
  const res = await request.post('/api/script', {
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': nextIp(),
      'x-oravan-key': E2E_TENANT_TOKEN_INACTIVE,
    },
    data: { slug: SLUG, stance: 'undecided', locale: 'en' },
  });
  expect(res.status()).toBe(403);
  expect(await res.json()).toEqual({ error: 'unauthorized' });
});

test('embed-originating, active tenant with no ToS on file: 403 tos_required - DISTINCT from unauthorized', async ({
  request,
}) => {
  const res = await request.post('/api/script', {
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': nextIp(),
      'x-oravan-key': E2E_TENANT_TOKEN_NO_TOS,
    },
    data: { slug: SLUG, stance: 'support', locale: 'en' },
  });
  expect(res.status()).toBe(403);
  expect(await res.json()).toEqual({ error: 'tos_required' });
});

test('embed-originating, fully-authorized tenant: passes the entire gate + both per-tenant limiters, reaches real generation', async ({
  request,
}) => {
  const res = await request.post('/api/script', {
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': nextIp(),
      'x-oravan-key': E2E_TENANT_TOKEN,
    },
    data: { slug: SLUG, stance: 'oppose', locale: 'en' },
  });
  // 502, not 403 - the decisive proof (see file header comment).
  expect(res.status()).toBe(502);
  expect(await res.json()).toEqual({ error: 'generation_failed' });
});

test('bad_request/not_found guards are unchanged for an authorized embed-originating caller too', async ({
  request,
}) => {
  const notFound = await request.post('/api/script', {
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': nextIp(),
      'x-oravan-key': E2E_TENANT_TOKEN,
    },
    data: { slug: 'not-a-real-bill-999', stance: 'support', locale: 'en' },
  });
  expect(notFound.status()).toBe(404);
  expect(await notFound.json()).toEqual({ error: 'not_found' });

  const badRequest = await request.post('/api/script', {
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': nextIp(),
      'x-oravan-key': E2E_TENANT_TOKEN,
    },
    data: { slug: SLUG, stance: 'not-a-real-stance', locale: 'en' },
  });
  expect(badRequest.status()).toBe(400);
  expect(await badRequest.json()).toEqual({ error: 'bad_request' });
});

test('response shape carries no tenant metadata even on the error paths', async ({ request }) => {
  const res = await request.post('/api/script', {
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': nextIp(),
      'x-oravan-key': E2E_TENANT_TOKEN,
    },
    data: { slug: SLUG, stance: 'support', locale: 'en' },
  });
  const body = await res.json();
  expect(Object.keys(body)).toEqual(['error']);
});
