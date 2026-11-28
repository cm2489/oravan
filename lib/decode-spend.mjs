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
 * Applied to bill text too. NOT MEASURED on bill text (check 2 of PR #581,
 * 2026-11-28): ordinary legal prose probably packs more characters into a
 * token than this, but dense numeric funding tables (an NDAA's Division D,
 * an omnibus's appropriation tables) may pack fewer, and then this estimate
 * counts FEWER tokens than are sent. If they ran at 2.5 characters per token,
 * a night of only split bills could cost about $3.00 x 3.1 / 2.5 = $3.72.
 * Before the ceiling is relied on as an upper bound, measure one such chunk
 * with the token-count endpoint and lower this figure if it is high.
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
 *    calls the model; new bills may use at most $2.25 of it, so re-decodes
 *    always keep at least $0.75; a lane that reaches its limit stops and
 *    leaves its remaining bills for the next night; a single decode estimated
 *    over $2.25 is never run at night but is named in an alarm every night
 *    until I approve a one-off amount for it; and the hourly newsdesk does
 *    not decode any bill over 60,000 characters (about $3 a day at list price
 *    at most)."
 *
 * HOW IT IS CHARGED: before each decode's first model call, at LIST PRICE and
 * WORST CASE (scripts/bill-decode.mjs estimateDecodeUsd: the exact prompts,
 * every reply at its max_tokens cap, no Batches discount). A batched night is
 * really invoiced at about half of what this ledger counts, so the ceiling is
 * conservative by design — on the one condition that DECODE_CHARS_PER_TOKEN
 * holds for the text (above: not yet measured on numeric funding tables).
 *
 * TWO LANES (2026-11-28, check 2 of PR #581, defect 3). New decodes run first
 * (the batch drain), re-decodes after. With one shared pot, any night the
 * drain filled — 60 ordinary new bills at ~$0.051 is already $3.06 — left
 * nothing for re-decodes, so a bill whose text changed kept a stale decode
 * for as long as the backlog lasted (the January new-Congress intake). Now new
 * decodes may use at most NEW_DECODE_SHARE of the ceiling ($2.25 of $3.00);
 * re-decodes may use whatever is left, so never less than $0.75. The first
 * decode that does not fit its lane STOPS THAT LANE for the night: it and
 * every later decode in the lane are left for the next night (new bills: the
 * cursor waits for them; re-decodes: they stay candidates), with no error.
 *
 * ONE DECODE OVER THE LIMIT ON ITS OWN (defect 1). A bill whose estimate
 * alone is over MAX_SINGLE_DECODE_USD (the new-decode lane, $2.25) can never
 * fit any night: H.R. 2617 of the 117th Congress, the 2023 omnibus at 4.6
 * million cleaned characters, is estimated at $3.30. Refusing it the ordinary
 * way stopped the lane, and because time-critical bills are charged first, a
 * floor omnibus blocked every decode behind it, every night. So such a decode
 * is refused WITHOUT stopping anything: it goes on the `neverFits` list, the
 * nightly names it in a ::warning:: line and the daily digest raises an
 * alarm, and a new bill of this kind is resolved for the cursor (like a bill
 * parked after repeated failures) so the backlog scan moves on. The owner
 * decodes it with the one-off dispatch inputs (ONE_OFF_DECODE_SLUG and
 * ONE_OFF_DECODE_MAX_USD), at an amount he approves, charged on its own
 * account and never against the $3.00.
 */
export const NIGHTLY_DECODE_USD_CEILING = 3.0;

/** The share of the nightly ceiling new decodes may use ($2.25 of $3.00);
 *  re-decodes may use the rest, and anything new decodes leave. */
export const NEW_DECODE_SHARE = 0.75;

/** The dearest single decode the nightly will run at all: the new-decode
 *  lane's limit. Anything over it waits for a one-off, owner-approved run. */
export const MAX_SINGLE_DECODE_USD = NIGHTLY_DECODE_USD_CEILING * NEW_DECODE_SHARE;

/** The most a one-off dispatch may approve for one decode. A guard against a
 *  mistyped amount ("300" for "3.00"), not a budget: the owner names the
 *  amount for each run. */
export const ONE_OFF_DECODE_HARD_MAX_USD = 10;

/**
 * The longest cleaned bill text the HOURLY NEWSDESK may decode: 60,000
 * characters, the long-bill line (scripts/bill-decode.mjs LONG_BILL_CHARS;
 * the test suite pins the two equal). Check 2 of PR #581 (defect 2): at the
 * single-call maximum of 400,000 characters, the newsdesk's 30 decodes a day
 * (10 press + 20 tier-0) could cost 30 x $0.338 = about $10 a day at list
 * price, outside the nightly ceiling. At 60,000 it is at most about
 * 30 x $0.098 = $2.94, close to what it cost before #581. A longer bill is
 * left to the nightly, under the ceiling above. Part of the same pending
 * approval.
 */
export const NEWSDESK_MAX_BILL_TEXT_CHARS = 60_000;

const MICRO = 1_000_000;
const toMicro = (usd) => Math.round(Number(usd) * MICRO);
const SLUG_RE = /^[a-z]+-\d+-\d+$/;

/**
 * Parse the one-off dispatch inputs. Both blank: null (no one-off tonight).
 * Otherwise `{ ok: true, slug, maxUsd }`, or `{ ok: false, reason }` for a
 * malformed slug, a missing or non-positive amount, or one over
 * ONE_OFF_DECODE_HARD_MAX_USD — a refused one-off decodes nothing.
 *
 * @param {string | undefined} slugRaw
 * @param {string | undefined} maxRaw
 */
export function parseOneOffDecode(slugRaw, maxRaw) {
  const slug = String(slugRaw ?? '').trim().toLowerCase();
  const maxText = String(maxRaw ?? '').trim().replace(/^\$/, '');
  if (!slug && !maxText) return null;
  if (!SLUG_RE.test(slug)) return { ok: false, reason: `the slug ${JSON.stringify(slug.slice(0, 40))} is not of the form hr-1234-119` };
  if (!/^\d+(?:\.\d+)?$/.test(maxText)) return { ok: false, reason: 'the approved amount is missing or not a plain dollar figure' };
  const maxUsd = Number(maxText);
  if (!(maxUsd > 0)) return { ok: false, reason: 'the approved amount must be more than $0' };
  if (maxUsd > ONE_OFF_DECODE_HARD_MAX_USD) {
    return { ok: false, reason: `the approved amount $${maxUsd.toFixed(2)} is over the $${ONE_OFF_DECODE_HARD_MAX_USD.toFixed(2)} guard on one-off decodes` };
  }
  return { ok: true, slug, maxUsd };
}

/**
 * One night's ledger. `tryCharge` is called BEFORE a decode's first model
 * call with that decode's estimate; it returns true and books the estimate
 * when it fits, and false otherwise. After a false, `lastRefusal` says which
 * kind: 'ceiling' (its lane is full tonight; try again tomorrow) or
 * 'never_fits' (over MAX_SINGLE_DECODE_USD on its own, an estimate that could
 * not be computed, or over the one-off amount; tomorrow will not differ).
 *
 * Lanes: an item with `lane: 'redecode'` (or `what: 're-decode'`) is a
 * re-decode; anything else is a new decode. The first 'ceiling' refusal stops
 * that lane for the rest of the run, so "stops" means stops: a cheaper bill
 * later in the lane does not slip in behind a dearer one. A 'never_fits'
 * refusal stops nothing.
 *
 * `oneOff` ({ slug, maxUsd }, from parseOneOffDecode): that slug's decode is
 * charged to its own account, up to maxUsd in all (a batch fallback is a
 * second charge on it), never against the nightly ceiling.
 *
 * Arithmetic is in whole micro-dollars, so $3.00 is exactly reachable and a
 * float sum can never let a charge cross it by a rounding error.
 *
 * @param {{ ceilingUsd?: number, newDecodeCapUsd?: number, singleDecodeMaxUsd?: number,
 *           oneOff?: { slug: string, maxUsd: number } | null }} [opts]
 */
export function createSpendLedger({
  ceilingUsd = NIGHTLY_DECODE_USD_CEILING,
  newDecodeCapUsd = ceilingUsd * NEW_DECODE_SHARE,
  singleDecodeMaxUsd = newDecodeCapUsd,
  oneOff = null,
} = {}) {
  const ceiling = toMicro(ceilingUsd);
  const newCap = Math.min(toMicro(newDecodeCapUsd), ceiling);
  const singleMax = Math.min(toMicro(singleDecodeMaxUsd), ceiling);
  const oneOffMax = oneOff ? toMicro(oneOff.maxUsd) : 0;
  let spent = 0;
  let spentNew = 0;
  let oneOffSpent = 0;
  let stoppedNew = false;
  let stoppedRedecode = false;
  /** @type {null | 'ceiling' | 'never_fits'} */
  let lastRefusal = null;
  const charged = [];
  const deferred = [];
  const neverFits = [];
  const oneOffCharged = [];
  return {
    ceilingUsd,
    newDecodeCapUsd: newCap / MICRO,
    singleDecodeMaxUsd: singleMax / MICRO,
    oneOff,
    get spentUsd() { return spent / MICRO; },
    get spentNewUsd() { return spentNew / MICRO; },
    get oneOffSpentUsd() { return oneOffSpent / MICRO; },
    get stopped() { return stoppedNew || stoppedRedecode; },
    get stoppedNew() { return stoppedNew; },
    get stoppedRedecode() { return stoppedRedecode; },
    get lastRefusal() { return lastRefusal; },
    charged,
    deferred,
    neverFits,
    oneOffCharged,
    /**
     * @param {{ slug: string, usd: number, long?: boolean, chunked?: boolean, what?: string, lane?: 'new' | 'redecode' }} item
     * @returns {boolean}
     */
    tryCharge(item) {
      const cost = toMicro(item.usd);
      const what = item.what ?? 'decode';
      const lane = item.lane ?? (what === 're-decode' ? 'redecode' : 'new');
      const priced = Number.isFinite(cost) && cost >= 0;
      lastRefusal = null;
      if (oneOff && item.slug === oneOff.slug) {
        if (priced && oneOffSpent + cost <= oneOffMax) {
          oneOffSpent += cost;
          oneOffCharged.push({ slug: item.slug, usd: item.usd, long: Boolean(item.long), chunked: Boolean(item.chunked), what });
          return true;
        }
        lastRefusal = 'never_fits';
        neverFits.push({ slug: item.slug, usd: priced ? item.usd : null, what, why: 'over the approved one-off amount' });
        return false;
      }
      if (!priced || cost > singleMax) {
        lastRefusal = 'never_fits';
        neverFits.push({ slug: item.slug, usd: priced ? item.usd : null, what, why: priced ? 'over the single-decode limit' : 'no estimate' });
        return false;
      }
      const laneStopped = lane === 'new' ? stoppedNew : stoppedRedecode;
      const fits = spent + cost <= ceiling && (lane !== 'new' || spentNew + cost <= newCap);
      if (laneStopped || !fits) {
        if (lane === 'new') stoppedNew = true; else stoppedRedecode = true;
        lastRefusal = 'ceiling';
        deferred.push({ slug: item.slug, usd: item.usd, what });
        return false;
      }
      spent += cost;
      if (lane === 'new') spentNew += cost;
      charged.push({ slug: item.slug, usd: item.usd, long: Boolean(item.long), chunked: Boolean(item.chunked), what, lane });
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
        neverFits: neverFits.length,
        neverFitsSlugs: [...new Set(neverFits.map((d) => d.slug))],
        oneOffUsd: oneOffSpent / MICRO,
      };
    },
  };
}

/** The alarm line for one decode over the single-decode limit. */
export function overDecodeLimitLine({ slug, usd, why = 'over the single-decode limit' }) {
  const est = Number.isFinite(usd) ? `$${Number(usd).toFixed(3)}` : 'unknown';
  return `::warning::DECODE OVER THE WHOLE NIGHTLY CEILING ${slug} est ${est} (${why}; the nightly never runs a decode over $${MAX_SINGLE_DECODE_USD.toFixed(2)}): not decoded and not retried at night. To decode it, dispatch sync-bills.yml with one_off_decode_slug=${slug} and one_off_decode_max_usd set to an amount the owner approves.`;
}

/**
 * The run-log line lib/pipeline-health.mjs parseDecodeLedger reads. Keep the
 * two in step (tests/decode-spend.unit.spec.ts pins the round trip).
 * @param {ReturnType<ReturnType<typeof createSpendLedger>['summary']>} s
 * `overLimit`: the bills on record as over the single-decode limit (tonight's
 * and earlier nights' still undecoded), so the digest alarm repeats daily.
 * @param {{ failureParked?: number, overLimit?: number }} [extra]
 */
export function formatSpendLedgerLine(s, { failureParked = 0, overLimit = 0 } = {}) {
  return `decode spend ledger: $${s.spentUsd.toFixed(3)} estimated at list price against the $${s.ceilingUsd.toFixed(2)} nightly ceiling; ${s.charged} decode(s) charged (${s.long} long, ${s.chunked} split into chunks); ${s.deferred} left for the next night by the ceiling; ${failureParked} parked after repeated failures; ${overLimit} over the single-decode limit; $${(s.oneOffUsd ?? 0).toFixed(3)} on a one-off approved decode`;
}
