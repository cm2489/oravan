import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): plain lib modules resolve under the test
// runner - same pattern as the other unit specs.
import {
  __resetFallbackLogForTests,
  __resetSaltMemoForTests,
  callerHash,
  callerIp,
  counterKey,
  createRateLimiter,
  createTenantRateLimiter,
  parseSaltRecord,
  readOravanKey,
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

/*
 * The salt memo lives in lib/ratelimit.ts's module scope, which outlives an
 * individual test (and, in a Playwright worker, an individual spec FILE) —
 * so without this every test after the first would silently reuse the
 * previous test's salt against a brand-new mock store and assert against a
 * database that was never written to. Same convention as
 * __resetFallbackLogForTests: an explicit seam, reset where it matters,
 * rather than a production module that behaves differently under test.
 */
test.beforeEach(() => {
  __resetSaltMemoForTests();
});

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
  // A SECOND SERVERLESS INSTANCE, which is what `b` has always stood for
  // here — and an instance starts with an empty salt memo, because the memo
  // is module scope in a process this one doesn't share. Dropping it is what
  // keeps the next line a real "b independently agreed on the salt" proof
  // rather than "b read a's memo".
  __resetSaltMemoForTests();
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
  // A different counters database is a different deployment, i.e. a
  // different process with its own empty memo — mirrored here, otherwise the
  // memo would answer for a store this limiter has never touched.
  __resetSaltMemoForTests();
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

/*
 * The 'reps' route label (fix/api-reps-rate-limit). /api/reps is the first
 * rate-limited route whose REQUEST carries a ZIP — the one identifier that is
 * simultaneously the caller's own lookup key and a location, i.e. exactly the
 * "network address linked to a political position" CLAUDE.md forbids. The
 * route only ever hands callerIp() to the limiter, and this pins that the
 * resulting key is hash-only: a ZIP cannot be in it, because there is no door
 * for one (counterKey takes a route label and a hash, nothing else).
 */
test("counterKey('reps', hash) is hash-only: a ZIP can never reach a counters key", async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

  // The exact construction app/api/reps/route.ts builds at module scope.
  const limiter = createRateLimiter({ route: 'reps', max: 300, windowSec: 600 });
  const ip = '203.0.113.120';
  await limiter.isLimited(ip);

  const key = mock.keys().find((k) => k.includes(':rl:reps:'))!;
  expect(key).toBeDefined();
  // dev:rl:reps:<64 hex> - nothing else. The raw IP never appears.
  expect(key).toMatch(/^dev:rl:reps:[0-9a-f]{64}$/);
  expect(key).not.toContain(ip);
  // The builder's own contract, independent of any limiter run.
  const salt = parseSaltRecord(mock.store.get(saltKey())!.value)!.v;
  expect(key).toBe(counterKey('reps', callerHash(ip, salt)));

  // No ZIP, anywhere on the wire - not a real one the site serves, not the
  // multi-district/vacant/DC fixtures tests/reps.spec.ts drives, not a
  // malformed one. Checked over every COMMAND, not just the keys that stuck.
  const wire = mock.commands.map((c) => c.join(' ')).join('\n');
  for (const zip of ['78501', '33313', '20002', '00000', 'not-a-zip']) {
    expect(wire, `counters wire surface must not carry ZIP "${zip}"`).not.toContain(zip);
  }
  // Same window discipline as every other caller-hash counter: TTL attached
  // at creation, so a pseudonym can't outlive its window.
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

test('X-Oravan-Key is parsed and inert: recognized shape, no effect on limiting', async () => {
  expect(readOravanKey(new Headers({ 'x-oravan-key': '  rk_test_123  ' }))).toBe('rk_test_123');
  expect(readOravanKey(new Headers({ 'x-oravan-key': '   ' }))).toBeNull();
  expect(readOravanKey(new Headers())).toBeNull();

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

// --- check(): the reset-disclosing variant of isLimited ----------------------

test('check(): passing requests return {limited:false, retryAfterSec:null} and never issue a TTL read', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

  const limiter = createRateLimiter({ route: 'script', max: 8, windowSec: 600 });
  const ip = '203.0.113.110';
  for (let i = 0; i < 8; i += 1) {
    const res = await limiter.check(ip);
    expect(res.limited, `request ${i + 1} of 8 must pass`).toBe(false);
    expect(res.retryAfterSec, 'reset info only exists on the limited path').toBeNull();
  }
  expect(
    mock.commands.filter((c) => c[0] === 'TTL'),
    'zero extra commands for passing requests'
  ).toHaveLength(0);
});

test('check(): the limited request discloses seconds-to-reset via exactly one TTL read of the counter key', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

  const limiter = createRateLimiter({ route: 'script', max: 8, windowSec: 600 });
  const ip = '203.0.113.111';
  for (let i = 0; i < 8; i += 1) expect((await limiter.check(ip)).limited).toBe(false);

  const ninth = await limiter.check(ip);
  expect(ninth.limited).toBe(true);
  expect(ninth.retryAfterSec).not.toBeNull();
  expect(ninth.retryAfterSec!).toBeGreaterThan(0);
  expect(ninth.retryAfterSec!, 'fixed window: reset can never exceed the window').toBeLessThanOrEqual(600);
  expect(
    mock.commands.filter((c) => c[0] === 'TTL'),
    'exactly one TTL read, on the limited path only'
  ).toHaveLength(1);
});

test('check(): no-env memory path returns a sane retryAfterSec when limited, zero network calls', async () => {
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });
  __resetFallbackLogForTests();

  const limiter = createRateLimiter({ route: 'script', max: 2, windowSec: 600 });
  const ip = '203.0.113.112';
  expect((await limiter.check(ip)).limited).toBe(false);
  expect((await limiter.check(ip)).limited).toBe(false);
  const third = await limiter.check(ip);
  expect(third.limited).toBe(true);
  expect(third.retryAfterSec).not.toBeNull();
  expect(third.retryAfterSec!).toBeGreaterThan(0);
  expect(third.retryAfterSec!, 'sliding window: oldest-hit expiry bounds the reset').toBeLessThanOrEqual(600);
  expect(mock.commands, 'must not touch the REST surface without env').toHaveLength(0);
});

// --- the salt memo -----------------------------------------------------------

/*
 * WHY THIS FAMILY EXISTS. currentSalt used to GET the salt on EVERY request,
 * so the durable path cost three serialized REST round-trips (GET salt, SET
 * NX, INCR) in front of every rate-limited route — including /api/reps,
 * which fires on page render rather than on a user action, so a slow
 * counters database stalled the rep panel before failing open.
 *
 * The memo is only defensible because it cannot extend a pseudonym's life:
 * rotation (24h) is the privacy mechanism, and these tests pin both bounds
 * that keep the memo inside it — a 60s wall-clock ceiling AND the stored
 * record's own expiry, whichever is sooner — plus the absence signal that
 * drops the memo the moment the database misbehaves.
 */
const saltGets = (mock: MockUpstash) =>
  mock.commands.filter((c) => c[0] === 'GET' && c[1] === saltKey()).length;

test('the salt is read once per instance, not once per request — and the extra round-trip really is gone', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

  const limiter = createRateLimiter({ route: 'reps', max: 300, windowSec: 600 });
  const ip = '203.0.113.130';
  await limiter.isLimited(ip);

  // The cold request pays for the salt exactly once: one GET (miss), one
  // SET NX to create it.
  expect(saltGets(mock), 'the first request reads the salt').toBe(1);
  const afterCold = mock.commands.length;

  for (let i = 0; i < 9; i += 1) expect(await limiter.isLimited(ip)).toBe(false);

  expect(saltGets(mock), 'no request after the first one may re-read the salt').toBe(1);
  expect(
    mock.commands.filter((c) => c[0] === 'SET' && c[1] === saltKey()),
    'and none of them may try to create a second salt'
  ).toHaveLength(1);
  // Two commands per warm request — SET NX + INCR — where it used to be
  // three. This is the whole point of the memo, asserted as a number rather
  // than as a claim in a comment.
  expect(mock.commands.length - afterCold).toBe(18);

  // Still the same salt, still hash-only, still the right counter.
  const salt = parseSaltRecord(mock.store.get(saltKey())!.value)!.v;
  expect(mock.keys().filter((k) => k.includes(':rl:reps:'))).toEqual([
    counterKey('reps', callerHash(ip, salt)),
  ]);
});

test('the memo expires: 60s on, the next request re-reads the salt', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

  const limiter = createRateLimiter({ route: 'script', max: 100, windowSec: 600 });
  const ip = '203.0.113.131';
  await limiter.isLimited(ip);
  await limiter.isLimited(ip);
  expect(saltGets(mock), 'inside the window, one read covers both').toBe(1);

  // 61 seconds later — far short of the counter window (600s) and the salt's
  // own TTL (86400s), so nothing else in the mock changes state.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 61_000;
    await limiter.isLimited(ip);
  } finally {
    Date.now = realNow;
  }
  expect(saltGets(mock), 'past the window, the salt is read again').toBe(2);
});

test('the memo can never outlive the salt record itself, even inside the 60s window', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

  // A record whose stated creation time is already 24h old: its 24h life is
  // over even though this store still hands it back. The memo's second bound
  // (creation + SALT_TTL_SECONDS, applied with Math.min) must refuse to
  // serve it from memory at all — which is what makes the normal-case
  // extension of a salt's effective life exactly zero seconds rather than
  // "up to 60".
  const aged = {
    v: 'a'.repeat(32),
    t: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  };
  mock.exec(['SET', saltKey(), JSON.stringify(aged), 'EX', '86400']);

  const limiter = createRateLimiter({ route: 'script', max: 100, windowSec: 600 });
  const ip = '203.0.113.132';
  await limiter.isLimited(ip);
  await limiter.isLimited(ip);
  await limiter.isLimited(ip);

  expect(saltGets(mock), 'an expired-by-its-own-clock salt is never served from the memo').toBe(3);
});

test('absence signal: a counters-database error drops the memo instead of holding it across a possible rotation', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

  const limiter = createRateLimiter({ route: 'script', max: 100, windowSec: 600 });
  const ip = '203.0.113.133';
  await limiter.isLimited(ip);
  expect(saltGets(mock)).toBe(1);

  // The database goes away mid-life. The request fails open to in-memory
  // (pinned elsewhere in this file); what matters here is that the memo does
  // not survive it — the failure might BE the rotation. The failing request
  // itself never reaches the wire in a recordable way (the mock rejects
  // before executing), so the count below is what proves the memo was
  // dropped: without the drop, the recovered request would still be riding
  // the pre-error memo and this would read 1.
  mock.failWithStatus = 503;
  const realError = console.error;
  console.error = () => {};
  try {
    expect(await limiter.isLimited(ip), 'fails open, never throws').toBe(false);
  } finally {
    console.error = realError;
  }

  mock.failWithStatus = null;
  await limiter.isLimited(ip);
  expect(saltGets(mock), 'the recovered request re-reads rather than trusting a pre-error memo').toBe(
    2
  );
});

// --- S19: createTenantRateLimiter -------------------------------------------

test('tenant counter keys are RAW tenantId, not hashed/salted - the deliberate divergence from the caller-hash shape', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

  const limiter = createTenantRateLimiter({ route: 'embed-script', max: 60, windowSec: 600 });
  await limiter.isLimited('cus_tenant_abc');

  const key = mock.keys().find((k) => k.includes(':rl:embed-script:'))!;
  expect(key).toBe('dev:rl:embed-script:cus_tenant_abc');
  // No salt was ever touched for this - a tenant-keyed limiter has nothing
  // to do with the caller-hash salt lifecycle.
  expect(mock.commands.some((c) => c[0] === 'SET' && c[1] === saltKey())).toBe(false);
});

test('tenant limiter: cross-instance semantics, exact max/window, independent per tenant', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

  const a = createTenantRateLimiter({ route: 'embed-script', max: 3, windowSec: 600 });
  const b = createTenantRateLimiter({ route: 'embed-script', max: 3, windowSec: 600 });

  const tenantId = 'cus_shared_across_instances';
  for (let i = 0; i < 3; i += 1) {
    const instance = i % 2 === 0 ? a : b;
    expect(await instance.isLimited(tenantId), `request ${i + 1} of 3 must pass`).toBe(false);
  }
  expect(await a.isLimited(tenantId)).toBe(true);
  expect(await b.isLimited(tenantId), 'and equally limited on instance B').toBe(true);

  // A different tenant is untouched by this one's saturation.
  expect(await b.isLimited('cus_other_tenant')).toBe(false);
});

test('tenant limiter: TTL is attached at creation, same as the caller-hash limiter', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

  const limiter = createTenantRateLimiter({ route: 'embed-script-day', max: 800, windowSec: 86400 });
  await limiter.isLimited('cus_ttl');

  const key = counterKey('embed-script-day', 'cus_ttl');
  expect(mock.exec(['TTL', key])).toBeGreaterThan(0);
  expect(mock.exec(['TTL', key])).toBeLessThanOrEqual(86400);
});

test('tenant limiter: graceful degradation - no env -> in-memory, zero network calls, no crash, shares the single startup line', async () => {
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });
  __resetFallbackLogForTests();

  const logged: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => logged.push(args.join(' '));
  try {
    const limiter = createTenantRateLimiter({ route: 'embed-script', max: 2, windowSec: 600 });
    const tenantId = 'cus_memory_fallback';
    expect(await limiter.isLimited(tenantId)).toBe(false);
    expect(await limiter.isLimited(tenantId)).toBe(false);
    expect(await limiter.isLimited(tenantId)).toBe(true);
  } finally {
    console.log = realLog;
  }

  expect(mock.commands, 'must not touch the REST surface without env').toHaveLength(0);
  const fallbackLines = logged.filter((l) => l.includes('in-memory'));
  expect(fallbackLines, 'the SAME startup line createRateLimiter uses - one counters DB, one line').toHaveLength(1);
});

test('tenant limiter: an Upstash request error fails open to in-memory and is counted/logged status-only', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  mock.failWithStatus = 503;
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

  const errorsBefore = getUpstashErrorCounts().counters;
  const limiter = createTenantRateLimiter({ route: 'embed-script', max: 2, windowSec: 600 });
  const tenantId = 'cus_error_fallback';
  expect(await limiter.isLimited(tenantId)).toBe(false);
  expect(await limiter.isLimited(tenantId)).toBe(false);
  expect(await limiter.isLimited(tenantId), 'in-memory fallback still enforces the limit').toBe(true);
  expect(getUpstashErrorCounts().counters).toBeGreaterThan(errorsBefore);
});

test('composition: the tenant limiter and the per-IP caller limiter are completely independent counters', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });

  const ipLimiter = createRateLimiter({ route: 'script', max: 8, windowSec: 600 });
  const tenantLimiter = createTenantRateLimiter({ route: 'embed-script', max: 60, windowSec: 600 });

  // Saturate the per-IP limit for one visitor IP...
  for (let i = 0; i < 8; i += 1) expect(await ipLimiter.isLimited('203.0.113.201')).toBe(false);
  expect(await ipLimiter.isLimited('203.0.113.201')).toBe(true);

  // ...the tenant limiter for the SAME tenant is untouched by that -
  // different key, different database row, different threat model.
  expect(await tenantLimiter.isLimited('cus_independent')).toBe(false);

  // And two different keys never collide in either direction.
  const ipKeys = mock.keys().filter((k) => k.includes(':rl:script:'));
  const tenantKeys = mock.keys().filter((k) => k.includes(':rl:embed-script:'));
  expect(ipKeys).toHaveLength(1);
  expect(tenantKeys).toHaveLength(1);
  expect(ipKeys[0]).not.toBe(tenantKeys[0]);
});
