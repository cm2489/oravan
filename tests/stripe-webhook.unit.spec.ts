import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): plain lib modules and this route only touch
// next/server - same pattern as tests/feedback.unit.spec.ts and
// tests/upstash-privacy.spec.ts (which notes app/api/script and the MCP
// route CANNOT be require()d in a unit spec because they pull ESM-only
// deps - this route has no such dependency, so it's driven directly).
import { POST, __resetStripeWebhookLogForTests } from '../app/api/stripe/webhook/route';
import { POST as feedbackPost } from '../app/api/feedback/route';
import { verifyStripeSignature } from '../lib/stripe-webhook';
import { parseTenantRecord, tenantKey } from '../lib/tenancy';
import { MockUpstash, TENANCY_URL, installUpstashFetch, setUpstashEnv } from './upstash-mock';

/*
 * Route + signature-verification tests for the S18 Stripe webhook. Real
 * HMAC-SHA256 signatures are computed in this file with node:crypto against
 * a test-only secret - no mocking of the crypto itself, matching the design
 * doc's "unit-testable by computing a known HMAC in the test fixture" plan.
 * The GLOBAL fetch swap only ever answers the mocked tenancy REST surface;
 * a live network call anywhere in this suite is a bug, not a feature.
 */

test.describe.configure({ mode: 'serial' }); // shared env + global-fetch swaps

const TEST_SECRET = 'whsec_test_1234567890';
const ORIGINAL_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

let restoreFetch: (() => void) | null = null;
let restoreEnv: (() => void) | null = null;

test.afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  restoreEnv?.();
  restoreEnv = null;
  if (ORIGINAL_SECRET === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = ORIGINAL_SECRET;
  __resetStripeWebhookLogForTests();
});

// --- fixture builders --------------------------------------------------------

function signPayload(secret: string, payload: string, timestamp: number = Math.floor(Date.now() / 1000)): string {
  const hmac = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${hmac}`;
}

function stripeRequest(payload: string, signatureHeader: string | null): Parameters<typeof POST>[0] {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signatureHeader !== null) headers['stripe-signature'] = signatureHeader;
  return new Request('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers,
    body: payload,
  }) as unknown as Parameters<typeof POST>[0];
}

/** A request whose headers/body throw if ever touched - proves the dark-ship guard runs first. */
function poisonedRequest(): Parameters<typeof POST>[0] {
  const poison = () => {
    throw new Error('S18 dark-ship violation: the request was touched despite a missing secret');
  };
  return {
    headers: new Proxy({}, { get: poison }),
    text: poison,
  } as unknown as Parameters<typeof POST>[0];
}

function checkoutSessionCompletedPayload(
  overrides: {
    eventId?: string;
    mode?: string;
    customer?: string | null;
    subscription?: string | null;
    tier?: string | null;
    domain?: string | null;
    orgName?: string | null;
  } = {}
): string {
  const {
    eventId = 'evt_checkout_default',
    mode = 'subscription',
    customer = 'cus_default',
    subscription = 'sub_default',
    tier = 'pro',
    domain = 'example.org',
    orgName = 'Example Org',
  } = overrides;
  const customFields: Array<{ key: string; type: string; text: { value: string } }> = [];
  if (domain !== null) customFields.push({ key: 'domain', type: 'text', text: { value: domain } });
  if (orgName !== null) customFields.push({ key: 'org_name', type: 'text', text: { value: orgName } });
  return JSON.stringify({
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        mode,
        customer,
        subscription,
        metadata: tier !== null ? { tier } : {},
        custom_fields: customFields,
      },
    },
  });
}

function subscriptionEventPayload(
  type: 'customer.subscription.updated' | 'customer.subscription.deleted',
  eventId: string,
  customer: string,
  status: string
): string {
  return JSON.stringify({ id: eventId, type, data: { object: { id: 'sub_x', customer, status } } });
}

// --- pure signature verification (no route, no Upstash) --------------------

test('verifyStripeSignature: accepts a correctly-signed payload', () => {
  const payload = '{"id":"evt_x","type":"checkout.session.completed"}';
  const header = signPayload(TEST_SECRET, payload);
  expect(verifyStripeSignature(payload, header, TEST_SECRET)).toBe(true);
});

test('verifyStripeSignature: rejects a tampered payload (HMAC no longer matches)', () => {
  const payload = '{"id":"evt_x"}';
  const header = signPayload(TEST_SECRET, payload);
  expect(verifyStripeSignature(`${payload}tampered`, header, TEST_SECRET)).toBe(false);
});

test('verifyStripeSignature: rejects the wrong secret', () => {
  const payload = '{"id":"evt_x"}';
  const header = signPayload('a-different-secret', payload);
  expect(verifyStripeSignature(payload, header, TEST_SECRET)).toBe(false);
});

test('verifyStripeSignature: malformed/absent headers are rejected without throwing', () => {
  const payload = '{"id":"evt_x"}';
  expect(verifyStripeSignature(payload, null, TEST_SECRET)).toBe(false);
  expect(verifyStripeSignature(payload, '', TEST_SECRET)).toBe(false);
  expect(verifyStripeSignature(payload, 'garbage', TEST_SECRET)).toBe(false);
  expect(verifyStripeSignature(payload, 't=not-a-number,v1=deadbeef', TEST_SECRET)).toBe(false);
  expect(verifyStripeSignature(payload, `t=${Math.floor(Date.now() / 1000)},v1=not-hex-zz`, TEST_SECRET)).toBe(false);

  // v1 present, valid hex, but decodes to a different byte length than the
  // real 32-byte HMAC digest - must not throw (RangeError guard before
  // timingSafeEqual) and must cleanly reject.
  const shortHeader = `t=${Math.floor(Date.now() / 1000)},v1=ab`;
  expect(() => verifyStripeSignature(payload, shortHeader, TEST_SECRET)).not.toThrow();
  expect(verifyStripeSignature(payload, shortHeader, TEST_SECRET)).toBe(false);
});

test('verifyStripeSignature: replay tolerance is exact at the 300s boundary (Stripe\'s own default)', () => {
  const payload = '{"id":"evt_x"}';
  const now = Math.floor(Date.now() / 1000);
  expect(verifyStripeSignature(payload, signPayload(TEST_SECRET, payload, now - 300), TEST_SECRET, 300, now)).toBe(
    true
  );
  expect(verifyStripeSignature(payload, signPayload(TEST_SECRET, payload, now - 301), TEST_SECRET, 300, now)).toBe(
    false
  );
  // Future-dated timestamps (clock skew, or a replay-forward attempt) are
  // equally bounded - abs(), not a one-sided check.
  expect(verifyStripeSignature(payload, signPayload(TEST_SECRET, payload, now + 301), TEST_SECRET, 300, now)).toBe(
    false
  );
});

// --- dark-ship posture (unset secret) ---------------------------------------

test('dark-ship posture: unset STRIPE_WEBHOOK_SECRET -> 503, request never touched, tenancy database never touched', async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  restoreEnv = setUpstashEnv(); // tenancy IS configured - proves the route still never reaches it
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });

  const res = await POST(poisonedRequest()); // throws if headers/body are ever read
  expect(res.status).toBe(503);
  expect(mock.commands, 'the tenancy database must never be touched when the secret is absent').toHaveLength(0);
});

test('dark-ship posture: exactly one startup-style log line regardless of request count', async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => logged.push(args.join(' '));
  try {
    await POST(poisonedRequest());
    await POST(poisonedRequest());
    await POST(poisonedRequest());
  } finally {
    console.log = realLog;
  }
  const startupLines = logged.filter((l) => l.includes('STRIPE_WEBHOOK_SECRET'));
  expect(startupLines).toHaveLength(1);
});

// --- signature / replay rejection at the route level ------------------------

test('bad signature: 400, no idempotency claim, no tenancy writes', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });

  const payload = checkoutSessionCompletedPayload({ eventId: 'evt_bad_sig' });
  const res = await POST(stripeRequest(payload, signPayload('wrong-secret', payload)));
  expect(res.status).toBe(400);
  expect(mock.commands).toHaveLength(0);
});

test('replay rejection: a stale (>5min) but otherwise validly-signed event is rejected, nothing written', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });

  const payload = checkoutSessionCompletedPayload({ eventId: 'evt_replay' });
  const staleHeader = signPayload(TEST_SECRET, payload, Math.floor(Date.now() / 1000) - 301);
  const res = await POST(stripeRequest(payload, staleHeader));
  expect(res.status).toBe(400);
  expect(mock.commands).toHaveLength(0);
});

test('bad_request: an unparseable body (valid signature over garbage JSON) is rejected 400', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });

  const payload = 'not json';
  const res = await POST(stripeRequest(payload, signPayload(TEST_SECRET, payload)));
  expect(res.status).toBe(400);
  expect(mock.commands).toHaveLength(0);
});

// --- idempotency -------------------------------------------------------------

test('idempotent re-delivery: the same event id is processed once; the retry is a no-op 200', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });

  const payload = checkoutSessionCompletedPayload({ eventId: 'evt_idem_1', customer: 'cus_idem' });
  const header = signPayload(TEST_SECRET, payload);

  const first = await POST(stripeRequest(payload, header));
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ ok: true });

  const second = await POST(stripeRequest(payload, header)); // exact same delivery, replayed
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual({ ok: true, duplicate: true });

  // Only ONE tenant-record write happened, not two.
  const tenantSets = mock.commands.filter((c) => c[0] === 'SET' && c[1] === tenantKey('cus_idem'));
  expect(tenantSets).toHaveLength(1);
});

// --- tenancy database unavailable -------------------------------------------

test('tenancy database unconfigured: 503, distinct from a signature failure', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
  // No setUpstashEnv() - secret IS set, tenancy is NOT configured.
  const payload = checkoutSessionCompletedPayload({ eventId: 'evt_unavailable' });
  const res = await POST(stripeRequest(payload, signPayload(TEST_SECRET, payload)));
  expect(res.status).toBe(503);
});

// --- checkout.session.completed provisioning --------------------------------

test('checkout.session.completed: provisions a new tenant, normalizes the domain field to lowercase registrable form', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });

  const payload = checkoutSessionCompletedPayload({
    eventId: 'evt_provision_1',
    customer: 'cus_provision',
    subscription: 'sub_provision',
    tier: 'pro',
    domain: 'Newsroom.Example',
    orgName: 'Provisioned Newsroom',
  });
  const res = await POST(stripeRequest(payload, signPayload(TEST_SECRET, payload)));
  expect(res.status).toBe(200);

  const record = parseTenantRecord(mock.store.get(tenantKey('cus_provision'))!.value)!;
  expect(record.tier).toBe('pro');
  expect(record.domainAllowlist).toEqual(['newsroom.example']);
  expect(record.orgName).toBe('Provisioned Newsroom');
  expect(record.subscriptionStatus).toBe('active');
  expect(record.attribution, 'self-serve checkout never grants attribution removal').toBe('required');
  expect(mock.keys().filter((k) => k.startsWith('dev:token:'))).toHaveLength(1);
});

test('checkout.session.completed guard: non-subscription mode is a silent no-op (200, zero writes)', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });

  const payload = checkoutSessionCompletedPayload({ eventId: 'evt_guard_mode', mode: 'payment' });
  const res = await POST(stripeRequest(payload, signPayload(TEST_SECRET, payload)));
  expect(res.status).toBe(200);
  expect(mock.keys().filter((k) => k.startsWith('dev:tenant:'))).toHaveLength(0);
});

test('checkout.session.completed guard: unrecognized/missing tier is a silent no-op (200, zero writes)', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });

  const payload = checkoutSessionCompletedPayload({ eventId: 'evt_guard_tier', tier: 'enterprise' });
  const res = await POST(stripeRequest(payload, signPayload(TEST_SECRET, payload)));
  expect(res.status).toBe(200);
  expect(mock.keys().filter((k) => k.startsWith('dev:tenant:'))).toHaveLength(0);
});

// --- subscription lifecycle sync (route level) ------------------------------

test('customer.subscription.updated (route level): past_due revokes the token within this event\'s processing', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });

  const checkoutPayload = checkoutSessionCompletedPayload({ eventId: 'evt_pre_upd', customer: 'cus_upd' });
  await POST(stripeRequest(checkoutPayload, signPayload(TEST_SECRET, checkoutPayload)));
  const tokenKeyBefore = mock.keys().find((k) => k.startsWith('dev:token:'))!;
  expect(tokenKeyBefore).toBeDefined();

  const updatePayload = subscriptionEventPayload('customer.subscription.updated', 'evt_upd_1', 'cus_upd', 'past_due');
  const res = await POST(stripeRequest(updatePayload, signPayload(TEST_SECRET, updatePayload)));
  expect(res.status).toBe(200);
  expect(mock.store.has(tokenKeyBefore), 'revocation within this event\'s TTL-bounded processing').toBe(false);

  const record = parseTenantRecord(mock.store.get(tenantKey('cus_upd'))!.value)!;
  expect(record.subscriptionStatus).toBe('past_due');
});

test('customer.subscription.deleted (route level): unconditional cancel + token revoked', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });

  const checkoutPayload = checkoutSessionCompletedPayload({ eventId: 'evt_pre_del', customer: 'cus_del' });
  await POST(stripeRequest(checkoutPayload, signPayload(TEST_SECRET, checkoutPayload)));
  const tokenKeyBefore = mock.keys().find((k) => k.startsWith('dev:token:'))!;

  const deletePayload = subscriptionEventPayload('customer.subscription.deleted', 'evt_del_1', 'cus_del', 'canceled');
  const res = await POST(stripeRequest(deletePayload, signPayload(TEST_SECRET, deletePayload)));
  expect(res.status).toBe(200);
  expect(mock.store.has(tokenKeyBefore)).toBe(false);

  const record = parseTenantRecord(mock.store.get(tenantKey('cus_del'))!.value)!;
  expect(record.subscriptionStatus).toBe('canceled');
});

test('unhandled event type: acknowledged 200, no writes, no crash', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });

  const payload = JSON.stringify({
    id: 'evt_unhandled_1',
    type: 'invoice.payment_failed',
    data: { object: {} },
  });
  const res = await POST(stripeRequest(payload, signPayload(TEST_SECRET, payload)));
  expect(res.status).toBe(200);
  expect(mock.keys().filter((k) => k.startsWith('dev:tenant:'))).toHaveLength(0);
});

// --- S18 changes nothing on existing routes ---------------------------------

test('S18 pin: app/api/feedback is unaffected - X-Oravan-Key stays recognized-but-inert', async () => {
  // A distinct IP octet to avoid colliding with tests/feedback.unit.spec.ts's
  // own in-memory rate-limiter state if this worker happens to reuse that
  // module (module state is per-process, keyed by IP - see that file's own
  // comment on the same concern).
  const realFetch = globalThis.fetch;
  const realToken = process.env.GITHUB_FEEDBACK_TOKEN;
  process.env.GITHUB_FEEDBACK_TOKEN = 'test-token';
  const calls: unknown[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ number: 1 }), { status: 201 });
  }) as typeof fetch;

  try {
    const body = { category: 'bug', message: 'S18 pin: nothing about this route changed.' };
    const mkReq = (extraHeaders: Record<string, string> = {}) =>
      new Request('http://localhost/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.241', ...extraHeaders },
        body: JSON.stringify(body),
      }) as unknown as Parameters<typeof feedbackPost>[0];

    const without = await feedbackPost(mkReq());
    const withKey = await feedbackPost(mkReq({ 'x-oravan-key': 'rk_s18_pin_test' }));
    expect(without.status).toBe(200);
    expect(withKey.status).toBe(200);
    expect(await withKey.json()).toEqual(await without.json());
    expect(calls).toHaveLength(2);
    // The header value never reached the outbound GitHub payload either.
    expect(JSON.stringify(calls[1])).not.toContain('rk_s18_pin_test');
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.GITHUB_FEEDBACK_TOKEN;
    else process.env.GITHUB_FEEDBACK_TOKEN = realToken;
  }
});
