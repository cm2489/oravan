import { expect, test } from '@playwright/test';
import syncState from '../data/sync-state.json';

/*
 * Pins the persisted cursor format. Congress.gov 400s a fromDateTime that is
 * either a bare date (outage #1, 2026-06-25/07-01, PR #16) or carries
 * fractional seconds (outage #2, 2026-07-17/07-22 - the first clean run
 * persisted raw Date.toISOString() runStart). verify-sync.mjs enforces the
 * same shape nightly; this spec catches a poisoned cursor at CI time
 * whenever a data commit rides along in a PR.
 */
test('lastSync is a seconds-precision ISO-8601 UTC datetime - never bare-date, never fractional', () => {
  expect(syncState.lastSync).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(Number.isNaN(Date.parse(syncState.lastSync))).toBe(false);
});

test('lastRun is a parseable datetime (display-only; milliseconds allowed)', () => {
  expect(Number.isNaN(Date.parse(syncState.lastRun))).toBe(false);
});
