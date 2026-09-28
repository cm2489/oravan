import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { NextRequest } from 'next/server';
// Relative imports (not '@/'): plain lib modules resolve under the test
// runner, same pattern as tests/ratelimit.unit.spec.ts.
import {
  __resetSaltMemoForTests,
  callerHash,
  callerIp,
  counterKey,
  createRateLimiter,
  DISTINCT_ADDRESS_GRACE_SECONDS,
  distinctAddressDay,
  distinctAddressElement,
  distinctAddressExpiresAt,
  distinctAddressKey,
  distinctSaltExpiresAt,
  distinctSaltKey,
  noteDistinctAddress,
  parseSaltRecord,
  readDistinctAddressCount,
  saltKey,
} from '../lib/ratelimit';
import { getUpstashErrorCounts } from '../lib/upstash';
import { isCountablePageviewRequest } from '../lib/usage';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { COUNTERS_URL, MockUpstash, installUpstashFetch, setUpstashEnv } from './upstash-mock';

/*
 * The daily distinct-address count (owner ruling 2026-09-25, card 15 / D4;
 * the 2026-09-27 audit's SY-20; hardened before merge on the owner's
 * 2026-09-27 decision "2. b"). Pins lib/ratelimit.ts's contract for it:
 *
 *   - ONE key per UTC day, `<env>:uniques:<YYYY-MM-DD>`, no other dimension;
 *   - the element added is sha256(daySalt ‖ address), where the day salt is
 *     the sketch's OWN key, `<env>:uniques-salt:<YYYY-MM-DD>`, born with SET
 *     NX + an absolute EXAT at 00:00:00Z of the next day and never extended
 *     — never the rate limiter's salt or hash, never the raw address;
 *   - the sketch key carries an absolute deadline, 48h after its UTC day ends;
 *   - best-effort: an unconfigured database is a true no-op (zero network,
 *     nothing kept in memory), a failure is swallowed and logged status-only;
 *   - the digest read fails closed and never writes;
 *   - proxy.ts wires it after the response, apart from the page label.
 *
 * No live Upstash tokens exist in this environment — the mock IS the seam.
 */

test.describe.configure({ mode: 'serial' }); // shared env + global-fetch swaps

let restoreFetch: (() => void) | null = null;
let restoreEnv: (() => void) | null = null;

test.beforeEach(() => {
  // The salt memo is module scope and outlives a test; see
  // tests/ratelimit.unit.spec.ts for why every spec resets it.
  __resetSaltMemoForTests();
});

test.afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  restoreEnv?.();
  restoreEnv = null;
});

function useMock(): MockUpstash {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });
  return mock;
}

/** The live RATE-LIMITER salt value the mock holds (only the limiter reads it). */
function storedLimiterSalt(mock: MockUpstash): string {
  const raw = mock.store.get(saltKey())?.value;
  const record = typeof raw === 'string' ? parseSaltRecord(raw) : null;
  if (!record) throw new Error('no rate-limiter salt record in the mock store');
  return record.v;
}

/** The live DAY salt the sketch uses for `day` (a bare hex string). */
function storedDaySalt(mock: MockUpstash, day: string): string {
  const raw = mock.store.get(distinctSaltKey(day))?.value;
  if (typeof raw !== 'string' || !/^[0-9a-f]{32,}$/.test(raw)) throw new Error(`no day salt for ${day} in the mock store`);
  return raw;
}

/** Unix seconds of the next 00:00:00Z after `now`. */
function nextUtcMidnightSec(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1000;
}

function wireText(mock: MockUpstash): string {
  return mock.commands.map((c) => c.join(' ')).join('\n');
}

/** Swap console.log/error for recorders; returns the lines and a restore fn. */
function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  return {
    lines,
    restore: () => {
      console.log = origLog;
      console.error = origError;
      console.warn = origWarn;
    },
  };
}

// --- the key: one per UTC day, nothing else ------------------------------------

test('distinctAddressKey: exactly <env>:uniques:<YYYY-MM-DD>, and the builder takes the day and nothing else', () => {
  expect(distinctAddressKey('2026-09-25')).toBe('dev:uniques:2026-09-25');
  // One parameter: there is no second argument through which a route, page,
  // locale, or bill could ever reach the key.
  expect(distinctAddressKey.length).toBe(1);
});

test('distinctAddressDay: the UTC calendar date, switching exactly at UTC midnight', () => {
  expect(distinctAddressDay(new Date('2026-09-25T00:00:00.000Z'))).toBe('2026-09-25');
  expect(distinctAddressDay(new Date('2026-09-25T23:59:59.999Z'))).toBe('2026-09-25');
  expect(distinctAddressDay(new Date('2026-09-26T00:00:00.000Z'))).toBe('2026-09-26');
  // A US evening is already the next UTC day — the count is per UTC day.
  expect(distinctAddressDay(new Date('2026-09-25T21:30:00-05:00'))).toBe('2026-09-26');
});

test('distinctAddressExpiresAt: an absolute deadline 48h after the UTC day ends', () => {
  expect(DISTINCT_ADDRESS_GRACE_SECONDS).toBe(48 * 60 * 60);
  const deadline = distinctAddressExpiresAt('2026-09-25');
  // End of Sep 25 is Sep 26 00:00Z; plus 48h is Sep 28 00:00Z.
  expect(deadline).toBe(Date.parse('2026-09-28T00:00:00Z') / 1000);
  // Same day in, same instant out — re-asserting it never extends a life.
  expect(distinctAddressExpiresAt('2026-09-25')).toBe(deadline);
  expect(distinctAddressExpiresAt('2026-09-26') - deadline).toBe(24 * 60 * 60);
});

// --- the sketch's own day salt (hardened 2026-09-27) ---------------------------------

test('distinctSaltKey: exactly <env>:uniques-salt:<YYYY-MM-DD>, one argument, and never the rate limiter\'s salt key', () => {
  expect(distinctSaltKey('2026-09-25')).toBe('dev:uniques-salt:2026-09-25');
  expect(distinctSaltKey.length).toBe(1);
  expect(distinctSaltKey('2026-09-25')).not.toBe(saltKey());
  // Not inside the sketch family either: a PFCOUNT over `uniques:*` can
  // never pick the salt up, and the two can never collide.
  expect(distinctSaltKey('2026-09-25')).not.toContain(':uniques:');
});

test('distinctSaltExpiresAt: 00:00:00Z of the NEXT day — the end of its UTC day, with no grace', () => {
  expect(distinctSaltExpiresAt('2026-09-25')).toBe(Date.parse('2026-09-26T00:00:00Z') / 1000);
  // Month and year boundaries, and a leap day.
  expect(distinctSaltExpiresAt('2026-09-30')).toBe(Date.parse('2026-10-01T00:00:00Z') / 1000);
  expect(distinctSaltExpiresAt('2026-12-31')).toBe(Date.parse('2027-01-01T00:00:00Z') / 1000);
  expect(distinctSaltExpiresAt('2028-02-28')).toBe(Date.parse('2028-02-29T00:00:00Z') / 1000);
  // Strictly earlier than the sketch's own deadline: the salt is gone for
  // the sketch's whole 48h tail.
  expect(distinctAddressExpiresAt('2026-09-25') - distinctSaltExpiresAt('2026-09-25')).toBe(DISTINCT_ADDRESS_GRACE_SECONDS);
});

test('a request 1 ms before midnight UTC: counted under that day, and its salt is created to die 1 ms later', () => {
  const now = new Date('2026-09-25T23:59:59.999Z');
  const day = distinctAddressDay(now);
  expect(day).toBe('2026-09-25');
  const deadlineSec = distinctSaltExpiresAt(day);
  // The deadline is the very next instant: 1 ms after the request.
  expect(deadlineSec * 1000 - now.getTime()).toBe(1);
});

test('the element is sha256(daySalt ‖ address) and differs from the rate limiter\'s hash — even for the same salt value', () => {
  const ip = '203.0.113.7';
  const salt = 'ab'.repeat(16);
  const element = distinctAddressElement(ip, salt);
  expect(element).toMatch(/^[0-9a-f]{64}$/);
  expect(element).toBe(createHash('sha256').update(salt + ip).digest('hex'));
  // A different construction from callerHash = sha256(ip + salt), so an
  // element can never equal a rate-limit key's hash.
  expect(element).not.toBe(callerHash(ip, salt));
  // And a different salt gives a different element for the same address.
  expect(distinctAddressElement(ip, 'cd'.repeat(16))).not.toBe(element);
});

// --- the write path --------------------------------------------------------------

test('noteDistinctAddress: creates the day salt with SET NX + EXAT at the end of the day, then PFADDs sha256(daySalt ‖ address) into today\'s ONE key', async () => {
  const mock = useMock();
  const ip = '203.0.113.7';
  const now = new Date();
  const day = distinctAddressDay(now);
  const key = distinctAddressKey(day);

  await noteDistinctAddress(ip, now);

  // The day salt: read, found absent, created in ONE command that carries
  // its absolute end-of-day deadline — never a relative EX.
  const saltCommands = mock.commands.filter((c) => c[1] === distinctSaltKey(day));
  expect(saltCommands.map((c) => c[0])).toEqual(['GET', 'SET']);
  const [, , value, ...flags] = saltCommands[1];
  expect(value).toMatch(/^[0-9a-f]{32}$/); // 128 bits of CSPRNG output, hex
  expect(flags).toEqual(['NX', 'EXAT', String(distinctSaltExpiresAt(day))]);
  expect(Number(flags[2])).toBe(nextUtcMidnightSec(now));
  // The salt's TTL, as the database reports it, never reaches past midnight.
  const saltTtl = mock.exec(['TTL', distinctSaltKey(day)]) as number;
  expect(saltTtl).toBeGreaterThan(0);
  expect(saltTtl).toBeLessThanOrEqual(nextUtcMidnightSec(now) - Math.floor(now.getTime() / 1000));

  // The element is the day salt's hash of the address — not the address,
  // not an unsalted digest, not the rate limiter's hash.
  const daySalt = storedDaySalt(mock, day);
  expect([...(mock.hll.get(key) ?? [])]).toEqual([distinctAddressElement(ip, daySalt)]);

  // Only two keys exist afterwards: the day salt and the day's sketch. The
  // rate limiter's salt was never read or created by this path.
  expect(mock.keys().sort()).toEqual([key, distinctSaltKey(day)].sort());
  expect(mock.commands.some((c) => c[1] === saltKey())).toBe(false);

  // The exact commands for the sketch itself: one PFADD, one EXPIREAT.
  const sketchCommands = mock.commands.filter((c) => c[1] === key);
  expect(sketchCommands.map((c) => c[0])).toEqual(['PFADD', 'EXPIREAT']);
  expect(sketchCommands[1][2]).toBe(String(distinctAddressExpiresAt(day)));

  // The deadline is on the key, absolute, and the TTL the database reports
  // agrees with it.
  expect(mock.store.get(key)?.expiresAt).toBe(distinctAddressExpiresAt(day) * 1000);
  const ttl = mock.exec(['TTL', key]) as number;
  expect(ttl).toBeGreaterThan(DISTINCT_ADDRESS_GRACE_SECONDS);
  expect(ttl).toBeLessThanOrEqual(24 * 60 * 60 + DISTINCT_ADDRESS_GRACE_SECONDS);
});

test('noteDistinctAddress: a repeat address changes nothing and costs no second EXPIREAT; a new one re-asserts the SAME deadline', async () => {
  const mock = useMock();
  const now = new Date();
  const key = distinctAddressKey(distinctAddressDay(now));

  await noteDistinctAddress('203.0.113.7', now);
  await noteDistinctAddress('203.0.113.7', now);
  expect(mock.hll.get(key)?.size).toBe(1);
  expect(mock.commands.filter((c) => c[0] === 'EXPIREAT')).toHaveLength(1);

  await noteDistinctAddress('198.51.100.20', now);
  expect(mock.hll.get(key)?.size).toBe(2);
  const expireats = mock.commands.filter((c) => c[0] === 'EXPIREAT');
  expect(expireats).toHaveLength(2);
  expect(new Set(expireats.map((c) => c[2])).size).toBe(1); // never extended
  expect(mock.exec(['PFCOUNT', key])).toBe(2);
});

test('noteDistinctAddress: the raw address never crosses the wire, and neither does anything but the key, the hash, and the deadline', async () => {
  const mock = useMock();
  const ips = ['203.0.113.7', '198.51.100.20', '2001:db8::1'];
  for (const ip of ips) await noteDistinctAddress(ip);

  const wire = wireText(mock);
  for (const ip of ips) expect(wire, `raw address ${ip} must never be sent`).not.toContain(ip);

  // Every sketch command's arguments are the key plus exactly one hex hash
  // (PFADD) or one unix-seconds deadline (EXPIREAT).
  const key = distinctAddressKey(distinctAddressDay());
  for (const c of mock.commands.filter((cmd) => cmd[1] === key)) {
    if (c[0] === 'PFADD') {
      expect(c).toHaveLength(3);
      expect(c[2]).toMatch(/^[0-9a-f]{64}$/);
    } else {
      expect(c[0]).toBe('EXPIREAT');
      expect(c[2]).toMatch(/^\d+$/);
    }
  }
});

test('noteDistinctAddress uses its OWN salt, never the rate limiter\'s: two salt keys, two values, and the element is not the limiter\'s hash', async () => {
  const mock = useMock();
  const ip = '203.0.113.50';
  const now = new Date();
  const day = distinctAddressDay(now);

  const limiter = createRateLimiter({ route: 'script', max: 8, windowSec: 600 });
  await limiter.isLimited(ip);
  await noteDistinctAddress(ip, now);

  // Two separate salts: the limiter's record and the sketch's day salt.
  expect(mock.store.has(saltKey())).toBe(true);
  expect(mock.store.has(distinctSaltKey(day))).toBe(true);
  const limiterSalt = storedLimiterSalt(mock);
  const daySalt = storedDaySalt(mock, day);
  expect(daySalt).not.toBe(limiterSalt);

  // The limiter's counter is keyed by ITS hash; the sketch holds only the
  // day salt's element, and neither of the limiter-style hashes.
  const limiterHash = callerHash(ip, limiterSalt);
  expect(mock.store.has(counterKey('script', limiterHash))).toBe(true);
  const sketch = mock.hll.get(distinctAddressKey(day));
  expect([...(sketch ?? [])]).toEqual([distinctAddressElement(ip, daySalt)]);
  expect(sketch?.has(limiterHash)).toBe(false);
  expect(sketch?.has(callerHash(ip, daySalt))).toBe(false);

  // And the sketch path never touched the limiter's salt key: every command
  // on it came from the limiter's own call, before the sketch ran.
  const firstSketchCommand = mock.commands.findIndex((c) => c[1] === distinctSaltKey(day));
  expect(mock.commands.slice(firstSketchCommand).some((c) => c[1] === saltKey())).toBe(false);
});

test('one address counts ONCE per UTC day — the rate limiter\'s salt rotating mid-day no longer splits it', async () => {
  const mock = useMock();
  const ip = '203.0.113.7';
  const now = new Date();
  const key = distinctAddressKey(distinctAddressDay(now));

  const limiter = createRateLimiter({ route: 'script', max: 8, windowSec: 600 });
  await limiter.isLimited(ip);
  await noteDistinctAddress(ip, now);

  // The LIMITER's salt rotates (its 24h TTL, or anything else): that used to
  // hand the sketch a second element for the same address. Not any more.
  mock.exec(['DEL', saltKey()]);
  __resetSaltMemoForTests(); // clears both memos, so the day salt is re-read too
  await limiter.isLimited(ip);
  await noteDistinctAddress(ip, now);

  expect(mock.hll.get(key)?.size).toBe(1);
  expect(mock.exec(['PFCOUNT', key])).toBe(1);
});

test('a new UTC day gets a new salt: the same address yields an unrelated element the next day', async () => {
  const mock = useMock();
  const ip = '203.0.113.7';
  // Days far in the future so the mock (which expires keys by the real
  // clock) keeps both salts readable for the assertions below.
  const dayOne = new Date('2099-03-01T12:00:00.000Z');
  const dayTwo = new Date('2099-03-02T12:00:00.000Z');

  await noteDistinctAddress(ip, dayOne);
  await noteDistinctAddress(ip, dayTwo);

  const saltOne = storedDaySalt(mock, '2099-03-01');
  const saltTwo = storedDaySalt(mock, '2099-03-02');
  expect(saltOne).not.toBe(saltTwo);
  expect([...(mock.hll.get(distinctAddressKey('2099-03-01')) ?? [])]).toEqual([distinctAddressElement(ip, saltOne)]);
  expect([...(mock.hll.get(distinctAddressKey('2099-03-02')) ?? [])]).toEqual([distinctAddressElement(ip, saltTwo)]);
  expect(distinctAddressElement(ip, saltOne)).not.toBe(distinctAddressElement(ip, saltTwo));
  // Each salt was born with ITS OWN day's end as its deadline.
  const sets = mock.commands.filter((c) => c[0] === 'SET');
  expect(sets.map((c) => [c[1], c[5]])).toEqual([
    [distinctSaltKey('2099-03-01'), String(Date.parse('2099-03-02T00:00:00Z') / 1000)],
    [distinctSaltKey('2099-03-02'), String(Date.parse('2099-03-03T00:00:00Z') / 1000)],
  ]);
});

test('the day salt is NEVER extended: many requests, one SET, no EXPIRE/EXPIREAT/PERSIST on it, and a memo refresh only reads', async () => {
  const mock = useMock();
  const now = new Date();
  const day = distinctAddressDay(now);
  for (let i = 0; i < 20; i++) await noteDistinctAddress(`198.51.100.${i}`, now);
  // A memo refresh (as after 60s, or on a fresh instance) re-reads the salt;
  // it must never re-write it or touch its deadline.
  __resetSaltMemoForTests();
  await noteDistinctAddress('198.51.100.200', now);

  const onSalt = mock.commands.filter((c) => c[1] === distinctSaltKey(day));
  expect(onSalt.filter((c) => c[0] === 'SET')).toHaveLength(1);
  expect(onSalt.filter((c) => c[0] !== 'SET' && c[0] !== 'GET')).toEqual([]);
  // One GET to create it, one after the memo was cleared: the memo serves
  // everything in between.
  expect(onSalt.filter((c) => c[0] === 'GET')).toHaveLength(2);
  // All 21 addresses share that one salt.
  expect(mock.exec(['PFCOUNT', distinctAddressKey(day)])).toBe(21);
});

test('1 ms before midnight UTC, then midnight: the old day\'s salt is never reused, and the new day mints its own', async () => {
  const mock = useMock();
  const ip = '203.0.113.7';
  const beforeMidnight = new Date('2026-09-25T23:59:59.999Z');
  const midnight = new Date('2026-09-26T00:00:00.000Z');

  await noteDistinctAddress(ip, beforeMidnight);
  // Same instant again: served from the memo, no salt read at all.
  const commandsAfterFirst = mock.commands.length;
  await noteDistinctAddress('198.51.100.9', beforeMidnight);
  expect(mock.commands.slice(commandsAfterFirst).some((c) => c[1]?.startsWith('dev:uniques-salt:'))).toBe(false);

  await noteDistinctAddress(ip, midnight);

  const saltSets = mock.commands.filter((c) => c[0] === 'SET');
  expect(saltSets.map((c) => c[1])).toEqual([distinctSaltKey('2026-09-25'), distinctSaltKey('2026-09-26')]);
  // Each born with its own day's end: the first dies 1 ms after the request
  // that created it.
  expect(saltSets[0].slice(3)).toEqual(['NX', 'EXAT', String(Date.parse('2026-09-26T00:00:00Z') / 1000)]);
  expect(saltSets[1].slice(3)).toEqual(['NX', 'EXAT', String(Date.parse('2026-09-27T00:00:00Z') / 1000)]);
  expect(saltSets[0][2]).not.toBe(saltSets[1][2]);
  // And each request went to its own day's sketch.
  const pfadds = mock.commands.filter((c) => c[0] === 'PFADD').map((c) => c[1]);
  expect(pfadds).toEqual([distinctAddressKey('2026-09-25'), distinctAddressKey('2026-09-25'), distinctAddressKey('2026-09-26')]);
});

test('an unusable value at the day-salt key is never guessed around or overwritten: that count is dropped', async () => {
  const mock = useMock();
  const now = new Date();
  const day = distinctAddressDay(now);
  mock.exec(['SET', distinctSaltKey(day), 'not-a-salt', 'EXAT', String(distinctSaltExpiresAt(day))]);
  const before = mock.commands.length;
  const out = captureConsole();
  try {
    await expect(noteDistinctAddress('203.0.113.7', now)).resolves.toBeUndefined();
  } finally {
    out.restore();
  }
  const after = mock.commands.slice(before);
  expect(after.map((c) => c[0])).toEqual(['GET']);
  expect(mock.store.get(distinctSaltKey(day))?.value).toBe('not-a-salt');
  expect(mock.hll.size).toBe(0);
});

test('noteDistinctAddress: an absent address ("unknown", the callerIp default, or blank) is not counted and costs no request', async () => {
  const mock = useMock();
  for (const ip of ['unknown', '', '   ']) await noteDistinctAddress(ip);
  expect(mock.callsAttempted).toBe(0);
  // And callerIp really does produce 'unknown' when the header is missing,
  // so a request with no forwarding header lands in this branch.
  expect(callerIp(new Headers())).toBe('unknown');
});

test('noteDistinctAddress: unconfigured counters database is a TRUE no-op — zero network, zero log lines, nothing kept', async () => {
  // No setUpstashEnv(): the counters env is absent, as in local dev and CI.
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('no network in this test');
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = realFetch;
  };
  const out = captureConsole();
  try {
    await expect(noteDistinctAddress('203.0.113.7')).resolves.toBeUndefined();
    await expect(noteDistinctAddress('198.51.100.20')).resolves.toBeUndefined();
  } finally {
    out.restore();
  }
  expect(fetchCalls).toBe(0);
  // Unlike the rate limiter there is no in-memory fallback to announce — a
  // per-instance set of addresses would be an actual list of addresses.
  expect(out.lines).toEqual([]);

  // Nothing was kept, not even a day salt: once the database is configured,
  // the very first command is the read of the day salt (no memo to skip it).
  restoreFetch();
  restoreFetch = null;
  const mock = useMock();
  const now = new Date();
  await noteDistinctAddress('203.0.113.7', now);
  expect(mock.commands[0]).toEqual(['GET', distinctSaltKey(distinctAddressDay(now))]);
});

test('noteDistinctAddress: an Upstash failure never throws, is counted, and logs a status code only — no address, no hash', async () => {
  const mock = useMock();
  mock.failWithStatus = 503;
  const ip = '203.0.113.7';
  const before = getUpstashErrorCounts().counters;
  const out = captureConsole();
  try {
    await expect(noteDistinctAddress(ip)).resolves.toBeUndefined();
  } finally {
    out.restore();
  }
  expect(getUpstashErrorCounts().counters).toBe(before + 1);
  expect(out.lines).toHaveLength(1);
  expect(out.lines[0]).toContain('status 503');
  expect(out.lines[0]).not.toContain(ip);
  expect(out.lines[0]).not.toMatch(/[0-9a-f]{32,}/);

  // Network failure: same contract.
  mock.failWithStatus = null;
  mock.failWithNetworkError = true;
  const out2 = captureConsole();
  try {
    await expect(noteDistinctAddress(ip)).resolves.toBeUndefined();
  } finally {
    out2.restore();
  }
  expect(out2.lines.join('\n')).not.toContain(ip);
});

// --- the digest read ---------------------------------------------------------------

test('readDistinctAddressCount: reads TTL then PFCOUNT, never writes, and reports the estimate', async () => {
  const mock = useMock();
  const now = new Date();
  const day = distinctAddressDay(now);
  for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.2']) {
    await noteDistinctAddress(ip, now);
  }
  const writesBefore = mock.commands.length;

  expect(await readDistinctAddressCount(day)).toEqual({ ok: true, count: 3, noExpiry: false });
  const readCommands = mock.commands.slice(writesBefore).map((c) => c[0]);
  expect(readCommands).toEqual(['TTL', 'PFCOUNT']);
});

test('readDistinctAddressCount: no sketch for that day reads as "not recorded" (null), never as an invented zero', async () => {
  const mock = useMock();
  expect(await readDistinctAddressCount('2026-09-20')).toEqual({ ok: true, count: null, noExpiry: false });
  expect(mock.commands.map((c) => c[0])).toEqual(['TTL']); // no PFCOUNT on an absent key
});

test('readDistinctAddressCount: a key that lost its deadline is flagged, not repaired', async () => {
  const mock = useMock();
  const day = distinctAddressDay();
  mock.exec(['PFADD', distinctAddressKey(day), 'a'.repeat(64)]); // PFADD alone sets no TTL
  const before = mock.commands.length;
  expect(await readDistinctAddressCount(day)).toEqual({ ok: true, count: 1, noExpiry: true });
  expect(mock.commands.slice(before).map((c) => c[0])).toEqual(['TTL', 'PFCOUNT']); // read-only
});

test('readDistinctAddressCount: fails CLOSED — unconfigured, request error, or a malformed reply all return { ok: false }', async () => {
  // Unconfigured.
  expect(await readDistinctAddressCount('2026-09-25')).toEqual({ ok: false });

  // Request error.
  const mock = useMock();
  mock.failWithStatus = 500;
  const out = captureConsole();
  try {
    expect(await readDistinctAddressCount('2026-09-25')).toEqual({ ok: false });
  } finally {
    out.restore();
  }
  restoreFetch?.();

  // Malformed replies: a string where a count belongs, a negative count.
  for (const bad of ['12', -1, 1.5]) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body)) as string[];
      const result = command[0] === 'TTL' ? 3600 : bad;
      return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = realFetch;
    };
    expect(await readDistinctAddressCount('2026-09-25'), `reply ${JSON.stringify(bad)}`).toEqual({ ok: false });
    restoreFetch();
    restoreFetch = null;
  }
});

// --- proxy.ts wiring ---------------------------------------------------------------

/*
 * proxy.ts itself cannot be imported here (next-intl's middleware is ESM that
 * the unit runner cannot resolve), so its wiring is pinned two ways, the same
 * split tests/upstash-privacy.spec.ts uses for the page-view family: the
 * source text for WHERE and HOW it is called, and a driven burst of the
 * exact call shape for WHAT reaches the wire.
 */
const proxySource = readFileSync(join(process.cwd(), 'proxy.ts'), 'utf8');

test('proxy.ts wiring (source): counted only for countable page requests, inside waitUntil, never awaited, never joined to the page label', () => {
  const from = proxySource.indexOf('export default function proxy');
  expect(from).toBeGreaterThan(-1);
  // The function body only: up to its closing brace at column zero.
  const body = proxySource.slice(from, proxySource.indexOf('\n}\n', from) + 2);
  const gate = body.indexOf('if (isCountablePageviewRequest(req))');
  const call = body.indexOf('noteDistinctAddress(');
  expect(gate, 'the count sits behind the same countable-request gate as page views').toBeGreaterThan(-1);
  expect(call).toBeGreaterThan(gate);

  // Exactly one call, with exactly one argument: the rate limiter's own
  // address derivation. No page label, path, or locale travels with it.
  const calls = body.match(/noteDistinctAddress\(([^()]*(?:\([^()]*\))?[^()]*)\)/g) ?? [];
  expect(calls).toEqual(['noteDistinctAddress(callerIp(req.headers))']);

  // Handed to waitUntil (so the response never waits on it) with a
  // swallowing .catch, inside its own try; nothing in the proxy awaits.
  expect(body).toContain('event.waitUntil(noteDistinctAddress(callerIp(req.headers)).catch(() => {}));');
  expect(body).not.toMatch(/\bawait\b/);
  expect(body.lastIndexOf('return res;')).toBeGreaterThan(call);

  // The embeds stay out of the matcher, so a tenant's visitors are never added.
  expect(proxySource).toContain("matcher: '/((?!api|_next|_vercel|embed/|embed$|.*\\\\..*).*)'");
});

test('proxy.ts wiring (driven): a burst of real requests leaves ONE daily key on the wire, no path, no raw address, and uncountable requests add nothing', async () => {
  const mock = useMock();
  const SLUG = 'hr-1234-119';
  const req = (path: string, ip: string | null, headers: Record<string, string> = {}, method = 'GET') =>
    new NextRequest(`https://oravan.org${path}`, {
      method,
      headers: { accept: 'text/html,application/xhtml+xml', ...(ip ? { 'x-forwarded-for': ip } : {}), ...headers },
    });

  const requests = [
    req('/', '203.0.113.10'),
    req('/es', '203.0.113.10'), // same address, other locale: one address
    req(`/bills/${SLUG}`, '203.0.113.11, 10.0.0.1'), // first hop only
    req(`/es/bills/${SLUG}?stance=support`, '198.51.100.12'),
    req('/reps?zip=10001', '2001:db8::7'),
    req('/about', null), // no forwarding header: 'unknown', not counted
    // Not page loads — proxy.ts counts none of these:
    req(`/bills/${SLUG}`, '192.0.2.1', { rsc: '1' }),
    req(`/bills/${SLUG}`, '192.0.2.2', { 'next-router-prefetch': '1' }),
    req('/bills', '192.0.2.3', { accept: 'application/json' }),
    req('/bills', '192.0.2.4', {}, 'HEAD'),
  ];
  for (const r of requests) {
    // Exactly proxy.ts's call shape.
    if (isCountablePageviewRequest(r)) await noteDistinctAddress(callerIp(r.headers));
  }

  const day = distinctAddressDay();
  const key = distinctAddressKey(day);
  expect(mock.keys().sort()).toEqual([key, distinctSaltKey(day)].sort());
  expect(mock.exec(['PFCOUNT', key])).toBe(4); // .10, .11, .12, the IPv6 address

  const wire = wireText(mock);
  for (const marker of [SLUG, 'stance', 'support', '/es', 'zip', '10001', '203.0.113', '198.51.100', '2001:db8', '192.0.2', '10.0.0.1']) {
    expect(wire, `the wire must not carry "${marker}"`).not.toContain(marker);
  }
  // The uncountable requests' addresses were never even hashed in.
  const daySalt = storedDaySalt(mock, day);
  for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4']) {
    expect(mock.hll.get(key)?.has(distinctAddressElement(ip, daySalt))).toBe(false);
  }
});

// --- source guarantees, district-log-privacy style ----------------------------------

test('the distinct-address code logs nothing of its own and keeps no in-memory collection of addresses', () => {
  const source = readFileSync(join(process.cwd(), 'lib/ratelimit.ts'), 'utf8');
  const start = source.indexOf('// --- daily distinct-address count');
  expect(start, 'section banner must exist so this scan has something to read').toBeGreaterThan(-1);
  // Code only: comments explain the design in prose and may name anything.
  const code = source
    .slice(start)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  expect(code).not.toMatch(/console\./); // errors go through noteUpstashError, status only
  expect(code).not.toMatch(/new (Set|Map)\b|\.push\(|\[\]\s*;/); // no list of addresses, not even per-instance
  // The one error sink, and every call to it passes nothing but the error
  // and a fixed sentence — no address, hash, or key can ride along.
  const sinkCalls = code.split('noteUpstashError(').length - 1;
  const safeCalls = code.match(/noteUpstashError\(\s*'counters',\s*err,\s*(?:"[^"]*"|'[^']*')\s*\)/g) ?? [];
  expect(sinkCalls).toBeGreaterThan(0);
  expect(safeCalls).toHaveLength(sinkCalls);

  // The section never reaches for the rate limiter's salt or hash.
  expect(code).not.toMatch(/\bcurrentSalt\(|\bcallerHash\(|\bsaltKey\(|\bparseSaltRecord\(/);
});

// --- the public sentence --------------------------------------------------------------

test('privacy.p9 exists in BOTH languages and the privacy page renders it, right after the page-kind count', () => {
  expect(typeof en.privacy.p9).toBe('string');
  expect(typeof es.privacy.p9).toBe('string');
  expect(en.privacy.p9.length).toBeGreaterThan(0);
  expect(es.privacy.p9.length).toBeGreaterThan(0);
  const page = readFileSync(join(process.cwd(), 'app/[locale]/privacy/page.tsx'), 'utf8');
  expect(page).toMatch(/'p8', 'p9'/);
});
