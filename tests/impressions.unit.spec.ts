import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): plain lib modules resolve under the test
// runner — same pattern as the other unit specs (tests/embed-referrer.unit.spec.ts).
import {
  __memoryImpressionCountForTests,
  __resetImpressionsFallbackLogForTests,
  impressionDayKey,
  noteImpression,
  noteImpressionForToken,
  readImpressionsWindow,
} from '../lib/impressions';
import { dayKey } from '../lib/embed-referrer';
import { mintCapabilityToken, tenantKey, tokenHash, tokenIndexKey, type TenantRecord } from '../lib/tenancy';
import { getUpstashErrorCounts } from '../lib/upstash';
import {
  COUNTERS_URL,
  MockUpstash,
  TENANCY_URL,
  installUpstashFetch,
  setUpstashEnv,
} from './upstash-mock';

/*
 * S20 (F6): pins lib/impressions.ts's contract — the write path (noteImpression,
 * noteImpressionForToken: non-blocking, fails open, IP-free by construction)
 * and the read path (readImpressionsWindow: ONE MGET, monthly aggregation,
 * fails CLOSED on error/unconfigured — the deliberate write/read asymmetry).
 * No live Upstash tokens exist in this environment — the mock IS the test
 * seam, same convention as every other S11/S18/S19 unit spec.
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

function seedTenant(
  mock: MockUpstash,
  overrides: Partial<TenantRecord> & { tenantId: string }
): string {
  const token = mintCapabilityToken();
  const hash = tokenHash(token);
  const record: TenantRecord = {
    tokenHash: hash,
    tier: 'pro',
    domainAllowlist: [],
    orgName: 'Impressions Fixture Org',
    attribution: 'required',
    createdAt: new Date().toISOString(),
    subscriptionId: `sub_${overrides.tenantId}`,
    subscriptionStatus: 'active',
    tosAcceptedAt: new Date().toISOString(),
    ...overrides,
  };
  mock.exec(['SET', tenantKey(overrides.tenantId), JSON.stringify(record)]);
  mock.exec(['SET', tokenIndexKey(hash), overrides.tenantId]);
  return token;
}

// --- key builder ---------------------------------------------------------------

test('impressionDayKey: exact shape, no caller/content bleed', () => {
  expect(impressionDayKey('cus_123', '2026-07-12')).toBe('dev:imp:cus_123:2026-07-12');
});

// --- noteImpression: the write path ---------------------------------------------

test('noteImpression: durable SET NX EX (400d) before INCR, exact key shape', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  await noteImpression('cus_write_1');
  const key = impressionDayKey('cus_write_1', dayKey());
  expect(key).toMatch(/^dev:imp:cus_write_1:\d{4}-\d{2}-\d{2}$/);
  expect(counters.store.get(key)?.value).toBe('1');

  const setCommands = counters.commands.filter((c) => c[0] === 'SET' && c[1] === key);
  expect(setCommands).toHaveLength(1);
  expect(setCommands[0].slice(3)).toEqual(['NX', 'EX', String(400 * 24 * 60 * 60)]);

  await noteImpression('cus_write_1');
  expect(counters.store.get(key)?.value).toBe('2'); // same-day loads accumulate
});

test('noteImpression: two different tenants get independent daily counters', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  await noteImpression('cus_a');
  await noteImpression('cus_b');
  await noteImpression('cus_a');

  expect(counters.store.get(impressionDayKey('cus_a', dayKey()))?.value).toBe('2');
  expect(counters.store.get(impressionDayKey('cus_b', dayKey()))?.value).toBe('1');
});

test('graceful degradation: no env → in-memory fallback, zero network calls, single startup line', async () => {
  __resetImpressionsFallbackLogForTests();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  const logged: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => logged.push(args.join(' '));
  try {
    await noteImpression('cus_memory');
    await noteImpression('cus_memory');
  } finally {
    console.log = realLog;
  }

  expect(counters.commands, 'must not touch the REST surface without env').toHaveLength(0);
  expect(__memoryImpressionCountForTests('cus_memory')).toBe(2);
  expect(logged.filter((l) => l.includes('in-memory'))).toHaveLength(1);
});

test('non-blocking-increment proof: an Upstash NETWORK failure fails open, never throws, and logs status-only', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  counters.failWithNetworkError = true;
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  const errorsBefore = getUpstashErrorCounts().counters;
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.join(' '));
  try {
    await expect(noteImpression('cus_down')).resolves.toBeUndefined();
  } finally {
    console.error = realError;
  }

  expect(getUpstashErrorCounts().counters).toBeGreaterThan(errorsBefore);
  expect(logged.length).toBeGreaterThan(0);
  expect(logged.some((l) => l.includes('failing open to in-memory'))).toBe(true);
});

// --- noteImpressionForToken: the rep-lookup/bill-card optional-token path -------

test('noteImpressionForToken: token absent is a byte-for-byte no-op — zero commands, no limiter touched', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  const tenancy = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters, [TENANCY_URL]: tenancy });

  await expect(noteImpressionForToken(null, '198.51.100.9')).resolves.toBeUndefined();
  expect(counters.commands).toHaveLength(0);
  expect(tenancy.commands).toHaveLength(0);
});

test('noteImpressionForToken: a valid, active token increments that tenant', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  const tenancy = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters, [TENANCY_URL]: tenancy });

  const token = seedTenant(tenancy, { tenantId: 'cus_token_ok' });
  await noteImpressionForToken(token, '198.51.100.10');

  expect(counters.store.get(impressionDayKey('cus_token_ok', dayKey()))?.value).toBe('1');
});

test('noteImpressionForToken: bad/unknown token silently no-ops — never a new paywall, never a throw', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  const tenancy = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters, [TENANCY_URL]: tenancy });

  await expect(noteImpressionForToken('totally-made-up-token', '198.51.100.11')).resolves.toBeUndefined();
  // The per-IP lookup limiter DOES touch the counters database (it runs
  // BEFORE tenant resolution, on any non-null token) - but no impression
  // bucket is ever created, because the token never resolves to a tenant.
  expect(counters.keys().some((k) => k.startsWith('dev:imp:'))).toBe(false);
  expect(tenancy.commands.length).toBeGreaterThan(0); // the lookup really was attempted...
  expect(tenancy.keys()).toHaveLength(0); // ...and found nothing, wrote nothing
});

test('noteImpressionForToken: an inactive-subscription tenant silently no-ops (same as a bad token)', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  const tenancy = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters, [TENANCY_URL]: tenancy });

  const token = seedTenant(tenancy, { tenantId: 'cus_token_inactive', subscriptionStatus: 'canceled' });
  await expect(noteImpressionForToken(token, '198.51.100.12')).resolves.toBeUndefined();
  // The tenancy lookup found the (inactive) tenant record, but no
  // impression bucket was ever created for it.
  expect(counters.keys().some((k) => k.startsWith('dev:imp:'))).toBe(false);
});

test('noteImpressionForToken: the per-IP lookup cap skips the tenancy lookup past 30/10min, without ever affecting rendering (never throws)', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  const tenancy = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters, [TENANCY_URL]: tenancy });

  const token = seedTenant(tenancy, { tenantId: 'cus_capped' });
  const ip = '198.51.100.13';

  for (let i = 0; i < 30; i++) {
    await expect(noteImpressionForToken(token, ip)).resolves.toBeUndefined();
  }
  expect(counters.store.get(impressionDayKey('cus_capped', dayKey()))?.value).toBe('30');
  const tenancyCallsAtCap = tenancy.commands.length;
  expect(tenancyCallsAtCap).toBeGreaterThan(0); // the first 30 calls really did reach the tenancy database

  // The 31st call, same IP within the same 10-minute window: the limiter
  // must trip BEFORE ever touching the tenancy database — the cap protects
  // the lookup itself (the actual cost concern), not just the write — and
  // it must still resolve cleanly, never throw, never change any response.
  await expect(noteImpressionForToken(token, ip)).resolves.toBeUndefined();
  expect(tenancy.commands.length, 'the capped call must not have issued any new tenancy command').toBe(
    tenancyCallsAtCap
  );
  expect(counters.store.get(impressionDayKey('cus_capped', dayKey()))?.value, 'the capped call must not increment').toBe(
    '30'
  );
});

// --- readImpressionsWindow: the read path ---------------------------------------

test('readImpressionsWindow: unconfigured counters database fails CLOSED, never a degraded number', async () => {
  // No setUpstashEnv() — the unconfigured path.
  const result = await readImpressionsWindow('cus_unconfigured', 3);
  expect(result).toEqual({ ok: false });
});

test('readImpressionsWindow: an Upstash MGET error fails CLOSED and logs an ACCURATE (non-"failing open") consequence', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  counters.failWithStatus = 503;
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.join(' '));
  let result: unknown;
  try {
    result = await readImpressionsWindow('cus_erroring', 3);
  } finally {
    console.error = realError;
  }

  expect(result).toEqual({ ok: false });
  expect(logged.length).toBeGreaterThan(0);
  // The write path's default "failing open to in-memory" wording would be a
  // lie here — this read path fails CLOSED (503), never a degraded number.
  for (const line of logged) {
    expect(line).not.toContain('failing open to in-memory');
  }
});

test('readImpressionsWindow: sums daily buckets into calendar months, oldest first, only the current month partial', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  // A fixed "now" so this test doesn't depend on the wall clock: 2026-07-12.
  const now = new Date('2026-07-12T00:00:00.000Z');

  // Seed some days in May, June, and July directly (mirrors what
  // noteImpression would have written on those days).
  counters.exec(['SET', 'dev:imp:cus_months:2026-05-15', '4']);
  counters.exec(['SET', 'dev:imp:cus_months:2026-05-31', '6']);
  counters.exec(['SET', 'dev:imp:cus_months:2026-06-01', '10']);
  counters.exec(['SET', 'dev:imp:cus_months:2026-06-30', '20']);
  counters.exec(['SET', 'dev:imp:cus_months:2026-07-01', '1']);
  counters.exec(['SET', 'dev:imp:cus_months:2026-07-12', '2']); // "today" — the last day counted
  counters.exec(['SET', 'dev:imp:cus_months:2026-07-13', '999']); // future day — must NOT be summed

  const before = counters.commands.length;
  const result = await readImpressionsWindow('cus_months', 3, now);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.months.map((m) => m.month)).toEqual(['2026-05', '2026-06', '2026-07']);
  expect(result.months[0]).toEqual({ month: '2026-05', impressions: 10, partial: false });
  expect(result.months[1]).toEqual({ month: '2026-06', impressions: 30, partial: false });
  expect(result.months[2]).toEqual({ month: '2026-07', impressions: 3, partial: true }); // 1 + 2, NOT +999
  expect(result.total).toBe(43);

  // ONE Upstash round trip via MGET, not N sequential GETs.
  const newCommands = counters.commands.slice(before);
  expect(newCommands).toHaveLength(1);
  expect(newCommands[0][0]).toBe('MGET');
});

test('readImpressionsWindow: months=1 returns only the current (partial) month', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  const now = new Date('2026-07-12T00:00:00.000Z');
  counters.exec(['SET', 'dev:imp:cus_single:2026-07-05', '7']);

  const result = await readImpressionsWindow('cus_single', 1, now);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.months).toEqual([{ month: '2026-07', impressions: 7, partial: true }]);
  expect(result.total).toBe(7);
});

test('readImpressionsWindow: a tenant with zero impressions gets an honest all-zero window, not an error', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  const result = await readImpressionsWindow('cus_never_loaded', 2, new Date('2026-07-12T00:00:00.000Z'));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.total).toBe(0);
  expect(result.months.every((m) => m.impressions === 0)).toBe(true);
});
