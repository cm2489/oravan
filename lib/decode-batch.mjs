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

const DEFAULT_MAX_WAIT_MS = 20 * 60 * 1000;
const POLL_INTERVAL_MS = 15_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      return { texts: out, timedOut: true, batchId: batch.id };
    }
    await sleep(POLL_INTERVAL_MS);
    current = await anthropic.messages.batches.retrieve(batch.id);
  }

  const results = await anthropic.messages.batches.results(batch.id);
  for await (const row of results) {
    const text = extractText(row);
    if (text) out.set(row.custom_id, text);
    else log(`decode-batch: ${label} ${row.custom_id} did not succeed (${row?.result?.type ?? 'unknown'})`);
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
 * The caller decides what to do with `ok: false`. scripts/sync-bills.mjs
 * decodes those synchronously.
 *
 * @param {{ slug: string, bill: any, text: string }[]} jobs
 * @param {{ anthropic?: any, now?: () => number, sleep?: (ms: number) => Promise<void>, maxWaitMs?: number, log?: (msg: string) => void }} [opts]
 * @returns {Promise<Map<string, { ok: boolean, dec?: any, reason?: string }>>}
 */
export async function decodeBatched(jobs, {
  anthropic,
  now = () => Date.now(),
  sleep = defaultSleep,
  maxWaitMs = Number(process.env.DECODE_BATCH_MAX_WAIT_MS ?? DEFAULT_MAX_WAIT_MS),
  log = console.log,
} = {}) {
  const out = new Map();
  if (jobs.length === 0) return out;

  let summaries = new Map();
  try {
    const round1 = await runRound({
      anthropic, requests: buildSummaryRequests(jobs), label: 'summaries', now, sleep, maxWaitMs, log,
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
      anthropic, requests: buildStructureRequests(jobs, summaries), label: 'structure', now, sleep, maxWaitMs, log,
    });
    structures = round2.texts;
  } catch (e) {
    log(`::warning::decode-batch: structure batch could not be created (${e.message}) — those bills fall back to a synchronous decode.`);
  }

  for (const j of jobs) {
    const summary = summaries.get(j.slug);
    if (!summary) { out.set(j.slug, { ok: false, reason: 'no-summary' }); continue; }
    const structure = structures.get(j.slug);
    if (!structure) { out.set(j.slug, { ok: false, reason: 'no-structure' }); continue; }
    try {
      // The SAME gate the synchronous path uses, not a second, looser one:
      // a reply missing a required field throws here exactly as it does
      // there, and the bill is not published.
      out.set(j.slug, { ok: true, dec: assembleDecode(summary, structure) });
    } catch (e) {
      out.set(j.slug, { ok: false, reason: `bad-shape: ${e.message}` });
    }
  }
  return out;
}
