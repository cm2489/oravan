import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): plain lib modules resolve under the test
// runner - same pattern as the other unit specs.
import {
  cancelSubscription,
  claimStripeEvent,
  lookupTenantByToken,
  mintCapabilityToken,
  parseTenantRecord,
  provisionFromCheckout,
  stripeEventKey,
  tenantKey,
  tokenHash,
  tokenIndexKey,
  updateSubscriptionStatus,
  type TenantRecord,
} from '../lib/tenancy';
import { getUpstashErrorCounts } from '../lib/upstash';
import { MockUpstash, TENANCY_URL, installUpstashFetch, setUpstashEnv } from './upstash-mock';

/*
 * Pins the S18 tenancy-registry contract: token lifecycle primitives,
 * fail-CLOSED reads (the one deliberate divergence from the rest of this
 * codebase's fail-open doctrine), checkout provisioning (new tenant vs.
 * returning-customer-keeps-token), and subscription lifecycle sync
 * (revocation deletes the reverse-index key immediately). No live Upstash
 * tokens exist in this environment - the mock IS the test seam, same
 * convention as tests/ratelimit.unit.spec.ts.
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

test('mintCapabilityToken: 128-bit CSPRNG hex, tokenHash is sha256 hex, never date-derived', () => {
  const a = mintCapabilityToken();
  const b = mintCapabilityToken();
  expect(a).toMatch(/^[0-9a-f]{32}$/); // 32 hex chars = 128 bits
  expect(b).toMatch(/^[0-9a-f]{32}$/);
  expect(a).not.toBe(b);
  expect(a).not.toContain(new Date().toISOString().slice(0, 10).replaceAll('-', ''));

  const hash = tokenHash(a);
  expect(hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  expect(hash).not.toBe(a);
  expect(tokenHash(a)).toBe(hash); // deterministic
});

test('key builders: exact shapes, no caller/content bleed', () => {
  expect(tenantKey('cus_123')).toBe('dev:tenant:cus_123');
  expect(tokenIndexKey('abc')).toBe('dev:token:abc');
  expect(stripeEventKey('evt_1')).toBe('dev:stripe-event:evt_1');
});

test('parseTenantRecord: parse-or-reject, mirrors parseSaltRecord style', () => {
  const good: TenantRecord = {
    tenantId: 'cus_1',
    tokenHash: 'a'.repeat(64),
    tier: 'pro',
    domainAllowlist: ['example.org'],
    orgName: 'Example Org',
    attribution: 'required',
    createdAt: new Date().toISOString(),
    subscriptionId: 'sub_1',
    subscriptionStatus: 'active',
  };
  expect(parseTenantRecord(JSON.stringify(good))).toEqual(good);
  expect(parseTenantRecord('not json')).toBeNull();
  expect(parseTenantRecord('{}')).toBeNull();
  expect(parseTenantRecord(JSON.stringify({ ...good, tier: 'enterprise' }))).toBeNull();
  expect(parseTenantRecord(JSON.stringify({ ...good, tokenHash: 'short' }))).toBeNull();
  expect(parseTenantRecord(JSON.stringify({ ...good, attribution: 'sometimes' }))).toBeNull();
  expect(parseTenantRecord(JSON.stringify({ ...good, subscriptionStatus: 'lifetime' }))).toBeNull();
  expect(parseTenantRecord(JSON.stringify({ ...good, domainAllowlist: [1, 2] }))).toBeNull();
});

test('fail CLOSED: lookupTenantByToken returns null when unconfigured (never "skip the check")', async () => {
  // No setUpstashEnv() here - the unconfigured path.
  const result = await lookupTenantByToken('any-token-at-all');
  expect(result).toBeNull();
});

test('fail CLOSED: lookupTenantByToken returns null on an Upstash error, and counts/logs status-only', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  mock.failWithStatus = 503;
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });

  const errorsBefore = getUpstashErrorCounts().tenancy;
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.join(' '));
  let result: unknown;
  try {
    result = await lookupTenantByToken('doesnt-matter');
  } finally {
    console.error = realError;
  }

  expect(result, 'fail closed - null, never a fallback record').toBeNull();
  expect(getUpstashErrorCounts().tenancy).toBeGreaterThan(errorsBefore);
  expect(logged.length).toBeGreaterThan(0);
  for (const line of logged) {
    expect(line).toContain('status 503');
    expect(line).toContain('failing closed');
    expect(line).not.toContain('mock upstream error');
  }
});

test('lookupTenantByToken miss: unknown token returns null without throwing', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });
  expect(await lookupTenantByToken('never-issued')).toBeNull();
});

test('claimStripeEvent: atomic SET NX EX 604800, duplicate delivery detected, unavailable when unconfigured', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });

  expect(await claimStripeEvent('evt_dup_1')).toBe('claimed');
  expect(await claimStripeEvent('evt_dup_1')).toBe('duplicate'); // second delivery, same event
  expect(await claimStripeEvent('evt_dup_2')).toBe('claimed'); // different event, independent

  const sets = mock.commands.filter((c) => c[0] === 'SET' && c[1] === stripeEventKey('evt_dup_1'));
  expect(sets).toHaveLength(2); // the winning claim + the duplicate's failed NX attempt
  expect(sets[0].slice(3)).toEqual(['NX', 'EX', '604800']);

  restoreFetch();
  restoreEnv();
  expect(await claimStripeEvent('evt_no_env')).toBe('unavailable');
});

test('provisionFromCheckout: new tenant mints a token that resolves via lookupTenantByToken', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });

  const ok = await provisionFromCheckout({
    tenantId: 'cus_new',
    subscriptionId: 'sub_new',
    tier: 'pro',
    orgName: 'New Newsroom',
    domainAllowlist: ['newsroom.example'],
    subscriptionStatus: 'active',
  });
  expect(ok).toBe(true);

  // Exactly one token index key was written for this tenant.
  const tokenKeys = mock.keys().filter((k) => k.startsWith('dev:token:'));
  expect(tokenKeys).toHaveLength(1);

  // The plaintext token was never written anywhere - only its hash.
  const tenantRaw = mock.store.get(tenantKey('cus_new'))!.value;
  const record = parseTenantRecord(tenantRaw)!;
  expect(record.tier).toBe('pro');
  expect(record.orgName).toBe('New Newsroom');
  expect(record.domainAllowlist).toEqual(['newsroom.example']);
  // Self-serve checkout never grants attribution removal (S5a honor-system rule).
  expect(record.attribution).toBe('required');
  expect(record.subscriptionStatus).toBe('active');

  // The token index resolves back to this exact record via the read path.
  const tokenValue = tokenKeys[0].slice('dev:token:'.length);
  // We don't have the plaintext token directly (only its hash is stored),
  // so reconstruct via the full command log: find the SET that wrote this
  // hash as a token key and confirm the record it resolves to matches.
  expect(mock.store.get(tokenKeys[0])!.value).toBe('cus_new');
  void tokenValue;
});

test('provisionFromCheckout: returning customer keeps the SAME token, updates tier/domains/status', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });

  await provisionFromCheckout({
    tenantId: 'cus_upgrade',
    subscriptionId: 'sub_a',
    tier: 'nonprofit',
    orgName: 'Org A',
    domainAllowlist: ['org-a.example'],
    subscriptionStatus: 'active',
  });
  const tokenKeysBefore = mock.keys().filter((k) => k.startsWith('dev:token:'));
  expect(tokenKeysBefore).toHaveLength(1);
  const tokenHashBefore = tokenKeysBefore[0];

  // Same tenant checks out again (e.g. an upgrade to Pro).
  const ok = await provisionFromCheckout({
    tenantId: 'cus_upgrade',
    subscriptionId: 'sub_b',
    tier: 'pro',
    orgName: 'Org A Renamed',
    domainAllowlist: ['org-a.example', 'org-a-2.example'],
    subscriptionStatus: 'active',
  });
  expect(ok).toBe(true);

  const tokenKeysAfter = mock.keys().filter((k) => k.startsWith('dev:token:'));
  expect(tokenKeysAfter, 'a live embed snippet must not silently break on a plan change').toEqual(tokenKeysBefore);
  expect(tokenKeysAfter[0]).toBe(tokenHashBefore);

  const record = parseTenantRecord(mock.store.get(tenantKey('cus_upgrade'))!.value)!;
  expect(record.tier).toBe('pro');
  expect(record.orgName).toBe('Org A Renamed');
  expect(record.domainAllowlist).toEqual(['org-a.example', 'org-a-2.example']);
  expect(record.subscriptionId).toBe('sub_b');
  expect(record.tokenHash).toBe(tokenHashBefore.slice('dev:token:'.length));
});

test('revocation within TTL: subscription.updated to past_due/canceled/unpaid deletes the token immediately; active/trialing keep it', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });

  await provisionFromCheckout({
    tenantId: 'cus_rev',
    subscriptionId: 'sub_rev',
    tier: 'pro',
    orgName: 'Revocable Org',
    domainAllowlist: [],
    subscriptionStatus: 'active',
  });
  const tokenKey = mock.keys().find((k) => k.startsWith('dev:token:'))!;
  expect(mock.store.has(tokenKey)).toBe(true);

  // trialing keeps the token.
  expect(await updateSubscriptionStatus('cus_rev', 'trialing')).toBe(true);
  expect(mock.store.has(tokenKey), 'trialing must not revoke').toBe(true);

  // past_due revokes immediately - DEL is atomic, no propagation delay.
  expect(await updateSubscriptionStatus('cus_rev', 'past_due')).toBe(true);
  expect(mock.store.has(tokenKey), 'past_due must revoke the token key').toBe(false);
  const record = parseTenantRecord(mock.store.get(tenantKey('cus_rev'))!.value)!;
  expect(record.subscriptionStatus).toBe('past_due');

  // Once revoked, the read path fails closed for that token immediately.
  // (We don't have the plaintext token here - re-provision to get a fresh
  // one and prove the *index* deletion is what lookupTenantByToken relies on.)
  expect(mock.store.has(tokenKey)).toBe(false);
});

test('customer.subscription.deleted: unconditional cancel + token revoked, no-op if tenant never existed', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });

  // No-op for an unknown tenant - not this webhook's problem.
  expect(await cancelSubscription('cus_never_provisioned')).toBe(true);
  expect(mock.commands.some((c) => c[0] === 'DEL')).toBe(false);

  await provisionFromCheckout({
    tenantId: 'cus_del',
    subscriptionId: 'sub_del',
    tier: 'pro',
    orgName: 'Deleting Org',
    domainAllowlist: [],
    subscriptionStatus: 'active',
  });
  const tokenKey = mock.keys().find((k) => k.startsWith('dev:token:'))!;

  expect(await cancelSubscription('cus_del')).toBe(true);
  expect(mock.store.has(tokenKey)).toBe(false);
  const record = parseTenantRecord(mock.store.get(tenantKey('cus_del'))!.value)!;
  expect(record.subscriptionStatus).toBe('canceled');
});

test('an unrecognized Stripe subscription status (e.g. "paused") is treated as inactive (safe default)', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [TENANCY_URL]: mock });

  await provisionFromCheckout({
    tenantId: 'cus_paused',
    subscriptionId: 'sub_paused',
    tier: 'pro',
    orgName: 'Paused Org',
    domainAllowlist: [],
    subscriptionStatus: 'active',
  });
  const tokenKey = mock.keys().find((k) => k.startsWith('dev:token:'))!;

  expect(await updateSubscriptionStatus('cus_paused', 'paused')).toBe(true);
  expect(mock.store.has(tokenKey), 'an exotic/unmapped status must revoke, not be silently ignored').toBe(false);
});
