import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): plain lib modules resolve under the test
// runner — same pattern as the other unit specs.
import { counterKey, createTenantRateLimiter } from '../lib/ratelimit';
import {
  createFillCoordinator,
  FILL_COOLDOWNS_MS,
  RECENT_FILL_MS,
  serveStanceBlind,
  type FillCoordinator,
  type ServeDeps,
  type ServeOutcome,
} from '../lib/script-serve';
import { createScriptCache, scriptKey } from '../lib/scriptcache';
import { STANCES } from '../lib/scriptprompt';
import type { Stance } from '../lib/types';
import {
  noteScriptGeneration,
  noteScriptRefusal,
  noteScriptServed,
  scriptRefusalUsageKey,
  scriptServedUsageKey,
  scriptUsageKey,
  usageDayKey,
} from '../lib/usage';
import { CACHE_URL, COUNTERS_URL, MockUpstash, installUpstashFetch, setUpstashEnv } from './upstash-mock';

/*
 * THE STANCE-BLIND SCRIPT PATH (owner's pick, 2026-11-24, "Option 1").
 *
 * The property under test: a caller who asks for SUPPORT and a caller who
 * asks for OPPOSE on the same bill, against the same cache state, send
 * BYTE-IDENTICAL requests to the script cache database — and to the counters
 * database, and the same set of drafts to the model. Upstash runs both
 * databases and receives the caller's salted hash in the counters database
 * milliseconds before the cache request, so anything that differed by stance
 * would let the provider pair a caller with a position.
 *
 * Driven through lib/script-serve.ts (the order of operations the route
 * runs) with the REAL cache module, the REAL fail-closed daily breaker and
 * the REAL day counts, each against tests/upstash-mock.ts; only the model is
 * a fake. The route's wiring of those same pieces is pinned at the bottom.
 */

test.describe.configure({ mode: 'serial' }); // shared env + global-fetch swaps

const SET = { slug: 'hr-1234-119', lang: 'en' as const, version: 'abcdef012345' };
const DAY = usageDayKey();

let restoreEnv: (() => void) | null = null;
test.beforeEach(() => {
  restoreEnv = setUpstashEnv();
});
test.afterEach(() => {
  restoreEnv?.();
  restoreEnv = null;
});

interface Run {
  outcome: ServeOutcome;
  cacheWire: Array<{ path: string; body: string }>;
  countersWire: Array<{ path: string; body: string }>;
  drafted: Stance[];
  cacheDb: MockUpstash;
  countersDb: MockUpstash;
  /** How many tasks were deferred (after() in the route). */
  deferredCount: number;
}

/** One request, on fresh databases holding `preload`, with every deferred task run afterwards. */
async function run(
  stance: Stance,
  opts: { preload?: Partial<Record<Stance, string>>; fail?: Stance[]; dayMax?: number; countersDown?: boolean } = {}
): Promise<Run> {
  const cacheDb = new MockUpstash();
  const countersDb = new MockUpstash();
  if (opts.countersDown) countersDb.failWithStatus = 503;
  // Preloaded straight into the store, so the wire records only this request.
  for (const [s, script] of Object.entries(opts.preload ?? {})) {
    cacheDb.store.set(scriptKey({ ...SET, stance: s }), { value: script as string, expiresAt: null });
  }
  const restoreFetch = installUpstashFetch({ [CACHE_URL]: cacheDb, [COUNTERS_URL]: countersDb });
  const drafted: Stance[] = [];
  const deferred: Array<() => Promise<void>> = [];
  const breaker = createTenantRateLimiter({
    route: 'script-day',
    max: opts.dayMax ?? 1_800,
    windowSec: 86_400,
    failClosed: true,
  });
  const realError = console.error;
  if (opts.countersDown) console.error = () => {};
  try {
    const outcome = await serveStanceBlind(SET, stance, {
      cache: createScriptCache(),
      takeGenerationUnit: () => breaker.isLimited('script-global'),
      generate: async (s) => {
        drafted.push(s);
        if (opts.fail?.includes(s)) throw new Error('model failed');
        return `DRAFT ${s}`;
      },
      defer: (task) => {
        deferred.push(task);
      },
      note: realNotes,
      // A fresh coordinator per request: these runs compare stances against
      // the SAME starting state, so no cooldown may carry from one to the next.
      fills: createFillCoordinator(),
      logFailure: () => {},
    });
    for (const task of deferred) await task();
    return {
      outcome,
      cacheWire: cacheDb.requests,
      countersWire: countersDb.requests,
      drafted,
      cacheDb,
      countersDb,
      deferredCount: deferred.length,
    };
  } finally {
    console.error = realError;
    restoreFetch();
  }
}

const realNotes: ServeDeps['note'] = {
  served: () => noteScriptServed(),
  generated: () => noteScriptGeneration(),
  refusedDaily: () => noteScriptRefusal('daily'),
};

/** A counters value, or 0. */
function count(db: MockUpstash, key: string): number {
  return Number(db.store.get(key)?.value ?? 0);
}

/** Run every stance against the same starting state; return the runs by stance. */
async function everyStance(
  opts: Parameters<typeof run>[1] = {}
): Promise<Record<Stance, Run>> {
  const out = {} as Record<Stance, Run>;
  for (const s of STANCES) out[s] = await run(s, opts);
  return out;
}

function expectSameWire(runs: Record<Stance, Run>) {
  const [first, ...rest] = STANCES;
  for (const s of rest) {
    expect(runs[s].cacheWire, `${s} vs ${first}: cache database bytes`).toEqual(runs[first].cacheWire);
    expect(runs[s].countersWire, `${s} vs ${first}: counters database bytes`).toEqual(
      runs[first].countersWire
    );
    expect(runs[s].drafted, `${s} vs ${first}: drafts sent to the model`).toEqual(runs[first].drafted);
  }
}

/* ------------------------------------------------------------------ *
 * 1 · The pinned property, in every cache state that matters.
 * ------------------------------------------------------------------ */

test('a cold bill: support and oppose (and undecided) send byte-identical requests to the script cache', async () => {
  const runs = await everyStance();
  expectSameWire(runs);

  // What those identical bytes are: one MGET of all three, one transaction of all three.
  const wire = runs.support.cacheWire;
  expect(wire.map((r) => r.path)).toEqual(['', '/multi-exec']);
  expect(JSON.parse(wire[0].body)).toEqual(['MGET', ...STANCES.map((s) => scriptKey({ ...SET, stance: s }))]);
  expect(JSON.parse(wire[1].body)).toEqual(
    STANCES.map((s) => ['SET', scriptKey({ ...SET, stance: s }), `DRAFT ${s}`, 'EX', '86400'])
  );
  expect(runs.support.drafted, 'every stance drafted, in the fixed order').toEqual(STANCES);

  // Each caller still gets their OWN script.
  for (const s of STANCES) {
    expect(runs[s].outcome).toEqual({ kind: 'script', script: `DRAFT ${s}`, cached: false });
  }
});

test('a warm bill: one MGET and nothing else, the same for every stance', async () => {
  const preload = { support: 'S', oppose: 'O', undecided: 'U' };
  const runs = await everyStance({ preload });
  expectSameWire(runs);
  expect(runs.oppose.cacheWire.map((r) => r.path)).toEqual(['']);
  expect(runs.oppose.drafted).toEqual([]);
  expect(runs.oppose.outcome).toEqual({ kind: 'script', script: 'O', cached: true });
});

test("a half-warm bill: the caller whose script is cached and the caller whose is not send the same bytes; the missing stances are drafted for both", async () => {
  // Only `support` is stored — e.g. a draft that failed earlier, or keys that
  // expired a second apart. A support caller is a hit, an oppose caller a miss.
  const runs = await everyStance({ preload: { support: 'S' } });
  expectSameWire(runs);
  expect(runs.support.drafted).toEqual(['oppose', 'undecided']);
  expect(JSON.parse(runs.support.cacheWire[1].body)).toEqual(
    (['oppose', 'undecided'] as const).map((s) => ['SET', scriptKey({ ...SET, stance: s }), `DRAFT ${s}`, 'EX', '86400'])
  );
  // The hit is answered from the cache, the miss with its draft; both only
  // once the fill has ended (fourth check of #554, B1: see section 2b).
  expect(runs.support.outcome).toEqual({ kind: 'script', script: 'S', cached: true });
  expect(runs.oppose.outcome).toEqual({ kind: 'script', script: 'DRAFT oppose', cached: false });
});

test('partial failure: one draft fails — the write and the counts still do not depend on who asked', async () => {
  const runs = await everyStance({ fail: ['oppose'] });
  expectSameWire(runs);
  // The drafts that came back are stored, in one write; the failed one is not.
  expect(JSON.parse(runs.support.cacheWire[1].body)).toEqual(
    (['support', 'undecided'] as const).map((s) => ['SET', scriptKey({ ...SET, stance: s }), `DRAFT ${s}`, 'EX', '86400'])
  );
  expect(runs.support.outcome).toEqual({ kind: 'script', script: 'DRAFT support', cached: false });
  expect(runs.oppose.outcome).toEqual({ kind: 'generation-failed' });
  // Two real spends counted; the served count is NOT ticked for anyone — if it
  // ticked only for the callers who got a script, it would say who did not.
  const db = runs.support.countersDb;
  expect(count(db, scriptUsageKey(DAY))).toBe(2);
  expect(count(db, scriptServedUsageKey(DAY))).toBe(0);
});

test('every draft fails: no cache write at all, a 502 for whoever was missing, identical wire', async () => {
  const runs = await everyStance({ fail: [...STANCES] });
  expectSameWire(runs);
  expect(runs.support.cacheWire.map((r) => r.path)).toEqual(['']);
  for (const s of STANCES) expect(runs[s].outcome).toEqual({ kind: 'generation-failed' });
});

/* ------------------------------------------------------------------ *
 * 2 · The daily spend breaker: one unit per draft, all or nothing.
 * ------------------------------------------------------------------ */

test('a cold bill takes three breaker units — one per stance drafted — and a warm bill takes none', async () => {
  const cold = await run('support');
  expect(count(cold.countersDb, counterKey('script-day', 'script-global'))).toBe(3);
  expect(count(cold.countersDb, scriptUsageKey(DAY)), 'three real generations counted').toBe(3);
  expect(count(cold.countersDb, scriptServedUsageKey(DAY))).toBe(1);

  const warm = await run('support', { preload: { support: 'S', oppose: 'O', undecided: 'U' } });
  expect(count(warm.countersDb, counterKey('script-day', 'script-global')), 'a hit never consumes the breaker').toBe(0);
  expect(count(warm.countersDb, scriptServedUsageKey(DAY))).toBe(1);
});

test('when the breaker cannot cover every missing stance, nothing is drafted — and the caller with a cached script is still answered', async () => {
  // Ceiling 2, three stances missing: all or nothing, so no model call at all.
  const cold = await everyStance({ dayMax: 2 });
  expectSameWire(cold);
  expect(cold.support.drafted).toEqual([]);
  expect(cold.support.cacheWire.map((r) => r.path), 'no write').toEqual(['']);
  for (const s of STANCES) expect(cold[s].outcome).toEqual({ kind: 'daily-limited' });
  expect(count(cold.support.countersDb, scriptRefusalUsageKey('daily', DAY))).toBe(1);
  expect(count(cold.support.countersDb, scriptServedUsageKey(DAY))).toBe(0);

  // Half-warm with the breaker shut: the support caller still gets the stored
  // script; the refusal is counted for BOTH callers, so the counters wire
  // cannot tell them apart either.
  const half = await everyStance({ preload: { support: 'S' }, dayMax: 1 });
  expectSameWire(half);
  expect(half.support.outcome).toEqual({ kind: 'script', script: 'S', cached: true });
  expect(half.oppose.outcome).toEqual({ kind: 'daily-limited' });
  expect(count(half.support.countersDb, scriptRefusalUsageKey('daily', DAY))).toBe(1);
  expect(count(half.oppose.countersDb, scriptRefusalUsageKey('daily', DAY))).toBe(1);
});

test('an unreachable counters database refuses the drafting (fail-closed), the same way for every stance', async () => {
  // First check of #554, N4: this used to run one stance and compare nothing.
  for (const preload of [{}, { support: 'S' }] as Array<Partial<Record<Stance, string>>>) {
    const runs = await everyStance({ countersDown: true, preload });
    expectSameWire(runs);
    // The mock refuses before recording, so compare what was ATTEMPTED too.
    for (const s of STANCES) {
      expect(runs[s].countersDb.callsAttempted, `${s}: counters requests attempted`).toBe(
        runs.support.countersDb.callsAttempted
      );
      expect(runs[s].drafted, 'no money spent with the day count unknown').toEqual([]);
    }
    expect(runs.support.cacheWire.map((r) => r.path), 'no write').toEqual(['']);
    expect(runs.oppose.outcome).toEqual({ kind: 'daily-limited' });
    expect(runs.undecided.outcome).toEqual({ kind: 'daily-limited' });
  }
});

test('half-warm plus a failed draft: the same wire for every stance; the cached caller is answered, the failed one gets the 502', async () => {
  const runs = await everyStance({ preload: { support: 'S' }, fail: ['oppose'] });
  expectSameWire(runs);
  expect(runs.support.drafted).toEqual(['oppose', 'undecided']);
  expect(JSON.parse(runs.support.cacheWire[1].body)).toEqual([
    ['SET', scriptKey({ ...SET, stance: 'undecided' }), 'DRAFT undecided', 'EX', '86400'],
  ]);
  expect(runs.support.outcome).toEqual({ kind: 'script', script: 'S', cached: true });
  expect(runs.oppose.outcome).toEqual({ kind: 'generation-failed' });
  expect(runs.undecided.outcome).toEqual({ kind: 'script', script: 'DRAFT undecided', cached: false });
  for (const s of STANCES) {
    expect(count(runs[s].countersDb, scriptUsageKey(DAY))).toBe(1);
    expect(count(runs[s].countersDb, scriptServedUsageKey(DAY))).toBe(0);
  }
});

test('a generate() that throws before returning a promise is one failed draft, not a thrown request', async () => {
  // First check of #554, N6: the route's buildPrompt runs inside generate.
  const cacheDb = new MockUpstash();
  const countersDb = new MockUpstash();
  const restoreFetch = installUpstashFetch({ [CACHE_URL]: cacheDb, [COUNTERS_URL]: countersDb });
  const breaker = createTenantRateLimiter({ route: 'script-day', max: 1_800, windowSec: 86_400, failClosed: true });
  const deferred: Array<() => Promise<void>> = [];
  try {
    const outcome = await serveStanceBlind(SET, 'oppose', {
      cache: createScriptCache(),
      takeGenerationUnit: () => breaker.isLimited('script-global'),
      generate: ((s: Stance) => {
        if (s === 'oppose') throw new Error('prompt could not be built');
        return Promise.resolve(`DRAFT ${s}`);
      }) as ServeDeps['generate'],
      defer: (task) => {
        deferred.push(task);
      },
      note: realNotes,
      fills: createFillCoordinator(),
    });
    expect(outcome).toEqual({ kind: 'generation-failed' });
    for (const task of deferred) await task(); // the counts, before the mocks go away
  } finally {
    restoreFetch();
  }
});

/* ------------------------------------------------------------------ *
 * 2b · ORDER and timing, not only bytes (first check of #554, B1).
 * ------------------------------------------------------------------ */

/** Wait until nothing new has been logged for a few timer turns. */
async function settle(log: unknown[]): Promise<void> {
  let seen = -1;
  while (seen !== log.length) {
    seen = log.length;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/**
 * One request with every Upstash request and every model call written to ONE
 * ordered log, the moment it is made. `defer` NEVER runs its task: this is a
 * response whose after() never fires, so anything still in the log was not
 * waiting on the response.
 */
async function runLogged(stance: Stance, preload: Partial<Record<Stance, string>>) {
  const cacheDb = new MockUpstash();
  const countersDb = new MockUpstash();
  for (const [s, script] of Object.entries(preload)) {
    cacheDb.store.set(scriptKey({ ...SET, stance: s }), { value: script as string, expiresAt: null });
  }
  const restoreFetch = installUpstashFetch({ [CACHE_URL]: cacheDb, [COUNTERS_URL]: countersDb });
  const mocked = globalThis.fetch;
  const log: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const db = url.startsWith(CACHE_URL) ? 'cache' : url.startsWith(COUNTERS_URL) ? 'counters' : 'other';
    log.push(`${db} ${String(init?.body)}`);
    return mocked(input as RequestInfo, init);
  }) as typeof fetch;
  const breaker = createTenantRateLimiter({ route: 'script-day', max: 1_800, windowSec: 86_400, failClosed: true });
  try {
    const outcome = await serveStanceBlind(SET, stance, {
      cache: createScriptCache(),
      takeGenerationUnit: () => breaker.isLimited('script-global'),
      generate: async (s) => {
        log.push(`model ${s}`);
        await new Promise((resolve) => setTimeout(resolve, 5)); // a model takes time
        return `DRAFT ${s}`;
      },
      defer: () => {}, // the response's after() never runs
      note: realNotes,
      fills: createFillCoordinator(),
    });
    log.push('RESPONSE');
    await settle(log);
    return { outcome, log };
  } finally {
    globalThis.fetch = mocked;
    restoreFetch();
  }
}

test('a half-warm bill: every Upstash request and model call leaves in the same ORDER for every stance, and none waits on the response', async () => {
  const preload = { support: 'S' };
  const runs = {} as Record<Stance, Awaited<ReturnType<typeof runLogged>>>;
  for (const s of STANCES) runs[s] = await runLogged(s, preload);

  const wire = (s: Stance) => runs[s].log.filter((e) => e !== 'RESPONSE');
  for (const s of STANCES) expect(wire(s), `${s} vs support: the ordered sequence`).toEqual(wire('support'));

  // The sequence is the whole fill and its counts, though after() never ran:
  // read, breaker units, drafts, one write, then the day counts.
  const seq = wire('support');
  expect(seq[0]).toBe(`cache ${JSON.stringify(['MGET', ...STANCES.map((s) => scriptKey({ ...SET, stance: s }))])}`);
  expect(seq.filter((e) => e.startsWith('model '))).toEqual(['model oppose', 'model undecided']);
  const lastModel = seq.lastIndexOf('model undecided');
  const write = seq.findIndex((e) => e.startsWith('cache [["SET"'));
  const generatedCount = seq.findIndex((e) => e.includes(scriptUsageKey(DAY)));
  const servedCount = seq.findIndex((e) => e.includes(scriptServedUsageKey(DAY)));
  expect(write, 'one write, after the drafts').toBeGreaterThan(lastModel);
  expect(generatedCount, 'the counts run without the response').toBeGreaterThan(write);
  expect(servedCount).toBeGreaterThan(generatedCount);

  // EVERY answer leaves after the fill's write, the cached caller's included
  // (fourth check of #554, B1), so the moment a caller gets their answer, and
  // so the timing of their next request, does not depend on their stance.
  expect(runs.support.outcome).toEqual({ kind: 'script', script: 'S', cached: true });
  for (const s of STANCES) {
    const { log } = runs[s];
    expect(log.indexOf('RESPONSE'), `${s}: the answer leaves after the write`).toBeGreaterThan(
      log.findIndex((e) => e.startsWith('cache [["SET"'))
    );
  }
});

test('a half-warm bill: the caller whose script is cached does not get it before the fill has settled (fourth check of #554, B1)', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const w = sharedWorld({ hold });
  try {
    w.cacheDb.store.set(scriptKey({ ...SET, stance: 'support' }), { value: 'CACHED support', expiresAt: null });
    const events: string[] = [];
    // The starter's deps run the fill, so its write is the one to watch.
    const real = w.deps();
    const starterDeps: ServeDeps = {
      ...real,
      cache: {
        ...real.cache,
        setStances: async (set, scripts) => {
          const stored = await real.cache.setStances(set, scripts);
          events.push('write settled');
          return stored;
        },
      },
    };
    const answered = (label: string) => (o: ServeOutcome) => {
      events.push(label);
      return o;
    };
    // A cached caller starts the fill; a cached joiner and a missing joiner
    // arrive while its drafts are held.
    const cached = serveStanceBlind(SET, 'support', starterDeps).then(answered('cached starter'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const joiner = serveStanceBlind(SET, 'support', w.deps()).then(answered('cached joiner'));
    const missing = serveStanceBlind(SET, 'oppose', w.deps()).then(answered('missing joiner'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events, 'no answer leaves while the drafts are out').toEqual([]);

    release();
    expect(await cached).toEqual({ kind: 'script', script: 'CACHED support', cached: true });
    expect(await joiner).toEqual({ kind: 'script', script: 'CACHED support', cached: true });
    expect(await missing).toEqual({ kind: 'script', script: 'DRAFT oppose', cached: false });
    expect(events[0], 'the fill (its write included) settled before any answer left').toBe('write settled');
    expect(events.slice(1).sort()).toEqual(['cached joiner', 'cached starter', 'missing joiner']);
    expect(w.drafted, 'one fill, shared').toEqual([`${SET.slug} oppose`, `${SET.slug} undecided`]);
    await w.flush();
  } finally {
    release();
    w.restoreFetch();
  }
});

/* ------------------------------------------------------------------ *
 * 2c · What bounds the spend: one fill per bill, a cooldown, a cap
 *      (first check of #554, B2). Keyed by bill, never by stance.
 * ------------------------------------------------------------------ */

/** Shared databases, breaker and coordinator, for requests that must see each other. */
function sharedWorld(opts: { fail?: () => Stance[]; fills?: FillCoordinator; hold?: Promise<void> } = {}) {
  const cacheDb = new MockUpstash();
  const countersDb = new MockUpstash();
  const restoreFetch = installUpstashFetch({ [CACHE_URL]: cacheDb, [COUNTERS_URL]: countersDb });
  const breaker = createTenantRateLimiter({ route: 'script-day', max: 1_800, windowSec: 86_400, failClosed: true });
  const drafted: string[] = [];
  const deferred: Array<() => Promise<void>> = [];
  const fills = opts.fills ?? createFillCoordinator();
  const deps = (slug = SET.slug): ServeDeps => ({
    cache: createScriptCache(),
    takeGenerationUnit: () => breaker.isLimited('script-global'),
    generate: async (s) => {
      drafted.push(`${slug} ${s}`);
      if (opts.hold) await opts.hold;
      if (opts.fail?.().includes(s)) throw new Error('model failed');
      return `DRAFT ${s}`;
    },
    defer: (task) => {
      deferred.push(task);
    },
    note: realNotes,
    fills,
    logFailure: () => {},
  });
  const flush = async () => {
    while (deferred.length) await deferred.shift()!();
  };
  return { cacheDb, countersDb, restoreFetch, drafted, deps, flush };
}

test('concurrent requests on a cold bill share ONE fill: each stance drafted once, three breaker units, three spends', async () => {
  const w = sharedWorld();
  try {
    const deps = w.deps();
    const outcomes = await Promise.all(STANCES.map((s) => serveStanceBlind(SET, s, deps)));
    await w.flush();
    STANCES.forEach((s, i) => expect(outcomes[i]).toEqual({ kind: 'script', script: `DRAFT ${s}`, cached: false }));
    expect(w.drafted, 'one draft per stance, not one per request').toEqual(STANCES.map((s) => `${SET.slug} ${s}`));
    expect(count(w.countersDb, counterKey('script-day', 'script-global'))).toBe(3);
    expect(count(w.countersDb, scriptUsageKey(DAY)), 'spend counted once, by the request that started the fill').toBe(3);
    expect(count(w.countersDb, scriptServedUsageKey(DAY)), 'every request was served').toBe(3);
    expect(w.cacheDb.requests.filter((r) => r.path === '/multi-exec')).toHaveLength(1);
  } finally {
    w.restoreFetch();
  }
});

test('after a fill with a failed draft, the bill cools down: no breaker unit, no draft, for ANY stance, until the (first, one-minute) cooldown ends', async () => {
  let now = 1_000_000;
  let failing: Stance[] = ['oppose'];
  const w = sharedWorld({ fail: () => failing, fills: createFillCoordinator({ now: () => now }) });
  try {
    const first = await serveStanceBlind(SET, 'support', w.deps());
    await w.flush();
    expect(first).toEqual({ kind: 'script', script: 'DRAFT support', cached: false });
    const unitsAfterFirst = count(w.countersDb, counterKey('script-day', 'script-global'));
    expect(unitsAfterFirst).toBe(3);

    // Thirty seconds later (past the five seconds a finished fill stays
    // joinable, inside the first cooldown), a popular bill: callers of every
    // stance. None of them spends; the one whose script is missing gets the 502.
    now += 30_000;
    const wireBefore = w.countersDb.requests.length;
    const cachedCaller = await serveStanceBlind(SET, 'support', w.deps());
    const missingCaller = await serveStanceBlind(SET, 'oppose', w.deps());
    await w.flush();
    expect(cachedCaller).toEqual({ kind: 'script', script: 'DRAFT support', cached: true });
    expect(missingCaller).toEqual({ kind: 'generation-failed' });
    expect(w.drafted).toHaveLength(3);
    expect(count(w.countersDb, counterKey('script-day', 'script-global'))).toBe(unitsAfterFirst);
    expect(w.countersDb.requests.length, 'nothing at all reaches the counters database while cooling').toBe(wireBefore);

    // Once the cooldown has passed, the next request drafts the missing stance.
    now += FILL_COOLDOWNS_MS[0];
    failing = [];
    const later = await serveStanceBlind(SET, 'support', w.deps());
    await w.flush();
    expect(later).toEqual({ kind: 'script', script: 'DRAFT support', cached: true });
    expect(w.drafted.slice(3)).toEqual([`${SET.slug} oppose`]);
    expect(await serveStanceBlind(SET, 'oppose', w.deps())).toEqual({ kind: 'script', script: 'DRAFT oppose', cached: true });
  } finally {
    w.restoreFetch();
  }
});

test('a fill whose cache write fails counts as a failed fill: the bill cools down instead of re-drafting every stance, and its drafts still serve every stance until the cooldown ends (third check of #554, N5; fourth, N1)', async () => {
  let now = 1_000_000;
  const w = sharedWorld({ fills: createFillCoordinator({ now: () => now }) });
  // The cache answers reads but refuses the write: call 1 is the MGET, call 2
  // the /multi-exec transaction.
  w.cacheDb.failOnCallNumber = 2;
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    const first = await serveStanceBlind(SET, 'oppose', w.deps());
    await w.flush();
    expect(first, 'the caller is still served from the drafts').toEqual({ kind: 'script', script: 'DRAFT oppose', cached: false });
    expect(w.drafted).toHaveLength(3);
    expect(w.cacheDb.store.size, 'nothing reached the cache database').toBe(0);
    const units = count(w.countersDb, counterKey('script-day', 'script-global'));
    expect(units).toBe(3);

    // Past the five seconds a successful fill stays joinable, inside the
    // first cooldown: the read finds every stance missing again, and no
    // stance is drafted again, for any caller. But every caller is still
    // served, from the drafts the failed write left in this instance (N1),
    // and each sends the cache database the same bytes: the one MGET.
    now += RECENT_FILL_MS + 1_000;
    for (const s of STANCES) {
      const cacheBefore = w.cacheDb.requests.length;
      expect(await serveStanceBlind(SET, s, w.deps()), s).toEqual({ kind: 'script', script: `DRAFT ${s}`, cached: false });
      expect(w.cacheDb.requests.slice(cacheBefore), `${s}: only the read`).toEqual([
        { path: '', body: JSON.stringify(['MGET', ...STANCES.map((st) => scriptKey({ ...SET, stance: st }))]) },
      ]);
    }
    await w.flush();
    expect(w.drafted, 'no second full fill').toHaveLength(3);
    expect(count(w.countersDb, counterKey('script-day', 'script-global')), 'no breaker unit while cooling').toBe(units);
    expect(count(w.countersDb, scriptUsageKey(DAY)), 'the spend counted once, by the starter').toBe(3);
    expect(count(w.countersDb, scriptServedUsageKey(DAY)), 'the starter and the three joiners were served').toBe(4);

    // It is still a failed fill: 1 ms before the cooldown ends, a
    // caller is still served from it and nothing is drafted.
    now += FILL_COOLDOWNS_MS[0] - (RECENT_FILL_MS + 1_000) - 1;
    expect(await serveStanceBlind(SET, 'undecided', w.deps())).toEqual({ kind: 'script', script: 'DRAFT undecided', cached: false });
    expect(w.drafted).toHaveLength(3);
    now += 1;

    // Once the cooldown ends (and the write lands), the bill fills again.
    expect(await serveStanceBlind(SET, 'support', w.deps())).toEqual({ kind: 'script', script: 'DRAFT support', cached: false });
    await w.flush();
    expect(w.drafted).toHaveLength(6);
    expect(w.cacheDb.store.size).toBe(3);
  } finally {
    console.warn = realWarn;
    console.error = realError;
    w.restoreFetch();
  }
});

test('a breaker refusal does not start a cooldown (it spent nothing, and the breaker already bounds it)', async () => {
  const fills = createFillCoordinator({ now: () => 0 });
  let calls = 0;
  const run = async () => {
    calls += 1;
    return { refused: true, drafted: {}, complete: false, stored: true };
  };
  const a = fills.start(SET, run);
  expect(a.kind).toBe('started');
  if (a.kind === 'started') await a.fill;
  const b = fills.start(SET, run);
  expect(b.kind).toBe('started');
  if (b.kind === 'started') await b.fill;
  expect(calls).toBe(2);
});

test('the cooldown backs off per bill — 1, 2, 4, then 10 minutes — and a fill that succeeds starts the bill over (second check of #554, D5)', async () => {
  expect(FILL_COOLDOWNS_MS).toEqual([60_000, 120_000, 240_000, 600_000]);
  let now = 0;
  let succeed = false;
  const fills = createFillCoordinator({ now: () => now });
  const run = async () =>
    succeed
      ? { refused: false, drafted: { support: 'S', oppose: 'O', undecided: 'U' }, complete: true, stored: true }
      : { refused: false, drafted: {}, complete: false, stored: true };
  const other = { ...SET, slug: 's-9-119' };
  /** Start a fill at `now`; return its kind, awaiting it when it started. */
  const attempt = async (set = SET) => {
    const r = fills.start(set, run);
    if (r.kind === 'started') await r.fill;
    return r.kind;
  };

  // Each failed fill in a row waits longer; the cooldown never passes 10 minutes.
  for (const wait of [60_000, 120_000, 240_000, 600_000, 600_000]) {
    expect(await attempt(), `a new fill when the last cooldown ended (t=${now})`).toBe('started');
    now += wait - 1;
    expect(await attempt(), `still cooling 1 ms before ${wait / 60_000} min`).toBe('cooling');
    // The backoff is the BILL's, never shared: another bill starts at once.
    expect(await attempt(other)).toBe('started');
    now += 1;
  }

  // A fill in which every draft comes back starts the bill over at one minute.
  succeed = true;
  expect(await attempt()).toBe('started');
  succeed = false;
  now += RECENT_FILL_MS;
  expect(await attempt(), 'the first failure after a success').toBe('started');
  now += 60_000 - 1;
  expect(await attempt()).toBe('cooling');
  now += 1;
  expect(await attempt(), 'one minute, not the ten it had reached before').toBe('started');
});

test('a request whose read lands as a fill finishes joins that fill instead of drafting every stance again (second check of #554, D4)', async () => {
  let now = 1_000_000;
  const w = sharedWorld({ fills: createFillCoordinator({ now: () => now }) });
  try {
    // B's read is answered while the bill is still cold, but B reaches the
    // coordinator only after A's fill has finished and been written.
    let releaseB!: () => void;
    const bGate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const real = w.deps();
    const lateRead: ServeDeps = {
      ...real,
      cache: {
        ...real.cache,
        getStances: async (set) => {
          const read = await real.cache.getStances(set);
          await bGate;
          return read;
        },
      },
    };
    const b = serveStanceBlind(SET, 'oppose', lateRead);
    const a = await serveStanceBlind(SET, 'support', w.deps());
    expect(a).toEqual({ kind: 'script', script: 'DRAFT support', cached: false });
    expect(w.drafted).toHaveLength(3);
    now += RECENT_FILL_MS - 1; // still inside the window a finished fill stays joinable
    releaseB();
    expect(await b, 'B gets the draft A paid for').toEqual({ kind: 'script', script: 'DRAFT oppose', cached: false });
    await w.flush();
    expect(w.drafted, 'each stance drafted once, not twice').toEqual(STANCES.map((s) => `${SET.slug} ${s}`));
    expect(count(w.countersDb, counterKey('script-day', 'script-global')), 'three breaker units, not six').toBe(3);
    expect(count(w.countersDb, scriptUsageKey(DAY)), 'spend counted once, by A').toBe(3);
    expect(count(w.countersDb, scriptServedUsageKey(DAY)), 'both requests were served').toBe(2);
    expect(w.cacheDb.requests.filter((r) => r.path === '/multi-exec')).toHaveLength(1);
  } finally {
    w.restoreFetch();
  }
});

test('the served count is judged by each request\'s OWN read: a joiner that found a stance the starter did not is not counted when it stays missing, whatever its stance (second check of #554, D3)', async () => {
  for (const joinerStance of STANCES) {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const w = sharedWorld({ hold });
    try {
      // The starter sees support cached and drafts oppose and undecided.
      const supportKey = scriptKey({ ...SET, stance: 'support' });
      w.cacheDb.store.set(supportKey, { value: 'CACHED support', expiresAt: null });
      const starter = serveStanceBlind(SET, 'undecided', w.deps());
      await new Promise((resolve) => setTimeout(resolve, 20)); // the starter's drafts are held
      // Support's key expires mid-fill; the joiner finds all three missing and joins.
      w.cacheDb.store.delete(supportKey);
      const joiner = serveStanceBlind(SET, joinerStance, w.deps());
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      expect(await starter).toEqual({ kind: 'script', script: 'DRAFT undecided', cached: false });
      const outcome = await joiner;
      await w.flush();
      expect(w.drafted, 'one fill: the starter\'s two drafts').toEqual([`${SET.slug} oppose`, `${SET.slug} undecided`]);
      if (joinerStance === 'support') expect(outcome).toEqual({ kind: 'generation-failed' });
      else expect(outcome).toEqual({ kind: 'script', script: `DRAFT ${joinerStance}`, cached: false });
      // The starter's read found only what the fill drafted: counted. The
      // joiner's found support too, which stayed missing: not counted, for
      // a joiner of ANY stance, so the count says nothing about whose it was.
      expect(count(w.countersDb, scriptServedUsageKey(DAY)), `served, joiner=${joinerStance}`).toBe(1);
    } finally {
      release();
      w.restoreFetch();
    }
  }
});

test('at most MAX_FILLS_IN_FLIGHT bills fill at once on an instance; past it, a missing script is a 502 and nothing is spent', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const w = sharedWorld({ hold, fills: createFillCoordinator({ maxInFlight: 1 }) });
  try {
    const first = serveStanceBlind(SET, 'support', w.deps());
    // Let the first request reach its drafts (they are held).
    await new Promise((resolve) => setTimeout(resolve, 20));
    const other = { ...SET, slug: 's-9-119' };
    const unitsBefore = count(w.countersDb, counterKey('script-day', 'script-global'));
    expect(await serveStanceBlind(other, 'oppose', w.deps(other.slug))).toEqual({ kind: 'generation-failed' });
    expect(w.drafted.filter((d) => d.startsWith(other.slug))).toEqual([]);
    expect(count(w.countersDb, counterKey('script-day', 'script-global'))).toBe(unitsBefore);
    release();
    expect(await first).toEqual({ kind: 'script', script: 'DRAFT support', cached: false });
    await w.flush();
  } finally {
    release();
    w.restoreFetch();
  }
});

/* ------------------------------------------------------------------ *
 * 3 · The route wires exactly these pieces (asserted over source: the
 *     route's after() needs a request scope a unit spec does not have).
 * ------------------------------------------------------------------ */

const routeSrc = readFileSync(join(process.cwd(), 'app/api/script/route.ts'), 'utf8');
const serveSrc = readFileSync(join(process.cwd(), 'lib/script-serve.ts'), 'utf8');

test('the route answers through serveStanceBlind with the real cache, breaker, model call and counts — and never reads or writes one stance itself', () => {
  expect(routeSrc).toContain('const outcome = await serveStanceBlind(set, stance, {');
  expect(routeSrc).toContain('takeGenerationUnit: () => dayBreaker.isLimited(SCRIPT_GLOBAL_BUCKET),');
  expect(routeSrc).toContain('generate: async (draftStance) => generateScript(buildPrompt(draftStance), set.lang),');
  expect(routeSrc).toContain('    fills: routeFills,\n');
  expect(serveSrc).toContain('export const routeFills: FillCoordinator = createFillCoordinator(');
  expect(routeSrc).toContain('defer: (task) => after(task),');
  expect(routeSrc).toContain('generated: () => noteScriptGeneration(),');
  expect(routeSrc).toContain('served: () => noteScriptServed(),');
  expect(routeSrc).toContain("refusedDaily: () => noteScriptRefusal('daily'),");
  // No single-stance cache call anywhere on the live path.
  for (const src of [routeSrc, serveSrc]) {
    expect(src).not.toMatch(/cache\.(get|set)\(/);
  }
  // Both vehicle kinds pass the stance to draft into the prompt builder, not the caller's.
  expect(routeSrc).toContain('(draftStance) => buildScriptPrompt({ bill, stance: draftStance, lang }),');
  expect(routeSrc).toContain(
    '(draftStance) => buildNominationScriptPrompt({ nomination, stance: draftStance, audience, lang }),'
  );
  expect(routeSrc.match(/return serveScript\(\s*\{ slug, lang, version \},\s*stance,/g)).toHaveLength(2);
});

test('the caller-facing stance reaches lib/script-serve.ts only to pick the response', () => {
  // `stance` (the caller's) is read in exactly one place: `stored[stance]` and
  // `fill.drafted[stance]`. Everything sent anywhere iterates STANCES or `missing`.
  const body = serveSrc.slice(serveSrc.indexOf('export async function serveStanceBlind('));
  const uses = [...body.matchAll(/\bstance\b/g)].length;
  expect(body).toContain('const own = stored[stance];');
  expect(body).toContain('const script = fill.drafted[stance];');
  // The parameter declaration plus the two reads above.
  expect(uses).toBe(3);
});
