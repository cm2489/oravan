import { expect, test } from '@playwright/test';
/*
 * verify-sync's pre-commit check reads the `summary_refusals` counter
 * (added 2026-11-12) the way check-moment-updates reads it in CI after the
 * commit. Before this, a malformed counter passed verify-sync, committed,
 * deployed, and only then reddened main. Each case below is run through BOTH
 * gates, so the two cannot drift apart without this spec failing.
 *
 * Pure: no network, no model calls, no committed data/ file read.
 */
import { checkMomentUpdates, SUMMARY_REFUSAL_REASON_MAX } from '../lib/moment-updates-gate.mjs';
import { summaryRefusalsProblem, verifyMomentUpdates } from '../lib/verify-moment-updates.mjs';

const NOW = Date.parse('2026-11-12T20:00:00Z');
const VEHICLES = ['sjres-185-119'];
const MOMENTS = { 'iran-war-powers': { status: 'live', vehicles: VEHICLES.map((slug) => ({ slug })) } };
const file = (refusals: unknown) => ({
  _meta: { schema: 1, generated_at: '2026-11-12T20:00:00Z' },
  'iran-war-powers': { updates: [], summary_revisions: [], summary_refusals: refusals },
});
const ciGate = (refusals: unknown) =>
  checkMomentUpdates(file(refusals), MOMENTS, new Set(VEHICLES), { now: NOW }).violations;
const preCommit = (refusals: unknown) => verifyMomentUpdates({ updates: file(refusals), moments: MOMENTS, now: NOW }).failures;

const GOOD = [
  { count: 1, day: '2026-11-12', reason: 'r' },
  { count: 3, day: '2026-11-01', reason: 'en: absence claim' },
  { count: 2, day: '2026-11-12', reason: 'x'.repeat(SUMMARY_REFUSAL_REASON_MAX) },
];
const BAD = [
  { count: 0, day: '2026-11-12', reason: 'r' },
  { count: 1.5, day: '2026-11-12', reason: 'r' },
  { count: '3', day: '2026-11-12', reason: 'r' },
  { count: 1, day: 'today', reason: 'r' },
  { count: 1, day: '2026-11-12', reason: '' },
  { count: 1, day: '2026-11-12', reason: '   ' },
  { count: 1, day: '2026-11-12', reason: 'x'.repeat(SUMMARY_REFUSAL_REASON_MAX + 1) },
  { count: 1, day: '2026-11-20', reason: 'r' },
  null,
  [],
  'three',
];

test('a well-formed counter passes both gates', () => {
  for (const ok of GOOD) {
    expect(ciGate(ok)).toEqual([]);
    expect(preCommit(ok)).toEqual([]);
    expect(summaryRefusalsProblem(ok, '2026-11-12')).toBeNull();
  }
});

test('every counter the CI gate rejects also fails the night before the commit', () => {
  for (const bad of BAD) {
    expect(ciGate(bad)).toHaveLength(1);
    const failures = preCommit(bad);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('iran-war-powers.summary_refusals');
  }
});

test('a future day is named as such', () => {
  const [failure] = preCommit({ count: 1, day: '2026-11-20', reason: 'r' });
  expect(failure).toContain('is in the future');
});

test('a moment with no counter is untouched', () => {
  const { failures } = verifyMomentUpdates({
    updates: { _meta: { schema: 1 }, 'iran-war-powers': { updates: [], summary_revisions: [] } },
    moments: MOMENTS,
    now: NOW,
  });
  expect(failures).toEqual([]);
});
