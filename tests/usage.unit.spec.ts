import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): plain lib modules resolve under the test
// runner — same pattern as tests/impressions.unit.spec.ts.
import {
  __memoryUsageCountForTests,
  __resetUsageFallbackLogForTests,
  asPageviewSurface,
  isCountablePageviewRequest,
  MCP_TOOL_NAMES,
  mcpClientUsageKey,
  mcpUsageKey,
  noteMcpClientHandshake,
  noteMcpToolCall,
  notePageview,
  noteScriptGeneration,
  PAGEVIEW_SURFACES,
  pageviewSurfaceForPath,
  pageviewUsageKey,
  readMcpClientDay,
  readPageviewWindow,
  readUsageWindow,
  sanitizeMcpClientName,
  scriptUsageKey,
  UNKNOWN_MCP_CLIENT,
  usageDayKey,
} from '../lib/usage';
import { getUpstashErrorCounts } from '../lib/upstash';
import { COUNTERS_URL, MockUpstash, installUpstashFetch, setUpstashEnv } from './upstash-mock';

/*
 * Traffic-watch design (2026-07): pins lib/usage.ts's contract — the write
 * path (noteMcpToolCall, noteScriptGeneration: non-blocking, fails open,
 * content-free and caller-free by construction) and the read path
 * (readUsageWindow: ONE MGET across all 6 series, fails CLOSED on error/
 * unconfigured — the same deliberate write/read asymmetry
 * tests/impressions.unit.spec.ts already pins for lib/impressions.ts). No
 * live Upstash tokens exist in this environment — the mock IS the test
 * seam, same convention as every other S11/S18/S19/S20 unit spec.
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

// --- key builders ---------------------------------------------------------------

test('mcpUsageKey / scriptUsageKey: exact shapes, no caller/content bleed', () => {
  expect(mcpUsageKey('get_bill', '2026-07-12')).toBe('dev:usage:mcp:get_bill:2026-07-12');
  expect(scriptUsageKey('2026-07-12')).toBe('dev:usage:script:2026-07-12');
});

test('MCP_TOOL_NAMES: the exact 5-tool closed set, in a stable order', () => {
  expect(MCP_TOOL_NAMES).toEqual([
    'lookup_representatives',
    'get_bill',
    'search_bills',
    'whats_moving',
    'get_representative',
  ]);
});

// --- sanitizeMcpClientName / mcpClientUsageKey (client-handshake family) --------

test('sanitizeMcpClientName: lowercases and strips everything outside [a-z0-9._-]', () => {
  expect(sanitizeMcpClientName('Claude-AI')).toBe('claude-ai');
  expect(sanitizeMcpClientName('glama')).toBe('glama');
  expect(sanitizeMcpClientName('client.name_v1-2')).toBe('client.name_v1-2'); // allowed charset preserved
  expect(sanitizeMcpClientName('My MCP Client 2')).toBe('mymcpclient2');
  expect(sanitizeMcpClientName('  ✨wéird→uni¢ode✨  ')).toBe('wirduniode'); // non-ASCII dropped, never mangled into a throw
});

test('sanitizeMcpClientName: truncates to 32 chars, AFTER stripping (strip-then-truncate order)', () => {
  expect(sanitizeMcpClientName('a'.repeat(100))).toBe('a'.repeat(32));
  // 32 'a's interleaved with spaces: strip-first keeps all 32; a
  // truncate-first implementation would keep only 16 — pin the order.
  expect(sanitizeMcpClientName('a '.repeat(32))).toBe('a'.repeat(32));
});

test('sanitizeMcpClientName: empty, all-stripped, and non-string inputs all degrade to "unknown"', () => {
  expect(sanitizeMcpClientName('')).toBe(UNKNOWN_MCP_CLIENT);
  expect(sanitizeMcpClientName('💥🎉')).toBe(UNKNOWN_MCP_CLIENT);
  expect(sanitizeMcpClientName(undefined)).toBe(UNKNOWN_MCP_CLIENT);
  expect(sanitizeMcpClientName(null)).toBe(UNKNOWN_MCP_CLIENT);
  expect(sanitizeMcpClientName(42)).toBe(UNKNOWN_MCP_CLIENT);
  expect(sanitizeMcpClientName({ name: 'sneaky-object' })).toBe(UNKNOWN_MCP_CLIENT);
});

test('sanitizeMcpClientName: idempotent — sanitizing a sanitized name is a no-op', () => {
  for (const raw of ['Claude-AI', '💥🎉', '', 'a '.repeat(32), 'client.name_v1-2']) {
    const once = sanitizeMcpClientName(raw);
    expect(sanitizeMcpClientName(once)).toBe(once);
  }
});

test('mcpClientUsageKey: exact shape, and sanitization is structural — a hostile raw name cannot inject key structure', () => {
  expect(mcpClientUsageKey('claude-ai', '2026-07-15')).toBe('dev:usage:mcp-client:claude-ai:2026-07-15');
  // ':' (the key separator) and glob chars are outside the sanitized
  // alphabet — the key builder itself strips them; there is no raw-name path.
  expect(mcpClientUsageKey('Evil:Client:*?[]', '2026-07-15')).toBe('dev:usage:mcp-client:evilclient:2026-07-15');
  expect(mcpClientUsageKey('', '2026-07-15')).toBe('dev:usage:mcp-client:unknown:2026-07-15');
});

// --- noteMcpToolCall / noteScriptGeneration: the write path ---------------------

test('noteMcpToolCall: durable SET NX EX (90d) before INCR, exact key shape, per-tool independence', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  await noteMcpToolCall('get_bill');
  const key = mcpUsageKey('get_bill', usageDayKey());
  expect(counters.store.get(key)?.value).toBe('1');

  const setCommands = counters.commands.filter((c) => c[0] === 'SET' && c[1] === key);
  expect(setCommands).toHaveLength(1);
  expect(setCommands[0].slice(3)).toEqual(['NX', 'EX', String(90 * 24 * 60 * 60)]);

  await noteMcpToolCall('get_bill');
  expect(counters.store.get(key)?.value).toBe('2'); // same-day calls accumulate

  // A DIFFERENT tool gets an INDEPENDENT daily counter, never blended.
  await noteMcpToolCall('whats_moving');
  expect(counters.store.get(mcpUsageKey('whats_moving', usageDayKey()))?.value).toBe('1');
  expect(counters.store.get(key)?.value).toBe('2'); // unaffected
});

test('noteScriptGeneration: independent of every MCP tool counter, exact key shape', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  await noteScriptGeneration();
  await noteScriptGeneration();
  await noteMcpToolCall('get_bill');

  expect(counters.store.get(scriptUsageKey(usageDayKey()))?.value).toBe('2');
  expect(counters.store.get(mcpUsageKey('get_bill', usageDayKey()))?.value).toBe('1');
});

test('noteMcpClientHandshake: durable SET NX EX (90d) before INCR, sanitized key, "unknown" fallback, independent of the tool counters', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  await noteMcpClientHandshake('Claude-AI'); // raw, unsanitized input — the route passes it through as-is
  const key = mcpClientUsageKey('claude-ai', usageDayKey());
  expect(counters.store.get(key)?.value).toBe('1');

  const setCommands = counters.commands.filter((c) => c[0] === 'SET' && c[1] === key);
  expect(setCommands).toHaveLength(1);
  expect(setCommands[0].slice(3)).toEqual(['NX', 'EX', String(90 * 24 * 60 * 60)]);

  await noteMcpClientHandshake('claude-ai');
  expect(counters.store.get(key)?.value).toBe('2'); // same-day handshakes accumulate

  // A handshake with no usable name still counts — under "unknown".
  await noteMcpClientHandshake(undefined);
  expect(counters.store.get(mcpClientUsageKey(UNKNOWN_MCP_CLIENT, usageDayKey()))?.value).toBe('1');

  // Never blended with the per-tool family.
  await noteMcpToolCall('get_bill');
  expect(counters.store.get(mcpUsageKey('get_bill', usageDayKey()))?.value).toBe('1');
  expect(counters.store.get(key)?.value).toBe('2'); // unaffected

  // Constitution check, in the test: every key this suite just wrote is a
  // software name + day — no raw name survived, nothing else was stored.
  for (const written of counters.keys()) {
    expect(written).toMatch(/^dev:usage:(mcp|mcp-client|script)/);
    expect(written).not.toContain('Claude'); // the raw (unsanitized) input never reaches a key
  }
});

test('graceful degradation: no env → in-memory fallback, zero network calls, single startup line', async () => {
  __resetUsageFallbackLogForTests();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  const logged: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => logged.push(args.join(' '));
  try {
    await noteMcpToolCall('search_bills');
    await noteMcpToolCall('search_bills');
    await noteScriptGeneration();
  } finally {
    console.log = realLog;
  }

  expect(counters.commands, 'must not touch the REST surface without env').toHaveLength(0);
  expect(__memoryUsageCountForTests(mcpUsageKey('search_bills', usageDayKey()))).toBe(2);
  expect(__memoryUsageCountForTests(scriptUsageKey(usageDayKey()))).toBe(1);
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
    await expect(noteMcpToolCall('lookup_representatives')).resolves.toBeUndefined();
  } finally {
    console.error = realError;
  }

  expect(getUpstashErrorCounts().counters).toBeGreaterThan(errorsBefore);
  expect(logged.length).toBeGreaterThan(0);
  expect(logged.some((l) => l.includes('failing open to in-memory'))).toBe(true);
});

// --- readUsageWindow: the read path ----------------------------------------------

const EIGHT_DAYS = Array.from({ length: 8 }, (_, i) => `2026-07-${String(12 - i).padStart(2, '0')}`); // day-1..day-8

test('readUsageWindow: unconfigured counters database fails CLOSED, never a degraded number', async () => {
  // No setUpstashEnv() — the unconfigured path.
  const result = await readUsageWindow(EIGHT_DAYS);
  expect(result).toEqual({ ok: false });
});

test('readUsageWindow: an Upstash MGET error fails CLOSED and logs an ACCURATE (non-"failing open") consequence', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  counters.failWithStatus = 503;
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.join(' '));
  let result: unknown;
  try {
    result = await readUsageWindow(EIGHT_DAYS);
  } finally {
    console.error = realError;
  }

  expect(result).toEqual({ ok: false });
  expect(logged.length).toBeGreaterThan(0);
  for (const line of logged) {
    expect(line).not.toContain('failing open to in-memory');
  }
});

test('readUsageWindow: ONE MGET round trip, exact per-tool + script counts mapped back to the right day index, an honest all-zero window for days with no traffic', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  // Seed day-1 (EIGHT_DAYS[0]) and day-8 (EIGHT_DAYS[7]) directly, so the
  // read proves it maps each key back to the correct array index, not just
  // "some count landed somewhere."
  counters.exec(['SET', mcpUsageKey('get_bill', EIGHT_DAYS[0]), '41']);
  counters.exec(['SET', mcpUsageKey('get_bill', EIGHT_DAYS[7]), '38']);
  counters.exec(['SET', scriptUsageKey(EIGHT_DAYS[0]), '14']);

  const result = await readUsageWindow(EIGHT_DAYS);
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const mgetCommands = counters.commands.filter((c) => c[0] === 'MGET');
  expect(mgetCommands).toHaveLength(1); // one round trip, not 48 sequential GETs
  expect(mgetCommands[0]).toHaveLength(1 + MCP_TOOL_NAMES.length * 8 + 8); // 'MGET' + 40 mcp keys + 8 script keys

  expect(result.mcp.get_bill[0]).toBe(41);
  expect(result.mcp.get_bill[7]).toBe(38);
  expect(result.mcp.get_bill.slice(1, 7)).toEqual([0, 0, 0, 0, 0, 0]); // untouched days read as 0, not missing
  expect(result.script[0]).toBe(14);
  expect(result.script.slice(1)).toEqual([0, 0, 0, 0, 0, 0, 0]);

  // Every OTHER tool has an honest all-zero window — never invented.
  for (const tool of MCP_TOOL_NAMES) {
    if (tool === 'get_bill') continue;
    expect(result.mcp[tool]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  }
});

// --- readMcpClientDay: the client-handshake read path -----------------------------

test('readMcpClientDay: unconfigured counters database fails CLOSED, never a degraded list', async () => {
  // No setUpstashEnv() — the unconfigured path.
  expect(await readMcpClientDay('2026-07-15')).toEqual({ ok: false });
});

test('readMcpClientDay: an Upstash error fails CLOSED and logs an ACCURATE (non-"failing open") consequence', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  counters.failWithStatus = 503;
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.join(' '));
  let result: unknown;
  try {
    result = await readMcpClientDay('2026-07-15');
  } finally {
    console.error = realError;
  }

  expect(result).toEqual({ ok: false });
  expect(logged.length).toBeGreaterThan(0);
  for (const line of logged) {
    expect(line).not.toContain('failing open to in-memory');
  }
});

test('readMcpClientDay: SCANs only that day\'s mcp-client keys, one MGET, sorted count-descending with alphabetical ties, other days/families ignored', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  counters.exec(['SET', mcpClientUsageKey('claude-ai', '2026-07-15'), '12']);
  counters.exec(['SET', mcpClientUsageKey('glama', '2026-07-15'), '3']);
  counters.exec(['SET', mcpClientUsageKey('unknown', '2026-07-15'), '3']);
  counters.exec(['SET', mcpClientUsageKey('claude-ai', '2026-07-14'), '99']); // another DAY — must not bleed in
  counters.exec(['SET', mcpUsageKey('get_bill', '2026-07-15'), '77']); // another FAMILY — must not bleed in
  counters.commands.length = 0; // count only the read's own round trips

  const result = await readMcpClientDay('2026-07-15');
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  expect(result.clients).toEqual([
    { client: 'claude-ai', count: 12 },
    { client: 'glama', count: 3 }, // 3-vs-3 tie: alphabetical, glama before unknown
    { client: 'unknown', count: 3 },
  ]);

  const mgets = counters.commands.filter((c) => c[0] === 'MGET');
  expect(mgets).toHaveLength(1); // one round trip for the counts, never N sequential GETs
  expect(mgets[0].slice(1).sort()).toEqual(
    [
      mcpClientUsageKey('claude-ai', '2026-07-15'),
      mcpClientUsageKey('glama', '2026-07-15'),
      mcpClientUsageKey('unknown', '2026-07-15'),
    ].sort()
  );
});

test('readMcpClientDay: a day with no handshakes is an honest empty list (ok: true), never an error and never an invented entry', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  expect(await readMcpClientDay('2026-07-15')).toEqual({ ok: true, clients: [] });
});

// --- the site page-view family (site-counter, 2026-09) ---------------------------

/*
 * The whole point of this family is that a URL goes in and a route-TEMPLATE
 * label comes out — 'bill', never which bill. These tests pin that boundary
 * from both sides: the mapper never invents a label from path material, and
 * the key builder refuses to carry one even when handed it directly.
 */

test('PAGEVIEW_SURFACES: the exact 9-member closed set, stable order, "other" last', () => {
  expect(PAGEVIEW_SURFACES).toEqual([
    'home',
    'bills-index',
    'bill',
    'questions-index',
    'question',
    'reps',
    'record',
    'nominations',
    'other',
  ]);
});

test('pageviewSurfaceForPath: every real route template maps to its own label, locale prefix stripped', () => {
  const locales = ['en', 'es'];
  expect(pageviewSurfaceForPath('/', locales)).toBe('home');
  expect(pageviewSurfaceForPath('/es', locales)).toBe('home');
  expect(pageviewSurfaceForPath('/es/', locales)).toBe('home');
  expect(pageviewSurfaceForPath('/bills', locales)).toBe('bills-index');
  expect(pageviewSurfaceForPath('/es/bills', locales)).toBe('bills-index');
  expect(pageviewSurfaceForPath('/bills/hr-1234-119', locales)).toBe('bill');
  expect(pageviewSurfaceForPath('/es/bills/hr-1234-119', locales)).toBe('bill');
  expect(pageviewSurfaceForPath('/questions', locales)).toBe('questions-index');
  expect(pageviewSurfaceForPath('/questions/what-is-a-markup', locales)).toBe('question');
  expect(pageviewSurfaceForPath('/reps', locales)).toBe('reps');
  expect(pageviewSurfaceForPath('/record', locales)).toBe('record');
  expect(pageviewSurfaceForPath('/nominations/jane-doe', locales)).toBe('nominations');
});

test('pageviewSurfaceForPath: everything unmatched collapses to "other" — no label is ever invented from a path', () => {
  const locales = ['en', 'es'];
  // Pages that exist but have no dedicated counter, a 404 under [...rest],
  // a bare /nominations (no index route exists), and deeper paths under a
  // single-page route all land in the same bucket.
  for (const path of [
    '/about',
    '/privacy',
    '/citations',
    '/glossary',
    '/es/why-call',
    '/nominations',
    '/reps/somebody',
    '/record/2026',
    '/definitely-not-a-route',
    '/es/definitely-not-a-route/deeper',
  ]) {
    expect(pageviewSurfaceForPath(path, locales), path).toBe('other');
  }
  // With no locale list supplied, a locale segment is just another unknown
  // first segment — 'other', never a new surface named after it.
  expect(pageviewSurfaceForPath('/es/bills')).toBe('other');
});

test('asPageviewSurface / pageviewUsageKey: narrowing is STRUCTURAL — a path, slug, or query can never become a key segment', () => {
  expect(pageviewUsageKey('bill', '2026-09-17')).toBe('dev:usage:pageview:bill:2026-09-17');
  expect(pageviewUsageKey('home', '2026-09-17')).toBe('dev:usage:pageview:home:2026-09-17');

  // Hand the key builder raw material directly, bypassing the mapper and
  // the type system the way a future careless caller would: it collapses to
  // 'other' inside the builder, so no path, slug, query, locale, or key
  // separator has any route into the key.
  for (const hostile of [
    '/bills/hr-1234-119',
    'hr-1234-119',
    'bill:evil',
    '?q=guns',
    'es',
    '*',
    '',
    undefined,
    null,
    42,
    { surface: 'bill' },
  ]) {
    expect(asPageviewSurface(hostile), String(hostile)).toBe('other');
    expect(pageviewUsageKey(hostile as never, '2026-09-17')).toBe('dev:usage:pageview:other:2026-09-17');
  }
});

test('isCountablePageviewRequest: GET HTML only — RSC payloads, prefetches, and non-GETs never count', () => {
  const req = (method: string, headers: Record<string, string>) => ({
    method,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  });
  const html = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

  expect(isCountablePageviewRequest(req('GET', html))).toBe(true);
  expect(isCountablePageviewRequest(req('HEAD', html))).toBe(false);
  expect(isCountablePageviewRequest(req('POST', html))).toBe(false);
  // Next's own client-side navigation traffic: one human page view must
  // never be counted two or three times.
  expect(isCountablePageviewRequest(req('GET', { ...html, rsc: '1' }))).toBe(false);
  expect(isCountablePageviewRequest(req('GET', { ...html, 'next-router-prefetch': '1' }))).toBe(false);
  expect(isCountablePageviewRequest(req('GET', { ...html, 'next-router-state-tree': '%5B%22%22%5D' }))).toBe(false);
  // Non-HTML fetches (an RSC payload that forgot its header, a JSON probe).
  expect(isCountablePageviewRequest(req('GET', { accept: 'text/x-component' }))).toBe(false);
  expect(isCountablePageviewRequest(req('GET', { accept: '*/*' }))).toBe(false);
  expect(isCountablePageviewRequest(req('GET', {}))).toBe(false);
});

test('notePageview: durable SET NX EX (90d) before INCR, exact key shape, per-surface independence', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  await notePageview('bill');
  const key = pageviewUsageKey('bill', usageDayKey());
  expect(counters.store.get(key)?.value).toBe('1');

  const setCommands = counters.commands.filter((c) => c[0] === 'SET' && c[1] === key);
  expect(setCommands).toHaveLength(1);
  expect(setCommands[0].slice(3)).toEqual(['NX', 'EX', String(90 * 24 * 60 * 60)]);

  await notePageview('bill');
  expect(counters.store.get(key)?.value).toBe('2'); // same-day views accumulate

  await notePageview('home');
  expect(counters.store.get(pageviewUsageKey('home', usageDayKey()))?.value).toBe('1');
  expect(counters.store.get(key)?.value).toBe('2'); // unaffected

  // Never blended with the other usage families.
  await notePageview('reps');
  await noteMcpToolCall('get_bill');
  expect(counters.store.get(mcpUsageKey('get_bill', usageDayKey()))?.value).toBe('1');
  for (const written of counters.keys()) {
    expect(written).toMatch(/^dev:usage:(mcp|mcp-client|script|pageview)/);
  }
});

test('notePageview: an Upstash failure fails open and never throws — a counter must never cost a page load', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  counters.failWithNetworkError = true;
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  const realError = console.error;
  console.error = () => {};
  try {
    await expect(notePageview('bill')).resolves.toBeUndefined();
  } finally {
    console.error = realError;
  }
});

test('readPageviewWindow: unconfigured counters database fails CLOSED, never a degraded number', async () => {
  // No setUpstashEnv() — the unconfigured path.
  expect(await readPageviewWindow(EIGHT_DAYS)).toEqual({ ok: false });
});

test('readPageviewWindow: an Upstash MGET error fails CLOSED and logs an ACCURATE (non-"failing open") consequence', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  counters.failWithStatus = 503;
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.join(' '));
  let result: unknown;
  try {
    result = await readPageviewWindow(EIGHT_DAYS);
  } finally {
    console.error = realError;
  }

  expect(result).toEqual({ ok: false });
  expect(logged.length).toBeGreaterThan(0);
  for (const line of logged) {
    expect(line).not.toContain('failing open to in-memory');
  }
});

test('readPageviewWindow: ONE MGET round trip, counts mapped back to the right day index, honest all-zero series elsewhere', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  counters.exec(['SET', pageviewUsageKey('bill', EIGHT_DAYS[0]), '412']);
  counters.exec(['SET', pageviewUsageKey('bill', EIGHT_DAYS[7]), '388']);
  counters.exec(['SET', pageviewUsageKey('home', EIGHT_DAYS[0]), '97']);
  counters.exec(['SET', mcpUsageKey('get_bill', EIGHT_DAYS[0]), '77']); // another FAMILY — must not bleed in
  counters.commands.length = 0; // count only the read's own round trips

  const result = await readPageviewWindow(EIGHT_DAYS);
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const mgetCommands = counters.commands.filter((c) => c[0] === 'MGET');
  expect(mgetCommands).toHaveLength(1); // one round trip, not 72 sequential GETs
  expect(mgetCommands[0]).toHaveLength(1 + PAGEVIEW_SURFACES.length * 8);

  expect(result.surfaces.bill[0]).toBe(412);
  expect(result.surfaces.bill[7]).toBe(388);
  expect(result.surfaces.bill.slice(1, 7)).toEqual([0, 0, 0, 0, 0, 0]);
  expect(result.surfaces.home[0]).toBe(97);
  for (const surface of PAGEVIEW_SURFACES) {
    if (surface === 'bill' || surface === 'home') continue;
    expect(result.surfaces[surface], surface).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  }
});

test('readPageviewWindow: an empty day list answers with empty series rather than an argument-less MGET', async () => {
  restoreEnv = setUpstashEnv();
  const counters = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

  const result = await readPageviewWindow([]);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(counters.commands).toHaveLength(0);
  for (const surface of PAGEVIEW_SURFACES) expect(result.surfaces[surface]).toEqual([]);
});
