import { expect, test } from '@playwright/test';
import {
  __resetUpstashEnvWarningsForTests,
  cacheClient,
  countersClient,
  countersConfigured,
  normalizeEnvValue,
  tenancyClient,
} from '../lib/upstash';

/*
 * Pins the env-value paste-mistake tolerance added after a verified
 * eight-night failure: a workflow step that pings each Upstash REST URL and
 * prints only the first 8 hostname characters found that the CACHE
 * database's UPSTASH_CACHE_REST_URL GitHub Actions secret VALUE began with
 * the literal text `UPSTASH_` — someone pasted a whole
 * `UPSTASH_CACHE_REST_URL=https://…` env line (or the bare variable name) as
 * the secret's value. Every cache request from the nightly pregen then
 * failed with status 0, and pregen paid for scripts it could never store.
 *
 * Two layers pinned here:
 *   1. normalizeEnvValue — the pure cleanup helper, tested directly.
 *   2. The client constructors (countersClient/cacheClient/tenancyClient) —
 *      tested end to end against real env vars, including the ONE-warning-
 *      per-process dedup and the https:// requirement.
 *
 * No live Upstash token exists anywhere in this environment, by design
 * (tests/upstash-mock.ts's header comment) — every case below sets env vars
 * to strings only, and the URL-shaped ones never resolve to a live host
 * within any assertion that would need to (a client is CONSTRUCTED, never
 * asked to actually cmd() against these fixture values).
 */

const ENV_VARS = [
  'UPSTASH_COUNTERS_REST_URL',
  'UPSTASH_COUNTERS_REST_TOKEN',
  'UPSTASH_CACHE_REST_URL',
  'UPSTASH_CACHE_REST_TOKEN',
  'UPSTASH_TENANCY_REST_URL',
  'UPSTASH_TENANCY_REST_TOKEN',
] as const;

function clearUpstashEnv(): void {
  for (const name of ENV_VARS) delete process.env[name];
}

test.describe.configure({ mode: 'serial' }); // shared process env + console spies

test.afterEach(() => {
  clearUpstashEnv();
  __resetUpstashEnvWarningsForTests();
});

// --- normalizeEnvValue: the pure helper ------------------------------------

test.describe('normalizeEnvValue', () => {
  test('passes a clean value through untouched', () => {
    const result = normalizeEnvValue('UPSTASH_CACHE_REST_URL', 'https://cache.example.upstash.io');
    expect(result).toEqual({
      value: 'https://cache.example.upstash.io',
      strippedQuotes: false,
      strippedPrefix: false,
    });
  });

  test('strips a `NAME=value` prefix — the whole-env-line paste mistake', () => {
    const result = normalizeEnvValue(
      'UPSTASH_CACHE_REST_URL',
      'UPSTASH_CACHE_REST_URL=https://cache.example.upstash.io'
    );
    expect(result.value).toBe('https://cache.example.upstash.io');
    expect(result.strippedPrefix).toBe(true);
  });

  test('strips a `NAME=value` prefix for the token variable too', () => {
    const result = normalizeEnvValue('UPSTASH_CACHE_REST_TOKEN', 'UPSTASH_CACHE_REST_TOKEN=abc123secret');
    expect(result.value).toBe('abc123secret');
    expect(result.strippedPrefix).toBe(true);
  });

  test('strips one layer of surrounding double quotes', () => {
    const result = normalizeEnvValue('UPSTASH_CACHE_REST_TOKEN', '"abc123secret"');
    expect(result.value).toBe('abc123secret');
    expect(result.strippedQuotes).toBe(true);
    expect(result.strippedPrefix).toBe(false);
  });

  test('strips one layer of surrounding single quotes', () => {
    const result = normalizeEnvValue('UPSTASH_CACHE_REST_TOKEN', "'abc123secret'");
    expect(result.value).toBe('abc123secret');
    expect(result.strippedQuotes).toBe(true);
  });

  test('strips surrounding quotes AND a `NAME=value` prefix together', () => {
    const result = normalizeEnvValue(
      'UPSTASH_CACHE_REST_URL',
      '"UPSTASH_CACHE_REST_URL=https://cache.example.upstash.io"'
    );
    expect(result.value).toBe('https://cache.example.upstash.io');
    expect(result.strippedQuotes).toBe(true);
    expect(result.strippedPrefix).toBe(true);
  });

  test('strips quotes wrapped around the value AFTER the prefix (NAME="value")', () => {
    const result = normalizeEnvValue(
      'UPSTASH_CACHE_REST_URL',
      'UPSTASH_CACHE_REST_URL="https://cache.example.upstash.io"'
    );
    expect(result.value).toBe('https://cache.example.upstash.io');
    expect(result.strippedQuotes).toBe(true);
    expect(result.strippedPrefix).toBe(true);
  });

  test('trims surrounding whitespace without flagging anything', () => {
    const result = normalizeEnvValue('UPSTASH_CACHE_REST_URL', '  https://cache.example.upstash.io  \n');
    expect(result).toEqual({
      value: 'https://cache.example.upstash.io',
      strippedQuotes: false,
      strippedPrefix: false,
    });
  });

  test('returns null for an absent value', () => {
    const result = normalizeEnvValue('UPSTASH_CACHE_REST_URL', undefined);
    expect(result).toEqual({ value: null, strippedQuotes: false, strippedPrefix: false });
  });

  test('returns null for an empty/whitespace-only value', () => {
    expect(normalizeEnvValue('UPSTASH_CACHE_REST_URL', '').value).toBeNull();
    expect(normalizeEnvValue('UPSTASH_CACHE_REST_URL', '   ').value).toBeNull();
  });

  test('returns null when the value is JUST the bare variable name with nothing after "="', () => {
    const result = normalizeEnvValue('UPSTASH_CACHE_REST_URL', 'UPSTASH_CACHE_REST_URL=');
    expect(result.value).toBeNull();
    expect(result.strippedPrefix).toBe(true);
  });

  test('does not strip a prefix belonging to a DIFFERENT variable name', () => {
    // The literal failure mode this repo hit: the CACHE secret's value
    // begins with `UPSTASH_` but is the wrong variable's name entirely —
    // normalizeEnvValue must not guess at a different name's prefix.
    const result = normalizeEnvValue(
      'UPSTASH_CACHE_REST_URL',
      'UPSTASH_TENANCY_REST_URL=https://tenancy.example.upstash.io'
    );
    expect(result.strippedPrefix).toBe(false);
    expect(result.value).toBe('UPSTASH_TENANCY_REST_URL=https://tenancy.example.upstash.io');
  });
});

// --- client constructors: end-to-end through the env + warning seam --------

test.describe('countersClient / cacheClient / tenancyClient env tolerance', () => {
  test('a clean https:// URL and plain token configure the client', () => {
    process.env.UPSTASH_COUNTERS_REST_URL = 'https://counters.example.upstash.io';
    process.env.UPSTASH_COUNTERS_REST_TOKEN = 'plain-token';
    expect(countersClient()).not.toBeNull();
    expect(countersConfigured()).toBe(true);
  });

  test('a `NAME=value`-pasted URL still configures the client, with exactly one warning', () => {
    process.env.UPSTASH_CACHE_REST_URL = 'UPSTASH_CACHE_REST_URL=https://cache.example.upstash.io';
    process.env.UPSTASH_CACHE_REST_TOKEN = 'plain-token';
    const warnings: string[] = [];
    const restore = console.warn;
    console.warn = (msg: string) => warnings.push(String(msg));
    try {
      expect(cacheClient()).not.toBeNull();
      cacheClient(); // called again — must not warn a second time
      cacheClient();
    } finally {
      console.warn = restore;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('UPSTASH_CACHE_REST_URL');
    expect(warnings[0]).toContain("NAME=value");
    // Never the value.
    expect(warnings[0]).not.toContain('cache.example.upstash.io');
  });

  test('a quoted token still configures the client, with exactly one warning naming the variable', () => {
    process.env.UPSTASH_CACHE_REST_URL = 'https://cache.example.upstash.io';
    process.env.UPSTASH_CACHE_REST_TOKEN = '"super-secret-token"';
    const warnings: string[] = [];
    const restore = console.warn;
    console.warn = (msg: string) => warnings.push(String(msg));
    try {
      expect(cacheClient()).not.toBeNull();
    } finally {
      console.warn = restore;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('UPSTASH_CACHE_REST_TOKEN');
    expect(warnings[0]).not.toContain('super-secret-token');
  });

  test('an empty (whitespace-only) URL is treated as unconfigured, no warning', () => {
    process.env.UPSTASH_TENANCY_REST_URL = '   ';
    process.env.UPSTASH_TENANCY_REST_TOKEN = 'plain-token';
    const warnings: string[] = [];
    const restore = console.warn;
    console.warn = (msg: string) => warnings.push(String(msg));
    try {
      expect(tenancyClient()).toBeNull();
    } finally {
      console.warn = restore;
    }
    expect(warnings).toHaveLength(0);
  });

  test('a non-https URL is treated as not configured, logging only the variable name', () => {
    process.env.UPSTASH_CACHE_REST_URL = 'http://cache.example.upstash.io'; // real host, wrong scheme
    process.env.UPSTASH_CACHE_REST_TOKEN = 'plain-token';
    const errors: string[] = [];
    const restore = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    try {
      expect(cacheClient()).toBeNull();
    } finally {
      console.error = restore;
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('UPSTASH_CACHE_REST_URL');
    expect(errors[0]).not.toContain('cache.example.upstash.io');
  });

  test('a bare variable-name-only paste (no "=value" at all) is treated as not configured', () => {
    // The exact real-world failure: the secret's value IS the literal text
    // `UPSTASH_CACHE_REST_URL` (name pasted with nothing else), which after
    // normalization has no https:// left to validate.
    process.env.UPSTASH_CACHE_REST_URL = 'UPSTASH_CACHE_REST_URL';
    process.env.UPSTASH_CACHE_REST_TOKEN = 'plain-token';
    expect(cacheClient()).toBeNull();
  });

  test('the sanctioned e2e-server.mjs loopback exception (http://127.0.0.1) still configures tenancyClient', () => {
    process.env.UPSTASH_TENANCY_REST_URL = 'http://127.0.0.1:54321';
    process.env.UPSTASH_TENANCY_REST_TOKEN = 'e2e-fixture-token';
    expect(tenancyClient()).not.toBeNull();
  });
});
