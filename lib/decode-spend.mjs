/**
 * THE NIGHTLY BILL-DECODE SPEND CEILING, and the list prices it is computed
 * from. Pure and import-free, so scripts/bill-decode.mjs, lib/decode-batch.mjs,
 * scripts/sync-bills.mjs, lib/pipeline-health.mjs and the unit specs read one
 * copy.
 *
 * WHY (2026-11-28, the independent check of PR #581). Removing the 60,000-
 * character cut made one decode's price depend on the bill's length: a bill
 * of ~1.4 million cleaned characters (an NDAA, an omnibus) is split into
 * chunks and costs about a dollar to decode, where main's dearest decode was
 * about nine cents. The nightly's caps count BILLS (MAX_NEW_DECODES=60,
 * REDECODE_MAX_PER_NIGHT=10), never dollars, so a night of long bills had no
 * bound in money at all. This file is that bound.
 */

/**
 * List prices, USD per million tokens. The one copy: lib/pipeline-health.mjs
 * re-exports it for the daily digest's estimate.
 */
export const MODEL_PRICE_PER_MTOK = {
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/**
 * Characters per token, measured 2026-09-18 on this model's tokenizer over
 * the stored decode prose (scripts/bill-decode.mjs, the max_tokens note).
 * Applied to bill text too, where it errs HIGH: legal text usually packs more
 * characters into a token, so the estimate counts more tokens than are sent.
 */
export const DECODE_CHARS_PER_TOKEN = 3.1;

/**
 * The search-input call a new decode makes (scripts/search-inputs.mjs: Haiku,
 * max_tokens 200). Its prompt is ~2,000 characters of fixed instruction plus
 * the title, headline and TLDR, so ~1,200 tokens is a generous ceiling.
 */
export const SEARCH_INPUTS_ESTIMATE = { priceKey: 'claude-haiku-4-5', inputTokens: 1_200, outputTokens: 200 };

/*
 * THE CEILING. ONE constant, read by the nightly sync (scripts/sync-bills.mjs)
 * and nothing else.
 *
 * OWNER APPROVAL: PENDING. This is built to the sentence below, which has NOT
 * been approved yet; nothing that carries it merges until it is:
 *
 *   "I approve a bill-decode spend ceiling of $3.00 per nightly run for PR
 *    #581: the nightly sync estimates each decode at list price before it
 *    calls the model, stops at $3.00 and leaves the remaining bills for the
 *    next night, and the hourly newsdesk does not decode any bill over
 *    400,000 characters."
 *
 * HOW IT IS CHARGED: before each decode's first model call, at LIST PRICE and
 * WORST CASE (scripts/bill-decode.mjs estimateDecodeUsd: the exact prompts,
 * every reply at its max_tokens cap, no Batches discount). A batched night is
 * really invoiced at about half of what this ledger counts, so the ceiling is
 * conservative by design. The first decode that would carry the running total
 * past the ceiling STOPS the ledger: it and every decode after it tonight are
 * left for the next night (new bills: the cursor waits for them; re-decodes:
 * they stay candidates), with no error.
 */
export const NIGHTLY_DECODE_USD_CEILING = 3.0;

/**
 * The longest cleaned bill text the HOURLY NEWSDESK may decode. Equal to the
 * single-call ceiling (lib/bill-text-clean.mjs SINGLE_CALL_MAX_CHARS), so the
 * newsdesk never runs a split, multi-call decode: those are left to the
 * nightly, under the ceiling above. Part of the same pending approval.
 */
export const NEWSDESK_MAX_BILL_TEXT_CHARS = 400_000;

const MICRO = 1_000_000;
const toMicro = (usd) => Math.round(Number(usd) * MICRO);

/**
 * One night's ledger. `tryCharge` is called BEFORE a decode's first model
 * call with that decode's estimate; it returns true and books the estimate
 * when it fits under the ceiling, and false otherwise. The first refusal
 * stops the ledger for the rest of the run, so "stops at $3.00" means stops:
 * a cheaper bill later in the queue does not slip in behind a dearer one.
 *
 * Arithmetic is in whole micro-dollars, so $3.00 is exactly reachable and a
 * float sum can never let a charge cross it by a rounding error.
 *
 * @param {{ ceilingUsd?: number }} [opts]
 */
export function createSpendLedger({ ceilingUsd = NIGHTLY_DECODE_USD_CEILING } = {}) {
  const ceiling = toMicro(ceilingUsd);
  let spent = 0;
  let stopped = false;
  const charged = [];
  const deferred = [];
  return {
    ceilingUsd,
    get spentUsd() { return spent / MICRO; },
    get stopped() { return stopped; },
    charged,
    deferred,
    /**
     * @param {{ slug: string, usd: number, long?: boolean, chunked?: boolean, what?: string }} item
     * @returns {boolean}
     */
    tryCharge(item) {
      const cost = toMicro(item.usd);
      if (stopped || !Number.isFinite(cost) || cost < 0 || spent + cost > ceiling) {
        stopped = true;
        deferred.push({ slug: item.slug, usd: item.usd, what: item.what ?? 'decode' });
        return false;
      }
      spent += cost;
      charged.push({ slug: item.slug, usd: item.usd, long: Boolean(item.long), chunked: Boolean(item.chunked), what: item.what ?? 'decode' });
      return true;
    },
    summary() {
      return {
        spentUsd: spent / MICRO,
        ceilingUsd,
        charged: charged.length,
        long: charged.filter((c) => c.long).length,
        chunked: charged.filter((c) => c.chunked).length,
        deferred: deferred.length,
        deferredSlugs: deferred.map((d) => d.slug),
      };
    },
  };
}

/**
 * The run-log line lib/pipeline-health.mjs parseDecodeLedger reads. Keep the
 * two in step (tests/decode-spend.unit.spec.ts pins the round trip).
 * @param {ReturnType<ReturnType<typeof createSpendLedger>['summary']>} s
 * @param {{ failureParked?: number }} [extra]
 */
export function formatSpendLedgerLine(s, { failureParked = 0 } = {}) {
  return `decode spend ledger: $${s.spentUsd.toFixed(3)} estimated at list price against the $${s.ceilingUsd.toFixed(2)} nightly ceiling; ${s.charged} decode(s) charged (${s.long} long, ${s.chunked} split into chunks); ${s.deferred} left for the next night by the ceiling; ${failureParked} parked after repeated failures`;
}
