/**
 * The NIGHTLY decode, through the Message Batches API — same two calls, same
 * prompts, same publish gate, half the price.
 *
 * WHY THIS EXISTS. Anthropic bills a batched request at 50% of the standard
 * rate, and the nightly bill sync is the one decode path in this repo with no
 * reader waiting on it: it runs in CI at 14:15 UTC, writes JSON, and commits.
 * Every other decode path is latency-sensitive by construction — the hourly
 * newsdesk re-decode heals a page that is live and wrong right now — and is
 * deliberately left synchronous (see scripts/bill-decode.mjs's `decode`).
 *
 * WHY TWO ROUNDS. A decode is two calls and the second reads the first's
 * reply: call 1 writes the plain-language summary from the bill's document,
 * call 2 turns that summary (and ONLY that summary) into headlines, sections
 * and the Spanish twin. A batch cannot chain, so this submits every bill's
 * call 1 as one batch, waits, then submits every surviving bill's call 2 as a
 * second batch. Merging the two into one cheaper call would break the
 * hallucination guard that keeps call 2 from writing claims the summary never
 * made; it is not on the table.
 *
 * WHAT IT COSTS IN WALL TIME. Measured on this repo's existing batch user
 * (the nightly script pre-generation, lib/pregen-runner.ts, 60 requests a
 * night): 5 of the last 7 nights finished in 2-5 minutes, one in ~5, and one
 * exceeded a 20-minute ceiling. Two rounds therefore usually cost 5-10
 * minutes of runner time and can cost more. The nightly job sets no
 * timeout-minutes, so GitHub's 6h default applies; the ceiling here is what
 * actually bounds it.
 *
 * WHAT HAPPENS WHEN IT DOESN'T WORK — the only part that really matters. A
 * night must never lose its decodes to this optimization. Every failure mode
 * — the batch create throwing, the poll exceeding its deadline, a row coming
 * back errored or expired, a reply failing the shape check — resolves to
 * `{ ok: false }` for that bill and nothing else. The caller
 * (scripts/sync-bills.mjs) then decodes those bills synchronously, at full
 * price, exactly as it did before this file existed. The worst case is a slow
 * night that costs what tonight already costs; there is no path where a bill
 * that would have been decoded is silently dropped.
 *
 * Every I/O dependency is injectable and the client is duck-typed
 * (`{ messages: { batches: { create, retrieve, results } } }`), the same shape
 * lib/pregen-runner.ts uses, so tests drive the whole two-round flow without a
 * network or a mock SDK.
 */
import {
  DECODE_MODEL,
  DECODE_STRUCTURE_MAX_TOKENS,
  DECODE_SUMMARY_MAX_TOKENS,
  assembleDecode,
  buildStructurePrompt,
  buildSummaryPrompt,
} from '../scripts/bill-decode.mjs';

/** Discounted rate this path buys. Anthropic's published Message Batches
 *  discount; used only for the run log's arithmetic, never for a decision. */
export const BATCH_DISCOUNT = 0.5;

/*
 * HOW LONG ONE ROUND MAY HOLD THE NIGHT — 8 minutes, lowered from 20 on
 * 2026-09-19, and the reason is not the model.
 *
 * sync-bills.yml, newsdesk.yml, hot-bills.yml and moment-watch.yml all sit in
 * the `data-sync` concurrency group, because they all write data/bills.json and
 * the group is what stops them racing each other's commit. The newsdesk's cron
 * fires at :07 EVERY HOUR. So every minute the nightly spends WAITING on a
 * batch is a minute the hourly live layer is queued behind it — and the
 * newsdesk is the layer that heals a page that is live and wrong right now.
 * At 20 minutes a round, two rounds could hold the group for 40 minutes on top
 * of the night's real work, which is most of an hourly slot spent waiting for a
 * discount.
 *
 * 8 COVERS THE MEASUREMENT AND NOT MUCH MORE. On this repo's existing batch
 * user (lib/pregen-runner.ts, 60 requests a night) 5 of the last 7 nights
 * finished in 2-5 minutes and one in ~5; one exceeded 20. A batch slower than 8
 * minutes is therefore an outlier, and the right answer for an outlier is the
 * one this file already has: abandon it, cancel it, and decode those bills
 * synchronously at full price. A stale homepage costs more than the discount
 * saves. DECODE_BATCH_MAX_WAIT_MS overrides it for a one-off catch-up run when
 * nothing else is queued.
 */
const DEFAULT_MAX_WAIT_MS = 8 * 60 * 1000;
const POLL_INTERVAL_MS = 15_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The wait ceiling this run will actually use.
 *
 * WHY IT IS NOT `Number(env ?? DEFAULT)` (2026-09-19). `Number('oops')` is NaN,
 * every comparison against NaN is false, and the poll loop's `now() >= deadline`
 * is one of them — so a typo in a workflow input did not shorten the wait, it
 * REMOVED it, and the nightly sat on the data-sync concurrency group until
 * GitHub's 6-hour job default killed it, with the hourly newsdesk queued behind
 * the whole time. A knob that cannot be read is a knob that was not set: fall
 * back to the built-in ceiling and say so out loud, the same shape
 * REDECODE_MAX_PER_NIGHT already uses in scripts/sync-bills.mjs.
 *
 * Zero is rejected with everything else: "give up before you have begun" is not
 * a thing anyone means to configure, and it would turn the batch path into a
 * full-price synchronous decode that still paid to create a batch first.
 *
 * @param {unknown} raw
 * @param {(msg: string) => void} log
 * @returns {number} milliseconds, always finite and positive
 */
export function resolveMaxWaitMs(raw, log = console.log) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_MAX_WAIT_MS;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  log(
    `::warning::decode-batch: DECODE_BATCH_MAX_WAIT_MS was not a usable number of milliseconds, so the built-in ceiling of ${DEFAULT_MAX_WAIT_MS}ms was used instead. Check the workflow input.`
  );
  return DEFAULT_MAX_WAIT_MS;
}

/**
 * Abandon a batch we are no longer going to read.
 *
 * WHY IT IS NOT OPTIONAL. Walking away from a created batch does not stop it:
 * it keeps processing and it keeps billing, and the caller is meanwhile paying
 * for the same decodes a second time synchronously. Cancelling is the only
 * thing that makes "we gave up waiting" cost one decode instead of two.
 *
 * It is best-effort by construction. A batch that ENDED between the last poll
 * and this call refuses cancellation, and a network failure here must not turn
 * a slow night into a failed one — the caller has already decided what it is
 * doing next. So every failure is logged and swallowed.
 */
async function cancelBatch(anthropic, batchId, label, log) {
  if (!batchId) return;
  try {
    await anthropic.messages.batches.cancel(batchId);
    log(`decode-batch: ${label} batch ${batchId} cancelled so it stops billing for work nobody will read`);
  } catch (e) {
    log(`decode-batch: ${label} batch ${batchId} could not be cancelled (${e.message}) — it may already have ended. Nothing else changes.`);
  }
}

/**
 * One batch request row. `thinking: { type: 'disabled' }` is passed explicitly
 * for the reason scripts/bill-decode.mjs's DECODE_MODEL comment gives: Sonnet
 * 5 turns thinking ON when the field is omitted, which would add unbounded
 * thinking spend to every row here.
 */
function requestRow(customId, prompt, maxTokens) {
  return {
    custom_id: customId,
    params: {
      model: DECODE_MODEL,
      max_tokens: maxTokens,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: prompt }],
    },
  };
}

/** Round 1: one row per bill, the summary prompt. */
export function buildSummaryRequests(jobs) {
  return jobs.map((j) => requestRow(j.slug, buildSummaryPrompt(j.bill, j.text), DECODE_SUMMARY_MAX_TOKENS));
}

/** Round 2: one row per bill that produced a summary. */
export function buildStructureRequests(jobs, summaries) {
  const rows = [];
  for (const j of jobs) {
    const summary = summaries.get(j.slug);
    if (!summary) continue;
    rows.push(requestRow(j.slug, buildStructurePrompt(j.bill, summary), DECODE_STRUCTURE_MAX_TOKENS));
  }
  return rows;
}

/** The text of one succeeded batch row, or null for anything else. A row that
 *  errored, expired or was canceled is not an exception here — it is one bill
 *  the caller will decode synchronously instead. */
export function extractText(row) {
  if (row?.result?.type !== 'succeeded') return null;
  const block = (row.result.message?.content ?? []).find((c) => c.type === 'text');
  const text = block && typeof block.text === 'string' ? block.text.trim() : '';
  return text || null;
}

/**
 * Submit one batch and drain it into a Map of custom_id -> reply text.
 *
 * Throws only when the batch could not be CREATED (an SDK/network failure);
 * a created batch that times out returns whatever it has, which for a timeout
 * is nothing. Both land the caller in the same place: the bills with no entry
 * fall back to a synchronous decode.
 */
async function runRound({ anthropic, requests, label, now, sleep, maxWaitMs, log }) {
  const out = new Map();
  if (requests.length === 0) return { texts: out, timedOut: false, batchId: null };
  const batch = await anthropic.messages.batches.create({ requests });
  log(`decode-batch: ${label} submitted batch ${batch.id} (${requests.length} request(s))`);

  const deadline = now() + maxWaitMs;
  let current = batch;
  while (current.processing_status !== 'ended') {
    if (now() >= deadline) {
      log(
        `::warning::decode-batch: ${label} batch ${batch.id} still processing after ${maxWaitMs}ms — ` +
          'abandoning it and decoding those bills synchronously instead. The night still lands; it costs full price.'
      );
      await cancelBatch(anthropic, batch.id, label, log);
      return { texts: out, timedOut: true, batchId: batch.id };
    }
    await sleep(POLL_INTERVAL_MS);
    // A POLL FAILURE IS A TIMEOUT, NOT AN EXCEPTION (2026-09-19). Letting
    // `retrieve` throw out of here threw out of decodeBatched's try as well,
    // which for round 2 discarded round 1's summaries — every bill then fell
    // back to a full synchronous decode and paid for a summary the batch had
    // already delivered and billed. A transient 500 on a status check is not a
    // reason to buy anything twice: give up on this batch the same way the
    // deadline does, cancel it, and let the caller reuse whatever it holds.
    try {
      current = await anthropic.messages.batches.retrieve(batch.id);
    } catch (e) {
      log(
        `::warning::decode-batch: ${label} batch ${batch.id} could not be polled (${e.message}) — ` +
          'treating it as a timeout: it is cancelled and those bills are finished synchronously.'
      );
      await cancelBatch(anthropic, batch.id, label, log);
      return { texts: out, timedOut: true, batchId: batch.id };
    }
  }

  // The results stream is the last thing that can fail, and by here the batch
  // has ENDED and been billed — so a failure to read it must not discard the
  // round before it either. Same verdict as a timeout, minus the cancel: there
  // is nothing left to cancel.
  try {
    const results = await anthropic.messages.batches.results(batch.id);
    for await (const row of results) {
      const text = extractText(row);
      if (text) out.set(row.custom_id, text);
      else log(`decode-batch: ${label} ${row.custom_id} did not succeed (${row?.result?.type ?? 'unknown'})`);
    }
  } catch (e) {
    log(
      `::warning::decode-batch: ${label} batch ${batch.id} ended but its results could not be read (${e.message}) — ` +
        'those bills are finished synchronously.'
    );
    return { texts: out, timedOut: true, batchId: batch.id };
  }
  return { texts: out, timedOut: false, batchId: batch.id };
}

/**
 * Decode a list of `{ slug, bill, text }` jobs through two batch rounds.
 *
 * Returns a Map keyed by slug: `{ ok: true, dec }` for a decode that passed
 * assembleDecode's shape gate, `{ ok: false, reason }` for anything else.
 * NEVER throws — a thrown batch create is caught and reported as every job
 * failing, because the caller's answer to a failure is always the same and it
 * must not be "abort the night".
 *
 * A FAILURE CARRIES WHAT IT DID GET (2026-09-19). When round 1 delivered a
 * summary and round 2 did not, the `{ ok: false }` entry carries that
 * `summary`. The batch has already been billed for it; a caller that ignored it
 * and re-ran the whole decode would buy the same paragraph twice. The caller
 * finishes those with scripts/bill-decode.mjs's `decodeStructureFrom` and pays
 * only for the half that is genuinely missing.
 *
 * The caller decides what to do with `ok: false`. scripts/sync-bills.mjs
 * decodes those synchronously.
 *
 * @param {{ slug: string, bill: any, text: string }[]} jobs
 * @param {{ anthropic?: any, now?: () => number, sleep?: (ms: number) => Promise<void>, maxWaitMs?: number, log?: (msg: string) => void }} [opts]
 * @returns {Promise<Map<string, { ok: boolean, dec?: any, reason?: string, summary?: string }>>}
 */
export async function decodeBatched(jobs, {
  anthropic,
  now = () => Date.now(),
  sleep = defaultSleep,
  maxWaitMs,
  log = console.log,
} = {}) {
  // A caller-supplied number wins as-is (the tests drive the clock with one);
  // otherwise the env var goes through the guard above rather than through a
  // bare Number(), which used to turn a typo into an unbounded wait.
  const waitMs = Number.isFinite(maxWaitMs) && maxWaitMs > 0
    ? maxWaitMs
    : resolveMaxWaitMs(maxWaitMs ?? process.env.DECODE_BATCH_MAX_WAIT_MS, log);
  const out = new Map();
  if (jobs.length === 0) return out;

  let summaries = new Map();
  try {
    const round1 = await runRound({
      anthropic, requests: buildSummaryRequests(jobs), label: 'summaries', now, sleep, maxWaitMs: waitMs, log,
    });
    summaries = round1.texts;
  } catch (e) {
    log(`::warning::decode-batch: summary batch could not be created (${e.message}) — every bill falls back to a synchronous decode.`);
    for (const j of jobs) out.set(j.slug, { ok: false, reason: 'batch-create-failed' });
    return out;
  }

  let structures = new Map();
  try {
    const round2 = await runRound({
      anthropic, requests: buildStructureRequests(jobs, summaries), label: 'structure', now, sleep, maxWaitMs: waitMs, log,
    });
    structures = round2.texts;
  } catch (e) {
    log(`::warning::decode-batch: structure batch could not be created (${e.message}) — those bills fall back to a synchronous decode.`);
  }

  for (const j of jobs) {
    const summary = summaries.get(j.slug);
    if (!summary) { out.set(j.slug, { ok: false, reason: 'no-summary' }); continue; }
    const structure = structures.get(j.slug);
    if (!structure) { out.set(j.slug, { ok: false, reason: 'no-structure', summary }); continue; }
    try {
      // The SAME gate the synchronous path uses, not a second, looser one:
      // a reply missing a required field throws here exactly as it does
      // there, and the bill is not published.
      out.set(j.slug, { ok: true, dec: assembleDecode(summary, structure) });
    } catch (e) {
      // The summary rides along here too: a structure reply that failed the
      // shape check is the one case where re-running call 2 alone is likeliest
      // to succeed, and call 1's paragraph was fine.
      out.set(j.slug, { ok: false, reason: `bad-shape: ${e.message}`, summary });
    }
  }
  return out;
}
