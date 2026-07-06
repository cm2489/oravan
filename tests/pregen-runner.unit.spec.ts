import { expect, test } from '@playwright/test';
import { main, type AnthropicLike } from '../lib/pregen-runner';
import { planCombos, buildBatchRequest, customId } from '../lib/pregen';
import { createScriptCache, scriptKey } from '../lib/scriptcache';
import { STANCES } from '../lib/scriptprompt';
import type { Bill } from '../lib/types';
import { CACHE_URL, MockUpstash, installUpstashFetch, setUpstashEnv } from './upstash-mock';

/*
 * Pins scripts/pregen-scripts.mjs's orchestration (lib/pregen-runner.ts):
 * idempotent skip against the REAL lib/scriptcache.ts cache (import
 * equality on the key, not a reimplementation), --dry-run's zero-network
 * guarantee, the batch-payload shape actually submitted, and the bounded
 * poll timeout's fail-safe (never writes a partial/incomplete result).
 *
 * No live Anthropic or Upstash token exists in this environment. Anthropic
 * is a plain injected fake shaped like { messages: { batches: { create,
 * retrieve, results } } } — main()'s only contract with it — so no test
 * needs to reproduce the Message Batches API's real HTTP/JSONL wire format.
 */

test.describe.configure({ mode: 'serial' }); // shared env + global-fetch swaps

let restoreFetch: (() => void) | null = null;
let restoreEnv: (() => void) | null = null;

test.afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  restoreEnv?.();
  restoreEnv = null;
});

function makeBill(overrides: Partial<Bill> = {}): Bill {
  return {
    full_identifier: '119-hr-1234',
    congress_number: 119,
    bill_type: 'hr',
    bill_number: 1234,
    title: 'An act to do a thing.',
    short_title: 'The Thing Act',
    ai_summary: 'This bill funds bridges.',
    ai_headline: 'Congress considers bridge funding',
    sponsor_bioguide_id: null,
    introduced_date: '2026-01-01',
    last_action_date: '2026-06-30',
    status: 'committee',
    last_action_text: 'Referred to committee.',
    issue_tags: null,
    policy_area: null,
    urgency_score: 0.5,
    congress_gov_url: null,
    ...overrides,
  };
}

const noopSleep = async () => {};

/** A fake shaped exactly like main()'s AnthropicLike contract. */
function fakeAnthropic(opts: {
  createStatus?: 'ended' | 'in_progress';
  retrieveStatus?: 'ended' | 'in_progress';
} = {}): { anthropic: AnthropicLike; createCalls: { requests: unknown[] }[]; retrieveCalls: string[]; resultsCalls: string[] } {
  const createCalls: { requests: unknown[] }[] = [];
  const retrieveCalls: string[] = [];
  const resultsCalls: string[] = [];
  const anthropic: AnthropicLike = {
    messages: {
      batches: {
        async create(body) {
          createCalls.push(body as { requests: unknown[] });
          return { id: 'batch_1', processing_status: opts.createStatus ?? 'ended' };
        },
        async retrieve(id) {
          retrieveCalls.push(id);
          return { id, processing_status: opts.retrieveStatus ?? 'ended' };
        },
        async results(id) {
          resultsCalls.push(id);
          const body = createCalls[0];
          async function* gen() {
            for (const req of body.requests as { custom_id: string }[]) {
              yield {
                custom_id: req.custom_id,
                result: {
                  type: 'succeeded' as const,
                  message: { content: [{ type: 'text', text: `SCRIPT FOR ${req.custom_id}` }] },
                },
              };
            }
          }
          return gen();
        },
      },
    },
  };
  return { anthropic, createCalls, retrieveCalls, resultsCalls };
}

/** Throws if any Anthropic method is invoked — for the dry-run zero-network test. */
const poisonAnthropic: AnthropicLike = {
  messages: {
    batches: {
      create: () => {
        throw new Error('main() must not call Anthropic in --dry-run');
      },
      retrieve: () => {
        throw new Error('main() must not call Anthropic in --dry-run');
      },
      results: () => {
        throw new Error('main() must not call Anthropic in --dry-run');
      },
    },
  },
};

test('idempotent skip + key/TTL exactness: a pre-cached combo is skipped, and writes use the REAL scriptcache key/TTL', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [CACHE_URL]: mock });

  const bill = makeBill();
  const cache = createScriptCache();
  const [preCached] = planCombos([bill], ['support'], ['en']);
  await cache.set(preCached, 'ALREADY GENERATED');
  mock.commands = []; // only care about what main() itself does from here

  const { anthropic, createCalls } = fakeAnthropic();
  const result = await main({
    anthropic,
    cache,
    getBills: () => [bill],
    sleep: noopSleep,
  });

  // 6 combos total (3 stances x 2 locales), 1 pre-cached -> 5 to generate.
  expect(result).toEqual({ planned: 5, generated: 5, dryRun: false, batchId: 'batch_1' });
  expect(createCalls).toHaveLength(1);
  expect(createCalls[0].requests).toHaveLength(5);

  // Every write went through the SAME key builder the live route uses
  // (import equality, not a second implementation) with the route's 24h TTL.
  const allCombos = planCombos([bill], STANCES, ['en', 'es']);
  const newlyGenerated = allCombos.filter((c) => `${c.stance}:${c.lang}` !== 'support:en');
  for (const combo of newlyGenerated) {
    const key = scriptKey(combo);
    const set = mock.commands.find((c) => c[0] === 'SET' && c[1] === key);
    expect(set, `expected a SET for ${key}`).toBeTruthy();
    expect(set!.slice(3)).toEqual(['EX', '86400']);
    expect(await cache.get(combo)).toBe(`SCRIPT FOR ${customId(combo)}`);
  }
  // The pre-cached combo is untouched.
  expect(await cache.get(preCached)).toBe('ALREADY GENERATED');
});

test('--dry-run: zero network calls of any kind (no Anthropic, no Upstash) and no cache writes', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [CACHE_URL]: mock });

  const bill = makeBill();
  const cache = createScriptCache();
  const result = await main({
    anthropic: poisonAnthropic,
    cache,
    getBills: () => [bill],
    dryRun: true,
    sleep: noopSleep,
  });

  expect(result).toEqual({ planned: 6, generated: 0, dryRun: true });
  expect(mock.commands).toHaveLength(0); // not one Upstash request, not even a GET
});

test('batch-payload shape: requests sent to Anthropic are exactly buildBatchRequest\'s output', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [CACHE_URL]: mock });

  const bill = makeBill({ bill_number: 42 });
  const cache = createScriptCache();
  const { anthropic, createCalls } = fakeAnthropic();
  await main({ anthropic, cache, getBills: () => [bill], sleep: noopSleep });

  const expected = planCombos([bill], STANCES, ['en', 'es']).map(buildBatchRequest);
  const actual = createCalls[0].requests as ReturnType<typeof buildBatchRequest>[];
  expect(actual.map((r) => r.custom_id).sort()).toEqual(expected.map((r) => r.custom_id).sort());
  for (const req of expected) {
    const sent = actual.find((r) => r.custom_id === req.custom_id);
    expect(sent).toEqual(req);
  }
});

test('bounded poll timeout: never writes a partial result, and stops before ever calling retrieve/results', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [CACHE_URL]: mock });

  const bill = makeBill();
  const cache = createScriptCache();
  const { anthropic, retrieveCalls, resultsCalls } = fakeAnthropic({ createStatus: 'in_progress' });

  let clock = 0;
  const now = () => {
    clock += 1;
    // 1st call sets the deadline; 2nd call (inside the poll loop) must
    // already be past it, so the timeout fires without ever sleeping.
    return clock === 1 ? 0 : 10 * 60 * 1000 + 1;
  };

  const result = await main({
    anthropic,
    cache,
    getBills: () => [bill],
    now,
    sleep: noopSleep,
    maxWaitMs: 10 * 60 * 1000,
  });

  expect(result.timedOut).toBe(true);
  expect(result.generated).toBe(0);
  expect(retrieveCalls).toHaveLength(0);
  expect(resultsCalls).toHaveLength(0);
  // Nothing was ever written to the cache database.
  expect(mock.commands.some((c) => c[0] === 'SET')).toBe(false);
  for (const combo of planCombos([bill], STANCES, ['en', 'es'])) {
    expect(await cache.get(combo)).toBeNull();
  }
});
