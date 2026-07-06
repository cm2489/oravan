import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): plain lib modules resolve under the test
// runner - same pattern as the other unit specs.
import {
  __resetFallbackLogForTests,
  callerHash,
  callerIp,
  counterKey,
  createRateLimiter,
  parseSaltRecord,
  readRostraKey,
  saltKey,
} from '../lib/ratelimit';
import { getUpstashErrorCounts } from '../lib/upstash';
import { COUNTERS_URL, MockUpstash, installUpstashFetch, setUpstashEnv } from './upstash-mock';

/*
 * Pins the S11 rate-limiter contract: durable cross-instance counters over
 * the (mocked) Upstash REST surface, the F5 salt rules, and the
 * graceful-degradation guarantees (no env -> in-memory; request error ->
 * fail open for that request, counted and logged status-only). No live
 * Upstash tokens exist in this environment - the mock IS the test seam.
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

test('cross-instance semantics: two limiter instances sharing the store see each other\'s counts', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

  // Two independent instances = two Fluid Compute instances. Pre-S11, each
  // had its own Map and the limit silently multiplied by instance count.
  const a = createRateLimiter({ route: 'script', max: 8, windowSec: 600 });
  const b = createRateLimiter({ route: 'script', max: 8, windowSec: 600 });

  const ip = '203.0.113.50';
  for (let i = 0; i < 8; i += 1) {
    const instance = i % 2 === 0 ? a : b; // alternate instances
    expect(await instance.isLimited(ip), `request ${i + 1} of 8 must pass`).toBe(false);
  }
  expect(await a.isLimited(ip), '9th request must be limited on instance A').toBe(true);
  expect(await b.isLimited(ip), 'and equally limited on instance B').toBe(true);

  // A different caller is untouched by that caller's saturation.
  expect(await b.isLimited('203.0.113.51')).toBe(false);
});

test('salt lifecycle: atomic create (SET NX EX 24h), >=128-bit CSPRNG hex, shared across instances, never date-derived', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

  const a = createRateLimiter({ route: 'feedback', max: 8, windowSec: 600 });
  const b = createRateLimiter({ route: 'feedback', max: 8, windowSec: 600 });
  await a.isLimited('203.0.113.60');
  await b.isLimited('203.0.113.60');

  // Exactly one salt exists, created with SET ... NX EX 86400.
  const saltSets = mock.commands.filter((c) => c[0] === 'SET' && c[1] === saltKey());
  expect(saltSets).toHaveLength(1);
  expect(saltSets[0].slice(3)).toEqual(['NX', 'EX', '86400']);

  const record = parseSaltRecord(mock.store.get(saltKey())!.value);
  expect(record, 'stored salt record must parse as {v, t}').not.toBeNull();
  // >=32 hex chars = >=128 bits (F5 floor). parseSaltRecord enforces the
  // same floor at read time, so a weak record could never even be used.
  expect(record!.v).toMatch(/^[0-9a-f]{32,}$/);
  // Never date-derived: two independent environments must produce different
  // salts (a date-derived salt would collide), and the value must not embed
  // today's date in any obvious form.
  const other = new MockUpstash();
  restoreFetch();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: other });
  await createRateLimiter({ route: 'feedback', max: 8, windowSec: 600 }).isLimited('203.0.113.60');
  const otherRecord = parseSaltRecord(other.store.get(saltKey())!.value);
  expect(otherRecord!.v).not.toBe(record!.v);
  expect(record!.v).not.toContain(new Date().toISOString().slice(0, 10).replaceAll('-', ''));

  // Both instances hashed with the SAME salt: exactly one counter key for
  // the caller (a second would mean the instances disagreed on the salt).
  const counterKeys = mock.keys().filter((k) => k.includes(':rl:feedback:'));
  expect(counterKeys).toHaveLength(1);
  expect(counterKeys[0]).toBe(counterKey('feedback', callerHash('203.0.113.60', record!.v)));
});

test('counter keys are hash-only and window-scoped: sha256(ip+salt), TTL attached at creation', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

  const limiter = createRateLimiter({ route: 'district', max: 10, windowSec: 600 });
  const ip = '203.0.113.70';
  await limiter.isLimited(ip);

  const key = mock.keys().find((k) => k.includes(':rl:district:'))!;
  expect(key).toBeDefined();
  // dev:rl:district:<64 hex> - nothing else. The raw IP never appears.
  expect(key).toMatch(/^dev:rl:district:[0-9a-f]{64}$/);
  expect(key).not.toContain(ip);
  // TTL was attached at creation (SET NX EX before INCR), so a crash between
  // commands can never leave an immortal pseudonym.
  expect(mock.exec(['TTL', key])).toBeGreaterThan(0);
  expect(mock.exec(['TTL', key])).toBeLessThanOrEqual(600);
});

test('graceful degradation: no env -> in-memory limiter, zero network calls, no crash, single startup line', async () => {
  // No setUpstashEnv() here - this is the local-dev/CI/preview-without-env path.
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });
  __resetFallbackLogForTests();

  const logged: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => logged.push(args.join(' '));
  try {
    const a = createRateLimiter({ route: 'script', max: 3, windowSec: 600 });
    const b = createRateLimiter({ route: 'district', max: 3, windowSec: 600 });

    const ip = '203.0.113.80';
    expect(await a.isLimited(ip)).toBe(false);
    expect(await a.isLimited(ip)).toBe(false);
    expect(await a.isLimited(ip)).toBe(false);
    expect(await a.isLimited(ip), 'in-memory window still enforces the limit').toBe(true);
    expect(await b.isLimited(ip), 'second limiter is independent and works').toBe(false);
  } finally {
    console.log = realLog;
  }

  expect(mock.commands, 'must not touch the REST surface without env').toHaveLength(0);
  const fallbackLines = logged.filter((l) => l.includes('in-memory'));
  expect(fallbackLines, 'exactly one startup line for any number of limiters').toHaveLength(1);
});

test('graceful degradation: Upstash request errors fail open to in-memory, are counted, and log status codes only', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  mock.failWithStatus = 503;
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

  const errorsBefore = getUpstashErrorCounts().counters;
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.join(' '));
  let limitedAt: number | null = null;
  try {
    const limiter = createRateLimiter({ route: 'script', max: 3, windowSec: 600 });
    const ip = '203.0.113.90';
    for (let i = 1; i <= 4; i += 1) {
      const limited = await limiter.isLimited(ip); // never throws
      if (limited && limitedAt === null) limitedAt = i;
    }
  } finally {
    console.error = realError;
  }

  // Failed open to the in-memory window - which still enforces the limit.
  expect(limitedAt, 'in-memory fallback limits the 4th request').toBe(4);
  expect(getUpstashErrorCounts().counters).toBeGreaterThan(errorsBefore);
  expect(logged.length).toBeGreaterThan(0);
  for (const line of logged) {
    expect(line).toContain('status 503'); // the status code IS logged...
    expect(line).not.toContain('mock upstream error'); // ...the body is NOT
    expect(line).not.toContain('203.0.113.90'); // and never the caller
  }
});

test('X-Rostra-Key is parsed and inert: recognized shape, no effect on limiting', async () => {
  expect(readRostraKey(new Headers({ 'x-rostra-key': '  rk_test_123  ' }))).toBe('rk_test_123');
  expect(readRostraKey(new Headers({ 'x-rostra-key': '   ' }))).toBeNull();
  expect(readRostraKey(new Headers())).toBeNull();

  // Inert against the limiter: the limiter API cannot even receive it -
  // route-level inertness (identical responses with/without the header) is
  // pinned in tests/feedback.unit.spec.ts against a live route handler.
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });
  const limiter = createRateLimiter({ route: 'script', max: 2, windowSec: 600 });
  const ip = '203.0.113.99';
  expect(await limiter.isLimited(ip)).toBe(false);
  expect(await limiter.isLimited(ip)).toBe(false);
  expect(await limiter.isLimited(ip), 'limit depends on the caller alone').toBe(true);
});

test('callerIp derivation is unchanged from the pre-S11 routes', () => {
  expect(callerIp(new Headers({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }))).toBe('198.51.100.7');
  expect(callerIp(new Headers())).toBe('unknown');
});
