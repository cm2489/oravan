import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): plain lib modules resolve under the test
// runner - same pattern as the other unit specs.
import { contentVersion, createScriptCache, scriptKey } from '../lib/scriptcache';
import type { Bill } from '../lib/types';
import { getUpstashErrorCounts } from '../lib/upstash';
import { CACHE_URL, MockUpstash, installUpstashFetch, setUpstashEnv } from './upstash-mock';

/*
 * Pins the S11 script-cache contract: content-versioned keys in the cache
 * database (a corrected decode invalidates stale scripts - strategy
 * §9.1(d)'s named gap), 24h TTL, cross-instance sharing, and graceful
 * degradation to the per-instance Map.
 *
 * Plus (2026-08-08) the status half of that key. The version hash covered the
 * summary only, and ai_summary is never rewritten for an already-decoded bill,
 * so a bill that passed its chamber kept its key: every visitor for the rest of
 * the 24h TTL got the pre-vote script, urging a vote that had already happened,
 * beside a redeployed page reading "Passed the House". Suite 2 below is that
 * scenario, run against the real cache.
 */

/** Minimal bill, the shape contentVersion reads. */
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

test.describe.configure({ mode: 'serial' }); // shared env + global-fetch swaps

let restoreFetch: (() => void) | null = null;
let restoreEnv: (() => void) | null = null;

test.afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  restoreEnv?.();
  restoreEnv = null;
});

const PARTS = { slug: 'hr-1234-119', stance: 'support', lang: 'en' as const };

test('contentVersion: deterministic, short, and summary-sensitive', () => {
  const v1 = contentVersion(makeBill());
  expect(v1).toMatch(/^[0-9a-f]{12}$/);
  expect(contentVersion(makeBill()), 'identical inputs -> identical key').toBe(v1);
  expect(
    contentVersion(makeBill({ ai_summary: 'This bill funds bridges!' })),
    'any edit is a new version'
  ).not.toBe(v1);
});

test('contentVersion: status is key material — the bug this suite exists for', () => {
  // buildScriptPrompt writes `Current status: ${bill.status}` into the prompt,
  // so two bills that differ only in status are two different scripts. Before
  // 2026-08-08 they shared one key.
  const before = makeBill({ status: 'floor_vote' });
  const after = makeBill({ status: 'passed_chamber' });
  expect(contentVersion(before)).not.toBe(contentVersion(after));
});

test('contentVersion: last_action_date is key material', () => {
  const before = makeBill({ last_action_date: '2026-06-30' });
  const after = makeBill({ last_action_date: '2026-07-01' });
  expect(contentVersion(before)).not.toBe(contentVersion(after));
  // …including "no recorded action" vs "recorded, empty", which a `?? ''` fold
  // would have keyed identically. Caught by this assertion on the first run.
  expect(contentVersion(makeBill({ last_action_date: null }))).not.toBe(
    contentVersion(makeBill({ last_action_date: '' }))
  );
});

test('contentVersion: falls back to the title when a bill has no decode, in ONE place', () => {
  // The `?? title` fallback lives inside contentVersion rather than at each
  // call site, so the route and the nightly warmer cannot disagree about it.
  const undecoded = makeBill({ ai_summary: null, title: 'An act to do a thing.' });
  const decodedToTheSameText = makeBill({ ai_summary: 'An act to do a thing.' });
  expect(contentVersion(undecoded)).toBe(contentVersion(decodedToTheSameText));
  expect(contentVersion(makeBill({ ai_summary: null, title: 'A different act.' }))).not.toBe(
    contentVersion(undecoded)
  );
});

test('contentVersion: field boundaries are unambiguous — no separator injection', () => {
  // A bare-concatenation hash collides whenever characters move across a field
  // boundary: 'ab' + 'c' and 'a' + 'bc' produce identical material.
  const abThenC = makeBill({ ai_summary: 'ab', status: 'c' as Bill['status'] });
  const aThenBc = makeBill({ ai_summary: 'a', status: 'bc' as Bill['status'] });
  expect(contentVersion(abThenC)).not.toBe(contentVersion(aThenBc));

  // A plain-separator join only moves the problem: a summary containing the
  // separator re-splits into the field after it. `ab|c` + `d` and `ab` + `c|d`
  // are the same string once joined on '|'. Length prefixes close both.
  const splitInSummary = makeBill({ ai_summary: 'ab|c', status: 'd' as Bill['status'] });
  const splitInStatus = makeBill({ ai_summary: 'ab', status: 'c|d' as Bill['status'] });
  expect(contentVersion(splitInSummary)).not.toBe(contentVersion(splitInStatus));

  // The reachable form of the same hazard, with no cast: a decoded summary is
  // free text and can contain anything, including the tail of its own key.
  const honest = makeBill({ ai_summary: 'Funds bridges.', last_action_date: '2026-06-30' });
  const forged = makeBill({
    ai_summary: 'Funds bridges.|committee|2026-06-30',
    last_action_date: '2026-06-30',
  });
  expect(contentVersion(honest)).not.toBe(contentVersion(forged));
});

test('a status move invalidates the stale script: chamber passes -> clean miss, not a 24h lie', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [CACHE_URL]: mock });

  const cache = createScriptCache();
  // Same bill, same decode, same day — only the chamber vote happened.
  const preVote = makeBill({ status: 'floor_vote', last_action_date: '2026-06-30' });
  const postVote = makeBill({ status: 'passed_chamber', last_action_date: '2026-07-01' });

  await cache.set(
    { ...PARTS, version: contentVersion(preVote) },
    'Please vote YES on H.R. 1234 when it reaches the floor.'
  );

  // The whole point: once hot-bills lands the status move, the next visitor
  // must NOT be handed the script urging a vote that already happened.
  expect(await cache.get({ ...PARTS, version: contentVersion(postVote) })).toBeNull();
});

test('a corrected decode invalidates the stale script: changed summary hash -> clean miss', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [CACHE_URL]: mock });

  const cache = createScriptCache();
  const staleVersion = contentVersion(makeBill({ ai_summary: 'Original (wrong) summary' }));
  const fixedVersion = contentVersion(makeBill({ ai_summary: 'Corrected summary after re-decode' }));

  await cache.set({ ...PARTS, version: staleVersion }, 'SCRIPT BUILT ON THE WRONG SUMMARY');
  // The pre-S11 key (slug:stance:lang, no version) would have HIT here and
  // kept serving the stale script against the corrected summary.
  expect(await cache.get({ ...PARTS, version: fixedVersion })).toBeNull();
  expect(await cache.get({ ...PARTS, version: staleVersion })).toBe(
    'SCRIPT BUILT ON THE WRONG SUMMARY'
  );
});

test('cross-instance sharing with 24h TTL: instance B hits what instance A cached', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [CACHE_URL]: mock });

  const version = contentVersion(makeBill({ ai_summary: 'shared summary' }));
  await createScriptCache().set({ ...PARTS, version }, 'ONE GENERATION TOTAL');
  expect(await createScriptCache().get({ ...PARTS, version })).toBe('ONE GENERATION TOTAL');

  // Key shape is the registry's, and the write carried the 24h TTL.
  const key = scriptKey({ ...PARTS, version });
  expect(key).toBe(`dev:script:hr-1234-119:support:en:${version}`);
  const set = mock.commands.find((c) => c[0] === 'SET' && c[1] === key)!;
  expect(set.slice(3)).toEqual(['EX', '86400']);
});

test('graceful degradation: no env -> per-instance Map, zero network calls, no crash', async () => {
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [CACHE_URL]: mock });

  const cache = createScriptCache();
  const version = contentVersion(makeBill({ ai_summary: 'local dev summary' }));
  await cache.set({ ...PARTS, version }, 'IN-MEMORY SCRIPT');
  expect(await cache.get({ ...PARTS, version })).toBe('IN-MEMORY SCRIPT');
  expect(await cache.get({ ...PARTS, version: contentVersion(makeBill({ ai_summary: 'other' })) })).toBeNull();
  expect(mock.commands, 'must not touch the REST surface without env').toHaveLength(0);
});

test('graceful degradation: request errors are a counted miss (get) / skipped write (set), never a throw', async () => {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  mock.failWithStatus = 500;
  restoreFetch = installUpstashFetch({ [CACHE_URL]: mock });

  const errorsBefore = getUpstashErrorCounts().cache;
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.join(' '));
  try {
    const cache = createScriptCache();
    const version = contentVersion(makeBill({ ai_summary: 'unreachable-upstash summary' }));
    await cache.set({ ...PARTS, version }, 'STILL SERVED'); // must not throw
    // The instance's own Map catches the fail-open read.
    expect(await cache.get({ ...PARTS, version })).toBe('STILL SERVED');
  } finally {
    console.error = realError;
  }

  expect(getUpstashErrorCounts().cache).toBeGreaterThan(errorsBefore);
  for (const line of logged) {
    expect(line).toContain('status 500'); // status code only...
    expect(line).not.toContain('mock upstream error'); // ...never the body
    expect(line).not.toContain('STILL SERVED'); // and never a script
  }
});
