import { expect, test } from '@playwright/test';
// Relative import of the plain .mjs module - same pattern as
// tests/urgency.unit.spec.ts importing lib/urgency.mjs: the logic tested
// here is exactly what the nightly workflow runs.
import { assessSalt } from '../lib/salt.mjs';

/*
 * Pins the salt-age dead-man's-switch (S11, F5): the verifier must FIRE on
 * every rotation-failure shape - silence here is the exact disease the
 * repo's verifier convention exists to cure. assessSalt (lib/salt.mjs) is
 * the pure core of scripts/verify-salt.mjs; sync-bills.yml runs it nightly
 * against the live counters database.
 */

const NOW = Date.parse('2026-07-06T12:00:00Z');
const HOURS = 60 * 60 * 1000;

function record(overrides: { v?: string; t?: string } = {}): string {
  return JSON.stringify({
    v: 'a'.repeat(32), // 32 hex chars = the 128-bit floor
    t: new Date(NOW - 2 * HOURS).toISOString(),
    ...overrides,
  });
}

type Assessment = { ok: boolean; problems: string[] };
const assess = assessSalt as (input: {
  record: string | null;
  ttlSeconds: number;
  now?: number;
}) => Assessment;

test('a healthy salt passes: fresh, 128-bit hex, TTL under 24h', () => {
  const result = assess({ record: record(), ttlSeconds: 79_200, now: NOW });
  expect(result.ok).toBe(true);
  expect(result.problems).toEqual([]);
});

test('no salt at all passes (created lazily on first traffic after rotation)', () => {
  const result = assess({ record: null, ttlSeconds: -2, now: NOW });
  expect(result.ok).toBe(true);
});

test('FIRES on the forced-stale fixture: a 26h-old salt means rotation failed', () => {
  const stale = record({ t: new Date(NOW - 26 * HOURS).toISOString() });
  const result = assess({ record: stale, ttlSeconds: 3600, now: NOW });
  expect(result.ok).toBe(false);
  expect(result.problems.join('\n')).toMatch(/rotation has FAILED/);
});

test('FIRES on a TTL-less salt key: pseudonyms would never rotate again', () => {
  const result = assess({ record: record(), ttlSeconds: -1, now: NOW });
  expect(result.ok).toBe(false);
  expect(result.problems.join('\n')).toMatch(/NO TTL/);
});

test('FIRES on a sub-128-bit or non-hex salt value (F5 floor)', () => {
  const short = assess({ record: record({ v: 'abc123' }), ttlSeconds: 3600, now: NOW });
  expect(short.ok).toBe(false);
  expect(short.problems.join('\n')).toMatch(/128 bits/);

  const nonHex = assess({ record: record({ v: 'Z'.repeat(32) }), ttlSeconds: 3600, now: NOW });
  expect(nonHex.ok).toBe(false);
});

test('FIRES on corruption: non-JSON records, missing/garbled timestamps, future timestamps, over-long TTLs', () => {
  expect(assess({ record: 'not-json-at-all', ttlSeconds: 3600, now: NOW }).ok).toBe(false);
  expect(assess({ record: record({ t: 'garbage' }), ttlSeconds: 3600, now: NOW }).ok).toBe(false);
  expect(
    assess({ record: record({ t: new Date(NOW + 3 * HOURS).toISOString() }), ttlSeconds: 3600, now: NOW }).ok
  ).toBe(false);
  expect(assess({ record: record(), ttlSeconds: 90_000, now: NOW }).ok).toBe(false);
});
