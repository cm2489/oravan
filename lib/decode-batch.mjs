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
 * price, exactly as it did before this file existed — EXCEPT for one case,
 * below. There is no path where a bill that would have been decoded is
 * silently dropped.
 *
 * THE ONE EXCEPTION: A SLOW BATCH IS PARKED, NOT RE-BOUGHT (2026-09-25). Two of
 * the first seven batched nights (2026-09-23, 54 bills; 2026-09-24, 12 bills)
 * ran past the 8-minute round-1 ceiling. Both times the batch was cancelled and
 * every bill was decoded synchronously at full price — 66 decodes at double the
 * rate this file exists to pay, plus whatever the batch had already processed
 * before the cancel landed, which is billed too. And the fallback was not even
 * fast: at ~22 seconds a bill it held the data-sync concurrency group for
 * another 20 minutes on 09-23. A slow batch is not a failed one — it finishes
 * within 24 hours and its results stay readable for 29 days — so for a caller
 * that passes `canPark`/`onPark`, a round that runs out of wait is no longer
 * cancelled for the bills that can wait a night. Its id is handed to `onPark`
 * (the caller persists it in data/decode-batch-parked.json), those bills come
 * back `{ ok: false, parked: true }` — not decoded, not failed — and the next
 * run collects the result through harvestParked() BEFORE it submits anything
 * new, so a parked bill is paid for exactly once (one narrow, chosen exception
 * is spelled out at drainDecodeQueue). A bill that cannot wait
 * (canPark false: see isTimeCriticalDecode) rides in its OWN batch in the same
 * round, and that batch keeps the old behaviour exactly — cancelled at the
 * deadline, decoded synchronously the same night — so splitting them is what
 * lets parking cost those bills nothing extra either. A caller that passes
 * neither option gets the pre-2026-09-25 behaviour byte for byte.
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
  completeDecode,
  decodeBill,
  decodeStructureFrom,
  textFingerprint,
} from '../scripts/bill-decode.mjs';
import { bumpCounter, recordApiError } from '../scripts/run-counters.mjs';
import { classifyApiError } from '../scripts/api-billing.mjs';
import { docketRung, isActNow } from './docket.mjs';

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
 * minutes is therefore an outlier. What happens to an outlier changed on
 * 2026-09-25 (see the header): a bill that can wait a night is PARKED and
 * collected by the next run at the batch rate; a time-critical bill is still
 * abandoned, cancelled and decoded synchronously at full price, because a stale
 * homepage costs more than the discount saves. DECODE_BATCH_MAX_WAIT_MS
 * overrides it for a one-off catch-up run when nothing else is queued.
 *
 * WHY THE CEILING WAS NOT SIMPLY RAISED (2026-09-25, measured). The decode
 * batch's own record, seven nights 2026-09-19..09-24: ten rounds that finished
 * took 2m02s-4m02s (both rounds, 8 to 41 requests); two round-1 batches (54 and
 * 12 requests) were still running at 8 minutes. Nothing tells us when those two
 * would have ended — they were cancelled — and the pregen batch on the same
 * account ran past a 20-minute ceiling on 2026-09-24 while finishing in 3m50s
 * that evening. So the tail is long and unbounded by anything we can see: a
 * 20-minute ceiling would buy up to 12 more minutes of the data-sync group on
 * every slow night and still not be a guarantee. Parking costs a slow night
 * NOTHING in wall-clock beyond the 8 minutes already spent, and it removes the
 * synchronous fallback's own ~22s-per-bill hold (20 minutes on 09-23).
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
 *
 * `park` (2026-09-25) changes what giving up MEANS, and nothing else. With it
 * set, a batch that runs out of wait, cannot be polled, or ended but could not
 * be read is NOT cancelled: it is still working (or already done) on requests
 * we have paid for, its results stay readable for 29 days, and the caller is
 * going to collect them next run. It comes back `{ parked: true }` carrying the
 * id. Cancelling it would throw that work away and make the next run buy it
 * again, which is the exact double payment parking exists to end.
 */
async function runRound({ anthropic, requests, label, now, sleep, maxWaitMs, log, park = false }) {
  const out = new Map();
  if (requests.length === 0) return { texts: out, timedOut: false, parked: false, batchId: null };
  const batch = await anthropic.messages.batches.create({ requests });
  log(`decode-batch: ${label} submitted batch ${batch.id} (${requests.length} request(s))`);
  const parkIt = (why) => {
    log(
      `::warning::decode-batch: ${label} batch ${batch.id} ${why} — PARKED for the next run to collect, not cancelled. ` +
        `Its ${requests.length} bill(s) are not decoded tonight and will not be bought twice; ` +
        'the batch keeps its 50% rate.'
    );
    return { texts: out, timedOut: true, parked: true, batchId: batch.id };
  };

  const deadline = now() + maxWaitMs;
  let current = batch;
  while (current.processing_status !== 'ended') {
    if (now() >= deadline) {
      if (park) return parkIt(`still processing after ${maxWaitMs}ms`);
      log(
        `::warning::decode-batch: ${label} batch ${batch.id} still processing after ${maxWaitMs}ms — ` +
          'abandoning it and decoding those bills synchronously instead. The night still lands; it costs full price.'
      );
      await cancelBatch(anthropic, batch.id, label, log);
      return { texts: out, timedOut: true, parked: false, batchId: batch.id };
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
      if (park) return parkIt(`could not be polled (${e.message})`);
      log(
        `::warning::decode-batch: ${label} batch ${batch.id} could not be polled (${e.message}) — ` +
          'treating it as a timeout: it is cancelled and those bills are finished synchronously.'
      );
      await cancelBatch(anthropic, batch.id, label, log);
      return { texts: out, timedOut: true, parked: false, batchId: batch.id };
    }
  }

  // The results stream is the last thing that can fail, and by here the batch
  // has ENDED and been billed — so a failure to read it must not discard the
  // round before it either. Same verdict as a timeout, minus the cancel: there
  // is nothing left to cancel. A parked batch's results are simply read again
  // next run, which costs nothing.
  try {
    const results = await anthropic.messages.batches.results(batch.id);
    for await (const row of results) {
      const text = extractText(row);
      if (text) out.set(row.custom_id, text);
      else log(`decode-batch: ${label} ${row.custom_id} did not succeed (${row?.result?.type ?? 'unknown'})`);
    }
  } catch (e) {
    if (park) return parkIt(`ended but its results could not be read (${e.message})`);
    log(
      `::warning::decode-batch: ${label} batch ${batch.id} ended but its results could not be read (${e.message}) — ` +
        'those bills are finished synchronously.'
    );
    return { texts: out, timedOut: true, parked: false, batchId: batch.id };
  }
  return { texts: out, timedOut: false, parked: false, batchId: batch.id };
}

/**
 * Run one round as up to TWO batches, concurrently: the bills that must land
 * tonight, and the bills that may be parked. Split so that a slow batch can be
 * cancelled for the first group without cancelling the second — batches cancel
 * whole, never per request. When either group is empty (every night with no
 * time-critical bill, and every caller that does not park) this is exactly one
 * batch, as before.
 *
 * Each group's create failure is caught on its own, so one group failing to be
 * created never takes the other's result down with it.
 *
 * @returns {Promise<Array<{ jobs: any[], park: boolean, texts: Map<string,string>, parked: boolean, batchId: string|null, createFailed: boolean, error?: string }>>}
 */
async function runRoundGroups({ groups, buildRequests, label, anthropic, now, sleep, maxWaitMs, log }) {
  const live = groups.filter((g) => g.jobs.length > 0);
  const labelled = (g) => (live.length > 1 ? `${label} (${g.park ? 'can wait' : 'time-critical'})` : label);
  return Promise.all(
    live.map(async (g) => {
      try {
        const r = await runRound({
          anthropic, requests: buildRequests(g.jobs), label: labelled(g), now, sleep, maxWaitMs, log, park: g.park,
        });
        return { ...g, texts: r.texts, parked: r.parked, batchId: r.batchId, createFailed: false };
      } catch (e) {
        return { ...g, texts: new Map(), parked: false, batchId: null, createFailed: true, error: e.message };
      }
    })
  );
}


/** The fingerprint of a job's round-1 INPUT — the exact prompt call 1 is sent.
 *  The same function completeDecode stamps as `decode_text_sha`, so "the parked
 *  summary was written from the document we hold tonight" is one comparison. */
export function jobPromptSha(job) {
  return textFingerprint(buildSummaryPrompt(job.bill, job.text));
}

/**
 * Decode a list of `{ slug, bill, text }` jobs through two batch rounds.
 *
 * Returns a Map keyed by slug: `{ ok: true, dec }` for a decode that passed
 * assembleDecode's shape gate, `{ ok: false, reason }` for anything else.
 * NEVER throws — a thrown batch create is caught and reported as every job
 * in that batch failing, because the caller's answer to a failure is always
 * the same and it must not be "abort the night".
 *
 * A FAILURE CARRIES WHAT IT DID GET (2026-09-19). When round 1 delivered a
 * summary and round 2 did not, the `{ ok: false }` entry carries that
 * `summary`. The batch has already been billed for it; a caller that ignored it
 * and re-ran the whole decode would buy the same paragraph twice. The caller
 * finishes those with scripts/bill-decode.mjs's `decodeStructureFrom` and pays
 * only for the half that is genuinely missing.
 *
 * PARKING (2026-09-25), opt-in. With `canPark(job)` and `onPark(entry)` both
 * supplied, a job `canPark` says may wait a night rides in its own batch, and
 * when that batch outlasts the wait it is handed to `onPark` instead of being
 * cancelled. The job comes back `{ ok: false, parked: true, reason: 'parked' }`
 * and the CALLER must treat it as neither decoded nor failed: not in the
 * corpus, not re-bought tonight, and — this is the cursor half — still needing
 * work. `onPark` receives `{ id, round, parkedAt, jobs: [{ slug, promptSha,
 * summaryBatch?, summaryAt? }] }`: ids and fingerprints, never content.
 *
 * `prefilled` (slug -> { text, batch, at }) is the other end of that: summaries
 * a previous run's parked batch already produced, which harvestParked() read
 * back. Those jobs skip round 1 entirely — the paragraph is already paid for —
 * and go straight to round 2. The caller is responsible for only prefilling a
 * summary whose `promptSha` matches the job's input tonight.
 *
 * @param {{ slug: string, bill: any, text: string, pass?: string }[]} jobs
 * @param {{ anthropic?: any, now?: () => number, sleep?: (ms: number) => Promise<void>, maxWaitMs?: number,
 *           log?: (msg: string) => void, prefilled?: Map<string, { text: string, batch?: string|null, at?: string|null }>,
 *           canPark?: ((job: any) => boolean) | null, onPark?: ((entry: any) => void) | null }} [opts]
 * @returns {Promise<Map<string, { ok: boolean, dec?: any, reason?: string, summary?: string, parked?: boolean }>>}
 */
export async function decodeBatched(jobs, {
  anthropic,
  now = () => Date.now(),
  sleep = defaultSleep,
  maxWaitMs,
  log = console.log,
  prefilled = new Map(),
  canPark = null,
  onPark = null,
} = {}) {
  // A caller-supplied number wins as-is (the tests drive the clock with one);
  // otherwise the env var goes through the guard above rather than through a
  // bare Number(), which used to turn a typo into an unbounded wait.
  const waitMs = Number.isFinite(maxWaitMs) && maxWaitMs > 0
    ? maxWaitMs
    : resolveMaxWaitMs(maxWaitMs ?? process.env.DECODE_BATCH_MAX_WAIT_MS, log);
  const out = new Map();
  if (jobs.length === 0) return out;

  const parking = typeof canPark === 'function' && typeof onPark === 'function';
  const mayPark = (j) => {
    if (!parking) return false;
    try { return Boolean(canPark(j)); } catch { return false; } // an unreadable verdict decodes tonight
  };
  const stamp = () => new Date(now()).toISOString();

  // slug -> { text, batch, at }: where each job's summary came from, because a
  // round-2 park has to say where the next run can read that summary back.
  const summaries = new Map();
  for (const j of jobs) {
    const p = prefilled?.get?.(j.slug);
    if (p && typeof p.text === 'string' && p.text) {
      summaries.set(j.slug, { text: p.text, batch: p.batch ?? null, at: p.at ?? null });
    }
  }
  const parked = new Set();
  const createFailed = new Set();

  // ---- Round 1: summaries, for every job that does not already hold one ----
  const r1Jobs = jobs.filter((j) => !summaries.has(j.slug));
  const r1At = stamp();
  const round1 = await runRoundGroups({
    groups: [
      { jobs: r1Jobs.filter((j) => !mayPark(j)), park: false },
      { jobs: r1Jobs.filter((j) => mayPark(j)), park: true },
    ],
    buildRequests: buildSummaryRequests,
    label: 'summaries',
    anthropic, now, sleep, maxWaitMs: waitMs, log,
  });
  for (const g of round1) {
    if (g.createFailed) {
      log(`::warning::decode-batch: summary batch could not be created (${g.error}) — ${g.jobs.length} bill(s) fall back to a synchronous decode.`);
      for (const j of g.jobs) createFailed.add(j.slug);
      continue;
    }
    if (g.parked) {
      onPark({
        id: g.batchId,
        round: 'summaries',
        parkedAt: stamp(),
        jobs: g.jobs.map((j) => ({ slug: j.slug, promptSha: jobPromptSha(j) })),
      });
      for (const j of g.jobs) parked.add(j.slug);
      continue;
    }
    for (const [slug, text] of g.texts) summaries.set(slug, { text, batch: g.batchId, at: r1At });
  }

  // ---- Round 2: structure, for every job holding a summary ----------------
  // A job may be parked in round 2 only if the next run can read its summary
  // back, i.e. the summary came out of a batch (tonight's or a harvested one).
  const r2Jobs = jobs.filter((j) => summaries.has(j.slug) && !parked.has(j.slug));
  const r2Parkable = (j) => mayPark(j) && Boolean(summaries.get(j.slug)?.batch);
  const summaryTexts = new Map([...summaries].map(([slug, s]) => [slug, s.text]));
  const round2 = await runRoundGroups({
    groups: [
      { jobs: r2Jobs.filter((j) => !r2Parkable(j)), park: false },
      { jobs: r2Jobs.filter((j) => r2Parkable(j)), park: true },
    ],
    buildRequests: (gJobs) => buildStructureRequests(gJobs, summaryTexts),
    label: 'structure',
    anthropic, now, sleep, maxWaitMs: waitMs, log,
  });
  const structures = new Map();
  for (const g of round2) {
    if (g.createFailed) {
      log(`::warning::decode-batch: structure batch could not be created (${g.error}) — those bills fall back to a synchronous decode.`);
      continue;
    }
    if (g.parked) {
      onPark({
        id: g.batchId,
        round: 'structure',
        parkedAt: stamp(),
        jobs: g.jobs.map((j) => ({
          slug: j.slug,
          promptSha: jobPromptSha(j),
          summaryBatch: summaries.get(j.slug).batch,
          summaryAt: summaries.get(j.slug).at ?? null,
        })),
      });
      for (const j of g.jobs) parked.add(j.slug);
      continue;
    }
    for (const [slug, text] of g.texts) structures.set(slug, text);
  }

  for (const j of jobs) {
    if (parked.has(j.slug)) { out.set(j.slug, { ok: false, reason: 'parked', parked: true }); continue; }
    if (createFailed.has(j.slug)) { out.set(j.slug, { ok: false, reason: 'batch-create-failed' }); continue; }
    const summary = summaries.get(j.slug)?.text;
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

// ===========================================================================
// PARKED BATCHES — the state file, the harvest, and who may wait (2026-09-25)
// ===========================================================================

/*
 * WHERE A PARKED BATCH IS REMEMBERED: data/decode-batch-parked.json, a file of
 * its own. Not data/sync-state.json, for three reasons that each hold alone:
 *   - sync-state.json is imported by the SITE (lib/freshness.ts, the bill page,
 *     the feeds), so anything written there ships in the build. Batch
 *     bookkeeping has no business in a page bundle.
 *   - It is a flat file of independent scalar keys, and the one conflict
 *     resolver the commit step trusts (scripts/merge-sync-state.mjs) is built on
 *     exactly that shape; a nested list would be the first value it cannot
 *     union.
 *   - This file has ONE writer — this pipeline, inside the data-sync
 *     concurrency group — so the commit step's rebase can never meet a content
 *     conflict in it.
 * It rides the same `git add data/` commit as the cursor, which is the point:
 * the cursor that froze on a parked bill and the record of where to collect it
 * land together or not at all.
 *
 * WHAT IS IN IT: batch ids, bill slugs, 16-hex prompt fingerprints and
 * timestamps. No model output — the summaries stay on Anthropic's side and are
 * read back by id — so nothing AI-written reaches the repo before the publish
 * gate. The ids are already printed in this public repo's Actions logs and are
 * inert without the API key; committing them exposes nothing new.
 */
export const PARKED_PATH = 'data/decode-batch-parked.json';
export const PARKED_SCHEMA = 'decode-batch-parked/v1';

/** Results are readable for 29 days after a batch is CREATED (Anthropic's
 *  published retention). A day of margin, measured from when we parked it —
 *  which is up to one wait ceiling after creation. */
export const PARK_RETENTION_MS = 28 * 24 * 3_600_000;

/** A batch cannot process for longer than 24 hours — it expires and ENDS. So a
 *  parked batch that still reports "not ended", or that we still cannot read,
 *  36 hours after we parked it is not slow: something is wrong with it, or
 *  with us. Past this line it stops blocking its bills (they are resubmitted)
 *  rather than holding them hostage for the rest of the retention window. */
export const PARK_BLOCK_MAX_MS = 36 * 3_600_000;

/** @returns {{ schema: string, batches: any[] }} */
export function emptyParkedState() {
  return { schema: PARKED_SCHEMA, batches: [] };
}

const SLUG_RE = /^[a-z]+-\d+-\d+$/;
const SHA_RE = /^[0-9a-f]{16}$/;

/**
 * Parse the state file's contents FAIL-CLOSED per entry: a malformed entry is
 * dropped (and reported), never trusted. A dropped entry can only cost the
 * batch rate on bills that are then resubmitted; a trusted malformed one could
 * hand a summary to the wrong bill.
 *
 * @param {unknown} raw parsed JSON, or null/undefined for "no file"
 * @param {(msg: string) => void} [log]
 * @returns {{ schema: string, batches: any[] }}
 */
export function normalizeParkedState(raw, log = () => {}) {
  const state = emptyParkedState();
  if (raw === null || raw === undefined) return state;
  const list = /** @type {any} */ (raw)?.batches;
  if (!Array.isArray(list)) {
    log(`::warning::decode-batch: ${PARKED_PATH} has no readable "batches" list — treating it as empty.`);
    return state;
  }
  for (const e of list) {
    const okEntry =
      e && typeof e.id === 'string' && e.id &&
      (e.round === 'summaries' || e.round === 'structure') &&
      Number.isFinite(Date.parse(e.parkedAt)) &&
      Array.isArray(e.jobs);
    if (!okEntry) {
      log(`::warning::decode-batch: dropped an unreadable parked entry from ${PARKED_PATH}: ${String(JSON.stringify(e)).slice(0, 200)}`);
      continue;
    }
    const jobs = e.jobs.filter((j) =>
      j && SLUG_RE.test(String(j.slug)) && SHA_RE.test(String(j.promptSha)) &&
      (e.round === 'summaries' || (typeof j.summaryBatch === 'string' && j.summaryBatch))
    );
    if (jobs.length !== e.jobs.length) {
      log(`::warning::decode-batch: parked batch ${e.id} carried ${e.jobs.length - jobs.length} unreadable job(s) — dropped.`);
    }
    if (jobs.length) state.batches.push({ id: e.id, round: e.round, parkedAt: e.parkedAt, jobs });
  }
  return state;
}

/** Every slug the state is still holding a decode for. */
export function parkedSlugs(state) {
  return new Set((state?.batches ?? []).flatMap((e) => e.jobs.map((j) => j.slug)));
}

/**
 * The oldest instant a job's parked output depends on: its own batch, and — for
 * a round-2 park — the batch its summary has to be read back from.
 */
function jobOldestAt(entry, job) {
  const at = [Date.parse(entry.parkedAt)];
  if (job.summaryAt) at.push(Date.parse(job.summaryAt));
  return Math.min(...at.filter(Number.isFinite));
}

/**
 * Drop what no longer needs collecting, before anything is asked of the API:
 *   - a job whose bill is already in the corpus (the newsdesk, a force run or a
 *     later night decoded it — the parked output would be a second decode);
 *   - a job whose output is past the results retention window.
 * Entries left with no jobs disappear. Pure.
 *
 * @param {{ batches: any[] }} state
 * @param {{ now: number, inCorpus: (slug: string) => boolean, log?: (msg: string) => void }} ctx
 */
export function pruneParkedState(state, { now, inCorpus, log = () => {} }) {
  const batches = [];
  for (const e of state.batches) {
    const jobs = e.jobs.filter((j) => {
      if (inCorpus(j.slug)) return false;
      if (now - jobOldestAt(e, j) > PARK_RETENTION_MS) {
        log(`decode-batch: parked ${j.slug} in batch ${e.id} is past the results retention window — forgotten; the bill is resubmitted when it next comes up.`);
        return false;
      }
      return true;
    });
    if (jobs.length) batches.push({ ...e, jobs });
  }
  return { ...state, batches };
}

/**
 * Read back whatever tonight's queue can use from batches earlier runs parked —
 * BEFORE the caller submits anything new, so a bill whose decode is already
 * paid for is never submitted again.
 *
 * Only entries holding a slug in `wanted` are asked about at all; the rest are
 * kept untouched (and free) for a later night.
 *
 * Per entry:
 *   - ENDED and readable: every wanted job's output is returned — `summaries`
 *     (slug -> { text, batch, at, promptSha }) and, for a round-2 entry, also
 *     `structures` (slug -> text), with the summary read back from the batch
 *     that produced it. Reading results is free and repeatable for 29 days.
 *     The entry's wanted slugs are reported in `settled`: whatever tonight
 *     does with them, that batch has nothing more to give them.
 *   - NOT ended, or unreadable (a 5xx, a network failure): its wanted jobs are
 *     `blocked` — the caller must not submit them tonight, because the batch
 *     may still deliver them and submitting again would pay twice — UNLESS the
 *     entry is older than PARK_BLOCK_MAX_MS, which a healthy batch cannot be;
 *     then it is dropped and its bills are resubmitted.
 *   - UNKNOWN to the API (404: expired, deleted, another workspace's id): the
 *     entry is dropped. A dead id must never wedge a bill.
 *
 * NEVER throws. The worst a failure here can do is block a bill for one more
 * night or cost it the batch rate — both bounded, neither silent.
 *
 * @param {{ batches: any[] }} state already pruned
 * @param {{ anthropic: any, wanted: Set<string>, now?: number, log?: (msg: string) => void }} ctx
 */
export async function harvestParked(state, { anthropic, wanted, now = Date.now(), log = console.log }) {
  const summaries = new Map();
  const structures = new Map();
  const blocked = new Set();
  const settled = new Set();
  const keep = [];
  const results = new Map(); // batch id -> Map<custom_id, text> | null (unreadable)

  const readResults = async (id) => {
    if (results.has(id)) return results.get(id);
    try {
      const texts = new Map();
      for await (const row of await anthropic.messages.batches.results(id)) {
        const text = extractText(row);
        if (text) texts.set(row.custom_id, text);
      }
      results.set(id, texts);
    } catch (e) {
      log(`::warning::decode-batch: parked batch ${id}'s results could not be read (${e?.message ?? e}).`);
      results.set(id, null);
    }
    return results.get(id);
  };

  for (const entry of state.batches) {
    const relevant = entry.jobs.filter((j) => wanted.has(j.slug));
    if (relevant.length === 0) { keep.push(entry); continue; }
    const age = now - Date.parse(entry.parkedAt);
    const blockOrDrop = (why) => {
      if (age > PARK_BLOCK_MAX_MS) {
        log(
          `::warning::decode-batch: parked batch ${entry.id} ${why} ${Math.round(age / 3_600_000)}h after it was parked — ` +
            'longer than any batch can run, so it is forgotten and its bills are resubmitted tonight.'
        );
        return; // dropped
      }
      log(
        `decode-batch: parked batch ${entry.id} ${why} — its ${relevant.length} bill(s) are held back tonight rather than bought twice, and it stays parked.`
      );
      for (const j of relevant) blocked.add(j.slug);
      keep.push(entry);
    };

    let status = null;
    try {
      status = (await anthropic.messages.batches.retrieve(entry.id))?.processing_status ?? null;
    } catch (e) {
      if (e?.status === 404) {
        log(`::warning::decode-batch: parked batch ${entry.id} is unknown to the API (404) — forgotten; its bills are resubmitted.`);
        continue;
      }
      blockOrDrop(`could not be checked (${e?.message ?? e})`);
      continue;
    }
    if (status !== 'ended') { blockOrDrop(`is still ${status ?? 'in an unknown state'}`); continue; }

    const texts = await readResults(entry.id);
    if (!texts) { blockOrDrop('ended, but its results could not be read'); continue; }
    for (const j of relevant) {
      if (entry.round === 'summaries') {
        settled.add(j.slug);
        const text = texts.get(j.slug);
        if (text) summaries.set(j.slug, { text, batch: entry.id, at: entry.parkedAt, promptSha: j.promptSha });
        continue;
      }
      // A round-2 entry: its structure is here, its summary is one batch back.
      const sums = await readResults(j.summaryBatch);
      if (sums === null && age <= PARK_BLOCK_MAX_MS) {
        // The summary's batch could not be READ (not "had no row"): the paid
        // paragraph may still be there next run. Hold the bill rather than buy
        // that paragraph again.
        blocked.add(j.slug);
        continue;
      }
      settled.add(j.slug);
      const summary = sums?.get(j.slug);
      if (!summary) continue; // nothing reusable — the bill is simply resubmitted
      summaries.set(j.slug, { text: summary, batch: j.summaryBatch, at: j.summaryAt ?? null, promptSha: j.promptSha });
      const structure = texts.get(j.slug);
      if (structure) structures.set(j.slug, structure);
    }
    keep.push(entry);
  }
  return { summaries, structures, blocked, settled, state: { ...state, batches: keep } };
}

/**
 * The state to write back after tonight's drain.
 *
 * A job leaves the file when tonight settled it one way or the other:
 *   - its bill is in the corpus now (it landed — or was already there);
 *   - `settled` says so: its entry was read tonight and its output was used,
 *     came back empty, or was written from an input that no longer matches, so
 *     there is nothing left in that batch worth coming back for;
 *   - tonight parked it AGAIN, in a newer batch, which supersedes the old one.
 * Everything else stays: a bill that was blocked, deferred by the budget, or not
 * reached keeps its entry, so a later run can still collect what was paid for.
 * Then tonight's new parks are appended. Pure.
 *
 * @param {{ batches: any[] }} state
 * @param {{ added: any[], settled: Set<string>, inCorpus: (slug: string) => boolean }} ctx
 * @returns {{ schema: string, batches: any[] }}
 */
export function finalizeParkedState(state, { added, settled, inCorpus }) {
  const reParked = new Set(added.flatMap((e) => e.jobs.map((j) => j.slug)));
  const batches = [];
  for (const e of state.batches) {
    const jobs = e.jobs.filter((j) => !inCorpus(j.slug) && !settled.has(j.slug) && !reParked.has(j.slug));
    if (jobs.length) batches.push({ ...e, jobs });
  }
  return { schema: PARKED_SCHEMA, batches: [...batches, ...added] };
}

/**
 * WHO MAY WAIT A NIGHT, and who may not. A queued decode is TIME-CRITICAL —
 * decoded synchronously the same night when its batch runs long, exactly as
 * before parking existed — when any one of these is true:
 *
 *   1. It came from FORCE_DECODE_SLUGS (`pass === 'force'`). That list is an
 *      owner's explicit order on a manual dispatch; making it wait for the
 *      next scheduled run would make the dispatch pointless.
 *   2. It is a vehicle of a LIVE Big Question (data/moments.json, stored
 *      status 'live'). A question whose vehicle has no page is a question
 *      readers cannot follow through.
 *   3. It would stand in the homepage's ACT-NOW POOL — lib/docket.mjs's
 *      `isActNow(docketRung(...))`, T0 ∪ T1 ∪ T2: announced for the floor, on
 *      the floor in the record's own words, or a dated calendar placement
 *      inside the signal window. The SAME predicate the crown, the homepage
 *      shortlist, MCP `whats_moving` and both feeds read, so "time-critical"
 *      here can never disagree with "moving this week" on the site.
 *
 * Everything else can wait. Measured on the 66 decodes the two slow nights
 * paid full price for (2026-09-23/24, rung computed against today's corpus and
 * signals, so approximate): 2 were act-now (T2), 7 were T3 (a fresh markup),
 * 57 were T4 — backlog bills whose last action is weeks or months old — and
 * none was a Big Question vehicle. T3 is deliberately NOT here: it is
 * "Moving", not "Deciding now", and a markup that happened last week does not
 * change if its explanation appears a night later. Widening this to T3 is a
 * one-line change if that call goes the other way.
 *
 * @param {{ slug?: string, bill?: any, pass?: string }} job
 * @param {{ liveVehicles?: Set<string>, floorSignals?: Record<string, any>, now?: number }} [ctx]
 * @returns {boolean}
 */
export function isTimeCriticalDecode(job, { liveVehicles = new Set(), floorSignals = {}, now = Date.now() } = {}) {
  if (job?.pass === 'force') return true;
  const slug = job?.slug ?? null;
  if (slug && liveVehicles.has(slug)) return true;
  const signal = (slug && floorSignals && floorSignals[slug]) || null;
  return isActNow(docketRung(job?.bill ?? {}, signal, { now }));
}

/**
 * The bill slugs that are vehicles of a live Big Question, from
 * data/moments.json's parsed contents. Nomination vehicles (`kind:
 * 'nomination'`) are skipped — this pipeline decodes bills only.
 *
 * @param {unknown} moments
 * @returns {Set<string>}
 */
export function liveVehicleSlugs(moments) {
  const out = new Set();
  if (!moments || typeof moments !== 'object') return out;
  for (const m of Object.values(/** @type {Record<string, any>} */ (moments))) {
    if (m?.status !== 'live' || !Array.isArray(m.vehicles)) continue;
    for (const v of m.vehicles) {
      if ((v?.kind ?? 'bill') === 'bill' && typeof v?.slug === 'string') out.add(v.slug);
    }
  }
  return out;
}

// ===========================================================================
// THE NIGHTLY DRAIN
// ===========================================================================

/**
 * THE BATCH DRAIN, as one function the tests can drive (2026-09-25; it used to
 * be inline in scripts/sync-bills.mjs's script body, where nothing could pin
 * it). It lives HERE rather than in that script for a reason worth knowing:
 * that script's body runs as top-level await inside its argv guard, and the
 * test runner can only load it because its babel transform turns every
 * `await importedFn(...)` into `await (0, _mod.importedFn)(...)` — which, in
 * the CommonJS it emits, parses as a harmless call to an identifier named
 * `await` in a block that never runs. An `await` on a function DEFINED in that
 * file has no such wrapper, fails to parse as CommonJS, and takes every spec
 * that imports sync-bills.mjs down with it. Imported, the call is safe.
 *
 * Every decode the night decided to spend is spent here, in this order:
 *
 *   1. COLLECT FIRST. Batches an earlier run parked are read back
 *      (harvestParked above) BEFORE anything new is submitted. A queued bill whose summary is already paid for skips round
 *      1; one whose whole decode is already paid for is assembled with no
 *      request at all. A bill whose parked batch is still running is HELD BACK
 *      — deferred, never resubmitted — unless it is time-critical. That is the
 *      ONE case this design pays twice, and it is chosen: a bill that became
 *      time-critical (or was forced) while its batch is still running cannot
 *      wait, and a batch cannot be cancelled for one request. It needs the
 *      parked batch to still be running at the next run, which a scheduled
 *      nightly ~24h later essentially never meets (batches end within 24h). The
 *      reuse is guarded by the prompt fingerprint: a parked summary is used
 *      only when it was written from the exact input (title + text) we hold
 *      tonight.
 *   2. SUBMIT the rest through decodeBatched, parking what can wait if the
 *      batch runs long.
 *   3. FALL BACK synchronously for anything the batch could not deliver and
 *      did not park — the same path as before, paying only for the missing
 *      half when round 1 delivered.
 *   4. STORE through completeDecode, the one writer.
 *
 * WHAT THE CALLER GETS BACK, and the one rule it must keep: `failedSlugs` AND
 * `deferredSlugs` both mean "this bill is not in the corpus and still needs
 * work", and both must reach resolveCursorRows. A deferred (parked or held)
 * bill is NOT a failure — it never counts toward the honesty alarm or the
 * mostly-failed abort — but the cursor must not walk past it any more than it
 * may walk past a failed one (#255's invariant: a queued decode that does not
 * land never lets the cursor advance past a missing bill).
 *
 * `isTimeCritical` defaults to "everything is", which parks nothing: the
 * pre-2026-09-25 drain.
 *
 * @param {any[]} decodeQueue jobs from syncOneBill's 'queued_decode' (+ `pass`)
 * @param {{ anthropic: any, bills: any[], es: Record<string, any>, bySlug: Map<string, any>,
 *           parkedState?: { batches: any[] }, isTimeCritical?: (job: any) => boolean,
 *           noDecodeNeeded?: Set<string>, now?: () => number, sleep?: (ms: number) => Promise<void>,
 *           maxWaitMs?: number, log?: (msg: string) => void, logError?: (msg: string) => void }} ctx
 */
export async function drainDecodeQueue(decodeQueue, {
  anthropic, bills, es, bySlug,
  parkedState = emptyParkedState(),
  isTimeCritical = () => true,
  noDecodeNeeded = new Set(),
  now = () => Date.now(),
  sleep,
  maxWaitMs,
  log = console.log,
  logError = console.error,
}) {
  const queue = Array.isArray(decodeQueue) ? decodeQueue : [];
  const failedSlugs = new Set();
  const deferredSlugs = new Set();
  const inCorpus = (slug) => bySlug.has(slug);
  const pruned = pruneParkedState(parkedState, { now: now(), inCorpus, log });
  const tally = { batchDecoded: 0, harvested: 0, syncFallback: 0, parked: 0, held: 0 };
  if (queue.length === 0) {
    return {
      ...tally, failedSlugs, deferredSlugs,
      parkedState: finalizeParkedState(pruned, { added: [], settled: noDecodeNeeded, inCorpus }),
    };
  }

  // Judged ONCE per job, so the batch split and the hold-back rule can never
  // disagree about the same bill.
  const critical = new Map(queue.map((job) => {
    let v = true;
    try { v = Boolean(isTimeCritical(job)); } catch { v = true; }
    return [job.slug, v];
  }));

  // ---- 1. Collect what earlier runs parked ----------------------------------
  const harvest = await harvestParked(pruned, {
    anthropic, wanted: new Set(queue.map((j) => j.slug)), now: now(), log,
  });
  const prefilled = new Map();
  const ready = new Map(); // slug -> dec, assembled from a parked round-2 batch
  const usedHarvest = new Set();
  const toSubmit = [];
  for (const job of queue) {
    if (harvest.blocked.has(job.slug) && !critical.get(job.slug)) {
      deferredSlugs.add(job.slug);
      tally.held++;
      continue;
    }
    const h = harvest.summaries.get(job.slug);
    if (h && h.promptSha === jobPromptSha(job)) {
      usedHarvest.add(job.slug);
      const structure = harvest.structures.get(job.slug);
      if (structure) {
        try {
          // The same publish gate every other decode passes through.
          ready.set(job.slug, assembleDecode(h.text, structure));
          continue;
        } catch (e) {
          log(`decode-batch: ${job.slug}'s parked structure failed the shape check (${e.message}) — re-running call 2 only.`);
        }
      }
      prefilled.set(job.slug, h);
    } else if (h) {
      log(`decode-batch: ${job.slug}'s parked summary was written from a different title or text than tonight's — not used; the bill is decoded from the current document.`);
    }
    toSubmit.push(job);
  }
  if (harvest.summaries.size || harvest.blocked.size) {
    log(
      `decode-batch: collected from parked batches — ${ready.size} decode(s) already complete, ${prefilled.size} summar(ies) reused (call 2 only), ${tally.held} bill(s) held back behind a batch still running`
    );
  }

  // ---- 2. Submit the rest -----------------------------------------------------
  const newlyParked = [];
  const decoded = toSubmit.length
    ? await decodeBatched(toSubmit, {
      anthropic, now, sleep, maxWaitMs, log, prefilled,
      canPark: (job) => !critical.get(job.slug),
      onPark: (entry) => newlyParked.push(entry),
    })
    : new Map();

  // ---- 3 + 4. Fall back where needed, then store --------------------------------
  for (const job of queue) {
    if (deferredSlugs.has(job.slug)) continue;
    let dec = ready.get(job.slug) ?? null;
    if (dec) {
      tally.harvested++;
    } else {
      // #246's counter, moved to where the spend moved. `decodeAttempts` is
      // what scripts/check-run-honesty.mjs's rule 3 measures a dead decode
      // path against ("reached the model N times, landed none"). One bump per
      // job that issues a request tonight — through the batch or through the
      // fallback. A decode assembled entirely from a parked batch issues none.
      bumpCounter('decodeAttempts');
      const batched = decoded.get(job.slug);
      if (batched?.parked) {
        deferredSlugs.add(job.slug);
        tally.parked++;
        continue;
      }
      if (batched?.ok) {
        dec = batched.dec;
        if (usedHarvest.has(job.slug)) tally.harvested++;
        else tally.batchDecoded++;
      } else {
        try {
          // PAY FOR THE MISSING HALF, NOT THE WHOLE THING. When the batch (or a
          // parked batch) delivered round 1 and round 2 did not land, the
          // summary is on the failure and has already been billed at the batch
          // rate — re-running decodeBill here would buy that paragraph a second
          // time at full rate for nothing.
          dec = batched?.summary
            ? await decodeStructureFrom(anthropic, job.bill, batched.summary)
            : await decodeBill(anthropic, job.bill, job.text);
          tally.syncFallback++;
          log(`decode-batch: ${job.slug} fell back to a synchronous ${batched?.summary ? 'call 2 only (a batch delivered its summary)' : 'decode'} (${batched?.reason ?? 'no batch result'})`);
        } catch (e) {
          logError(`FAIL ${job.slug}: batch (${batched?.reason ?? 'no batch result'}) then sync decode (${e.message})`);
          // The other half of #246: a refusal the API never billed (a credit
          // balance 400 above all) has to be classified where it is caught, or
          // the post-commit alarm cannot tell an outage from a bad night.
          recordApiError(classifyApiError(e));
          failedSlugs.add(job.slug);
          continue;
        }
      }
    }
    try {
      await completeDecode({
        slug: job.slug, bill: job.bill, text: job.text,
        version: job.version ?? null, count: job.count ?? null,
        dec, bills, es, bySlug, anthropic,
      });
    } catch (e) {
      // completeDecode is the write, not the decode: a throw here means the
      // bill is not in the corpus, so it is a failure like any other.
      logError(`FAIL ${job.slug}: storing the decode threw (${e.message})`);
      failedSlugs.add(job.slug);
    }
  }

  // What tonight settled in the parked file: everything the harvest read back,
  // EXCEPT a bill that reused a parked summary and then failed anyway — its
  // paid-for summary is still worth collecting next run. Plus every parked bill
  // tonight's sync saw and decided needs no decode at all (gated, no text).
  const settled = new Set([...harvest.settled].filter((s) => !(usedHarvest.has(s) && failedSlugs.has(s))));
  for (const s of noDecodeNeeded) settled.add(s);
  return {
    ...tally, failedSlugs, deferredSlugs,
    parkedState: finalizeParkedState(harvest.state, { added: newlyParked, settled, inCorpus }),
  };
}
