import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { expect, test } from '@playwright/test';
import { NextRequest } from 'next/server';
// Relative imports (not '@/'), as in tests/brand-off.unit.spec.ts: the route
// loads in a unit spec, because the installed @anthropic-ai/sdk ships a
// CommonJS build and `new Anthropic()` does not throw without a key.
import { POST } from '../app/api/script/route';
import { billSlug, getAllBills, getBill } from '../lib/core/bills';
import { getAllNominations, nominationSlug } from '../lib/core/nominations';
import { lastFailedVote, liveCallTargetForNomination, settledDecision } from '../lib/journey';
import { parsePregen } from '../lib/pipeline-health.mjs';
import { planCombos } from '../lib/pregen';
import { main, type AnthropicLike } from '../lib/pregen-runner';
import type { ScriptCache } from '../lib/scriptcache';
import { STANCES } from '../lib/scriptprompt';
import type { Bill } from '../lib/types';

/*
 * /api/script REFUSES A BILL WITH NO DECISION LEFT (2026-09-29).
 *
 * Page 1, rule 6: "a settled decision shows no call apparatus". The bill page
 * has honoured it since 2026-09-28 by reading `settledDecision` (lib/journey.ts)
 * and showing the record-only panel instead of the call panel. The route did
 * not read it, so a direct request still spent a model call writing a call
 * script for H.Con.Res. 86 or a signed law. It now answers 409 `settled`
 * before the cache and before any spend, and the nightly warmer (lib/pregen.ts
 * planCombos) never plans such a bill.
 *
 * Driven on the REAL handler. The instruments:
 *   - the model: Anthropic.Messages.prototype.create is replaced with a
 *     recorder that THROWS, so even a broken gate cannot spend. A request that
 *     gets past every check therefore ends in 502 `generation_failed` with
 *     exactly one recorded call — the decisive "it proceeds" signal, the same
 *     one tests/embed-script-route.spec.ts uses against the running server;
 *   - the network: globalThis.fetch is replaced with a recorder that throws.
 *     ANTHROPIC_API_KEY and every UPSTASH_* variable are removed for the
 *     file's lifetime, so the limiters, the daily breaker and the cache run on
 *     their in-memory fallbacks and nothing here can reach a real service.
 *
 * The "proceeds" tests are what prove the model instrument sees its step;
 * without them a zero count on a refusal could mean an instrument that
 * watches nothing.
 */

const realCreate = Anthropic.Messages.prototype.create;
const realFetch = globalThis.fetch;
let savedEnv: Record<string, string | undefined> = {};
let modelCalls = 0;
let fetchCalls: string[] = [];

test.beforeAll(() => {
  savedEnv = {};
  for (const name of Object.keys(process.env)) {
    if (name === 'ANTHROPIC_API_KEY' || name.startsWith('UPSTASH_')) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  }
});

test.afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[name] = value;
  }
});

test.beforeEach(() => {
  modelCalls = 0;
  Anthropic.Messages.prototype.create = function blockedCreate() {
    modelCalls += 1;
    throw new Error('blocked in unit test');
  } as typeof realCreate;
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input instanceof Request ? input.url : input));
    throw new Error('blocked in unit test');
  }) as typeof fetch;
});

test.afterEach(() => {
  Anthropic.Messages.prototype.create = realCreate;
  globalThis.fetch = realFetch;
});

// A distinct caller per request (TEST-NET-3, 203.0.113.0/24, then onward), so
// the per-caller limiter's 20-per-10-minutes never trips inside this file.
let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `203.0.${113 + Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

function post(slug: string, stance: string = 'support', locale: 'en' | 'es' = 'en') {
  return POST(
    new NextRequest('http://localhost/api/script', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ slug, stance, locale }),
    })
  );
}

function bill(slug: string): Bill {
  const b = getBill(slug);
  expect(b, `${slug} is in the committed corpus`).toBeTruthy();
  return b!;
}

/* ------------------------------------------------------------------ *
 * 1 · Settled bills: 409, and nothing is spent.
 * ------------------------------------------------------------------ */

test('H.Con.Res. 86 (adopted by both chambers) → 409 settled, for every stance and both languages, with no model call', async () => {
  const hconres86 = bill('hconres-86-119');
  expect(settledDecision(hconres86), 'precondition: the page reads it as adopted').toEqual({
    kind: 'adopted',
    chamber: 'senate',
  });
  for (const stance of STANCES) {
    for (const locale of ['en', 'es'] as const) {
      const res = await post('hconres-86-119', stance, locale);
      expect(res.status, `${stance}/${locale}`).toBe(409);
      expect(await res.json()).toEqual({ error: 'settled' });
    }
  }
  expect(modelCalls, 'no model call for a settled bill').toBe(0);
  expect(fetchCalls, 'no network request of any kind').toEqual([]);
});

test('a signed law (H.R. 1, Public Law 119-21) → 409 settled, with no model call', async () => {
  const hr1 = bill('hr-1-119');
  expect(hr1.status, 'precondition: signed').toBe('signed');
  expect(settledDecision(hr1), 'precondition: the page reads it as law').toEqual({ kind: 'law' });
  const res = await post('hr-1-119', 'oppose');
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: 'settled' });
  expect(modelCalls).toBe(0);
  expect(fetchCalls).toEqual([]);
});

test('every bill the page calls settled is refused by the route — over the whole committed corpus', async () => {
  const settled = getAllBills().filter((b) => settledDecision(b) !== null);
  // Non-vacuity: on 2026-09-29 this was 91 laws, 9 failed final votes and one
  // adopted concurrent resolution. A range, not a pin: the corpus moves.
  expect(settled.length, 'the corpus holds settled bills to check').toBeGreaterThan(10);
  const kinds = new Set(settled.map((b) => settledDecision(b)!.kind));
  expect(kinds.has('law') && kinds.has('rejected'), 'laws and failed final votes both present').toBe(true);
  for (const b of settled) {
    const res = await post(billSlug(b));
    expect(res.status, billSlug(b)).toBe(409);
  }
  expect(modelCalls).toBe(0);
  expect(fetchCalls).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * 2 · Open decisions still get their script.
 * ------------------------------------------------------------------ */

test('an open bill proceeds past the gate to the model call (502 here only because the stub throws)', async () => {
  const open = getAllBills().find(
    (b) => b.status === 'committee' && b.ai_summary && settledDecision(b) === null && lastFailedVote(b) === null
  );
  expect(open, 'the corpus holds an open, decoded committee-stage bill').toBeTruthy();
  const res = await post(billSlug(open!));
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: 'generation_failed' });
  expect(modelCalls, 'the request reached the model exactly once').toBe(1);
  expect(fetchCalls, 'and nothing else touched the network').toEqual([]);
});

test("S.J.Res. 185 (a failed motion to proceed) proceeds — owner's pick (a) keeps the call on a procedural failure", async () => {
  const sjres185 = bill('sjres-185-119');
  expect(settledDecision(sjres185), 'precondition: not settled').toBeNull();
  expect(lastFailedVote(sjres185)?.procedure, 'precondition: its last floor vote was a failed motion to proceed').toBe(
    'proceed'
  );
  const res = await post('sjres-185-119', 'undecided', 'es');
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: 'generation_failed' });
  expect(modelCalls).toBe(1);
});

/* ------------------------------------------------------------------ *
 * 3 · The nomination path already had its own refusal, and is unchanged.
 * ------------------------------------------------------------------ */

test('nomination path unchanged: a confirmed and a withdrawn nomination still answer 422 not_callable, with no model call', async () => {
  const all = getAllNominations();
  for (const status of ['confirmed', 'withdrawn'] as const) {
    const n = all.find((x) => x.status === status && x.nominee_description);
    expect(n, `the corpus holds a ${status} nomination with a description`).toBeTruthy();
    expect(liveCallTargetForNomination(n!), `precondition: ${status} routes nowhere`).toBeNull();
    const res = await post(nominationSlug(n!));
    expect(res.status, status).toBe(422);
    expect(await res.json()).toEqual({ error: 'not_callable' });
  }
  expect(modelCalls).toBe(0);
});

/* ------------------------------------------------------------------ *
 * 4 · WHERE the gate sits: after input validation, before the cache.
 *
 * Behaviour above cannot show ordering against the cache — with the cache
 * database absent, a read costs nothing observable — so this is asserted over
 * the route's source, the way tests/script-spend-guard.unit.spec.ts pins the
 * breaker's position. Each anchor is checked first, so a rename fails loudly
 * rather than passing vacuously.
 * ------------------------------------------------------------------ */

test('the settled gate is the first thing in the bill path: after validation, before the content version and serveScript', () => {
  const src = readFileSync(join(process.cwd(), 'app/api/script/route.ts'), 'utf8');
  const validation = src.indexOf('if (!slug || !stance || !STANCES.includes(stance)) {');
  const billPath = src.indexOf('  if (bill) {\n');
  const gate = src.indexOf('if (settledDecision(bill)) {');
  const refusal = src.indexOf("return NextResponse.json({ error: 'settled' }, { status: 409 });");
  const version = src.indexOf('const version = contentVersion(bill);');
  const serve = src.indexOf('return serveScript(', billPath);
  const cacheRead = src.indexOf('const cached = await cache.get(key);');
  for (const [name, at] of Object.entries({ validation, billPath, gate, refusal, version, serve, cacheRead })) {
    expect(at, `anchor: ${name}`).toBeGreaterThan(-1);
  }
  expect(validation, 'input validation runs first').toBeLessThan(billPath);
  expect(billPath).toBeLessThan(gate);
  expect(gate).toBeLessThan(refusal);
  expect(refusal, 'refused before the content version is computed').toBeLessThan(version);
  expect(version).toBeLessThan(serve);
  // serveScript (the cache read, the breaker, the model call) is defined
  // below POST; the bill path reaches it only through the call above.
  expect(serve).toBeLessThan(cacheRead);
  expect(src.split("{ error: 'settled' }").length - 1, 'exactly one settled refusal').toBe(1);
});

/* ------------------------------------------------------------------ *
 * 5 · The nightly warmer never plans a settled bill.
 * ------------------------------------------------------------------ */

test('planCombos plans nothing for a settled bill, and everything for an open one', () => {
  const settled = [bill('hconres-86-119'), bill('hr-1-119')];
  const open = [bill('sjres-185-119')];
  const combos = planCombos([...settled, ...open], STANCES, ['en', 'es']);
  expect(new Set(combos.map((c) => c.slug))).toEqual(new Set(['sjres-185-119']));
  expect(combos).toHaveLength(STANCES.length * 2);
  expect(planCombos(settled, STANCES, ['en', 'es'])).toEqual([]);
});

test('the nightly run submits no batch request for a settled bill, and submits nothing at all when every bill is settled', async () => {
  const requests: { custom_id: string }[][] = [];
  const anthropic: AnthropicLike = {
    messages: {
      batches: {
        async create(body) {
          requests.push(body.requests as { custom_id: string }[]);
          return { id: 'batch_1', processing_status: 'ended' };
        },
        async retrieve(id) {
          return { id, processing_status: 'ended' };
        },
        async results() {
          const rows = requests[requests.length - 1];
          async function* gen() {
            for (const r of rows) {
              yield {
                custom_id: r.custom_id,
                result: { type: 'succeeded' as const, message: { content: [{ type: 'text', text: 'SCRIPT' }] } },
              };
            }
          }
          return gen();
        },
      },
    },
  };
  // A durable-looking cache: every read misses, every write "reaches the
  // database", so the run's dead-cache guard stays out of the way.
  const cache: ScriptCache = { get: async () => null, set: async () => true };
  const probe = async () => ({ configured: true, reachable: true, status: null });

  const logged: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  let mixed: Awaited<ReturnType<typeof main>>;
  try {
    mixed = await main({
      anthropic,
      cache,
      probe,
      getBills: () => [bill('hconres-86-119'), bill('hr-1-119'), bill('sjres-185-119')],
      sleep: async () => {},
      dryRun: false,
    });
  } finally {
    console.log = realLog;
  }
  expect(requests).toHaveLength(1);
  expect(requests[0].map((r) => r.custom_id.split('--')[0])).toEqual(
    Array(STANCES.length * 2).fill('sjres-185-119')
  );
  expect(mixed.planned).toBe(STANCES.length * 2);
  // The skip is said in the log, as a SUFFIX, so the nightly digest's parser
  // (lib/pipeline-health.mjs parsePregen) still reads the plan line.
  expect(logged.join('\n')).toContain('(2 settled bill(s) skipped: no decision left)');
  const parsed = parsePregen(logged.join('\n'));
  expect(parsed.topBills).toBe(3);
  expect(parsed.combos).toBe(STANCES.length * 2);
  expect(parsed.toGenerate).toBe(STANCES.length * 2);

  const allSettled = await main({
    anthropic,
    cache,
    probe,
    getBills: () => [bill('hconres-86-119'), bill('hr-1-119')],
    sleep: async () => {},
    dryRun: false,
  });
  expect(requests, 'no second batch was submitted').toHaveLength(1);
  expect(allSettled.planned).toBe(0);
});
