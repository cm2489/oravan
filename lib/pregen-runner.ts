import Anthropic from '@anthropic-ai/sdk';
import { getTopActions } from './core/bills';
import {
  buildBatchRequest,
  customId,
  estimateCost,
  extractScriptFromResult,
  LOCALES,
  planCombos,
  type BatchResultRow,
} from './pregen';
import { createScriptCache, probeCacheDatabase, type CacheProbe, type ScriptCache } from './scriptcache';
import { STANCES } from './scriptprompt';
import type { Bill } from './types';

/*
 * Orchestration for scripts/pregen-scripts.mjs (S21, F7) — split into a .ts
 * module so Playwright's unit tests can import it directly (the same way
 * they import lib/scriptcache.ts, lib/ratelimit.ts, etc.), exactly like
 * scripts/verify-salt.mjs's logic lives in lib/salt.mjs. The .mjs script
 * itself is a thin CLI shim; see that file for why it must run under `tsx`.
 *
 * FAIL-LOUD ON A DEAD CACHE (2026-09-18). This job's entire product is a
 * durable cache entry, so it must never pay for scripts it cannot store.
 * For at least eight consecutive nightlies it did exactly that: the cache
 * database was unreachable (status 0), every one of the 60 reads fell open
 * to an empty in-memory map — "0 already cached", every night — all 60
 * scripts were generated and paid for, all 60 writes failed the same way,
 * and the run printed "60 cached" and exited green. The counters database
 * was healthy in the same run, so nothing else in the nightly noticed.
 * Now: one cheap probe BEFORE the batch is submitted, and a hard stop if
 * the database does not answer — nothing submitted, nothing spent. The
 * workflow step stays post-commit and the night's data still lands; the run
 * goes red, which is the honest outcome when the cache is down.
 *
 * The live route's fail-open behaviour (app/api/script) is untouched and
 * must stay that way: a visitor whose script cannot be cached still gets
 * their script. Only this batch job treats an unstorable result as failure.
 *
 * All I/O dependencies are injectable so tests never touch a live Anthropic
 * or Upstash endpoint: no mock reproduces the Message Batches API's JSONL
 * results stream at the network layer here — `anthropic` is a plain object
 * shaped like { messages: { batches: { create, retrieve, results } } }, and
 * tests hand in a fake with the exact async-iterable shape they need.
 */

const DEFAULT_TOP_N = 10;
const DEFAULT_MAX_WAIT_MS = 20 * 60 * 1000; // batches this small finish in minutes in practice
const POLL_INTERVAL_MS = 15_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface BatchesLike {
  create(body: { requests: unknown[] }): Promise<{ id: string; processing_status: string }>;
  retrieve(id: string): Promise<{ id: string; processing_status: string }>;
  results(id: string): Promise<AsyncIterable<BatchResultRow>>;
}

export interface AnthropicLike {
  messages: { batches: BatchesLike };
}

export interface PregenDeps {
  anthropic?: AnthropicLike;
  cache?: ScriptCache;
  /** Cache-database reachability check; injectable for tests. */
  probe?: () => Promise<CacheProbe>;
  getBills?: () => Bill[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  dryRun?: boolean;
  topN?: number;
  maxWaitMs?: number;
}

export interface PregenResult {
  planned: number;
  generated: number;
  dryRun: boolean;
  timedOut?: boolean;
  batchId?: string;
  /** Combos already present in the cache database — the health signal. */
  alreadyCached?: number;
  /** Writes the cache DATABASE accepted (not the in-memory fallback). */
  cacheWrites?: number;
  /** Writes that did not reach the database. */
  cacheWriteFailures?: number;
}

/**
 * Thrown when the cache database cannot be reached. Its whole job is to
 * stop the run BEFORE any Anthropic spend, so the message has to say what
 * to check rather than just what happened.
 */
export class PregenCacheUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PregenCacheUnavailableError';
  }
}

export async function main({
  anthropic = new Anthropic() as unknown as AnthropicLike,
  cache = createScriptCache(),
  probe = probeCacheDatabase,
  getBills,
  now = () => Date.now(),
  sleep = defaultSleep,
  dryRun = process.argv.includes('--dry-run'),
  topN = Number(process.env.PREGEN_TOP_N ?? DEFAULT_TOP_N),
  maxWaitMs = Number(process.env.PREGEN_BATCH_MAX_WAIT_MS ?? DEFAULT_MAX_WAIT_MS),
}: PregenDeps = {}): Promise<PregenResult> {
  const bills = (getBills ?? (() => getTopActions(topN)))();
  const allCombos = planCombos(bills, STANCES, LOCALES);

  // --dry-run short-circuits BEFORE any I/O — not even an Upstash cache
  // read — so "zero API calls" is literal, not just "zero Anthropic
  // spend". The plan/estimate below is therefore against the full combo
  // set, not net of what happens to already be cached.
  if (dryRun) {
    const estimate = estimateCost(allCombos.length);
    console.log(
      `pregen: --dry-run — zero API calls. ${bills.length} top bill(s), ${allCombos.length} combo(s):`
    );
    for (const combo of allCombos) {
      console.log(`  - ${combo.slug} / ${combo.stance} / ${combo.lang} (version ${combo.version})`);
    }
    console.log(
      `pregen: estimated cost if all ${allCombos.length} generate tonight — ` +
        `batch ~$${estimate.perNightBatch.intro}-$${estimate.perNightBatch.standard}/night ` +
        `(~$${estimate.perMonthBatch.intro}-$${estimate.perMonthBatch.standard}/month); ` +
        `sync-fallback ~$${estimate.perNightSyncFallback.intro}-$${estimate.perNightSyncFallback.standard}/night ` +
        `(~$${estimate.perMonthSyncFallback.intro}-$${estimate.perMonthSyncFallback.standard}/month). ` +
        '(Real nightly cost is usually lower - combos already cached are skipped.)'
    );
    return { planned: allCombos.length, generated: 0, dryRun: true };
  }

  // Is the cache database actually there? One GET, before anything is read
  // in bulk and long before anything is submitted. Without this the reads
  // below fail open to an empty in-memory map, which is indistinguishable
  // from a genuine cold cache — so the job cheerfully re-buys all 60 scripts
  // every night and stores none of them. A visitor's request is right to
  // fail open here; a batch job that exists to fill a cache is not.
  const health = await probe();
  if (!health.reachable) {
    // The two env var names are deliberately NOT spelled out here: they are
    // confined to lib/upstash.ts by scripts/check-key-namespaces.mjs's
    // env-confinement rule, and a log line is not a good enough reason to
    // start naming them in a second place. The workflow step's own `env:`
    // block and scripts/pregen-scripts.mjs's header both list them.
    const why = health.configured
      ? `the database did not answer (status ${health.status})`
      : 'the cache database is not configured in this environment (its two REST secrets are absent)';
    console.error(
      `::error::pregen: the CACHE database is unreachable — ${why}. ` +
        'Nothing was submitted and nothing was spent: every generated script would be ' +
        'thrown away, because the in-memory fallback dies with this process. ' +
        'Check that the cache database still exists and that the two cache secrets in this ' +
        "step's env block point at it — the counters database is separate and can be " +
        'healthy in the same run while this one is not.'
    );
    throw new PregenCacheUnavailableError(`cache database unreachable — ${why}`);
  }

  // Idempotent skip: never re-spend on a combo already cached under its
  // current content-version.
  const todo = [];
  for (const combo of allCombos) {
    const hit = await cache.get(combo);
    if (!hit) todo.push(combo);
  }

  const estimate = estimateCost(todo.length);
  console.log(
    `pregen: ${bills.length} top bill(s), ${allCombos.length} combo(s) total, ` +
      `${allCombos.length - todo.length} already cached, ${todo.length} to generate`
  );
  console.log(
    `pregen: estimated cost — batch ~$${estimate.perNightBatch.intro}-$${estimate.perNightBatch.standard}/night ` +
      `(~$${estimate.perMonthBatch.intro}-$${estimate.perMonthBatch.standard}/month); ` +
      `sync-fallback (if batch is ever unavailable) ~$${estimate.perNightSyncFallback.intro}-` +
      `$${estimate.perNightSyncFallback.standard}/night (~$${estimate.perMonthSyncFallback.intro}-` +
      `$${estimate.perMonthSyncFallback.standard}/month)`
  );

  if (todo.length === 0) {
    console.log('pregen: nothing to do — every combo is already cached.');
    logMetrics({ alreadyCached: allCombos.length, generated: 0, cacheWrites: 0, cacheWriteFailures: 0 });
    return {
      planned: 0,
      generated: 0,
      dryRun: false,
      alreadyCached: allCombos.length,
      cacheWrites: 0,
      cacheWriteFailures: 0,
    };
  }

  const requests = todo.map(buildBatchRequest);
  const batch = await anthropic.messages.batches.create({ requests });
  console.log(`pregen: submitted batch ${batch.id} (${requests.length} requests)`);

  const deadline = now() + maxWaitMs;
  let current = batch;
  while (current.processing_status !== 'ended') {
    if (now() >= deadline) {
      console.log(
        `::warning::pregen: batch ${batch.id} still processing after ${maxWaitMs}ms — ` +
          'skipping this run without writing anything; uncached combos get a fresh batch next night.'
      );
      logMetrics({
        alreadyCached: allCombos.length - todo.length,
        generated: 0,
        cacheWrites: 0,
        cacheWriteFailures: 0,
      });
      return {
        planned: todo.length,
        generated: 0,
        dryRun: false,
        timedOut: true,
        batchId: batch.id,
        alreadyCached: allCombos.length - todo.length,
        cacheWrites: 0,
        cacheWriteFailures: 0,
      };
    }
    await sleep(POLL_INTERVAL_MS);
    current = await anthropic.messages.batches.retrieve(batch.id);
  }

  const byCustomId = new Map(todo.map((combo) => [customId(combo), combo]));
  let generated = 0;
  let failed = 0;
  let cacheWrites = 0;
  let cacheWriteFailures = 0;
  const results = await anthropic.messages.batches.results(batch.id);
  for await (const row of results) {
    const combo = byCustomId.get(row.custom_id);
    if (!combo) continue; // defensive: unrecognized custom_id must never crash a nightly run
    const extracted = extractScriptFromResult(row);
    if (!extracted.ok || !extracted.script) {
      failed++;
      console.error(`pregen: ${row.custom_id} did not succeed (${extracted.reason})`);
      continue;
    }
    // never throws (lib/scriptcache.ts); false = it did not reach the database
    const stored = await cache.set(combo, extracted.script);
    if (stored) cacheWrites++;
    else cacheWriteFailures++;
    generated++;
  }

  const alreadyCached = allCombos.length - todo.length;
  console.log(
    `pregen: done — ${generated} generated, ${cacheWrites} stored durably, ` +
      `${cacheWriteFailures} not stored, ${failed} failed, batch ${batch.id}`
  );
  logMetrics({ alreadyCached, generated, cacheWrites, cacheWriteFailures });

  // The probe passed and the writes still all failed: the database went away
  // mid-run. Say so out loud rather than reporting a green night — this is
  // the exact shape of the failure that hid for eight nights.
  if (generated > 0 && cacheWrites === 0) {
    console.error(
      '::error::pregen: every cache write failed after the batch was paid for — ' +
        'the cache database became unreachable mid-run. Tonight\'s generation is lost.'
    );
    throw new PregenCacheUnavailableError('all cache writes failed after generation');
  }

  return {
    planned: todo.length,
    generated,
    dryRun: false,
    batchId: batch.id,
    alreadyCached,
    cacheWrites,
    cacheWriteFailures,
  };
}

/**
 * One machine-readable line per run, so a health check can read the two
 * numbers that actually say whether pregen is working — how many combos
 * were ALREADY in the database (0 every night is the dead-cache signature)
 * and how many writes the database accepted — without parsing prose.
 * Stable key=value pairs; add fields at the end, never rename one.
 */
function logMetrics(m: {
  alreadyCached: number;
  generated: number;
  cacheWrites: number;
  cacheWriteFailures: number;
}): void {
  console.log(
    `pregen: metrics already_cached=${m.alreadyCached} generated=${m.generated} ` +
      `cache_writes_ok=${m.cacheWrites} cache_writes_failed=${m.cacheWriteFailures}`
  );
}
