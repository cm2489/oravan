import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/*
 * F7 (S21): "Pre-generation authenticates via build-time secret or direct
 * Upstash write — never a public request flag; an unauthenticated pregen
 * marker is rejected loudly and rate-limited normally, not silently
 * honored" (strategy §9.1(d) ledger item 7 / §1.3 S21).
 *
 * The strongest version of that guarantee isn't "a pregen flag exists and
 * gets correctly rejected" — it's that no such flag exists to present in
 * the first place. scripts/pregen-scripts.mjs never calls /api/script; it
 * writes straight into the cache database with build-time secrets
 * (lib/scriptcache.ts, same registry the route uses). This grep-level test
 * pins that the route stays completely unaware pregen exists — a future
 * edit that adds ANY pregen-shaped special-casing here (a header, a query
 * param, a body field, an env check) fails CI immediately, before it can
 * become a free rate-limit bypass or an unauthenticated Sonnet-spend
 * trigger.
 */

const ROUTE_PATH = join(process.cwd(), 'app/api/script/route.ts');

test('F7: app/api/script/route.ts has zero pregen-awareness', () => {
  const source = readFileSync(ROUTE_PATH, 'utf8');
  expect(source).not.toMatch(/pregen/i);
});

test('F7 sanity: the route still handles its normal recognized header (x-oravan-key) unrelated to pregen', () => {
  // Guards against the first test passing only because the whole route (or
  // its dormant-hook line) got deleted rather than because it's clean.
  const source = readFileSync(ROUTE_PATH, 'utf8');
  expect(source).toMatch(/readOravanKey/);
  expect(source).toMatch(/anthropic\.messages\.create/);
});
