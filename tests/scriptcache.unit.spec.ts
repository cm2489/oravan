import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): plain lib modules resolve under the test
// runner - same pattern as the other unit specs.
import { contentVersion, createScriptCache, scriptKey } from '../lib/scriptcache';
import { getUpstashErrorCounts } from '../lib/upstash';
import { CACHE_URL, MockUpstash, installUpstashFetch, setUpstashEnv } from './upstash-mock';

/*
 * Pins the S11 script-cache contract: content-versioned keys in the cache
 * database (a corrected decode invalidates stale scripts - strategy
 * §9.1(d)'s named gap), 24h TTL, cross-instance sharing, and graceful
 * degradation to the per-instance Map.
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

const PARTS = { slug: 'hr-1234-119', stance: 'support', lang: 'en' as const };

test('contentVersion: deterministic, short, and summary-sensitive', () => {
  const v1 = contentVersion('This bill funds bridges.');
  expect(v1).toMatch(/^[0-9a-f]{12}$/);
  expect(contentVersion('This bill funds bridges.')).toBe(v1);
  expect(contentVersion('This bill funds bridges!'), 'any edit is a new version').not.toBe(v1);
});

test('a corrected decode invalidates the stale script: changed summary hash -> clean miss', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [CACHE_URL]: mock });

  const cache = createScriptCache();
  const staleVersion = contentVersion('Original (wrong) summary');
  const fixedVersion = contentVersion('Corrected summary after re-decode');

  await cache.set({ ...PARTS, version: staleVersion }, 'SCRIPT BUILT ON THE WRONG SUMMARY');
  // The pre-S11 key (slug:stance:lang, no version) would have HIT here and
  // kept serving the stale script against the corrected summary.
  expect(await cache.get({ ...PARTS, version: fixedVersion })).toBeNull();
  expect(await cache.get({ ...PARTS, version: staleVersion })).toBe(
    'SCRIPT BUILT ON THE WRONG SUMMARY'
  );
});

test('cross-instance sharing with 24h TTL: instance B hits what instance A cached', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [CACHE_URL]: mock });

  const version = contentVersion('shared summary');
  await createScriptCache().set({ ...PARTS, version }, 'ONE GENERATION TOTAL');
  expect(await createScriptCache().get({ ...PARTS, version })).toBe('ONE GENERATION TOTAL');

  // Key shape is the registry's, and the write carried the 24h TTL.
  const key = scriptKey({ ...PARTS, version });
  expect(key).toBe(`dev:script:hr-1234-119:support:en:${version}`);
  const set = mock.commands.find((c) => c[0] === 'SET' && c[1] === key)!;
  expect(set.slice(3)).toEqual(['EX', '86400']);
});

test('graceful degradation: no env -> per-instance Map, zero network calls, no crash', async () => {
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [CACHE_URL]: mock });

  const cache = createScriptCache();
  const version = contentVersion('local dev summary');
  await cache.set({ ...PARTS, version }, 'IN-MEMORY SCRIPT');
  expect(await cache.get({ ...PARTS, version })).toBe('IN-MEMORY SCRIPT');
  expect(await cache.get({ ...PARTS, version: contentVersion('other') })).toBeNull();
  expect(mock.commands, 'must not touch the REST surface without env').toHaveLength(0);
});

test('graceful degradation: request errors are a counted miss (get) / skipped write (set), never a throw', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  mock.failWithStatus = 500;
  restoreFetch = installUpstashFetch({ [CACHE_URL]: mock });

  const errorsBefore = getUpstashErrorCounts().cache;
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.join(' '));
  try {
    const cache = createScriptCache();
    const version = contentVersion('unreachable-upstash summary');
    await cache.set({ ...PARTS, version }, 'STILL SERVED'); // must not throw
    // The instance's own Map catches the fail-open read.
    expect(await cache.get({ ...PARTS, version })).toBe('STILL SERVED');
  } finally {
    console.error = realError;
  }

  expect(getUpstashErrorCounts().cache).toBeGreaterThan(errorsBefore);
  for (const line of logged) {
    expect(line).toContain('status 500'); // status code only...
    expect(line).not.toContain('mock upstream error'); // ...never the body
    expect(line).not.toContain('STILL SERVED'); // and never a script
  }
});
