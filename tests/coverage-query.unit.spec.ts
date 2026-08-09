import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// Same pattern as urgency.unit.spec.ts: pin the pure .mjs module the pipeline
// ships. Each shape below encodes a live-verified TheNewsAPI behavior — see
// the header comment in scripts/coverage-query.mjs before "fixing" a pin.
import { pressCitation, queryFor, readRateLimitRemaining } from '../scripts/coverage-query.mjs';

const bill = (over: Record<string, unknown>) => ({
  bill_type: 'hr', bill_number: 8463, congress_number: 119,
  press_names: null, news_query: null, ...over,
});

test.describe('pressCitation (journalists write periods)', () => {
  test('House bill', () => {
    expect(pressCitation(bill({}))).toBe('H.R. 8463');
  });
  test('Senate bill', () => {
    expect(pressCitation(bill({ bill_type: 's', bill_number: 180 }))).toBe('S. 180');
  });
  test('joint resolutions', () => {
    expect(pressCitation(bill({ bill_type: 'sjres', bill_number: 188 }))).toBe('S.J. Res. 188');
    expect(pressCitation(bill({ bill_type: 'hjres', bill_number: 1 }))).toBe('H.J. Res. 1');
  });
});

test.describe('queryFor', () => {
  test('named House bill: press names OR standalone press citation', () => {
    const q = queryFor(bill({ press_names: ['SAVE Act', 'Safeguard American Voter Eligibility Act'] }));
    expect(q).toBe('"SAVE Act" | "Safeguard American Voter Eligibility Act" | "H.R. 8463"');
  });

  test('Senate citation NEVER stands alone (junk magnet) — always ANDed with context', () => {
    const q = queryFor(bill({ bill_type: 's', bill_number: 180, press_names: ['Secondary Exposure Act'] }));
    expect(q).toBe('"Secondary Exposure Act" | ("S. 180" + (senate | congress))');
  });

  test('unnamed CRA resolution: subject query, not a dead citation phrase', () => {
    const q = queryFor(bill({ bill_type: 'sjres', bill_number: 188, news_query: 'EPA "power plant" rule' }));
    expect(q).toBe('(EPA "power plant" rule) | ("S.J. Res. 188" + (senate | congress))');
  });

  test('unbackfilled fallback: press-style citation, never the clerk form', () => {
    expect(queryFor(bill({}))).toBe('"H.R. 8463"');
    expect(queryFor(bill({}))).not.toContain('HR 8463');
  });

  test('press names win over news_query when both exist', () => {
    const q = queryFor(bill({ press_names: ['GEO Act'], news_query: 'geothermal leasing permits' }));
    expect(q).toBe('"GEO Act" | "H.R. 8463"');
  });

  test('oversized or empty names are dropped', () => {
    const q = queryFor(bill({ press_names: ['x'.repeat(61), '  ', 'Real Name Act'] }));
    expect(q).toBe('"Real Name Act" | "H.R. 8463"');
  });
});

test.describe('citation-shaped press names are rejected (generator defense)', () => {
  test('clerk citations cannot masquerade as names', () => {
    const q = queryFor(bill({ press_names: ['HR 7086', 'S. 45', 'SJRES 9', 'Equitable Access to School Facilities Act'] }));
    expect(q).toBe('"Equitable Access to School Facilities Act" | "H.R. 8463"');
  });
});

test.describe('apostrophe variants (phrase match is apostrophe-exact)', () => {
  test('a name with an apostrophe searches both curly and straight', () => {
    const q = queryFor(bill({ press_names: ["Kayleigh's Law Act"] }));
    expect(q).toBe('"Kayleigh’s Law Act" | "Kayleigh\'s Law Act" | "H.R. 8463"');
  });
  test('curly input produces the same pair', () => {
    const q = queryFor(bill({ press_names: ['Kayleigh’s Law Act'] }));
    expect(q).toContain('"Kayleigh’s Law Act"');
    expect(q).toContain('"Kayleigh\'s Law Act"');
  });
});

test.describe('unbackfilled fallback keeps the title arm (2026-07-03 regression)', () => {
  test('a usable title is searched when no generated inputs exist', () => {
    const q = queryFor(bill({ bill_type: 's', bill_number: 3674, title: 'SCAM Act' }));
    expect(q).toBe('"SCAM Act" | ("S. 3674" + (senate | congress))');
  });
  test('formal long titles still fall through to citation only', () => {
    expect(queryFor(bill({ title: 'To establish governmentwide requirements for pre-payment fraud prevention' }))).toBe('"H.R. 8463"');
    expect(queryFor(bill({ bill_type: 'sjres', bill_number: 188, title: 'A joint resolution providing for congressional disapproval…' }))).toBe('("S.J. Res. 188" + (senate | congress))');
  });
  test('title fallback gets apostrophe variants too', () => {
    const q = queryFor(bill({ title: "Kayleigh's Law Act of 2026" }));
    expect(q).toContain('"Kayleigh’s Law Act of 2026"');
    expect(q).toContain('"Kayleigh\'s Law Act of 2026"');
  });
  test('generated inputs still take precedence over the title', () => {
    expect(queryFor(bill({ press_names: ['GEO Act'], title: 'Geothermal Energy Orderly Decisions Act of 2025' }))).toBe('"GEO Act" | "H.R. 8463"');
  });
});

/*
 * THE THROTTLE LATCH (2026-08-09).
 *
 * scripts/sync-coverage.mjs read its rate-limit budget as
 * `Number(res.headers.get('x-ratelimit-remaining'))`. A MISSING header makes
 * that `Number(null)` === 0, which passes `Number.isFinite`, so an absent
 * header latched the throttle to "this window's budget is spent" — and every
 * later batch in the run slept a full 60 seconds before firing, permanently,
 * because only a response can reset the counter and no response arrives until
 * after the sleep. A CDN-cached 200, a provider revision that renames the
 * header, or a proxy that strips it is enough: the nightly coverage run never
 * fails, it just crawls, and then runs out of night.
 */
test.describe('readRateLimitRemaining (absent is not zero)', () => {
  const headers = (v: string | null) => ({ get: () => v });

  test('an ABSENT header returns null so the caller leaves its budget alone - the latch', () => {
    expect(readRateLimitRemaining(headers(null))).toBe(null);
  });

  test("a present '0' still latches - a real zero budget must still be honored", () => {
    expect(readRateLimitRemaining(headers('0'))).toBe(0);
  });

  test("a present '42' records 42", () => {
    expect(readRateLimitRemaining(headers('42'))).toBe(42);
  });

  test('a blank or non-numeric value reads as absent, not as zero (Number("") is 0 too)', () => {
    expect(readRateLimitRemaining(headers(''))).toBe(null);
    expect(readRateLimitRemaining(headers('   '))).toBe(null);
    expect(readRateLimitRemaining(headers('unlimited'))).toBe(null);
    expect(readRateLimitRemaining(headers('NaN'))).toBe(null);
  });

  test('surrounding whitespace on a real number is tolerated', () => {
    expect(readRateLimitRemaining(headers(' 7 '))).toBe(7);
  });

  test('a response with no headers object at all degrades to null rather than throwing', () => {
    expect(readRateLimitRemaining(undefined)).toBe(null);
    expect(readRateLimitRemaining({} as { get: (n: string) => string | null })).toBe(null);
  });

  test('reads the header by its canonical lowercase name off a real Headers object', () => {
    const h = new Headers({ 'X-RateLimit-Remaining': '13' });
    expect(readRateLimitRemaining(h)).toBe(13);
    expect(readRateLimitRemaining(new Headers())).toBe(null);
  });
});

test.describe('sync-coverage.mjs honors the header only when it said something', () => {
  const src = readFileSync(join(process.cwd(), 'scripts/sync-coverage.mjs'), 'utf8');

  test('the raw Number(header) read is gone - that expression IS the bug', () => {
    expect(src).not.toMatch(/Number\(res\.headers\.get\(/);
  });

  test('the budget is only overwritten on a non-null reading', () => {
    expect(src).toMatch(/const rem = readRateLimitRemaining\(res\.headers\)/);
    expect(src).toMatch(/if \(rem !== null\) rlRemaining = rem/);
  });
});
