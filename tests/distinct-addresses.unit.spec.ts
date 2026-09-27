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
  distinctAddressExpiresAt,
  distinctAddressKey,
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
 * the 2026-09-27 audit's SY-20). Pins lib/ratelimit.ts's contract for it:
 *
 *   - ONE key per UTC day, `<env>:uniques:<YYYY-MM-DD>`, no other dimension;
 *   - the element added is the rate limiter's own salted caller hash, from
 *     the same salt record — never the raw address;
 *   - the key carries an absolute deadline, 48h after its UTC day ends;
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

/** The live salt value the mock holds (the one the rate limiter reads). */
function storedSalt(mock: MockUpstash): string {
  const raw = mock.store.get(saltKey())?.value;
  const record = typeof raw === 'string' ? parseSaltRecord(raw) : null;
  if (!record) throw new Error('no salt record in the mock store');
  return record.v;
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

// --- the write path --------------------------------------------------------------

test('noteDistinctAddress: PFADDs the salted caller hash into today\'s ONE key and attaches the deadline at creation', async () => {
  const mock = useMock();
  const ip = '203.0.113.7';
  const now = new Date();
  const day = distinctAddressDay(now);
  const key = distinctAddressKey(day);

  await noteDistinctAddress(ip, now);

  // The element is the rate limiter's own hash of the address, from the
  // same stored salt — not the address, not an unsalted digest.
  const salt = storedSalt(mock);
  expect([...(mock.hll.get(key) ?? [])]).toEqual([callerHash(ip, salt)]);

  // Only two keys exist afterwards: the salt the limiter already keeps, and
  // the day's sketch. Nothing else was written.
  expect(mock.keys().sort()).toEqual([key, saltKey()].sort());

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

test('noteDistinctAddress shares the rate limiter\'s salt and hash: one salt record, and the element IS the limiter\'s caller hash', async () => {
  const mock = useMock();
  const ip = '203.0.113.50';

  const limiter = createRateLimiter({ route: 'script', max: 8, windowSec: 600 });
  await limiter.isLimited(ip);
  await noteDistinctAddress(ip);

  // No second salt: the limiter created it, the sketch reused it.
  expect(mock.keys().filter((k) => k.includes(':salt:'))).toEqual([saltKey()]);

  const hash = callerHash(ip, storedSalt(mock));
  expect(mock.store.has(counterKey('script', hash))).toBe(true);
  expect(mock.hll.get(distinctAddressKey(distinctAddressDay()))?.has(hash)).toBe(true);
});

test('KNOWN OVERCOUNT, pinned as intended: after the salt rotates, the same address counts again', async () => {
  const mock = useMock();
  const ip = '203.0.113.7';
  const key = distinctAddressKey(distinctAddressDay());

  await noteDistinctAddress(ip);
  const firstSalt = storedSalt(mock);

  // Rotation: the record dies (its 24h TTL) and the next reader mints a new one.
  mock.exec(['DEL', saltKey()]);
  __resetSaltMemoForTests();
  await noteDistinctAddress(ip);
  const secondSalt = storedSalt(mock);

  expect(secondSalt).not.toBe(firstSalt);
  // Two different elements for one address: the overcount the digest caveat
  // discloses. The alternative (a longer-lived hash) is what rotation forbids.
  expect(mock.hll.get(key)?.size).toBe(2);
  expect(mock.hll.get(key)?.has(callerHash(ip, firstSalt))).toBe(true);
  expect(mock.hll.get(key)?.has(callerHash(ip, secondSalt))).toBe(true);
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

  const key = distinctAddressKey(distinctAddressDay());
  expect(mock.keys().sort()).toEqual([key, saltKey()].sort());
  expect(mock.exec(['PFCOUNT', key])).toBe(4); // .10, .11, .12, the IPv6 address

  const wire = wireText(mock);
  for (const marker of [SLUG, 'stance', 'support', '/es', 'zip', '10001', '203.0.113', '198.51.100', '2001:db8', '192.0.2', '10.0.0.1']) {
    expect(wire, `the wire must not carry "${marker}"`).not.toContain(marker);
  }
  // The uncountable requests' addresses were never even hashed in.
  const salt = storedSalt(mock);
  for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4']) {
    expect(mock.hll.get(key)?.has(callerHash(ip, salt))).toBe(false);
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
