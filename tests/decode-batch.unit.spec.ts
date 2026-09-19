import { expect, test } from '@playwright/test';
import {
  DECODE_MODEL,
  DECODE_STRUCTURE_MAX_TOKENS,
  DECODE_SUMMARY_MAX_TOKENS,
  assembleDecode,
  buildStructurePrompt,
  buildSummaryPrompt,
  decodeStructureFrom,
  redecodeBill,
  textFingerprint,
} from '../scripts/bill-decode.mjs';
import {
  buildStructureRequests,
  buildSummaryRequests,
  decodeBatched,
  extractText,
} from '../lib/decode-batch.mjs';
import { resolveCursorRows } from '../scripts/sync-bills.mjs';
import { redecodeVerdict } from '../scripts/floor-signals-parse.mjs';
import { anyDataChanged } from '../scripts/newsdesk-match.mjs';

/*
 * Pins the 2026-09-18 spend-reduction pair, both halves of which are only safe
 * because of a property a test can hold onto:
 *
 *   1. THE BATCHED DECODE IS THE SAME DECODE. The nightly sync now spends its
 *      two model calls through the Message Batches API at half price. That is
 *      only acceptable while the batch sends byte-identical prompts, the same
 *      output ceilings, and passes replies through the SAME publish gate — and
 *      while every way a batch can fail resolves to "decode this bill
 *      synchronously instead", never to a bill quietly going missing.
 *
 *   2. AN UNCHANGED DOCUMENT IS NOT RE-DECODED. The hourly re-decode trigger
 *      fires on a date (the bill's action is newer than its decode). When the
 *      document behind that action is byte-identical to the one the decode was
 *      written from, re-decoding pays two Sonnet calls to rewrite what we hold.
 *      The short-circuit must skip the spend, must never skip the re-READ, and
 *      must never short-circuit a vehicle swap.
 *
 * If one of these fails, a spend guarantee moved. Re-derive it deliberately
 * rather than loosening the pin.
 */

test.beforeAll(() => {
  process.env.CONGRESS_API_KEY ??= 'test-key-never-sent-anywhere';
});

type AnyBill = Record<string, unknown>;

function makeBill(overrides: AnyBill = {}): AnyBill {
  return {
    full_identifier: 'hr-1234-119',
    congress_number: 119,
    bill_type: 'hr',
    bill_number: 1234,
    title: 'An act to fund bridge repair.',
    ai_summary: 'This bill funds bridges.',
    ai_headline: 'Bridge repair money moves to the states',
    ai_sections: { tldr: 'Money for bridges.', what: 'w', who: 'o', why: 'y', cost: null, costChips: null },
    decoded_at: '2026-09-01T00:00:00Z',
    last_action_date: '2026-09-10',
    status: 'floor_vote',
    ...overrides,
  };
}

/**
 * THE FINGERPRINT AS THE CODE COMPUTES IT — over the MODEL INPUT, not the
 * document. Written once here so a test can never accidentally pin the
 * document-only version the 2026-09-19 merge corrected: a fingerprint that
 * ignored the title let a renamed bill read as unchanged, and made the veto
 * useless against the nightly re-decode pass, which routinely passes a title.
 */
function fingerprintOf(bill: AnyBill, text: string): string {
  return textFingerprint(buildSummaryPrompt(bill, text));
}

/** A structure reply carrying every required tag. */
const STRUCTURE_REPLY = [
  '[HEADLINE_EN]\nBridge money moves',
  '[HEADLINE_ES]\nDinero para puentes',
  '[TLDR]\nTldr.',
  '[WHAT]\nWhat.',
  '[WHO]\nWho.',
  '[WHY]\nWhy.',
  '[COST]\nNONE',
  '[COST_CHIPS]\nNONE',
  '[ES_TLDR]\nTldr es.',
  '[ES_WHAT]\nQue.',
  '[ES_WHO]\nQuien.',
  '[ES_WHY]\nPor que.',
  '[ES_COST]\nNONE',
  '[ES_COST_CHIPS]\nNONE',
  '[ES_SUMMARY]\nResumen completo.',
].join('\n');

// ---------------------------------------------------------------------------
// 1. The batch sends the same decode the synchronous path sends
// ---------------------------------------------------------------------------

test.describe('batch requests carry the synchronous decode, unaltered', () => {
  test('round 1 uses buildSummaryPrompt verbatim, at the summary ceiling', () => {
    const bill = makeBill();
    const jobs = [{ slug: 'hr-1234-119', bill, text: 'FULL BILL TEXT' }];
    const [row] = buildSummaryRequests(jobs);
    expect(row.custom_id).toBe('hr-1234-119');
    expect(row.params.model).toBe(DECODE_MODEL);
    expect(row.params.max_tokens).toBe(DECODE_SUMMARY_MAX_TOKENS);
    // Not "looks similar": the exact string the synchronous decoder sends.
    expect(row.params.messages[0].content).toBe(buildSummaryPrompt(bill, 'FULL BILL TEXT'));
  });

  test('round 2 uses buildStructurePrompt verbatim, at the structure ceiling', () => {
    const bill = makeBill();
    const jobs = [{ slug: 'hr-1234-119', bill, text: 'FULL BILL TEXT' }];
    const rows = buildStructureRequests(jobs, new Map([['hr-1234-119', 'A plain summary.']]));
    expect(rows).toHaveLength(1);
    expect(rows[0].params.max_tokens).toBe(DECODE_STRUCTURE_MAX_TOKENS);
    expect(rows[0].params.messages[0].content).toBe(buildStructurePrompt(bill, 'A plain summary.'));
  });

  test('thinking is disabled explicitly on every row', () => {
    // Sonnet 5 turns thinking ON when the field is omitted; a batch of rows
    // that forgot it would add unbounded thinking spend to the cheapest path
    // in the pipeline, which is the opposite of the point.
    const jobs = [{ slug: 'hr-1-119', bill: makeBill(), text: 't' }];
    for (const row of buildSummaryRequests(jobs)) {
      expect(row.params.thinking).toEqual({ type: 'disabled' });
    }
    for (const row of buildStructureRequests(jobs, new Map([['hr-1-119', 's']]))) {
      expect(row.params.thinking).toEqual({ type: 'disabled' });
    }
  });

  test('a bill whose round-1 row produced nothing gets no round-2 row', () => {
    const jobs = [
      { slug: 'hr-1-119', bill: makeBill(), text: 't' },
      { slug: 'hr-2-119', bill: makeBill(), text: 't' },
    ];
    const rows = buildStructureRequests(jobs, new Map([['hr-1-119', 's']]));
    expect(rows.map((r) => r.custom_id)).toEqual(['hr-1-119']);
  });
});

// ---------------------------------------------------------------------------
// 2. Draining a batch
// ---------------------------------------------------------------------------

interface FakeBatch {
  id: string;
  processing_status: string;
}

/** A batches client that ends immediately and replies per round. */
function fakeBatches(repliesByRound: Array<Map<string, string>>, opts: { neverEnds?: boolean; throwOnCreate?: boolean } = {}) {
  let round = -1;
  const created: Array<{ id: string; requests: unknown[] }> = [];
  return {
    created,
    messages: {
      batches: {
        async create({ requests }: { requests: unknown[] }): Promise<FakeBatch> {
          if (opts.throwOnCreate) throw new Error('boom');
          round++;
          created.push({ id: `batch-${round}`, requests });
          return { id: `batch-${round}`, processing_status: opts.neverEnds ? 'in_progress' : 'ended' };
        },
        async retrieve(id: string): Promise<FakeBatch> {
          return { id, processing_status: opts.neverEnds ? 'in_progress' : 'ended' };
        },
        async results(id: string) {
          const idx = Number(id.split('-')[1]);
          const replies = repliesByRound[idx] ?? new Map<string, string>();
          return (async function* () {
            for (const [customId, text] of replies) {
              yield {
                custom_id: customId,
                result: { type: 'succeeded', message: { content: [{ type: 'text', text }] } },
              };
            }
          })();
        },
      },
    },
  };
}

test.describe('decodeBatched', () => {
  const jobs = () => [{ slug: 'hr-1234-119', bill: makeBill(), text: 'FULL TEXT' }];

  test('two rounds produce a decode that passes the same publish gate', async () => {
    const fake = fakeBatches([
      new Map([['hr-1234-119', 'A plain-language summary of the bill.']]),
      new Map([['hr-1234-119', STRUCTURE_REPLY]]),
    ]);
    const out = await decodeBatched(jobs(), { anthropic: fake, log: () => {} });
    const row = out.get('hr-1234-119');
    expect(row?.ok).toBe(true);
    // Identical to what assembleDecode produces from the same two replies —
    // the batch cannot have its own, looser assembly.
    expect(row?.dec).toEqual(
      assembleDecode('A plain-language summary of the bill.', STRUCTURE_REPLY)
    );
    expect(fake.created).toHaveLength(2);
  });

  test('a round-2 reply missing a required tag fails CLOSED, never half-published', async () => {
    const truncated = STRUCTURE_REPLY.slice(0, STRUCTURE_REPLY.indexOf('[ES_SUMMARY]'));
    const fake = fakeBatches([
      new Map([['hr-1234-119', 'summary']]),
      new Map([['hr-1234-119', truncated]]),
    ]);
    const out = await decodeBatched(jobs(), { anthropic: fake, log: () => {} });
    const row = out.get('hr-1234-119');
    expect(row?.ok).toBe(false);
    expect(String(row?.reason)).toContain('bad-shape');
  });

  test('a batch that never ends gives up at the deadline and reports every bill unresolved', async () => {
    // The caller's answer to this is a synchronous decode. The one outcome
    // that must never happen is silence.
    let clock = 0;
    const fake = fakeBatches([], { neverEnds: true });
    const out = await decodeBatched(jobs(), {
      anthropic: fake,
      log: () => {},
      now: () => clock,
      sleep: async () => { clock += 60_000; },
      maxWaitMs: 120_000,
    });
    expect(out.get('hr-1234-119')).toEqual({ ok: false, reason: 'no-summary' });
  });

  test('a batch that cannot be created never throws out of the night', async () => {
    const fake = fakeBatches([], { throwOnCreate: true });
    const out = await decodeBatched(jobs(), { anthropic: fake, log: () => {} });
    expect(out.get('hr-1234-119')).toEqual({ ok: false, reason: 'batch-create-failed' });
  });

  test('an empty queue submits nothing', async () => {
    const fake = fakeBatches([]);
    const out = await decodeBatched([], { anthropic: fake, log: () => {} });
    expect(out.size).toBe(0);
    expect(fake.created).toHaveLength(0);
  });

  test('extractText refuses a row that errored, expired or was canceled', () => {
    expect(extractText({ custom_id: 'x', result: { type: 'errored', error: {} } })).toBeNull();
    expect(extractText({ custom_id: 'x', result: { type: 'expired' } })).toBeNull();
    expect(extractText({ custom_id: 'x', result: { type: 'succeeded', message: { content: [] } } })).toBeNull();
  });
});

/**
 * A batches client that must actually be POLLED, so the retrieve/cancel paths
 * are reachable. `failRetrieveOnRound` makes that round's status check throw.
 */
function pollableBatches(
  repliesByRound: Array<Map<string, string>>,
  opts: { failRetrieveOnRound?: number; neverEnds?: boolean } = {}
) {
  let round = -1;
  const cancelled: string[] = [];
  const created: string[] = [];
  return {
    cancelled,
    created,
    messages: {
      batches: {
        async create(): Promise<FakeBatch> {
          round++;
          created.push(`batch-${round}`);
          return { id: `batch-${round}`, processing_status: 'in_progress' };
        },
        async retrieve(id: string): Promise<FakeBatch> {
          const idx = Number(id.split('-')[1]);
          if (opts.failRetrieveOnRound === idx) throw new Error('503 from the status check');
          return { id, processing_status: opts.neverEnds ? 'in_progress' : 'ended' };
        },
        async cancel(id: string) {
          cancelled.push(id);
          return { id, processing_status: 'canceling' };
        },
        async results(id: string) {
          const idx = Number(id.split('-')[1]);
          const replies = repliesByRound[idx] ?? new Map<string, string>();
          return (async function* () {
            for (const [customId, text] of replies) {
              yield {
                custom_id: customId,
                result: { type: 'succeeded', message: { content: [{ type: 'text', text }] } },
              };
            }
          })();
        },
      },
    },
  };
}

test.describe('a batch that stops answering costs one decode, not two', () => {
  const jobs = () => [{ slug: 'hr-1234-119', bill: makeBill(), text: 'FULL TEXT' }];

  test('a poll failure in round 2 keeps round 1 and hands the summary back', async () => {
    // THE MEDIUM FINDING. `batches.retrieve` throwing used to escape
    // decodeBatched's try, which discarded round 1's summaries — so every bill
    // fell back to a FULL synchronous decode and bought, at full price, a
    // paragraph the batch had already produced and billed at half.
    let clock = 0;
    const fake = pollableBatches([
      new Map([['hr-1234-119', 'A plain-language summary of the bill.']]),
      new Map(),
    ], { failRetrieveOnRound: 1 });
    const out = await decodeBatched(jobs(), {
      anthropic: fake,
      log: () => {},
      now: () => clock,
      sleep: async () => { clock += 1_000; },
      maxWaitMs: 600_000,
    });
    const row = out.get('hr-1234-119');
    expect(row?.ok).toBe(false);
    expect(row?.reason).toBe('no-structure');
    expect(row?.summary).toBe('A plain-language summary of the bill.');
    // And the batch nobody will read is cancelled rather than left to bill.
    expect(fake.cancelled).toEqual(['batch-1']);
  });

  test('the caller finishes such a bill with ONE model call, not two', async () => {
    // The other half of "does not double-pay": decodeStructureFrom is call 2
    // alone, and it produces byte-for-byte what the two-call path would have.
    let calls = 0;
    const anthropic = {
      messages: {
        create: async () => {
          calls++;
          return { content: [{ type: 'text', text: STRUCTURE_REPLY }] };
        },
      },
    };
    const dec = await decodeStructureFrom(anthropic, makeBill(), 'A plain-language summary of the bill.');
    expect(calls).toBe(1);
    expect(dec).toEqual(assembleDecode('A plain-language summary of the bill.', STRUCTURE_REPLY));
  });

  test('a batch abandoned at the deadline is cancelled, not just walked away from', async () => {
    // Walking away does not stop a batch: it keeps processing and keeps
    // billing while the caller pays for the same decodes synchronously.
    let clock = 0;
    const fake = pollableBatches([], { neverEnds: true });
    const out = await decodeBatched(jobs(), {
      anthropic: fake,
      log: () => {},
      now: () => clock,
      sleep: async () => { clock += 60_000; },
      maxWaitMs: 120_000,
    });
    expect(out.get('hr-1234-119')).toEqual({ ok: false, reason: 'no-summary' });
    expect(fake.cancelled).toEqual(['batch-0']);
  });

  test('the default wait ceiling is 8 minutes a round, not 20', async () => {
    // A money-and-starvation pin. sync-bills.yml shares the `data-sync`
    // concurrency group with the hourly newsdesk (cron :07), so every minute
    // the nightly waits is a minute the live layer is queued behind it. Two
    // rounds at the old 20-minute ceiling could hold that group for 40 minutes
    // to save a few dollars. If this number is raised, raise it deliberately.
    let clock = 0;
    let lastSeen = 0;
    const fake = pollableBatches([], { neverEnds: true });
    await decodeBatched(jobs(), {
      anthropic: fake,
      log: () => {},
      now: () => clock,
      sleep: async () => { clock += 60_000; lastSeen = clock; },
    });
    // It gave up on the first minute at or past the ceiling.
    expect(lastSeen).toBe(8 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// 3. The cursor still freezes on a decode that did not land
// ---------------------------------------------------------------------------

test.describe('resolveCursorRows', () => {
  /** One row per fetched bill, exactly as the ascending loop pushes them:
   *  every bill of the window gets one, dedupes included, and `day` is the
   *  bare date the day-walk reads. */
  const rows = (...r: Array<{ updateDate: string; needsWork?: boolean; slug?: string }>) =>
    r.map((x, i) => ({
      needsWork: false,
      slug: x.slug ?? `hr-${i + 1}-119`,
      day: x.updateDate.slice(0, 10),
      ...x,
    }));

  test('a clean window advances the high-water mark to its last bill', () => {
    const out = resolveCursorRows(
      rows({ updateDate: '2026-09-01' }, { updateDate: '2026-09-02' }, { updateDate: '2026-09-03' }),
      '2026-08-31T00:00:00Z'
    );
    expect(out.frozen).toBe(false);
    expect(out.cursor.startsWith('2026-09-03')).toBe(true);
  });

  test('a QUEUED decode that later failed freezes the cursor exactly like an inline failure', () => {
    // This is the whole reason the cursor decision moved after the drain. If a
    // failed batch decode advanced the cursor, the bill would be neither in
    // the corpus nor in any future window — the permanently-skipped-bill
    // failure docs/solutions/pinned-sync-cursor.md exists for.
    const window = rows(
      { updateDate: '2026-09-01' },
      { updateDate: '2026-09-02', slug: 'hr-9-119' },
      { updateDate: '2026-09-03' }
    );
    const failed = resolveCursorRows(window, '2026-08-31T00:00:00Z', new Set(['hr-9-119']));
    expect(failed.frozen).toBe(true);
    expect(failed.cursor.startsWith('2026-09-01')).toBe(true);

    const succeeded = resolveCursorRows(window, '2026-08-31T00:00:00Z', new Set());
    expect(succeeded.frozen).toBe(false);
    expect(succeeded.cursor.startsWith('2026-09-03')).toBe(true);
  });

  test('a PASS-1 queued decode that failed freezes the cursor at its own bill', () => {
    // THE HIGH FINDING of the 2026-09-19 review. Pass 1 resolves a bill, adds
    // it to handledSlugs, and queues its decode; pass 2 meets the same bill,
    // takes the dedupe branch, and decides nothing. Before this merge that
    // branch pushed a row with no slug on it, so when the drain failed that
    // decode, nothing in the window carried the failure and the cursor walked
    // straight past a bill that never entered the corpus.
    const window = rows(
      { updateDate: '2026-09-01' },
      { updateDate: '2026-09-02', slug: 'hr-DEDUPED-119' }, // resolved by pass 1, needsWork false
      { updateDate: '2026-09-03' }
    );
    const out = resolveCursorRows(window, '2026-08-31T00:00:00Z', new Set(['hr-DEDUPED-119']));
    expect(out.frozen).toBe(true);
    expect(out.cursor.startsWith('2026-09-01')).toBe(true);
  });

  test('an inline needsWork row still freezes, with no pending slugs involved', () => {
    const out = resolveCursorRows(
      rows({ updateDate: '2026-09-01' }, { updateDate: '2026-09-02', needsWork: true }, { updateDate: '2026-09-03' }),
      '2026-08-31T00:00:00Z'
    );
    expect(out.frozen).toBe(true);
    expect(out.cursor.startsWith('2026-09-01')).toBe(true);
  });

  test('the day-walk closes a day only when nothing behind it is frozen', () => {
    // #251's rule, now decided in the same pass as the freeze because a day
    // whose last bill is a queued decode is not finished until the drain says
    // so. Day 09-01 is walked clean through, then 09-02 freezes: the cursor
    // may claim the END of 09-01 and nothing later.
    const window = rows(
      { updateDate: '2026-09-01' },
      { updateDate: '2026-09-01' },
      { updateDate: '2026-09-02', slug: 'hr-STUCK-119' },
      { updateDate: '2026-09-03' }
    );
    const frozen = resolveCursorRows(window, '2026-08-31T00:00:00Z', new Set(['hr-STUCK-119']));
    expect(frozen.frozen).toBe(true);
    expect(frozen.lastFullDay).toBe('2026-09-01');

    // Same window, that decode landed: the walk crosses 09-02 and 09-03 too,
    // so the newest day it got CLEAN THROUGH is 09-02 (09-03 is the day it is
    // standing in, which the caller answers with plan.dayComplete).
    const clean = resolveCursorRows(window, '2026-08-31T00:00:00Z', new Set());
    expect(clean.frozen).toBe(false);
    expect(clean.lastFullDay).toBe('2026-09-02');
  });

  test('a freeze on the FIRST bill of a day leaves the previous day closed and nothing more', () => {
    const window = rows(
      { updateDate: '2026-09-01' },
      { updateDate: '2026-09-02', slug: 'hr-STUCK-119', needsWork: true },
      { updateDate: '2026-09-02' }
    );
    const out = resolveCursorRows(window, '2026-08-31T00:00:00Z');
    expect(out.lastFullDay).toBe('2026-09-01');
    expect(out.cursor.startsWith('2026-09-01')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. The unchanged-document short-circuit
// ---------------------------------------------------------------------------

const TEXT = 'SEC. 1. SHORT TITLE. This Act may be cited as the Bridge Act.';

/** Stubs Congress.gov's /text endpoint and the document fetch behind it. */
function stubText(body: string) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes('api.congress.gov')) {
      return new Response(
        JSON.stringify({
          textVersions: [
            { type: 'Engrossed', date: '2026-09-10', formats: [{ type: 'Formatted Text', url: 'https://congress.gov/doc.htm' }] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(`<html><body>${body}</body></html>`, { status: 200 });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test.describe('redecodeBill: an identical document costs nothing', () => {
  test('matching fingerprint skips the model entirely and stamps only the verification', async () => {
    const restore = stubText(TEXT);
    try {
      const bill = makeBill({ ai_summary: 'OLD SUMMARY' });
      bill.decode_text_sha = fingerprintOf(bill, TEXT);
      const bySlug = new Map([['hr-1234-119', bill]]);
      const es: Record<string, unknown> = { 'hr-1234-119': { summary: 'RESUMEN VIEJO' } };
      // A client that throws on any call: proof the decode never happened.
      const anthropic = {
        messages: {
          create: async () => { throw new Error('a model call was made on an unchanged document'); },
        },
      };
      const result = await redecodeBill('hr-1234-119', { anthropic, es, bySlug });
      expect(result.outcome).toBe('text-unchanged');
      expect(result.decodeAttempted).toBe(false);
      // The existing decode stands, untouched, in both languages.
      expect(bill.ai_summary).toBe('OLD SUMMARY');
      expect(es['hr-1234-119']).toEqual({ summary: 'RESUMEN VIEJO' });
      // decoded_at means "when a decode was written" and no decode was
      // written; only the weaker, separately-named claim is stamped.
      expect(bill.decoded_at).toBe('2026-09-01T00:00:00Z');
      expect(typeof bill.decode_text_verified_at).toBe('string');
      // BOTH PROVENANCE SETS, from the version just read. Stamping only the
      // verification date left #248's nominator measuring against a stale
      // text_version_date forever: the bill was nominated, probed, vetoed and
      // nominated again every night, spending a free probe and a free /text
      // fetch on the same answer for the life of the corpus.
      expect(bill.text_version_date).toBe('2026-09-10');
      expect(bill.text_version_type).toBe('Engrossed');
      expect(bill.text_version_count).toBe(1);
    } finally {
      restore();
    }
  });

  test('a CHANGED document is re-decoded, and re-stamps the fingerprint', async () => {
    const restore = stubText(TEXT);
    try {
      const bill = makeBill();
      bill.decode_text_sha = fingerprintOf(bill, 'SOMETHING ELSE ENTIRELY');
      const bySlug = new Map([['hr-1234-119', bill]]);
      const es: Record<string, unknown> = {};
      let calls = 0;
      const anthropic = {
        messages: {
          create: async () => {
            calls++;
            return { content: [{ type: 'text', text: calls === 1 ? 'A new summary.' : STRUCTURE_REPLY }] };
          },
        },
      };
      const result = await redecodeBill('hr-1234-119', { anthropic, es, bySlug });
      expect(result.outcome).toBe('redecoded');
      expect(calls).toBe(2);
      expect(bill.ai_summary).toBe('A new summary.');
      // Stamped from the document actually decoded (the stub's HTML strips to
      // exactly TEXT), so the NEXT run can short-circuit.
      expect(bill.decode_text_sha).toBe(fingerprintOf(bill, TEXT));
      // The version stamp lands in the same breath, so the next run's probe
      // measures against THIS document.
      expect(bill.text_version_date).toBe('2026-09-10');
    } finally {
      restore();
    }
  });

  test('a bill with no stored fingerprint behaves exactly as it did before', async () => {
    const restore = stubText(TEXT);
    try {
      const bill = makeBill(); // no decode_text_sha — the whole pre-2026-09-18 corpus
      const bySlug = new Map([['hr-1234-119', bill]]);
      let calls = 0;
      const anthropic = {
        messages: {
          create: async () => {
            calls++;
            return { content: [{ type: 'text', text: calls === 1 ? 'Summary.' : STRUCTURE_REPLY }] };
          },
        },
      };
      const result = await redecodeBill('hr-1234-119', { anthropic, es: {}, bySlug });
      expect(result.outcome).toBe('redecoded');
      expect(result.decodeAttempted).toBe(true);
    } finally {
      restore();
    }
  });

  test('a VEHICLE SWAP never short-circuits, even on an identical document', async () => {
    // The title changed under us. That is the one case where the record and
    // the document have to be rewritten together, and skipping it is how a
    // page ends up explaining a different bill than the one being voted.
    // NOTE (2026-09-19): this no longer needs a `!title` carve-out to hold.
    // The fingerprint covers the prompt, and the prompt carries the title.
    const restore = stubText(TEXT);
    try {
      const bill = makeBill();
      bill.decode_text_sha = fingerprintOf(bill, TEXT);
      const bySlug = new Map([['hr-1234-119', bill]]);
      let calls = 0;
      const anthropic = {
        messages: {
          create: async () => {
            calls++;
            return { content: [{ type: 'text', text: calls === 1 ? 'Summary.' : STRUCTURE_REPLY }] };
          },
        },
      };
      const result = await redecodeBill('hr-1234-119', {
        anthropic, es: {}, bySlug, title: 'A continuing resolution for fiscal year 2027.',
      });
      expect(result.outcome).toBe('redecoded');
      // Three calls, not two: a vehicle swap also regenerates the search
      // handles, because the old press_names still name the old act.
      expect(calls).toBe(3);
      expect(bill.title).toBe('A continuing resolution for fiscal year 2027.');
    } finally {
      restore();
    }
  });
});

test.describe('the fingerprint covers the MODEL INPUT, not the document', () => {
  test('a title-only change changes the fingerprint', () => {
    // THE MEDIUM FINDING of the 2026-09-19 review. Call 1 reads
    // `buildSummaryPrompt(bill, text)`, which prints the title above the
    // document. A fingerprint over the document alone therefore called a
    // renamed bill unchanged — and vetoed exactly the re-decode that rename
    // needed.
    const before = makeBill({ title: 'An act to fund bridge repair.' });
    const after = makeBill({ title: 'An act to fund bridge repair and rail crossings.' });
    expect(fingerprintOf(before, TEXT)).not.toBe(fingerprintOf(after, TEXT));
    // And the document still matters on its own.
    expect(fingerprintOf(before, TEXT)).not.toBe(fingerprintOf(before, `${TEXT} SEC. 2.`));
  });

  test('a SUB-THRESHOLD title change on an identical document is still re-decoded', async () => {
    // Not a vehicle swap — titleDrift would not call this one — so the old
    // `!title` carve-out could not have saved it, and the document-only
    // fingerprint matched. The result was a page whose headline named one act
    // and whose explanation described another, permanently.
    const restore = stubText(TEXT);
    try {
      const bill = makeBill();
      bill.decode_text_sha = fingerprintOf(bill, TEXT);
      const bySlug = new Map([['hr-1234-119', bill]]);
      let calls = 0;
      const anthropic = {
        messages: {
          create: async () => {
            calls++;
            return { content: [{ type: 'text', text: calls === 1 ? 'Summary.' : STRUCTURE_REPLY }] };
          },
        },
      };
      const result = await redecodeBill('hr-1234-119', {
        anthropic, es: {}, bySlug, title: 'An act to fund bridge repair and rail crossings.',
      });
      expect(result.outcome).toBe('redecoded');
      expect(result.decodeAttempted).toBe(true);
    } finally {
      restore();
    }
  });
});

test.describe('the short-circuit settles instead of re-firing every hour', () => {
  test('redecodeVerdict counts a verification stamp as freshness', () => {
    const base = { corpusTitle: 'Same', fetchedTitle: 'Same', lastActionDate: '2026-09-15' };
    // Without the stamp, this bill re-enters the verdict every single run.
    expect(redecodeVerdict({ ...base, decodedAt: '2026-09-01T00:00:00Z' }).reason).toBe('stale-decode');
    // With it, the run that re-read the document and found it unchanged has
    // settled the question until the document itself moves again.
    expect(
      redecodeVerdict({ ...base, decodedAt: '2026-09-01T00:00:00Z', textVerifiedAt: '2026-09-16T00:00:00Z' }).redecode
    ).toBe(false);
  });

  test('a verification stamp never rescues a bill that has no decode at all', () => {
    expect(
      redecodeVerdict({
        decodedAt: null,
        textVerifiedAt: '2026-09-16T00:00:00Z',
        lastActionDate: '2026-09-15',
        corpusTitle: 'Same',
        fetchedTitle: 'Same',
      }).reason
    ).toBe('null-decoded-at');
  });

  test('an older verification stamp changes nothing', () => {
    expect(
      redecodeVerdict({
        decodedAt: '2026-09-14T00:00:00Z',
        textVerifiedAt: '2026-09-02T00:00:00Z',
        lastActionDate: '2026-09-15',
        corpusTitle: 'Same',
        fetchedTitle: 'Same',
      }).reason
    ).toBe('stale-decode');
  });

  test('the newsdesk commits the verification stamp', () => {
    // If 'text-unchanged' were not a data change, the stamp would be written
    // in memory and thrown away, the verdict would fire again next hour, and
    // the saving would be exactly zero.
    expect(anyDataChanged(['text-unchanged'])).toBe(true);
    expect(anyDataChanged(['gated', 'skipped_no_text'])).toBe(false);
  });
});
