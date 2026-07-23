import { expect, test } from '@playwright/test';
import { congressGovUrl } from '../scripts/congress-fetch.mjs';

/*
 * Pins the Congress.gov URL path per bill type. The old inline ternary only
 * knew four types, so decoded hconres/sconres bills got senate-joint-
 * resolution URLs (2026-07-23). refreshBillFields recomputes this on every
 * refresh, so any bill stored with a wrong URL self-heals on its next touch.
 */
test('every tracked type maps to its Congress.gov path segment', () => {
  expect(congressGovUrl('hr', 8800)).toBe('https://www.congress.gov/bill/119th-congress/house-bill/8800');
  expect(congressGovUrl('s', 3752)).toBe('https://www.congress.gov/bill/119th-congress/senate-bill/3752');
  expect(congressGovUrl('hjres', 45)).toBe('https://www.congress.gov/bill/119th-congress/house-joint-resolution/45');
  expect(congressGovUrl('sjres', 99)).toBe('https://www.congress.gov/bill/119th-congress/senate-joint-resolution/99');
  expect(congressGovUrl('hconres', 38)).toBe('https://www.congress.gov/bill/119th-congress/house-concurrent-resolution/38');
  expect(congressGovUrl('sconres', 12)).toBe('https://www.congress.gov/bill/119th-congress/senate-concurrent-resolution/12');
});
