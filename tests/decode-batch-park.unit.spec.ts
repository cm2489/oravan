import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSummaryPrompt, textFingerprint } from '../scripts/bill-decode.mjs';
import { runHonestyVerdict } from '../scripts/check-run-honesty.mjs';
import {
  PARK_BLOCK_MAX_MS,
  PARK_RETENTION_MS,
  decodeBatched,
  drainDecodeQueue,
  emptyParkedState,
  finalizeParkedState,
  harvestParked,
  isTimeCriticalDecode,
  jobPromptSha,
  liveVehicleSlugs,
  normalizeParkedState,
  pruneParkedState,
  unresolvedSlugs,
} from '../lib/decode-batch.mjs';
import { formatSyncDoneLine, loadParkingContext, resolveCursorRows } from '../scripts/sync-bills.mjs';
import { parseSyncDone } from '../lib/pipeline-health.mjs';

/*
 * Pins the 2026-09-25 change: a nightly decode batch that runs past its wait
 * is PARKED and collected by the next run, instead of being cancelled and
 * re-bought synchronously at full price.
 *
 * The evidence that made it worth doing: nightly run 36041019168 (2026-09-24)
 * — "summaries batch ... still processing after 480000ms — abandoning it and
 * decoding those bills synchronously instead ... 0 decoded via Batches (50%
 * rate), 12 via synchronous fallback (full rate)"; and 2026-09-23, 54 bills the
 * same way.
 *
 * The four properties a reader of this file should be able to rely on:
 *   1. A PARKED BILL IS PAID FOR ONCE. Tonight parks it; the next run reads
 *      the parked result back BEFORE it submits anything, and never submits a
 *      request for a half it already holds.
 *   2. A PARKED BILL IS NEVER STEPPED OVER. It is not in the corpus, so the
 *      cursor freezes on it exactly as it would on a failed decode (#255).
 *   3. A PARKED BILL IS NOT A FAILURE. It never reaches failedSlugs, and it
 *      is not counted in `decodeAttempts` either, so it cannot trip the
 *      honesty alarm (not even alongside an unrelated refresh failure) or the
 *      mostly-failed abort.
 *   4. TIME-CRITICAL BILLS KEEP THE OLD PATH — their own batch, cancelled at
 *      the deadline, decoded synchronously the same night.
 *
 * Every API call is a fake. Nothing here reaches Anthropic or Congress.gov.
 */

test.beforeAll(() => {
  process.env.CONGRESS_API_KEY ??= 'test-key-never-sent-anywhere';
});

const NOW = Date.parse('2026-09-24T18:30:00Z');

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

type AnyBill = Record<string, unknown>;

/** A brand-new bill as syncOneBill builds it: a stale backlog markup, which
 *  can wait a night. */
function backlogBill(slug: string, overrides: AnyBill = {}): AnyBill {
  const [type, num] = slug.split('-');
  return {
    full_identifier: slug,
    congress_number: 119,
    bill_type: type,
    bill_number: Number(num),
    title: `An act numbered ${num}.`,
    status: 'markup',
    last_action_text: 'Ordered to be Reported (Amended) by Voice Vote.',
    last_action_date: '2026-04-22',
    ai_summary: null,
    ai_headline: null,
    decoded_at: null,
    ...overrides,
  };
}

/** A new bill with a dated Senate calendar placement inside the signal window:
 *  T2, the homepage's act-now pool — time-critical. */
function floorBill(slug: string): AnyBill {
  return backlogBill(slug, {
    status: 'floor_vote',
    last_action_text: 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 412.',
    last_action_date: '2026-09-17',
  });
}

type Job = { slug: string; bill: AnyBill; text: string; version: null; count: null; pass?: string };
const job = (slug: string, bill = backlogBill(slug), text = `FULL TEXT OF ${slug}`, pass = 'ascending'): Job => ({
  slug, bill, text, version: null, count: null, pass,
});

type StoredBatch = { status: string; rows: Map<string, string>; requests: Array<{ custom_id: string; params: { messages: Array<{ content: string }> } }>; notFound?: boolean; failRetrieve?: boolean; failResults?: boolean };

const isSummaryPrompt = (p: string) => p.startsWith('Explain this congressional bill');
const isStructurePrompt = (p: string) => p.startsWith('From this plain-language bill summary');

/**
 * One fake Anthropic client, stateful across "nights": batches created on
 * night 1 are still there on night 2, so a test can flip one to ended and
 * watch the next drain collect it.
 */
function fakeAnthropic() {
  const batches = new Map<string, StoredBatch>();
  const created: string[] = [];
  const cancelled: string[] = [];
  const retrieved: string[] = [];
  const sync: string[] = [];
  let n = 0;
  // What a NEW batch does: 'end' finishes at once, 'stall' never ends tonight.
  let mode: 'end' | 'stall' = 'end';
  const replyFor = (req: StoredBatch['requests'][number]) =>
    isSummaryPrompt(req.params.messages[0].content) ? `BATCH SUMMARY OF ${req.custom_id}` : STRUCTURE_REPLY;
  const client = {
    batches, created, cancelled, retrieved, sync,
    setMode(m: 'end' | 'stall') { mode = m; },
    /** Overnight: a stalled batch finishes and its rows appear. */
    finish(id: string) { const b = batches.get(id)!; b.status = 'ended'; },
    requestsIn(id: string) { return batches.get(id)!.requests; },
    messages: {
      async create({ messages }: { messages: Array<{ content: string }> }) {
        const p = messages[0].content;
        if (isSummaryPrompt(p)) { sync.push('summary'); return { content: [{ type: 'text', text: 'SYNC SUMMARY' }] }; }
        if (isStructurePrompt(p)) { sync.push('structure'); return { content: [{ type: 'text', text: STRUCTURE_REPLY }] }; }
        sync.push('search-inputs');
        return { content: [{ type: 'text', text: '[PRESS_NAMES]\nNONE\n[NEWS_QUERY]\nEPA "bridge repair"' }] };
      },
      batches: {
        async create({ requests }: { requests: StoredBatch['requests'] }) {
          const id = `msgbatch_${String(n++).padStart(4, '0')}`;
          const rows = new Map(requests.map((r) => [r.custom_id, replyFor(r)]));
          batches.set(id, { status: mode === 'end' ? 'ended' : 'in_progress', rows, requests });
          created.push(id);
          return { id, processing_status: batches.get(id)!.status };
        },
        async retrieve(id: string) {
          retrieved.push(id);
          const b = batches.get(id);
          if (!b || b.notFound) {
            const e = new Error(`batch ${id} not found`) as Error & { status?: number };
            e.status = 404;
            throw e;
          }
          if (b.failRetrieve) throw new Error('503 from the status check');
          return { id, processing_status: b.status };
        },
        async cancel(id: string) {
          cancelled.push(id);
          return { id, processing_status: 'canceling' };
        },
        async results(id: string) {
          const b = batches.get(id)!;
          if (b.failResults) throw new Error('results stream reset');
          return (async function* () {
            for (const [customId, text] of b.rows) {
              yield { custom_id: customId, result: { type: 'succeeded', message: { content: [{ type: 'text', text }] } } };
            }
          })();
        },
      },
    },
  };
  return client;
}

/** A fake clock that advances a minute per poll — so an 8-minute wait passes
 *  in microseconds. */
function clock(start = NOW) {
  let t = start;
  return { now: () => t, sleep: async () => { t += 60_000; }, advance: (ms: number) => { t += ms; } };
}

const quiet = () => {};

// ---------------------------------------------------------------------------
// 1. decodeBatched parks instead of cancelling — for bills that can wait
// ---------------------------------------------------------------------------

test.describe('decodeBatched: a slow batch is parked, not re-bought', () => {
  test('round 1 runs out of wait: the batch is NOT cancelled, its id is handed to onPark, the bills come back parked', async () => {
    const api = fakeAnthropic();
    api.setMode('stall');
    const c = clock();
    const parks: Array<Record<string, unknown>> = [];
    const jobs = [job('hr-1515-119'), job('hr-3706-119')];
    const out = await decodeBatched(jobs, {
      anthropic: api, log: quiet, now: c.now, sleep: c.sleep, maxWaitMs: 120_000,
      canPark: () => true, onPark: (e: Record<string, unknown>) => parks.push(e),
    });
    // The batch keeps working on requests we paid for; cancelling it is what
    // used to throw that work away.
    expect(api.cancelled).toEqual([]);
    expect(api.created).toHaveLength(1);
    expect(parks).toHaveLength(1);
    expect(parks[0].id).toBe(api.created[0]);
    expect(parks[0].round).toBe('summaries');
    // Ids and fingerprints only — no model output is ever written to the repo.
    expect(parks[0].jobs).toEqual(jobs.map((j) => ({ slug: j.slug, promptSha: jobPromptSha(j) })));
    for (const j of jobs) expect(out.get(j.slug)).toEqual({ ok: false, reason: 'parked', parked: true });
  });

  test('a time-critical bill rides its OWN batch, which is cancelled and falls back exactly as before', async () => {
    const api = fakeAnthropic();
    api.setMode('stall');
    const c = clock();
    const parks: Array<{ id: string; jobs: Array<{ slug: string }> }> = [];
    const urgent = job('s-4668-119', floorBill('s-4668-119'));
    const waits = job('hr-1461-119');
    const out = await decodeBatched([urgent, waits], {
      anthropic: api, log: quiet, now: c.now, sleep: c.sleep, maxWaitMs: 120_000,
      canPark: (j: Job) => j.slug !== urgent.slug,
      onPark: (e: { id: string; jobs: Array<{ slug: string }> }) => parks.push(e),
    });
    // Two batches, because batches cancel whole and only one may be cancelled.
    expect(api.created).toHaveLength(2);
    const urgentBatch = api.created.find((id) => api.requestsIn(id).some((r) => r.custom_id === urgent.slug))!;
    const waitingBatch = api.created.find((id) => id !== urgentBatch)!;
    expect(api.requestsIn(urgentBatch).map((r) => r.custom_id)).toEqual([urgent.slug]);
    expect(api.cancelled).toEqual([urgentBatch]);
    expect(parks.map((p) => p.id)).toEqual([waitingBatch]);
    expect(parks[0].jobs.map((j) => j.slug)).toEqual([waits.slug]);
    // The urgent bill is handed back for a synchronous decode tonight.
    expect(out.get(urgent.slug)).toEqual({ ok: false, reason: 'no-summary' });
    expect(out.get(waits.slug)?.parked).toBe(true);
  });

  test('round 2 runs out of wait: parked with a pointer to the batch that holds its summary', async () => {
    const api = fakeAnthropic();
    const c = clock();
    const parks: Array<{ id: string; round: string; jobs: Array<Record<string, unknown>> }> = [];
    const j = job('hr-2388-119');
    // Round 1 ends at once; round 2 stalls.
    const realCreate = api.messages.batches.create;
    api.messages.batches.create = async (arg) => {
      if (isStructurePrompt(arg.requests[0].params.messages[0].content)) api.setMode('stall');
      return realCreate(arg);
    };
    const out = await decodeBatched([j], {
      anthropic: api, log: quiet, now: c.now, sleep: c.sleep, maxWaitMs: 120_000,
      canPark: () => true, onPark: (e: { id: string; round: string; jobs: Array<Record<string, unknown>> }) => parks.push(e),
    });
    expect(api.created).toHaveLength(2);
    expect(api.cancelled).toEqual([]);
    expect(parks).toHaveLength(1);
    expect(parks[0].round).toBe('structure');
    expect(parks[0].id).toBe(api.created[1]);
    expect(parks[0].jobs[0].summaryBatch).toBe(api.created[0]);
    expect(parks[0].jobs[0].promptSha).toBe(jobPromptSha(j));
    expect(out.get(j.slug)?.parked).toBe(true);
  });

  test('without BOTH canPark and onPark nothing parks — the pre-2026-09-25 behaviour', async () => {
    const api = fakeAnthropic();
    api.setMode('stall');
    const c = clock();
    const out = await decodeBatched([job('hr-9-119')], {
      anthropic: api, log: quiet, now: c.now, sleep: c.sleep, maxWaitMs: 120_000,
      canPark: () => true, // no onPark: parking is not armed
    });
    expect(api.cancelled).toEqual(api.created);
    expect(out.get('hr-9-119')).toEqual({ ok: false, reason: 'no-summary' });
  });

  test('a prefilled (harvested) summary skips round 1 entirely', async () => {
    const api = fakeAnthropic();
    const c = clock();
    const j = job('hr-4093-119');
    const out = await decodeBatched([j], {
      anthropic: api, log: quiet, now: c.now, sleep: c.sleep, maxWaitMs: 120_000,
      prefilled: new Map([[j.slug, { text: 'A PARKED SUMMARY', batch: 'msgbatch_old', at: '2026-09-23T18:40:00Z' }]]),
    });
    expect(api.created).toHaveLength(1);
    expect(api.requestsIn(api.created[0]).every((r) => isStructurePrompt(r.params.messages[0].content))).toBe(true);
    expect(out.get(j.slug)?.ok).toBe(true);
    expect(out.get(j.slug)?.dec?.ai_summary).toBe('A PARKED SUMMARY');
  });

  test('one failed status check does NOT park a batch that ends inside its wait', async () => {
    // Parking early is no longer a double payment, but it is still a night's
    // delay for every bill in the batch — too much to pay for one transient 503.
    const api = fakeAnthropic();
    api.setMode('stall');
    const c = clock();
    const realRetrieve = api.messages.batches.retrieve;
    let polls = 0;
    api.messages.batches.retrieve = async (id: string) => {
      polls++;
      if (polls === 1) throw new Error('503 transient');
      api.finish(id); // the batch ends by the next look
      return realRetrieve(id);
    };
    const parks: unknown[] = [];
    const logs: string[] = [];
    const j = job('hr-1515-119');
    const out = await decodeBatched([j], {
      anthropic: api, log: (m: string) => logs.push(m), now: c.now, sleep: c.sleep, maxWaitMs: 480_000,
      canPark: () => true, onPark: (e: unknown) => parks.push(e),
    });
    expect(parks).toEqual([]);
    expect(api.cancelled).toEqual([]);
    expect(out.get(j.slug)?.ok).toBe(true);
    expect(logs.some((m) => m.includes('could not be polled (503 transient)') && m.includes('polling again'))).toBe(true);
  });

  test('status checks that keep failing park the batch at the deadline, not before, and never cancel it', async () => {
    const api = fakeAnthropic();
    api.setMode('stall');
    const c = clock();
    api.messages.batches.retrieve = async () => { throw new Error('503 from the status check'); };
    const parks: Array<{ id: string }> = [];
    const out = await decodeBatched([job('hr-1515-119')], {
      anthropic: api, log: quiet, now: c.now, sleep: c.sleep, maxWaitMs: 480_000,
      canPark: () => true, onPark: (e: { id: string }) => parks.push(e),
    });
    expect(c.now() - NOW).toBeGreaterThanOrEqual(480_000);
    expect(parks.map((p) => p.id)).toEqual(api.created);
    expect(api.cancelled).toEqual([]);
    expect(out.get('hr-1515-119')?.parked).toBe(true);
  });

  test('a failed status check on the TIME-CRITICAL batch still cancels and falls back at once', async () => {
    const api = fakeAnthropic();
    api.setMode('stall');
    const c = clock();
    api.messages.batches.retrieve = async () => { throw new Error('503 from the status check'); };
    const urgent = job('s-4668-119', floorBill('s-4668-119'));
    const out = await decodeBatched([urgent], {
      anthropic: api, log: quiet, now: c.now, sleep: c.sleep, maxWaitMs: 480_000,
      canPark: () => false, onPark: () => { throw new Error('nothing may park here'); },
    });
    // One poll interval, not the whole wait.
    expect(c.now() - NOW).toBeLessThan(480_000);
    expect(api.cancelled).toEqual(api.created);
    expect(out.get(urgent.slug)).toEqual({ ok: false, reason: 'no-summary' });
  });
});

// ---------------------------------------------------------------------------
// 2. Collecting what an earlier run parked
// ---------------------------------------------------------------------------

function parkedEntry(id: string, jobs: Job[], parkedAt = '2026-09-23T18:40:00Z') {
  return { id, round: 'summaries', parkedAt, jobs: jobs.map((j) => ({ slug: j.slug, promptSha: jobPromptSha(j) })) };
}

test.describe('harvestParked', () => {
  test('an ENDED parked batch hands back its summaries, keyed and fingerprinted', async () => {
    const api = fakeAnthropic();
    api.setMode('stall');
    const j = job('hr-1515-119');
    await api.messages.batches.create({ requests: [{ custom_id: j.slug, params: { messages: [{ content: buildSummaryPrompt(j.bill, j.text) }] } }] });
    api.finish(api.created[0]);
    const state = { ...emptyParkedState(), batches: [parkedEntry(api.created[0], [j])] };
    const h = await harvestParked(state, { anthropic: api, wanted: new Set([j.slug]), now: NOW, log: quiet });
    expect(h.summaries.get(j.slug)).toEqual({
      text: `BATCH SUMMARY OF ${j.slug}`, batch: api.created[0], at: '2026-09-23T18:40:00Z', promptSha: jobPromptSha(j),
    });
    expect(h.blocked.size).toBe(0);
    expect([...h.settled]).toEqual([j.slug]);
  });

  test('a parked batch STILL RUNNING blocks its bills — they must not be submitted twice', async () => {
    const api = fakeAnthropic();
    api.setMode('stall');
    const j = job('hr-1515-119');
    await api.messages.batches.create({ requests: [{ custom_id: j.slug, params: { messages: [{ content: 'Explain this congressional bill' }] } }] });
    const state = { ...emptyParkedState(), batches: [parkedEntry(api.created[0], [j])] };
    const h = await harvestParked(state, { anthropic: api, wanted: new Set([j.slug]), now: NOW, log: quiet });
    expect([...h.blocked]).toEqual([j.slug]);
    expect(h.summaries.size).toBe(0);
    expect(h.state.batches).toHaveLength(1); // still parked
  });

  test('an id the API does not know (404) is forgotten and blocks nothing', async () => {
    const api = fakeAnthropic();
    const j = job('hr-1515-119');
    const state = { ...emptyParkedState(), batches: [parkedEntry('msgbatch_gone', [j])] };
    const h = await harvestParked(state, { anthropic: api, wanted: new Set([j.slug]), now: NOW, log: quiet });
    expect(h.blocked.size).toBe(0);
    expect(h.state.batches).toHaveLength(0);
  });

  test('an unreadable batch blocks while young, and is forgotten once older than any batch can run', async () => {
    const api = fakeAnthropic();
    api.setMode('stall');
    const j = job('hr-1515-119');
    await api.messages.batches.create({ requests: [] as never });
    api.batches.get(api.created[0])!.failRetrieve = true;
    const young = { ...emptyParkedState(), batches: [parkedEntry(api.created[0], [j], new Date(NOW - 3_600_000).toISOString())] };
    const h1 = await harvestParked(young, { anthropic: api, wanted: new Set([j.slug]), now: NOW, log: quiet });
    expect([...h1.blocked]).toEqual([j.slug]);
    expect(h1.state.batches).toHaveLength(1);

    const old = { ...emptyParkedState(), batches: [parkedEntry(api.created[0], [j], new Date(NOW - PARK_BLOCK_MAX_MS - 60_000).toISOString())] };
    const h2 = await harvestParked(old, { anthropic: api, wanted: new Set([j.slug]), now: NOW, log: quiet });
    expect(h2.blocked.size).toBe(0);
    expect(h2.state.batches).toHaveLength(0);
  });

  test('a round-2 entry whose SUMMARY batch cannot be read holds the bill instead of re-buying the summary', async () => {
    const api = fakeAnthropic(); // mode 'end': both batches below have ended
    const j = job('hr-2388-119');
    await api.messages.batches.create({ requests: [{ custom_id: j.slug, params: { messages: [{ content: buildSummaryPrompt(j.bill, j.text) }] } }] });
    await api.messages.batches.create({ requests: [{ custom_id: j.slug, params: { messages: [{ content: 'From this plain-language bill summary: x' }] } }] });
    api.batches.get(api.created[0])!.failResults = true;
    const at = new Date(NOW - 3_600_000).toISOString();
    const state = {
      ...emptyParkedState(),
      batches: [{
        id: api.created[1], round: 'structure', parkedAt: at,
        jobs: [{ slug: j.slug, promptSha: jobPromptSha(j), summaryBatch: api.created[0], summaryAt: at }],
      }],
    };
    const h = await harvestParked(state, { anthropic: api, wanted: new Set([j.slug]), now: NOW, log: quiet });
    expect([...h.blocked]).toEqual([j.slug]);
    expect(h.settled.size).toBe(0);
    expect(h.summaries.size).toBe(0);
    expect(h.state.batches).toHaveLength(1);
  });

  test('an entry tonight does not need is never asked about — and is kept', async () => {
    const api = fakeAnthropic();
    const j = job('hr-1515-119');
    const state = { ...emptyParkedState(), batches: [parkedEntry('msgbatch_elsewhere', [j])] };
    const h = await harvestParked(state, { anthropic: api, wanted: new Set(['s-1-119']), now: NOW, log: quiet });
    expect(api.retrieved).toEqual([]);
    expect(h.state.batches).toHaveLength(1);
  });
});

test.describe('the parked-state file', () => {
  test('normalize is fail-closed per entry and per job', () => {
    const good = parkedEntry('msgbatch_a', [job('hr-1-119')]);
    const s = normalizeParkedState({
      batches: [
        good,
        { id: 'msgbatch_b', round: 'bogus', parkedAt: '2026-09-23T00:00:00Z', jobs: [] },
        { id: 'msgbatch_c', round: 'summaries', parkedAt: 'not a date', jobs: good.jobs },
        { ...good, id: 'msgbatch_d', jobs: [...good.jobs, { slug: 'HR 1', promptSha: 'x' }] },
        { id: 'msgbatch_e', round: 'structure', parkedAt: '2026-09-23T00:00:00Z', jobs: good.jobs }, // no summaryBatch
      ],
    });
    expect(s.batches.map((e: { id: string }) => e.id)).toEqual(['msgbatch_a', 'msgbatch_d']);
    expect(s.batches[1].jobs).toHaveLength(1);
    expect(normalizeParkedState(null).batches).toEqual([]);
    expect(normalizeParkedState({ nope: 1 }).batches).toEqual([]);
  });

  test('prune drops bills already in the corpus and output past the retention window', () => {
    const a = job('hr-1-119');
    const b = job('hr-2-119');
    const c = job('hr-3-119');
    const state = {
      ...emptyParkedState(),
      batches: [
        parkedEntry('msgbatch_new', [a, b], new Date(NOW - 86_400_000).toISOString()),
        parkedEntry('msgbatch_old', [c], new Date(NOW - PARK_RETENTION_MS - 60_000).toISOString()),
      ],
    };
    const out = pruneParkedState(state, { now: NOW, inCorpus: (s: string) => s === 'hr-2-119' });
    expect(out.batches).toHaveLength(1);
    expect(out.batches[0].jobs.map((j: { slug: string }) => j.slug)).toEqual(['hr-1-119']);
  });

  test('finalize removes what tonight settled, landed or re-parked, and appends tonight\'s parks', () => {
    const [a, b, c, d] = ['hr-1-119', 'hr-2-119', 'hr-3-119', 'hr-4-119'].map((s) => job(s));
    const state = { ...emptyParkedState(), batches: [parkedEntry('msgbatch_old', [a, b, c, d])] };
    const tonight = parkedEntry('msgbatch_tonight', [d]);
    const out = finalizeParkedState(state, {
      added: [tonight], settled: new Set(['hr-1-119']), inCorpus: (s: string) => s === 'hr-2-119',
    });
    expect(out.batches.map((e: { id: string }) => e.id)).toEqual(['msgbatch_old', 'msgbatch_tonight']);
    expect(out.batches[0].jobs.map((j: { slug: string }) => j.slug)).toEqual(['hr-3-119']);
  });
});

// ---------------------------------------------------------------------------
// 3. Who may wait a night
// ---------------------------------------------------------------------------

test.describe('isTimeCriticalDecode', () => {
  const ctx = { liveVehicles: new Set(['hr-9770-119']), floorSignals: {}, now: NOW };

  test('an owner\'s FORCE_DECODE_SLUGS entry never waits', () => {
    expect(isTimeCriticalDecode({ ...job('hr-1-119'), pass: 'force' }, ctx)).toBe(true);
  });

  test('a live Big Question vehicle never waits', () => {
    expect(isTimeCriticalDecode(job('hr-9770-119'), ctx)).toBe(true);
  });

  test('a bill in the homepage act-now pool (a fresh calendar placement) never waits', () => {
    expect(isTimeCriticalDecode(job('s-4668-119', floorBill('s-4668-119')), ctx)).toBe(true);
  });

  test('a floor announcement (T0) makes an otherwise quiet bill time-critical', () => {
    const signal = {
      tier0: { source: 'daily-digest', covers: '2026-09-25', quote: 'x' },
      fetched_at: new Date(NOW - 3_600_000).toISOString(),
    };
    expect(isTimeCriticalDecode(job('hr-7-119'), { ...ctx, floorSignals: { 'hr-7-119': signal } })).toBe(true);
  });

  test('a backlog bill whose last action is months old can wait', () => {
    expect(isTimeCriticalDecode(job('hr-1515-119'), ctx)).toBe(false);
  });

  test('a stale calendar placement is not act-now either', () => {
    const stale = floorBill('s-2074-119');
    stale.last_action_date = '2025-06-18';
    expect(isTimeCriticalDecode(job('s-2074-119', stale), ctx)).toBe(false);
  });

  test('liveVehicleSlugs reads only live questions, and only bill vehicles', () => {
    const got = liveVehicleSlugs({
      a: { status: 'live', vehicles: [{ slug: 'hr-1-119' }, { slug: 'pn-12-119', kind: 'nomination' }] },
      b: { status: 'retired', vehicles: [{ slug: 'hr-2-119' }] },
    });
    expect([...got]).toEqual(['hr-1-119']);
  });

  test('an unreadable moments file turns parking OFF, not on', () => {
    const ctxOut = loadParkingContext((p: string) => {
      if (p.endsWith('moments.json')) throw new Error('ENOENT');
      return '{"signals":{}}';
    }, quiet);
    expect(ctxOut.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. The drain across two nights — paid once, never stepped over
// ---------------------------------------------------------------------------

function corpus() {
  const bills: AnyBill[] = [];
  const es: Record<string, unknown> = {};
  const bySlug = new Map<string, AnyBill>();
  return { bills, es, bySlug };
}

/** Summary requests any batch was ever sent for `slug`. */
function summaryRequestsFor(api: ReturnType<typeof fakeAnthropic>, slug: string) {
  return api.created.flatMap((id) => api.requestsIn(id))
    .filter((r) => r.custom_id === slug && isSummaryPrompt(r.params.messages[0].content)).length;
}

test.describe('drainDecodeQueue: a slow night, then the night after', () => {
  const nightOne = async (api: ReturnType<typeof fakeAnthropic>, jobs: Job[]) => {
    const c = clock();
    const store = corpus();
    api.setMode('stall');
    const res = await drainDecodeQueue(jobs, {
      anthropic: api, ...store,
      isTimeCritical: (j: Job) => j.pass === 'force' || j.slug.startsWith('s-4668'),
      now: c.now, sleep: c.sleep, maxWaitMs: 120_000, log: quiet, logError: quiet,
    });
    return { res, store };
  };

  test('night 1: the time-critical bill lands tonight; the rest are parked — deferred, not failed, not decoded', async () => {
    const api = fakeAnthropic();
    const urgent = job('s-4668-119', floorBill('s-4668-119'));
    const waits = job('hr-1515-119');
    const { res, store } = await nightOne(api, [urgent, waits]);

    expect(store.bySlug.has(urgent.slug)).toBe(true);
    expect(res.syncFallback).toBe(1);
    // The synchronous spend tonight is the urgent bill's two calls and nothing else.
    expect(api.sync.filter((s) => s !== 'search-inputs')).toEqual(['summary', 'structure']);

    expect(store.bySlug.has(waits.slug)).toBe(false);
    expect([...res.deferredSlugs]).toEqual([waits.slug]);
    expect(res.failedSlugs.size).toBe(0); // property 3: parked is not failed
    expect(res.parked).toBe(1);
    expect(res.parkedState.batches).toHaveLength(1);
    expect(res.parkedState.batches[0].jobs.map((j: { slug: string }) => j.slug)).toEqual([waits.slug]);
  });

  test('night 1: the cursor freezes on the parked bill — it is never stepped over (#255)', async () => {
    const api = fakeAnthropic();
    const waits = job('hr-1515-119');
    const { res } = await nightOne(api, [waits]);
    const rows = [
      { updateDate: '2026-09-22', day: '2026-09-22', slug: 'hr-100-119', needsWork: false },
      { updateDate: '2026-09-23', day: '2026-09-23', slug: waits.slug, needsWork: false }, // queued: its row cannot know yet
      { updateDate: '2026-09-24', day: '2026-09-24', slug: 'hr-200-119', needsWork: false },
    ];
    // Exactly the set scripts/sync-bills.mjs hands resolveCursorRows — the
    // drain's own `unresolvedSlugs`, pinned at the call site in section 6.
    expect([...res.unresolvedSlugs]).toEqual([waits.slug]);
    const out = resolveCursorRows(rows, '2026-09-21T00:00:00Z', res.unresolvedSlugs);
    expect(out.frozen).toBe(true);
    expect(out.cursor.startsWith('2026-09-22')).toBe(true);
    expect(out.lastFullDay).toBe('2026-09-22');

    // And the counter-check: the failure set alone would have walked past it.
    const naive = resolveCursorRows(rows, '2026-09-21T00:00:00Z', res.failedSlugs);
    expect(naive.cursor.startsWith('2026-09-24')).toBe(true);
  });

  test('night 2: the parked batch has ended — its summary is collected, only call 2 is bought, and the bill lands', async () => {
    const api = fakeAnthropic();
    const waits = job('hr-1515-119');
    const { res: first } = await nightOne(api, [waits]);
    api.finish(first.parkedState.batches[0].id); // it finished overnight

    const store = corpus();
    const c = clock(NOW + 86_400_000);
    api.setMode('end');
    const syncBefore = api.sync.length;
    const res = await drainDecodeQueue([job('hr-1515-119')], {
      anthropic: api, ...store, parkedState: first.parkedState,
      isTimeCritical: () => false,
      now: c.now, sleep: c.sleep, maxWaitMs: 120_000, log: quiet, logError: quiet,
    });

    expect(store.bySlug.has(waits.slug)).toBe(true);
    expect(store.bySlug.get(waits.slug)?.ai_summary).toBe(`BATCH SUMMARY OF ${waits.slug}`);
    // PROPERTY 1: across both nights the summary was requested exactly once.
    expect(summaryRequestsFor(api, waits.slug)).toBe(1);
    expect(api.sync.slice(syncBefore).filter((s) => s !== 'search-inputs')).toEqual([]);
    expect(res.harvested).toBe(1);
    expect(res.deferredSlugs.size).toBe(0);
    // Nothing left to collect.
    expect(res.parkedState.batches).toEqual([]);
  });

  test('night 2: the parked batch is STILL running — the bill is held back, nothing is submitted for it, it stays parked', async () => {
    const api = fakeAnthropic();
    const waits = job('hr-1515-119');
    const { res: first } = await nightOne(api, [waits]);
    const createdBefore = api.created.length;

    const store = corpus();
    const c = clock(NOW + 6 * 3_600_000); // a manual dispatch six hours later
    const res = await drainDecodeQueue([job('hr-1515-119')], {
      anthropic: api, ...store, parkedState: first.parkedState,
      isTimeCritical: () => false,
      now: c.now, sleep: c.sleep, maxWaitMs: 120_000, log: quiet, logError: quiet,
    });
    expect(api.created.length).toBe(createdBefore);
    expect(summaryRequestsFor(api, waits.slug)).toBe(1);
    expect([...res.deferredSlugs]).toEqual([waits.slug]);
    expect(res.held).toBe(1);
    expect(res.failedSlugs.size).toBe(0);
    expect(res.parkedState.batches).toHaveLength(1);
  });

  test('night 2: the bill\'s text changed since — the parked summary is NOT used and the bill is decoded from the new text', async () => {
    const api = fakeAnthropic();
    const waits = job('hr-1515-119');
    const { res: first } = await nightOne(api, [waits]);
    api.finish(first.parkedState.batches[0].id);

    const store = corpus();
    const c = clock(NOW + 86_400_000);
    api.setMode('end');
    const amended = job('hr-1515-119', backlogBill('hr-1515-119'), 'AMENDED TEXT');
    const res = await drainDecodeQueue([amended], {
      anthropic: api, ...store, parkedState: first.parkedState,
      isTimeCritical: () => false,
      now: c.now, sleep: c.sleep, maxWaitMs: 120_000, log: quiet, logError: quiet,
    });
    const landed = store.bySlug.get(amended.slug);
    expect(landed?.ai_summary).toBe(`BATCH SUMMARY OF ${amended.slug}`);
    // Stamped from the text the model actually read tonight.
    expect(landed?.decode_text_sha).toBe(textFingerprint(buildSummaryPrompt(amended.bill, 'AMENDED TEXT')));
    expect(summaryRequestsFor(api, amended.slug)).toBe(2);
    expect(res.harvested).toBe(0);
    expect(res.batchDecoded).toBe(1);
    expect(res.parkedState.batches).toEqual([]);
  });

  test('night 2: a round-2 park that has ended is assembled with no new request at all', async () => {
    const api = fakeAnthropic();
    const c1 = clock();
    const j = job('hr-2388-119');
    const realCreate = api.messages.batches.create;
    api.messages.batches.create = async (arg) => {
      api.setMode(isStructurePrompt(arg.requests[0].params.messages[0].content) ? 'stall' : 'end');
      return realCreate(arg);
    };
    const first = await drainDecodeQueue([j], {
      anthropic: api, ...corpus(), isTimeCritical: () => false,
      now: c1.now, sleep: c1.sleep, maxWaitMs: 120_000, log: quiet, logError: quiet,
    });
    expect(first.parkedState.batches[0].round).toBe('structure');
    api.finish(first.parkedState.batches[0].id);
    const createdBefore = api.created.length;
    const syncBefore = api.sync.length;

    const store = corpus();
    const c2 = clock(NOW + 86_400_000);
    const res = await drainDecodeQueue([job('hr-2388-119')], {
      anthropic: api, ...store, parkedState: first.parkedState, isTimeCritical: () => false,
      now: c2.now, sleep: c2.sleep, maxWaitMs: 120_000, log: quiet, logError: quiet,
    });
    expect(api.created.length).toBe(createdBefore);
    expect(api.sync.slice(syncBefore).filter((s) => s !== 'search-inputs')).toEqual([]);
    expect(store.bySlug.has(j.slug)).toBe(true);
    expect(res.harvested).toBe(1);
    expect(res.parkedState.batches).toEqual([]);
  });

  test('a parked bill tonight\'s sync gated out needs nothing collected — it leaves the file', async () => {
    const api = fakeAnthropic();
    const waits = job('hr-1515-119');
    const { res: first } = await nightOne(api, [waits]);
    const res = await drainDecodeQueue([], {
      anthropic: api, ...corpus(), parkedState: first.parkedState,
      noDecodeNeeded: new Set([waits.slug]), now: () => NOW + 86_400_000, log: quiet, logError: quiet,
    });
    expect(res.parkedState.batches).toEqual([]);
  });

  test('with the default isTimeCritical nothing is parked — the pre-2026-09-25 drain', async () => {
    const api = fakeAnthropic();
    const c = clock();
    api.setMode('stall');
    const store = corpus();
    const res = await drainDecodeQueue([job('hr-1515-119')], {
      anthropic: api, ...store, now: c.now, sleep: c.sleep, maxWaitMs: 120_000, log: quiet, logError: quiet,
    });
    expect(api.cancelled).toEqual(api.created);
    expect(res.parked).toBe(0);
    expect(res.syncFallback).toBe(1);
    expect(store.bySlug.has('hr-1515-119')).toBe(true);
  });

  test('unresolvedSlugs is every bill the drain did not land — failed AND parked — and freezes the cursor on either', async () => {
    const api = fakeAnthropic();
    // The time-critical bill's synchronous fallback fails outright.
    api.messages.create = async () => { throw new Error('529 overloaded'); };
    const urgent = job('s-4668-119', floorBill('s-4668-119'));
    const waits = job('hr-1515-119');
    const { res } = await nightOne(api, [urgent, waits]);
    expect([...res.failedSlugs]).toEqual([urgent.slug]);
    expect([...res.deferredSlugs]).toEqual([waits.slug]);
    expect(res.unresolvedSlugs).toEqual(new Set([urgent.slug, waits.slug]));
    expect(unresolvedSlugs(res)).toEqual(res.unresolvedSlugs);

    for (const slug of [urgent.slug, waits.slug]) {
      const rows = [
        { updateDate: '2026-09-22', day: '2026-09-22', slug: 'hr-100-119', needsWork: false },
        { updateDate: '2026-09-23', day: '2026-09-23', slug, needsWork: false },
        { updateDate: '2026-09-24', day: '2026-09-24', slug: 'hr-200-119', needsWork: false },
      ];
      const out = resolveCursorRows(rows, '2026-09-21T00:00:00Z', res.unresolvedSlugs);
      expect(out.frozen).toBe(true);
      expect(out.lastFullDay).toBe('2026-09-22');
    }
  });

  test('an empty queue still hands back an (empty) unresolvedSlugs', async () => {
    const res = await drainDecodeQueue([], { anthropic: fakeAnthropic(), ...corpus(), log: quiet, logError: quiet });
    expect(res.unresolvedSlugs).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// 4a. The honesty alarm — a night that parked is not a dead decode path
// ---------------------------------------------------------------------------

test.describe('decodeAttempts and the run-honesty alarm (rule 3)', () => {
  /** Run `fn` with RUN_COUNTERS_FILE pointed at a fresh temp file, and hand
   *  back what it wrote. Restores the env either way. */
  async function withCounters(fn: () => Promise<void>): Promise<Record<string, number>> {
    const dir = mkdtempSync(join(tmpdir(), 'park-counters-'));
    const file = join(dir, 'counters.json');
    const prev = process.env.RUN_COUNTERS_FILE;
    process.env.RUN_COUNTERS_FILE = file;
    try {
      await fn();
      try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
    } finally {
      if (prev === undefined) delete process.env.RUN_COUNTERS_FILE;
      else process.env.RUN_COUNTERS_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const drainStalled = (api: ReturnType<typeof fakeAnthropic>, jobs: Job[], isTimeCritical: (j: Job) => boolean) => {
    const c = clock();
    api.setMode('stall');
    return drainDecodeQueue(jobs, {
      anthropic: api, ...corpus(), isTimeCritical,
      now: c.now, sleep: c.sleep, maxWaitMs: 120_000, log: quiet, logError: quiet,
    });
  };

  test('a night where EVERY bill parks, plus one unrelated refresh failure, does not red the run', async () => {
    const api = fakeAnthropic();
    const jobs = ['hr-1515-119', 'hr-3706-119', 'hr-1461-119'].map((s) => job(s));
    let parked = -1;
    const counters = await withCounters(async () => { parked = (await drainStalled(api, jobs, () => false)).parked; });
    expect(parked).toBe(3);
    // The parked jobs reached the model, but their verdict is due next run.
    expect(counters.decodeAttempts ?? 0).toBe(0);
    // What scripts/sync-bills.mjs then writes: every parked bill came back out
    // of `added`, and one Congress.gov refresh 500 lands in billsFailed.
    const verdict = runHonestyVerdict({ ...counters, billsAdded: 0, billsFailed: 1 }, { job: 'nightly' });
    expect(verdict.failures).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  test('...but the one decode that was DUE tonight failing both ways still reds it', async () => {
    const api = fakeAnthropic();
    api.messages.create = async () => { throw new Error('529 overloaded'); };
    const urgent = job('s-4668-119', floorBill('s-4668-119'));
    const jobs = [urgent, job('hr-1515-119'), job('hr-3706-119')];
    let failed: string[] = [];
    let parked = -1;
    const counters = await withCounters(async () => {
      const res = await drainStalled(api, jobs, (j) => j.slug === urgent.slug);
      failed = [...res.failedSlugs];
      parked = res.parked;
    });
    expect(parked).toBe(2);
    expect(failed).toEqual([urgent.slug]);
    expect(counters.decodeAttempts).toBe(1);
    const verdict = runHonestyVerdict({ ...counters, billsAdded: 0, billsFailed: 1 }, { job: 'nightly' });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(' ')).toContain('dead decode path');
  });

  test('a bill that lands still counts as an attempt', async () => {
    const api = fakeAnthropic(); // mode 'end': the batch finishes at once
    const c = clock();
    let batchDecoded = -1;
    const counters = await withCounters(async () => {
      const res = await drainDecodeQueue([job('hr-1515-119')], {
        anthropic: api, ...corpus(), isTimeCritical: () => false,
        now: c.now, sleep: c.sleep, maxWaitMs: 120_000, log: quiet, logError: quiet,
      });
      batchDecoded = res.batchDecoded;
    });
    expect(batchDecoded).toBe(1);
    expect(counters.decodeAttempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. The DONE line still parses
// ---------------------------------------------------------------------------

test('the DONE line the script prints still parses in lib/pipeline-health.mjs, with the parked segment in it', () => {
  const line = formatSyncDoneLine({
    refreshed: 237, added: 3, gated: 324, queued: 1, deferredDecodes: 9, parkedTonight: 8, heldTonight: 1,
    harvestedDecodes: 2, revisited: 1, revisitFailed: 0, partialSkipped: 0, noTextSkipped: 0,
    forceWrongCongress: 0, failed: 4, newFailed: 2, recentFailed: 1, forceFailed: 0,
    cursor: '2026-09-23T00:00:00Z', cursorReason: 'frozen, finished 2026-09-22', newSeen: 337, corpus: 3218,
  });
  const parsed = parseSyncDone(line);
  expect(parsed).not.toBeNull();
  expect(parsed).toMatchObject({
    refreshed: 237, added: 3, gated: 324, queued: 1, ascendingFailed: 4, newFailed: 2,
    recentFailed: 1, forceFailed: 0, cursor: '2026-09-23T00:00:00Z', newSeen: 337, corpus: 3218,
  });
});

// ---------------------------------------------------------------------------
// 6. The script really hands the cursor that set (source pins)
// ---------------------------------------------------------------------------

test.describe('scripts/sync-bills.mjs wires the drain to the cursor', () => {
  // The script body is top-level await inside its argv guard, so no spec can
  // run it; everything above tests the pieces. These pin the lines that join
  // them. If resolveCursorRows were handed the failure set alone, every
  // behavioural test above would still pass and every parked bill would be
  // stepped over for good: #255's regression, back without a sound.
  const src = readFileSync(join(process.cwd(), 'scripts/sync-bills.mjs'), 'utf8');

  test('the one resolveCursorRows call site is handed the drain\'s unresolvedSlugs', () => {
    const calls = src.match(/resolveCursorRows\([^)]*\)/g) ?? [];
    // The first match is the function's own signature.
    const callSites = calls.filter((c) => !c.startsWith('resolveCursorRows(rows,'));
    expect(callSites).toEqual(['resolveCursorRows(cursorRows, since, drainUnresolvedSlugs)']);
    expect(src).toMatch(/drainUnresolvedSlugs = drain\.unresolvedSlugs;/);
  });

  test('the parked-bill direct fetch skips a slug a pass already met tonight', () => {
    expect(src).toMatch(
      /if \(handledSlugs\.has\(slug\) \|\| metTonight\.has\(slug\) \|\| queuedTonight\.has\(slug\) \|\| bySlug\.has\(slug\)\) continue;/
    );
  });
});
