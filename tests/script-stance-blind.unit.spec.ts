import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): plain lib modules resolve under the test
// runner — same pattern as the other unit specs.
import { counterKey, createTenantRateLimiter } from '../lib/ratelimit';
import { serveStanceBlind, type ServeOutcome } from '../lib/script-serve';
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
  opts: { preload?: Partial<Record<Stance, string>>; fail?: Stance[]; dayMax?: number } = {}
): Promise<Run> {
  const cacheDb = new MockUpstash();
  const countersDb = new MockUpstash();
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
      note: {
        served: () => noteScriptServed(),
        generated: () => noteScriptGeneration(),
        refusedDaily: () => noteScriptRefusal('daily'),
      },
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
    restoreFetch();
  }
}

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
  // The hit is answered at once from the cache (the drafting ran in after());
  // the miss waits for its draft.
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
  const cacheDb = new MockUpstash();
  const countersDb = new MockUpstash();
  countersDb.failWithStatus = 503;
  const restoreFetch = installUpstashFetch({ [CACHE_URL]: cacheDb, [COUNTERS_URL]: countersDb });
  const realError = console.error;
  console.error = () => {};
  try {
    const breaker = createTenantRateLimiter({ route: 'script-day', max: 1_800, windowSec: 86_400, failClosed: true });
    const drafted: Stance[] = [];
    const deferred: Array<() => Promise<void>> = [];
    const outcome = await serveStanceBlind(SET, 'oppose', {
      cache: createScriptCache(),
      takeGenerationUnit: () => breaker.isLimited('script-global'),
      generate: async (s) => {
        drafted.push(s);
        return `DRAFT ${s}`;
      },
      defer: (task) => {
        deferred.push(task);
      },
      note: { served: noteScriptServed, generated: noteScriptGeneration, refusedDaily: () => noteScriptRefusal('daily') },
    });
    for (const task of deferred) await task();
    expect(outcome).toEqual({ kind: 'daily-limited' });
    expect(drafted, 'no money spent with the day count unknown').toEqual([]);
  } finally {
    console.error = realError;
    restoreFetch();
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
  expect(routeSrc).toContain('generate: (draftStance) => generateScript(buildPrompt(draftStance), set.lang),');
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
