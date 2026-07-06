import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): plain lib modules resolve under the test
// runner - same pattern as the other unit specs.
import { contentVersion } from '../lib/scriptcache';
import { buildScriptPrompt } from '../lib/scriptprompt';
import {
  buildBatchRequest,
  customId,
  estimateCost,
  extractScriptFromResult,
  LOCALES,
  parseCustomId,
  planCombos,
  type BatchResultRow,
} from '../lib/pregen';
import type { Bill } from '../lib/types';

/*
 * Pins lib/pregen.ts's pure planning/estimation logic (S21, F7): the
 * (bill x stance x locale) combo shape, the custom_id encode/decode round
 * trip the batch result-processing step depends on, batch-payload shape
 * (built via the SAME buildScriptPrompt the live route uses - import
 * equality, not a second copy of the prompt), and the cost model.
 */

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
    last_action_text: 'Referred to committee.',
    status: 'committee',
    issue_tags: null,
    policy_area: null,
    urgency_score: 0.5,
    congress_gov_url: null,
    ...overrides,
  };
}

test.describe('planCombos', () => {
  test('one bill x 3 stances x 2 locales = 6 combos, each with the route\'s exact content-version', () => {
    const bill = makeBill();
    const combos = planCombos([bill], ['support', 'oppose', 'undecided'], ['en', 'es']);
    expect(combos).toHaveLength(6);
    const version = contentVersion(bill.ai_summary ?? bill.title);
    for (const combo of combos) {
      expect(combo.slug).toBe('hr-1234-119');
      expect(combo.version).toBe(version);
    }
    const pairs = combos.map((c) => `${c.stance}:${c.lang}`).sort();
    expect(pairs).toEqual(
      ['oppose:en', 'oppose:es', 'support:en', 'support:es', 'undecided:en', 'undecided:es'].sort()
    );
  });

  test('a corrected ai_summary changes the version — the exact §9.1(d) gap this key closes', () => {
    const original = makeBill({ ai_summary: 'Original summary.' });
    const corrected = makeBill({ ai_summary: 'Corrected summary after re-decode.' });
    const [a] = planCombos([original], ['support'], ['en']);
    const [b] = planCombos([corrected], ['support'], ['en']);
    expect(a.version).not.toBe(b.version);
  });

  test('multiple bills each produce their own combo set, in input order', () => {
    const b1 = makeBill({ bill_number: 1 });
    const b2 = makeBill({ bill_number: 2 });
    const combos = planCombos([b1, b2], ['support'], ['en']);
    expect(combos.map((c) => c.slug)).toEqual(['hr-1-119', 'hr-2-119']);
  });

  test('empty bill list (a genuine quiet week) plans zero combos, not an error', () => {
    expect(planCombos([], ['support', 'oppose', 'undecided'], ['en', 'es'])).toEqual([]);
  });
});

test.describe('customId / parseCustomId', () => {
  test('round-trips every field', () => {
    const bill = makeBill();
    const [combo] = planCombos([bill], ['undecided'], ['es']);
    const id = customId(combo);
    const parsed = parseCustomId(id);
    expect(parsed).toEqual({ slug: combo.slug, stance: combo.stance, lang: combo.lang, version: combo.version });
  });

  test('rejects malformed ids instead of guessing', () => {
    expect(parseCustomId('too-few--parts')).toBeNull();
    expect(parseCustomId('hr-1-119--not-a-stance--en--abc123')).toBeNull();
    expect(parseCustomId('hr-1-119--support--fr--abc123')).toBeNull();
    expect(parseCustomId('')).toBeNull();
  });
});

test.describe('buildBatchRequest', () => {
  test('the batch request prompt IS buildScriptPrompt\'s output — import equality, not a second copy', () => {
    const bill = makeBill();
    const [combo] = planCombos([bill], ['support'], ['en']);
    const request = buildBatchRequest(combo);
    expect(request.custom_id).toBe(customId(combo));
    expect(request.params.messages).toHaveLength(1);
    expect(request.params.messages[0].role).toBe('user');
    expect(request.params.messages[0].content).toBe(
      buildScriptPrompt({ bill: combo.bill, stance: combo.stance, lang: combo.lang })
    );
  });

  test('carries the same model/max_tokens the live route uses', () => {
    const [combo] = planCombos([makeBill()], ['oppose'], ['es']);
    const request = buildBatchRequest(combo);
    expect(request.params.model).toBe('claude-sonnet-5');
    expect(request.params.max_tokens).toBe(520);
    expect(request.params.thinking).toEqual({ type: 'disabled' });
  });
});

test.describe('estimateCost', () => {
  test('60 generations (10 bills x 3 stances x 2 locales) matches strategy §9.1(d)\'s own figures', () => {
    const estimate = estimateCost(60);
    // Non-batch ("sync fallback"): $0.17-$0.25/night intro/standard per the
    // doc's table -> ~$5.04-$7.56/month, i.e. the doc's "~$5-7.50/month".
    expect(estimate.perNightSyncFallback).toEqual({ intro: 0.168, standard: 0.252 });
    expect(estimate.perMonthSyncFallback).toEqual({ intro: 5.04, standard: 7.56 });
    // Batch halves it.
    expect(estimate.perNightBatch).toEqual({ intro: 0.084, standard: 0.126 });
    expect(estimate.perMonthBatch).toEqual({ intro: 2.52, standard: 3.78 });
  });

  test('zero generations costs zero', () => {
    const estimate = estimateCost(0);
    expect(estimate.perNightBatch).toEqual({ intro: 0, standard: 0 });
    expect(estimate.perMonthBatch).toEqual({ intro: 0, standard: 0 });
  });
});

test.describe('extractScriptFromResult', () => {
  const row = (result: BatchResultRow['result']): BatchResultRow => ({ custom_id: 'x--support--en--v', result });

  test('a succeeded result with text content extracts the trimmed script', () => {
    const result = extractScriptFromResult(
      row({ type: 'succeeded', message: { content: [{ type: 'text', text: '  Hello, this is a script.  ' }] } })
    );
    expect(result).toEqual({ ok: true, script: 'Hello, this is a script.', reason: null });
  });

  test('a succeeded result with no text block is a failure, not a crash', () => {
    const result = extractScriptFromResult(row({ type: 'succeeded', message: { content: [] } }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty');
  });

  test('errored / canceled / expired all fail with their type as the reason', () => {
    expect(extractScriptFromResult(row({ type: 'errored' })).reason).toBe('errored');
    expect(extractScriptFromResult(row({ type: 'canceled' })).reason).toBe('canceled');
    expect(extractScriptFromResult(row({ type: 'expired' })).reason).toBe('expired');
  });
});

// LOCALES is imported (not re-declared) by scripts/pregen-scripts.mjs's
// orchestration layer — pinned here so a future edit can't silently drop es.
test('LOCALES is exactly [en, es]', () => {
  expect(LOCALES).toEqual(['en', 'es']);
});
