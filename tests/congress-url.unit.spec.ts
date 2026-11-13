import { expect, test } from '@playwright/test';
import { congressGovUrl } from '../scripts/congress-fetch.mjs';

/*
 * Pins the Congress.gov URL path per bill type. The old inline ternary only
 * knew four types, so decoded hconres/sconres bills got senate-joint-
 * resolution URLs (2026-07-23). refreshBillFields recomputes this on every
 * refresh, so any bill stored with a wrong URL self-heals on its next touch.
 */
test('every tracked type maps to its Congress.gov path segment', () => {
  expect(congressGovUrl('hr', 8800, 119)).toBe('https://www.congress.gov/bill/119th-congress/house-bill/8800');
  expect(congressGovUrl('s', 3752, 119)).toBe('https://www.congress.gov/bill/119th-congress/senate-bill/3752');
  expect(congressGovUrl('hjres', 45, 119)).toBe('https://www.congress.gov/bill/119th-congress/house-joint-resolution/45');
  expect(congressGovUrl('sjres', 99, 119)).toBe('https://www.congress.gov/bill/119th-congress/senate-joint-resolution/99');
  expect(congressGovUrl('hconres', 38, 119)).toBe('https://www.congress.gov/bill/119th-congress/house-concurrent-resolution/38');
  expect(congressGovUrl('sconres', 12, 119)).toBe('https://www.congress.gov/bill/119th-congress/senate-concurrent-resolution/12');
});

test('the Congress is the bill\'s own, and a missing one is refused, never guessed', () => {
  // 2026-11-12: the record link names the bill's OWN Congress, so an archived
  // bill keeps linking to itself after the tracked Congress moves on.
  expect(congressGovUrl('hr', 1234, 118)).toBe('https://www.congress.gov/bill/118th-congress/house-bill/1234');
  expect(congressGovUrl('hr', 1234, 120)).toBe('https://www.congress.gov/bill/120th-congress/house-bill/1234');
  expect(() => (congressGovUrl as (t: string, n: number, c?: unknown) => string)('hr', 1234)).toThrow();
  expect(() => congressGovUrl('hr', 1234, Number('119x'))).toThrow();
});
