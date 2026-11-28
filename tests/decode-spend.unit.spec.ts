import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DECODE_CHARS_PER_TOKEN,
  MODEL_PRICE_PER_MTOK,
  NEWSDESK_MAX_BILL_TEXT_CHARS,
  NIGHTLY_DECODE_USD_CEILING,
  SEARCH_INPUTS_ESTIMATE,
  createSpendLedger,
  formatSpendLedgerLine,
} from '../lib/decode-spend.mjs';
import {
  DECODE_FAILURE_LIMIT,
  emptyFailureState,
  isFailureParked,
  normalizeFailureState,
  parkedFailures,
  recordFailure,
  recordSuccess,
} from '../lib/decode-failures.mjs';
import { SINGLE_CALL_MAX_CHARS } from '../lib/bill-text-clean.mjs';
import {
  DECODE_STRUCTURE_MAX_TOKENS,
  DECODE_SUMMARY_MAX_TOKENS,
  buildStructurePrompt,
  buildSummaryPrompt,
  estimateDecodeUsd,
  prepareDecodePlan,
  redecodeBill,
  syncOneBill,
} from '../scripts/bill-decode.mjs';
import { drainDecodeQueue, jobPromptSha } from '../lib/decode-batch.mjs';
import { alarms, estimateDaySpend, parseDecodeLedger } from '../lib/pipeline-health.mjs';

/*
 * PR #581's spend ceiling, newsdesk length limit, failure limit, and the
 * status kept out of the model input (2026-11-28). No network, no model:
 * every Anthropic client and every fetch here is a stub.
 */

test.beforeAll(() => {
  process.env.CONGRESS_API_KEY ??= 'test-key-never-sent-anywhere';
});

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

const STRUCTURE_REPLY = [
  '[HEADLINE_EN]', 'Bill would change a program', '[HEADLINE_ES]', 'El proyecto cambiaría un programa',
  '[TLDR]', 'T.', '[WHAT]', 'W.', '[WHO]', 'W.', '[WHY]', 'W.', '[COST]', 'NONE', '[COST_CHIPS]', 'NONE',
  '[ES_TLDR]', 'T.', '[ES_WHAT]', 'Q.', '[ES_WHO]', 'Q.', '[ES_WHY]', 'P.', '[ES_COST]', 'NONE', '[ES_COST_CHIPS]', 'NONE',
  '[ES_SUMMARY]', 'R.',
].join('\n');

type AnyBill = Record<string, unknown>;
const newBill = (slug: string, overrides: AnyBill = {}): AnyBill => {
  const [type, num] = slug.split('-');
  return {
    full_identifier: slug, congress_number: 119, bill_type: type, bill_number: Number(num),
    title: `An act numbered ${num}.`, status: 'markup', last_action_text: 'Ordered to be Reported.',
    last_action_date: '2026-04-22', ai_summary: null, ai_headline: null, decoded_at: null, ...overrides,
  };
};

/** A stub client: synchronous calls and batches that end at once. */
function stubAnthropic(opts: { failSync?: Error } = {}) {
  const batchRequests: string[] = [];
  const syncCalls: string[] = [];
  const client = {
    batchRequests, syncCalls,
    messages: {
      async create({ messages, model }: { model: string; messages: Array<{ content: string }> }) {
        const p = messages[0].content;
        if (model.includes('haiku')) return { content: [{ type: 'text', text: '[PRESS_NAMES]\nNONE\n[NEWS_QUERY]\nEPA "bridge"' }] };
        syncCalls.push(p.slice(0, 40));
        if (opts.failSync) throw opts.failSync;
        if (p.startsWith('From this plain-language bill summary')) return { content: [{ type: 'text', text: STRUCTURE_REPLY }] };
        return { content: [{ type: 'text', text: 'A plain summary.' }] };
      },
      batches: {
        rows: new Map<string, Array<{ custom_id: string; text: string }>>(),
        async create({ requests }: { requests: Array<{ custom_id: string; params: { messages: Array<{ content: string }> } }> }) {
          const id = `b${this.rows.size}`;
          this.rows.set(id, requests.map((r) => {
            batchRequests.push(r.custom_id);
            const p = r.params.messages[0].content;
            return { custom_id: r.custom_id, text: p.startsWith('From this plain-language') ? STRUCTURE_REPLY : 'A batch summary.' };
          }));
          return { id, processing_status: 'ended' };
        },
        async retrieve(id: string) { return { id, processing_status: 'ended' }; },
        async results(id: string) {
          const rows = this.rows.get(id) ?? [];
          return (async function* () {
            for (const r of rows) yield { custom_id: r.custom_id, result: { type: 'succeeded', message: { content: [{ type: 'text', text: r.text }] } } };
          })();
        },
      },
    },
  };
  return client;
}

const corpus = () => ({ bills: [] as AnyBill[], es: {} as Record<string, unknown>, bySlug: new Map<string, AnyBill>() });
const quiet = () => {};

// ---------------------------------------------------------------------------
// 1. The ledger: arithmetic
// ---------------------------------------------------------------------------

test.describe('the nightly ceiling — arithmetic', () => {
  test('the constant is $3.00 and the newsdesk limit equals the single-call ceiling (400,000)', () => {
    expect(NIGHTLY_DECODE_USD_CEILING).toBe(3);
    expect(NEWSDESK_MAX_BILL_TEXT_CHARS).toBe(400_000);
    expect(NEWSDESK_MAX_BILL_TEXT_CHARS).toBe(SINGLE_CALL_MAX_CHARS);
  });

  test('a run stops at $3.00: the decode that would pass it, and every one after it, is left for the next night', () => {
    const l = createSpendLedger();
    // A bad night in the order the nightly charges it: 7 new bills (drain
    // first), then two split bills and long re-decodes.
    const plan = [
      ...Array.from({ length: 7 }, (_, i) => ({ slug: `hr-${i + 1}-119`, usd: 0.051 })),
      { slug: 'hr-4366-119', usd: 1.025, long: true, chunked: true },
      { slug: 'hr-2670-119', usd: 1.025, long: true, chunked: true },
      { slug: 's-10-119', usd: 0.155, long: true },
      { slug: 's-11-119', usd: 0.155, long: true },
      { slug: 's-12-119', usd: 0.155, long: true }, // running total $2.872
      { slug: 's-13-119', usd: 0.155, long: true }, // 2.872 + 0.155 = 3.027 > 3.00: stops here
      { slug: 's-14-119', usd: 0.01 }, // would fit, but the ledger has stopped
    ];
    const verdicts = plan.map((p) => l.tryCharge(p));
    expect(verdicts).toEqual([...Array(12).fill(true), false, false]);
    const s = l.summary();
    expect(s.spentUsd).toBeCloseTo(7 * 0.051 + 2 * 1.025 + 3 * 0.155, 9); // $2.872
    expect(s.spentUsd).toBeLessThanOrEqual(3);
    expect(s.charged).toBe(12);
    expect(s.long).toBe(5);
    expect(s.chunked).toBe(2);
    expect(s.deferredSlugs).toEqual(['s-13-119', 's-14-119']);
  });

  test('exactly $3.00 is reachable, one micro-dollar more is not', () => {
    const l = createSpendLedger({ ceilingUsd: 3 });
    expect(l.tryCharge({ slug: 'a-1-119', usd: 1.1 })).toBe(true);
    expect(l.tryCharge({ slug: 'a-2-119', usd: 1.9 })).toBe(true); // 1.1 + 1.9 = 3.0000000000000004 in floats
    expect(l.spentUsd).toBe(3);
    expect(l.tryCharge({ slug: 'a-3-119', usd: 0.000001 })).toBe(false);
    expect(l.stopped).toBe(true);
  });

  test('a normal night: 70 median decodes stop at $3.00 and leave the rest', () => {
    const l = createSpendLedger();
    const bill = { bill_type: 'hr', bill_number: 1, title: 'A bill to do a thing' };
    const est = estimateDecodeUsd(bill, 'x '.repeat(2597) + 'x');
    let charged = 0;
    for (let i = 0; i < 70; i++) if (l.tryCharge({ slug: `hr-${i}-119`, usd: est.usd })) charged++;
    expect(charged).toBe(Math.floor(3 / est.usd));
    expect(l.summary().deferred).toBe(70 - charged);
    expect(l.spentUsd).toBeLessThanOrEqual(3);
  });

  test('the estimate is list price at every cap, from the exact prompts', () => {
    const bill = { bill_type: 'hr', bill_number: 7, title: 'A bill' };
    const text = 'SEC. 1. Short title. This Act may be cited as the Example Act.';
    const tok = (chars: number) => Math.ceil(chars / DECODE_CHARS_PER_TOKEN);
    const s = MODEL_PRICE_PER_MTOK['claude-sonnet-5-5'];
    const h = MODEL_PRICE_PER_MTOK[SEARCH_INPUTS_ESTIMATE.priceKey as 'claude-haiku-4-5'];
    const inTok = tok(buildSummaryPrompt(bill, text).length) + tok(buildStructurePrompt(bill, '').length) + DECODE_SUMMARY_MAX_TOKENS;
    const outTok = DECODE_SUMMARY_MAX_TOKENS + DECODE_STRUCTURE_MAX_TOKENS;
    const expected = (inTok * s.input + outTok * s.output) / 1e6
      + (SEARCH_INPUTS_ESTIMATE.inputTokens * h.input + SEARCH_INPUTS_ESTIMATE.outputTokens * h.output) / 1e6;
    const est = estimateDecodeUsd(bill, text);
    expect(est.inputTokens).toBe(inTok);
    expect(est.outputTokens).toBe(outTok);
    expect(est.usd).toBeCloseTo(expected, 12);
    // Sizes the report priced by hand: ~$0.05 median, ~$0.32 at the single-call maximum, ~$1 for a 1.4M split bill.
    expect(estimateDecodeUsd(bill, 'x '.repeat(2597) + 'x').usd).toBeGreaterThan(0.04);
    expect(estimateDecodeUsd(bill, 'x '.repeat(2597) + 'x').usd).toBeLessThan(0.06);
    const max = estimateDecodeUsd(bill, `SEC. 1. ${'word '.repeat(79_998)}`);
    expect(max.chunked).toBe(false);
    expect(max.usd).toBeGreaterThan(0.3);
    expect(max.usd).toBeLessThan(0.33);
    const mega = estimateDecodeUsd(bill, `SEC. 1. ${'word '.repeat(280_000)}`);
    expect(mega.chunked).toBe(true);
    expect(mega.usd).toBeGreaterThan(0.95);
    expect(mega.usd).toBeLessThan(1.1);
  });
});

// ---------------------------------------------------------------------------
// 2. The ledger inside the nightly drain
// ---------------------------------------------------------------------------

test.describe('the nightly drain under the ceiling', () => {
  const job = (slug: string, text = `SEC. 1. The text of ${slug}.`) => ({ slug, bill: newBill(slug), text, version: null, count: null, pass: 'ascending' });

  test('jobs past the ceiling are not submitted: deferred (cursor waits), never failed', async () => {
    const api = stubAnthropic();
    const jobs = ['hr-1-119', 'hr-2-119', 'hr-3-119', 'hr-4-119'].map((s) => job(s));
    const one = estimateDecodeUsd(jobs[0].bill, jobs[0].text).usd;
    const ledger = createSpendLedger({ ceilingUsd: one * 2.5 }); // room for two
    const store = corpus();
    const res = await drainDecodeQueue(jobs, { anthropic: api, ...store, ledger, log: quiet, logError: quiet, maxWaitMs: 60_000, sleep: async () => {} });
    expect(store.bySlug.has('hr-1-119')).toBe(true);
    expect(store.bySlug.has('hr-2-119')).toBe(true);
    expect([...res.ceilingDeferredSlugs]).toEqual(['hr-3-119', 'hr-4-119']);
    expect([...res.deferredSlugs].sort()).toEqual(['hr-3-119', 'hr-4-119']);
    expect([...res.unresolvedSlugs].sort()).toEqual(['hr-3-119', 'hr-4-119']); // the cursor holds for them
    expect(res.failedSlugs.size).toBe(0);
    expect(res.overCeiling).toBe(2);
    // Only the two that fit ever reached a batch.
    expect(new Set(api.batchRequests)).toEqual(new Set(['hr-1-119', 'hr-2-119']));
    expect(ledger.spentUsd).toBeLessThanOrEqual(one * 2.5);
  });

  test('time-critical bills are charged first', async () => {
    const api = stubAnthropic();
    const jobs = ['hr-1-119', 'hr-2-119', 's-9-119'].map((s) => job(s));
    const one = estimateDecodeUsd(jobs[0].bill, jobs[0].text).usd;
    const ledger = createSpendLedger({ ceilingUsd: one * 1.5 });
    const res = await drainDecodeQueue(jobs, {
      anthropic: api, ...corpus(), ledger, log: quiet, logError: quiet, maxWaitMs: 60_000, sleep: async () => {},
      isTimeCritical: (j: { slug: string }) => j.slug === 's-9-119',
    });
    expect([...res.ceilingDeferredSlugs].sort()).toEqual(['hr-1-119', 'hr-2-119']);
    expect(api.batchRequests).toContain('s-9-119');
  });

  test('no ledger: no ceiling, exactly as before', async () => {
    const api = stubAnthropic();
    const res = await drainDecodeQueue([job('hr-1-119'), job('hr-2-119')], { anthropic: api, ...corpus(), log: quiet, logError: quiet, maxWaitMs: 60_000, sleep: async () => {} });
    expect(res.ceilingDeferredSlugs.size).toBe(0);
    expect(res.batchDecoded).toBe(2);
  });

  test('a billed failure is reported for the failure limit; an unbilled refusal is not', async () => {
    // A batch that delivers nothing, then a synchronous fallback that throws.
    const mk = (err: Error) => {
      const api = stubAnthropic({ failSync: err });
      api.messages.batches.create = async () => { throw new Error('batch create down'); };
      return api;
    };
    const billed = await drainDecodeQueue([job('hr-1-119')], { anthropic: mk(new Error('missing [TLDR]')), ...corpus(), log: quiet, logError: quiet });
    expect([...billed.failedSlugs]).toEqual(['hr-1-119']);
    expect([...billed.billedFailedSlugs]).toEqual(['hr-1-119']);
    const refusal = Object.assign(new Error('credit balance is too low'), { status: 400, error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } });
    const unbilled = await drainDecodeQueue([job('hr-2-119')], { anthropic: mk(refusal), ...corpus(), log: quiet, logError: quiet });
    expect([...unbilled.failedSlugs]).toEqual(['hr-2-119']);
    expect(unbilled.billedFailedSlugs.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. The newsdesk never decodes a bill over 400,000 characters
// ---------------------------------------------------------------------------

const DETAIL = {
  title: 'A very long bill.',
  latestAction: { text: 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 550.', actionDate: '2026-08-05' },
  introducedDate: '2026-07-30',
  sponsors: [{ bioguideId: 'X000001' }],
  policyArea: { name: 'Health' },
};
const VERSIONS = [{ type: 'Reported in Senate', date: '2026-08-01T04:00:00Z', formats: [{ type: 'Formatted Text', url: 'https://congress.gov/long.htm' }] }];

function stubCongress(docChars: number) {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes('/text?')) return { ok: true, status: 200, json: async () => ({ textVersions: VERSIONS }) };
    if (url.includes('api.congress.gov')) return { ok: true, status: 200, json: async () => ({ bill: DETAIL }) };
    return { ok: true, status: 200, text: async () => `<html><body><pre>SEC. 1. ${'a'.repeat(docChars)}</pre></body></html>` };
  }) as unknown as typeof fetch;
}

test.describe('the newsdesk length limit', () => {
  test('a new bill over 400,000 cleaned characters is skipped before any model call', async () => {
    stubCongress(450_000);
    const api = stubAnthropic();
    const store = corpus();
    const res = await syncOneBill({ type: 's', number: '77' }, {
      ...store, anthropic: api, allowDecode: true, forceSlugs: new Set(), maxTextChars: NEWSDESK_MAX_BILL_TEXT_CHARS,
    });
    expect(res.outcome).toBe('skipped_too_long');
    expect(res.decodeAttempted).toBe(false);
    expect(api.syncCalls).toHaveLength(0);
    expect(store.bills).toHaveLength(0);
  });

  test('the same bill under the limit decodes', async () => {
    stubCongress(10_000);
    const api = stubAnthropic();
    const res = await syncOneBill({ type: 's', number: '77' }, {
      ...corpus(), anthropic: api, allowDecode: true, forceSlugs: new Set(), maxTextChars: NEWSDESK_MAX_BILL_TEXT_CHARS,
    });
    expect(res.outcome).toBe('added');
  });

  test('a re-decode over the limit is skipped, the old decode untouched', async () => {
    stubCongress(450_000);
    const api = stubAnthropic();
    const bill = newBill('s-77-119', { ai_summary: 'OLD', decoded_at: '2026-01-01T00:00:00Z' });
    const bySlug = new Map([['s-77-119', bill]]);
    const res = await redecodeBill('s-77-119', { anthropic: api, es: {}, bySlug, locks: new Map(), maxTextChars: NEWSDESK_MAX_BILL_TEXT_CHARS });
    expect(res.outcome).toBe('skipped_too_long');
    expect(api.syncCalls).toHaveLength(0);
    expect(bill.ai_summary).toBe('OLD');
  });

  test('every decode-capable newsdesk call passes the limit (source pin)', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/newsdesk.mjs'), 'utf8');
    const redecodeCalls = src.match(/redecodeBill\([\s\S]*?\}\);/g) ?? [];
    expect(redecodeCalls.length).toBe(2);
    for (const c of redecodeCalls) expect(c).toContain('maxTextChars: NEWSDESK_MAX_BILL_TEXT_CHARS');
    // The one syncOneBill call that may decode (allowDecode not hard-wired false).
    const decodingSync = (src.match(/syncOneBill\([\s\S]*?\}\);/g) ?? []).filter((c) => !c.includes('allowDecode: false'));
    expect(decodingSync.length).toBe(1);
    expect(decodingSync[0]).toContain('maxTextChars: NEWSDESK_MAX_BILL_TEXT_CHARS');
  });

  test('the nightly re-decode refuses a decode the ledger cannot pay for, mutating nothing', async () => {
    stubCongress(10_000);
    const api = stubAnthropic();
    const bill = newBill('s-78-119', { ai_summary: 'OLD', decode_text_sha: 'feedfacefeedface' });
    const ledger = createSpendLedger({ ceilingUsd: 0.01 });
    const res = await redecodeBill('s-78-119', { anthropic: api, es: {}, bySlug: new Map([['s-78-119', bill]]), locks: new Map(), budget: ledger });
    expect(res.outcome).toBe('over_ceiling');
    expect(api.syncCalls).toHaveLength(0);
    expect(bill.ai_summary).toBe('OLD');
    expect(bill.decode_text_sha).toBe('feedfacefeedface');
    expect(ledger.summary().deferredSlugs).toEqual(['s-78-119']);
  });
});

// ---------------------------------------------------------------------------
// 4. The failure limit
// ---------------------------------------------------------------------------

test.describe('the per-bill failure limit', () => {
  const v1 = { date: '2026-08-01T04:00:00Z' };
  const v2 = { date: '2026-09-01T04:00:00Z' };

  test(`${DECODE_FAILURE_LIMIT} billed failures on the same text park the bill; new text unparks it; success clears it`, () => {
    let s = emptyFailureState();
    for (let night = 1; night <= DECODE_FAILURE_LIMIT; night++) {
      const r = recordFailure(s, 'hr-9-119', v1, { now: Date.parse(`2026-11-0${night}T15:00:00Z`) });
      s = r.state;
      expect(r.parkedNow).toBe(night === DECODE_FAILURE_LIMIT);
    }
    expect(isFailureParked(s, 'hr-9-119', v1)).toBe(true);
    expect(parkedFailures(s).map((p) => p.slug)).toEqual(['hr-9-119']);
    // A different document is a fresh chance.
    expect(isFailureParked(s, 'hr-9-119', v2)).toBe(false);
    const again = recordFailure(s, 'hr-9-119', v2, { now: Date.parse('2026-11-05T15:00:00Z') });
    expect(again.entry.failures).toBe(1);
    expect(again.entry.parkedAt).toBeNull();
    // Success clears the record.
    expect(recordSuccess(s, 'hr-9-119').bills['hr-9-119']).toBeUndefined();
  });

  test('a parked bill is refused before any call and is not a failure; a forced one is not held', async () => {
    stubCongress(10_000);
    let s = emptyFailureState();
    for (let i = 0; i < DECODE_FAILURE_LIMIT; i++) s = recordFailure(s, 's-77-119', VERSIONS[0]).state;
    const api = stubAnthropic();
    const isParked = (slug: string, version: unknown) => isFailureParked(s, slug, version);
    const held = await syncOneBill({ type: 's', number: '77' }, { ...corpus(), anthropic: api, allowDecode: true, forceSlugs: new Set(), isFailureParked: isParked });
    expect(held.outcome).toBe('failure_parked');
    expect(api.syncCalls).toHaveLength(0);
    const forced = await syncOneBill({ type: 's', number: '77' }, { ...corpus(), anthropic: api, allowDecode: true, forceSlugs: new Set(['s-77-119']), isFailureParked: isParked });
    expect(forced.outcome).toBe('added');
  });

  test('the state file is read fail-closed per entry', () => {
    const s = normalizeFailureState({
      bills: {
        'hr-1-119': { failures: 2, lastFailureAt: '2026-11-01T00:00:00Z', textDate: null },
        'not a slug': { failures: 9, lastFailureAt: '2026-11-01T00:00:00Z', textDate: null },
        'hr-2-119': { failures: 'x', lastFailureAt: '2026-11-01T00:00:00Z' },
      },
      waiting: { 'hr-3-119': { since: '2026-11-27T15:00:00Z' } },
    });
    expect(Object.keys(s.bills)).toEqual(['hr-1-119']);
    expect(Object.keys(s.waiting)).toEqual(['hr-3-119']);
  });

  test('the nightly wires the limit, the ceiling and the ledger line (source pins)', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/sync-bills.mjs'), 'utf8');
    expect(src).toMatch(/drainDecodeQueue\(decodeQueue, \{[\s\S]*?ledger,/);
    expect(src).toMatch(/redecodeBill\(item\.slug, \{[\s\S]*?budget: ledger, isFailureParked: parkedForFailure,/);
    expect(src).toContain('budget: ledger, isFailureParked: parkedForFailure }');
    expect(src).toContain('console.log(formatSpendLedgerLine(spend, { failureParked: parkedNow.length }));');
    expect(src).toContain('for (const p of parkedNow) console.log(failureParkedLine(p));');
  });
});

// ---------------------------------------------------------------------------
// 5. Hard rule 6: the status is not in the model input or the fingerprint
// ---------------------------------------------------------------------------

test.describe('the bill status stays out of call 1 and the fingerprint', () => {
  const text = `DIVISION A — PROCUREMENT\n${'Sec. 101 '.repeat(800)}\nDIVISION B — MILITARY PAY\n${'Sec. 201 '.repeat(800)}`;

  test('two records that differ only in status send the same prompt and stamp the same fingerprint', () => {
    const a = { bill_type: 'hr', bill_number: 8800, title: 'NDAA', status: 'status_sentinel_a' };
    const b = { ...a, status: 'status_sentinel_b' };
    const pa = prepareDecodePlan(a, text);
    const pb = prepareDecodePlan(b, text);
    expect(pa.summaryPrompt).toBe(pb.summaryPrompt);
    expect(pa.fingerprint).toBe(pb.fingerprint);
    expect(jobPromptSha({ slug: 'hr-8800-119', bill: a, text })).toBe(jobPromptSha({ slug: 'hr-8800-119', bill: b, text }));
    for (const p of [pa.summaryPrompt, buildStructurePrompt(a, 'x')]) {
      expect(p).not.toContain('status_sentinel');
      expect(p).not.toMatch(/official status/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. The daily digest reads the ledger
// ---------------------------------------------------------------------------

test.describe('the daily digest', () => {
  const line = formatSpendLedgerLine(
    { spentUsd: 2.873, ceilingUsd: 3, charged: 15, long: 5, chunked: 2, deferred: 6, deferredSlugs: [] },
    { failureParked: 1 }
  );

  test('the ledger line the nightly prints round-trips through the digest parser', () => {
    const log = `sync\tSync bills\t2026-11-29T15:02:11.0000000Z ${line}`;
    expect(parseDecodeLedger(log)).toEqual({ usd: 2.873, ceilingUsd: 3, charged: 15, long: 5, chunked: 2, deferred: 6, failureParked: 1 });
    expect(parseDecodeLedger('nothing here')).toBeNull();
  });

  test('the long-bill figure reaches the estimate, and the ledger total replaces the averages', () => {
    const ledger = parseDecodeLedger(line)!;
    const withLedger = estimateDaySpend({ decodes: 3, redecodes: 10, longDecodes: ledger.long, ledger });
    expect(withLedger.longDecodeUsd).toBeGreaterThan(0);
    expect(withLedger.totalLow).toBeCloseTo(2.873, 3);
    const alarmCodes = alarms({ nightly: { conclusion: 'success' }, spend: withLedger }).map((a: { code: string }) => a.code);
    expect(alarmCodes).toContain('decode-failure-parked');
  });
});
