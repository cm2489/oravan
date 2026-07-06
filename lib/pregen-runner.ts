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
import { createScriptCache, type ScriptCache } from './scriptcache';
import { STANCES } from './scriptprompt';
import type { Bill } from './types';

/*
 * Orchestration for scripts/pregen-scripts.mjs (S21, F7) — split into a .ts
 * module so Playwright's unit tests can import it directly (the same way
 * they import lib/scriptcache.ts, lib/ratelimit.ts, etc.), exactly like
 * scripts/verify-salt.mjs's logic lives in lib/salt.mjs. The .mjs script
 * itself is a thin CLI shim; see that file for why it must run under `tsx`.
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
}

export async function main({
  anthropic = new Anthropic() as unknown as AnthropicLike,
  cache = createScriptCache(),
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
    return { planned: 0, generated: 0, dryRun: false };
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
      return { planned: todo.length, generated: 0, dryRun: false, timedOut: true, batchId: batch.id };
    }
    await sleep(POLL_INTERVAL_MS);
    current = await anthropic.messages.batches.retrieve(batch.id);
  }

  const byCustomId = new Map(todo.map((combo) => [customId(combo), combo]));
  let generated = 0;
  let failed = 0;
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
    await cache.set(combo, extracted.script); // never throws (lib/scriptcache.ts)
    generated++;
  }

  console.log(`pregen: done — ${generated} cached, ${failed} failed, batch ${batch.id}`);
  return { planned: todo.length, generated, dryRun: false, batchId: batch.id };
}
