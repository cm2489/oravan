import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): plain lib modules resolve under the test
// runner — same pattern as tests/impressions.unit.spec.ts.
import {
  __memoryUsageCountForTests,
  __resetUsageFallbackLogForTests,
  MCP_TOOL_NAMES,
  mcpUsageKey,
  noteMcpToolCall,
  noteScriptGeneration,
  readUsageWindow,
  scriptUsageKey,
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
