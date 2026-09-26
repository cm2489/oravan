import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// Same pattern as urgency.unit.spec.ts: pin the pure .mjs module the pipeline
// ships. Each shape below encodes a live-verified TheNewsAPI behavior — see
// the header comment in scripts/coverage-query.mjs before "fixing" a pin.
import {
  CONGRESS_START,
  DATE_SORT,
  ENACTED_GRACE_DAYS,
  PRIORITY_REQUESTS_PER_BILL,
  RECENT_WINDOW_DAYS,
  RELEVANCE_SORT,
  apiErrorDetail,
  coveragePriority,
  isCoverageEligible,
  isNewestFirst,
  mergeArticles,
  parseKeptIndexes,
  planCoverageRun,
  pressCitation,
  queryFor,
  readRateLimitRemaining,
  recentWindowStart,
  relevancePrompt,
  wholeLifeStart,
} from '../scripts/coverage-query.mjs';

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

/* ------------------------------------------------------------------ *
 * THE RECENCY PASS (2026-09-26) — the pure half. The runner itself is driven
 * end to end, with every network call mocked, in
 * tests/sync-coverage-runner.unit.spec.ts.
 * ------------------------------------------------------------------ */
const NOW = Date.parse('2026-09-25T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10);
const fullBill = (over: Record<string, unknown>) => ({
  bill_type: 'hr', bill_number: 1, congress_number: 119, ai_headline: 'h', status: 'committee',
  introduced_date: '2025-06-01', last_action_date: daysAgo(3), ...over,
});

test.describe('the date sort is ONE constant, defaulting to the documented value', () => {
  test('DATE_SORT is published_at (the docs name it as the default twice)', () => {
    expect(DATE_SORT).toBe('published_at');
    expect(RELEVANCE_SORT).toBe('relevance_score');
  });

  test('sync-coverage.mjs never spells a sort value itself', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/sync-coverage.mjs'), 'utf8');
    expect(src).not.toMatch(/'published_(at|on)'/);
    expect(src).not.toMatch(/'relevance_score'/);
  });
});

test.describe('isCoverageEligible — a newly enacted bill gets a 14-day grace', () => {
  test('moving bills are eligible; undecoded ones never are', () => {
    expect(isCoverageEligible(fullBill({}), NOW)).toBe(true);
    expect(isCoverageEligible(fullBill({ ai_headline: null }), NOW)).toBe(false);
  });

  test('signed within 14 days: still checked (the peak-coverage week)', () => {
    expect(isCoverageEligible(fullBill({ status: 'signed', last_action_date: daysAgo(0) }), NOW)).toBe(true);
    expect(isCoverageEligible(fullBill({ status: 'signed', last_action_date: daysAgo(ENACTED_GRACE_DAYS) }), NOW)).toBe(true);
  });

  test('signed longer ago, vetoed, or undated: out, as before', () => {
    expect(isCoverageEligible(fullBill({ status: 'signed', last_action_date: daysAgo(ENACTED_GRACE_DAYS + 1) }), NOW)).toBe(false);
    // H.R. 6500 became PL 119-103 on 2026-09-02: 23 days before this clock.
    expect(isCoverageEligible(fullBill({ status: 'signed', last_action_date: '2026-09-02' }), NOW)).toBe(false);
    expect(isCoverageEligible(fullBill({ status: 'vetoed', last_action_date: daysAgo(1) }), NOW)).toBe(false);
    expect(isCoverageEligible(fullBill({ status: 'signed', last_action_date: null }), NOW)).toBe(false);
    expect(isCoverageEligible(fullBill({ status: 'signed', last_action_date: daysAgo(-2) }), NOW)).toBe(false);
  });
});

test.describe('the two date floors', () => {
  test('whole-life pass starts at introduction, or the Congress start when unknown', () => {
    expect(wholeLifeStart(fullBill({}))).toBe('2025-06-01');
    expect(wholeLifeStart(fullBill({ introduced_date: null }))).toBe(CONGRESS_START);
  });

  test('30-day pass starts 30 days ago — never before the bill existed', () => {
    expect(RECENT_WINDOW_DAYS).toBe(30);
    expect(recentWindowStart(fullBill({}), NOW)).toBe('2026-08-26');
    expect(recentWindowStart(fullBill({ introduced_date: daysAgo(5) }), NOW)).toBe(daysAgo(5));
  });
});

test.describe('coveragePriority — vehicles, the news pool, live tier-0 signals', () => {
  const moments = {
    'iran-war-powers': { status: 'live', vehicles: [{ slug: 'hconres-89-119' }, { slug: 'sjres-185-119' }] },
    retired: { status: 'retired', vehicles: [{ slug: 'hr-5-119' }] },
    nomination: { status: 'live', vehicles: [{ slug: 'pn-12-119', kind: 'nomination' }] },
  };
  const outlet = (domain: string, lean: string) => ({ domain, lean, firstSeen: daysAgo(2), lastSeen: daysAgo(1) });
  const conversation = {
    slugs: {
      's-4668-119': { outlets7d: [outlet('nytimes.com', 'left'), outlet('foxnews.com', 'right')], unratedOutlets7d: [], mostViewed: null },
      'hr-1-119': { outlets7d: [], unratedOutlets7d: [], mostViewed: { weeksOnList: 7, lastRank: 7, lastSeen: daysAgo(1), lastWeek: daysAgo(5) } },
      'hr-7-119': { outlets7d: [outlet('cnn.com', 'left')], unratedOutlets7d: [], mostViewed: null }, // c0: one outlet
      'sjres-185-119': { outlets7d: [outlet('reuters.com', 'center'), outlet('politico.com', 'left')], unratedOutlets7d: [], mostViewed: null },
    },
  };
  const floorSignals = {
    _meta: { fetched_at: new Date(NOW - 3_600_000).toISOString() },
    signals: {
      's-4668-119': { tier0: { source: 'daily-digest', covers: daysAgo(0) } },
      'hr-9-119': { tier0: { source: 'daily-digest', covers: daysAgo(10) } }, // horizon passed: not live
    },
  };

  test('order is vehicles, then the pool, then tier-0 — each slug once', () => {
    const p = coveragePriority({ moments, conversation, floorSignals, now: NOW });
    expect(p.vehicles).toEqual(['hconres-89-119', 'sjres-185-119']);
    expect(p.band).toEqual(['s-4668-119', 'sjres-185-119', 'hr-1-119']);
    expect(p.tier0).toEqual(['s-4668-119']);
    expect(p.slugs).toEqual(['hconres-89-119', 'sjres-185-119', 's-4668-119', 'hr-1-119']);
  });

  test('retired questions, nominations, one-outlet slugs and dead floor signals stay out', () => {
    const p = coveragePriority({ moments, conversation, floorSignals, now: NOW });
    for (const s of ['hr-5-119', 'pn-12-119', 'hr-7-119', 'hr-9-119']) expect(p.slugs).not.toContain(s);
  });

  test('missing or malformed inputs shrink the set; they never throw', () => {
    expect(coveragePriority({}).slugs).toEqual([]);
    expect(coveragePriority({ moments: 'nope', conversation: 42, floorSignals: { signals: 'x' } }).slugs).toEqual([]);
  });
});

test.describe('planCoverageRun — the budget never grows', () => {
  const ranked = Array.from({ length: 40 }, (_, i) => ({
    b: fullBill({ bill_number: i + 1 }),
    eff: 1 - i / 100,
  }));
  const slug = (n: number) => `hr-${n}-119`;

  test('with no priority set it is exactly the old head/tail split', () => {
    const plan = planCoverageRun({ ranked, prioritySlugs: [], topN: 10, tailShare: 0.5 });
    expect(plan.priority).toEqual([]);
    expect(plan.head.map((b: { bill_number: number }) => b.bill_number)).toEqual([1, 2, 3, 4, 5]);
    expect(plan.tail).toHaveLength(5);
    expect(plan.requests).toBe(10);
  });

  test('each priority bill costs two requests and the rotation shrinks to pay for it', () => {
    const plan = planCoverageRun({ ranked, prioritySlugs: [slug(30), slug(35)], topN: 10, tailShare: 0.5 });
    expect(plan.priority.map((b: { bill_number: number }) => b.bill_number)).toEqual([30, 35]);
    expect(plan.head.length + plan.tail.length + plan.overflow.length).toBe(6);
    expect(plan.requests).toBe(10);
    expect(PRIORITY_REQUESTS_PER_BILL).toBe(2);
  });

  test('a priority bill is never also in the head or the tail', () => {
    const plan = planCoverageRun({ ranked, prioritySlugs: [slug(1), slug(2)], topN: 12, tailShare: 0.5 });
    const all = [...plan.priority, ...plan.head, ...plan.tail, ...plan.overflow].map(
      (b: { bill_number: number }) => b.bill_number,
    );
    expect(new Set(all).size).toBe(all.length);
    expect(plan.head.map((b: { bill_number: number }) => b.bill_number)).toEqual([3, 4, 5, 6]);
  });

  test('the tail is still least-recently-checked first, never-checked ahead of all', () => {
    const checkedAt: Record<string, string> = {};
    for (let i = 1; i <= 40; i++) checkedAt[slug(i)] = daysAgo(1);
    checkedAt[slug(33)] = daysAgo(20);
    delete checkedAt[slug(38)];
    const plan = planCoverageRun({ ranked, prioritySlugs: [], topN: 6, tailShare: 0.5, checkedAt });
    expect(plan.tail.slice(0, 2).map((b: { bill_number: number }) => b.bill_number)).toEqual([38, 33]);
  });

  test('ineligible priority slugs are reported, not spent on', () => {
    const plan = planCoverageRun({ ranked, prioritySlugs: ['hr-6500-119', slug(3)], topN: 10, tailShare: 0.5 });
    expect(plan.skipped).toEqual(['hr-6500-119']);
    expect(plan.priority).toHaveLength(1);
    expect(plan.requests).toBe(10);
  });

  test('a priority set larger than half the budget is capped — requests still ≤ topN', () => {
    const plan = planCoverageRun({ ranked, prioritySlugs: ranked.map((e) => slug(e.b.bill_number as number)), topN: 7, tailShare: 0.5 });
    expect(plan.priority).toHaveLength(3);
    expect(plan.requests).toBeLessThanOrEqual(7);
  });

  test('600 against the 2026-09-25 corpus shape: 25 priority bills leave 550 rotating, 600 requests', () => {
    const big = Array.from({ length: 3000 }, (_, i) => ({ b: fullBill({ bill_number: i + 1 }), eff: 0.5 }));
    const prio = Array.from({ length: 25 }, (_, i) => slug(1000 + i));
    const plan = planCoverageRun({ ranked: big, prioritySlugs: prio, topN: 600, tailShare: 0.5 });
    expect(plan.priority).toHaveLength(25);
    expect(plan.head).toHaveLength(275);
    expect(plan.tail).toHaveLength(275);
    expect(plan.requests).toBe(600);
  });
});

test.describe('mergeArticles — merge by URL, newest first, never erase', () => {
  const art = (url: string, publishedAt: string | null, title = url) => ({ url, title, source: 'x.com', snippet: null, publishedAt });

  test('an empty night keeps what was stored (the old code replaced it with nothing)', () => {
    const stored = [art('https://a/1', '2026-06-01'), art('https://a/2', '2026-05-01')];
    expect(mergeArticles([], stored, 5)).toEqual(stored);
  });

  test('new articles merge in newest first and the cap drops the OLDEST', () => {
    const stored = [art('https://a/old1', '2026-05-01'), art('https://a/old2', '2026-04-01')];
    const fresh = [art('https://a/new', '2026-09-24')];
    expect(mergeArticles(fresh, stored, 2).map((a) => a.url)).toEqual(['https://a/new', 'https://a/old1']);
  });

  test('the same URL is one article — tonight’s copy wins', () => {
    const stored = [{ ...art('https://a/1', '2026-09-01'), snippet: 'old' }];
    const fresh = [{ ...art('https://a/1', '2026-09-01'), snippet: 'new' }];
    const merged = mergeArticles(fresh, stored, 5);
    expect(merged).toHaveLength(1);
    expect(merged[0].snippet).toBe('new');
  });

  test('a syndicated copy (same title, different URL) is still one article', () => {
    const merged = mergeArticles([art('https://b/1', '2026-09-02', 'Senate votes')], [art('https://a/1', '2026-09-02', 'Senate  VOTES')], 5);
    expect(merged).toHaveLength(1);
  });

  test('undated articles sort after every dated one, and inputs are not mutated', () => {
    const fresh = [art('https://a/undated', null), art('https://a/dated', '2026-01-01')];
    const copy = JSON.parse(JSON.stringify(fresh));
    expect(mergeArticles(fresh, [], 5).map((a) => a.url)).toEqual(['https://a/dated', 'https://a/undated']);
    expect(fresh).toEqual(copy);
  });
});

test.describe('the gate sees dates; the sort is checked, not assumed', () => {
  test('relevancePrompt dates every article and the bill', () => {
    const p = relevancePrompt(
      fullBill({ bill_type: 'hconres', bill_number: 89, last_action_date: '2026-07-23', last_action_text: 'Received in the Senate.' }),
      [
        { title: 'Senate votes on war powers', snippet: 'It failed.', source: 'cbsnews.com', publishedAt: '2026-09-24' },
        { title: 'Old story', snippet: null, source: 'x.com', publishedAt: null },
      ],
    );
    expect(p).toContain('HCONRES 89');
    expect(p).toContain('Introduced: 2025-06-01. Latest action (2026-07-23): Received in the Senate.');
    expect(p).toContain('0. [2026-09-24] Senate votes on war powers — It failed. (cbsnews.com)');
    expect(p).toContain('1. [undated] Old story (x.com)');
    expect(p).toContain('Reply with a comma-separated list of numbers, or "none".');
  });

  test('parseKeptIndexes keeps in-range numbers only', () => {
    expect([...parseKeptIndexes('0, 2, 7, 99', 8)].sort((a, b) => a - b)).toEqual([0, 2, 7]);
    expect(parseKeptIndexes('none', 5).size).toBe(0);
  });

  test('isNewestFirst tells a date-sorted response from one that ignored the sort', () => {
    expect(isNewestFirst([{ publishedAt: '2026-09-24' }, { publishedAt: '2026-09-20' }, { publishedAt: null }])).toBe(true);
    expect(isNewestFirst([{ publishedAt: '2026-06-01' }, { publishedAt: '2026-09-20' }])).toBe(false);
    expect(isNewestFirst([{ publishedAt: '2026-09-24' }])).toBeNull();
  });

  test('apiErrorDetail reports the API’s own words and nothing else', () => {
    expect(apiErrorDetail({ error: { code: 'malformed_parameters', message: 'Invalid sort.' } })).toBe('malformed_parameters: Invalid sort.');
    expect(apiErrorDetail({})).toBe('no error detail in the body');
    expect(apiErrorDetail(null)).toBe('no error detail in the body');
  });
});
