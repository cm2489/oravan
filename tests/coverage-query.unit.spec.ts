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
  LEAN_DRIFT,
  LEAN_DRIFT_WORD,
  PRIORITY_MAX_SHARE,
  PRIORITY_REQUESTS_PER_BILL,
  RECENT_WINDOW_DAYS,
  RELEVANCE_SORT,
  apiErrorDetail,
  articleMatcher,
  coveragePriority,
  formatLeanDrift,
  gateAnswered,
  isCoverageEligible,
  isNewestFirst,
  leanDrift,
  mergeArticles,
  parseKeptIndexes,
  planCoverageRun,
  pressCitation,
  queryFor,
  readRateLimitRemaining,
  recentWindowStart,
  relevancePrompt,
  wholeLifeStart,
  withoutRejected,
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

  test('a PRIORITY bill is checked whatever its status — H.R. 6500 is still a live vehicle', () => {
    // The plan's words: "always query vehicles, C1/C2 and tier-0 slugs". The
    // grace window alone had left H.R. 6500 (the funding question's vehicle),
    // and the band's H.R. 1 and H.R. 4405, unchecked.
    const hr6500 = fullBill({ bill_number: 6500, status: 'signed', last_action_date: '2026-09-02' });
    expect(isCoverageEligible(hr6500, NOW)).toBe(false);
    expect(isCoverageEligible(hr6500, NOW, { priority: true })).toBe(true);
    expect(isCoverageEligible(fullBill({ status: 'vetoed', last_action_date: daysAgo(90) }), NOW, { priority: true })).toBe(true);
    expect(isCoverageEligible(fullBill({ status: 'signed', last_action_date: null }), NOW, { priority: true })).toBe(true);
    // Being decoded is still required: the Read section only exists on a decoded bill.
    expect(isCoverageEligible(fullBill({ ai_headline: null, status: 'signed' }), NOW, { priority: true })).toBe(false);
    // priority: false is exactly the ordinary rule.
    expect(isCoverageEligible(hr6500, NOW, { priority: false })).toBe(false);
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
    const plan = planCoverageRun({ ranked, prioritySlugs: [slug(30), slug(35)], topN: 20, tailShare: 0.5 });
    expect(plan.priority.map((b: { bill_number: number }) => b.bill_number)).toEqual([30, 35]);
    expect(plan.head.length + plan.tail.length + plan.overflow.length).toBe(16);
    expect(plan.requests).toBe(20);
    expect(PRIORITY_REQUESTS_PER_BILL).toBe(2);
  });

  test('a priority bill is never also in the head or the tail', () => {
    const plan = planCoverageRun({ ranked, prioritySlugs: [slug(1), slug(2)], topN: 20, tailShare: 0.5 });
    const all = [...plan.priority, ...plan.head, ...plan.tail, ...plan.overflow].map(
      (b: { bill_number: number }) => b.bill_number,
    );
    expect(new Set(all).size).toBe(all.length);
    expect(plan.head.map((b: { bill_number: number }) => b.bill_number)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
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

  test('the priority set has its OWN ceiling — 20% of the night — so the tail is never starved', () => {
    // The 2026-09-26 review's probe: 30 priority slugs on a 20-request night.
    // With only the old half-the-budget ceiling that was 10 priority bills,
    // 0 head, 0 tail — the 2026-08-05 starvation the 50/50 split exists to stop.
    expect(PRIORITY_MAX_SHARE).toBe(0.2);
    const thirty = ranked.slice(0, 30).map((e) => slug(e.b.bill_number as number));
    const plan = planCoverageRun({ ranked, prioritySlugs: thirty, topN: 20, tailShare: 0.5 });
    expect(plan.maxPriority).toBe(2);
    expect(plan.priority).toHaveLength(2);
    expect(plan.head.length + plan.tail.length + plan.overflow.length).toBe(16);
    expect(plan.tail.length).toBeGreaterThan(0);
    expect(plan.requests).toBe(20);
    // The other 28 are DEFERRED, not dropped: reported, and still in line for
    // an ordinary slot (the head here is made of them).
    expect(plan.deferred).toEqual(thirty.slice(2));
    expect(plan.head.every((b: { bill_number: number }) => thirty.includes(slug(b.bill_number)))).toBe(true);
    expect(plan.skipped).toEqual([]);
  });

  test('the ceiling is a parameter, clamped to [0, 1], and requests never exceed topN', () => {
    const all = ranked.map((e) => slug(e.b.bill_number as number));
    expect(planCoverageRun({ ranked, prioritySlugs: all, topN: 7, tailShare: 0.5, priorityShare: 1 }).priority).toHaveLength(3);
    expect(planCoverageRun({ ranked, prioritySlugs: all, topN: 7, tailShare: 0.5, priorityShare: 5 }).priority).toHaveLength(3);
    expect(planCoverageRun({ ranked, prioritySlugs: all, topN: 20, tailShare: 0.5, priorityShare: 0 }).priority).toHaveLength(0);
    expect(planCoverageRun({ ranked, prioritySlugs: all, topN: 20, tailShare: 0.5, priorityShare: -1 }).priority).toHaveLength(0);
    expect(planCoverageRun({ ranked, prioritySlugs: all, topN: 20, tailShare: 0.5, priorityShare: Number.NaN }).priority).toHaveLength(2);
    for (const topN of [0, 1, 7, 20, 39]) {
      expect(planCoverageRun({ ranked, prioritySlugs: all, topN, tailShare: 0.5, priorityShare: 1 }).requests).toBeLessThanOrEqual(topN);
    }
  });

  test('600 on the 2026-09-26 shape: 28 priority bills fit under the 60-bill ceiling', () => {
    const big = Array.from({ length: 3000 }, (_, i) => ({ b: fullBill({ bill_number: i + 1 }), eff: 0.5 }));
    const prio = Array.from({ length: 28 }, (_, i) => slug(1000 + i));
    const plan = planCoverageRun({ ranked: big, prioritySlugs: prio, topN: 600, tailShare: 0.5 });
    expect(plan.maxPriority).toBe(60);
    expect(plan.priority).toHaveLength(28);
    expect(plan.deferred).toEqual([]);
    expect(plan.head).toHaveLength(272);
    expect(plan.tail).toHaveLength(272);
    expect(plan.requests).toBe(600);
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

test.describe('the gate’s NO is not made permanent by the merge', () => {
  const art = (url: string, title = url) => ({ url, title, source: 'x.com', snippet: null, publishedAt: '2026-09-01' });

  test('a stored article tonight’s gate was shown and rejected is dropped; one it did not see stays', () => {
    const stored = [art('https://a/wrongly-kept', 'Fringe take'), art('https://a/not-seen-tonight', 'Old hearing')];
    const rejected = [art('https://a/wrongly-kept', 'Fringe take'), art('https://a/other', 'Unrelated')];
    expect(withoutRejected(stored, rejected).map((a) => a.url)).toEqual(['https://a/not-seen-tonight']);
  });

  test('the same syndicated title is the same article — as in the merge', () => {
    const stored = [art('https://a/1', 'Senate  VOTES on it')];
    expect(withoutRejected(stored, [art('https://b/1', 'senate votes on it')])).toEqual([]);
  });

  test('nothing rejected, nothing dropped; inputs are never mutated', () => {
    const stored = [art('https://a/1')];
    const copy = JSON.parse(JSON.stringify(stored));
    expect(withoutRejected(stored, [])).toEqual(stored);
    expect(withoutRejected(stored, [art('https://a/1')])).toEqual([]);
    expect(stored).toEqual(copy);
    expect(withoutRejected(undefined as never, [])).toEqual([]);
  });

  test('gateAnswered: only a COMPLETE, WELL-FORMED reply may delete stored coverage', () => {
    const done = { stopReason: 'end_turn' };
    // The exact shapes relevancePrompt asks for.
    expect(gateAnswered('0, 3', 5, done)).toBe(true);
    expect(gateAnswered('0,3,4', 5, done)).toBe(true);
    expect(gateAnswered('4', 5, done)).toBe(true);
    expect(gateAnswered('none', 5, done)).toBe(true);
    // Tolerated wrapping: one trailing period, one pair of quotes/backticks, whitespace.
    expect(gateAnswered('None.', 5, done)).toBe(true);
    expect(gateAnswered('"none"', 5, done)).toBe(true);
    expect(gateAnswered('`0, 3`', 5, done)).toBe(true);
    expect(gateAnswered('  0, 3.\n', 5, done)).toBe(true);
    expect(gateAnswered('10, 12', 20, done)).toBe(true);
  });

  test('gateAnswered: a TRUNCATED reply is not an answer, however clean the surviving text looks', () => {
    // "0, 3, 1" cut off at max_tokens may have been "0, 3, 12".
    expect(gateAnswered('0, 3, 1', 20, { stopReason: 'max_tokens' })).toBe(false);
    expect(gateAnswered('none', 5, { stopReason: 'max_tokens' })).toBe(false);
    expect(gateAnswered('0, 3', 5, { stopReason: 'refusal' })).toBe(false);
    // No stop reason at all is unknown, and unknown is no.
    expect(gateAnswered('0, 3', 5)).toBe(false);
    expect(gateAnswered('0, 3', 5, { stopReason: null })).toBe(false);
    expect(gateAnswered('0, 3', 5, {})).toBe(false);
  });

  test('gateAnswered: an OFF-SCRIPT reply is not an answer, even with in-range indexes in it', () => {
    const done = { stopReason: 'end_turn' };
    for (const text of [
      '',
      '   ',
      'I cannot tell from these headlines.',
      '0, 3 — the rest are about other bills',
      'Articles 2 and 4',
      '2 and 4',
      '0 3',
      '0;3',
      '0, 3,',
      ',0, 3',
      '0,\n3',
      'none of 0-24',
      'None of these are about this bill.',
      'none\n\nArticle 2 is close but covers a different bill.',
      '0, 3\n\nThese discuss the vote.',
      '1-3',
      '-1',
      '0.5',
      '03',
      '0, 03',
      '0, 0', // repeated: a looping reply, not a verdict
      '"0, 3', // unbalanced quote
      '0, 3..', // one trailing period is tolerated, not two
    ]) {
      expect(gateAnswered(text, 5, done), JSON.stringify(text)).toBe(false);
    }
    expect(gateAnswered(null, 5, done)).toBe(false);
    expect(gateAnswered(undefined, 5, done)).toBe(false);
    // Out of range: not an answer about THESE candidates — whole reply or part of it.
    expect(gateAnswered('7, 9', 5, done)).toBe(false);
    expect(gateAnswered('0, 5', 5, done)).toBe(false);
    // Nothing was shown.
    expect(gateAnswered('none', 0, done)).toBe(false);
  });

  test('gateAnswered is stricter than parseKeptIndexes, which still decides what a night KEEPS', () => {
    // An off-script reply keeps what it names (the keep path is unchanged)…
    expect([...parseKeptIndexes('0, 3 — the rest are about other bills', 5)].sort()).toEqual([0, 3]);
    // …but cannot delete anything.
    expect(gateAnswered('0, 3 — the rest are about other bills', 5, { stopReason: 'end_turn' })).toBe(false);
  });

  test('articleMatcher matches by URL or by syndicated title', () => {
    const isOne = articleMatcher([art('https://a/1', 'A title')]);
    expect(isOne(art('https://a/1', 'something else'))).toBe(true);
    expect(isOne(art('https://z/9', 'a  TITLE'))).toBe(true);
    expect(isOne(art('https://z/9', 'Other'))).toBe(false);
    expect(articleMatcher([])(art('https://a/1'))).toBe(false);
  });
});

test.describe('leanDrift — the date pass is judged by lean against the whole-life pass', () => {
  const mix = (left: number, center: number, right: number, unrated: number) => ({ left, center, right, unrated });

  test('thresholds are one frozen constant', () => {
    expect(LEAN_DRIFT).toEqual({ minArticles: 10, minPartisan: 8, minShift: 0.15, z: 2.58 });
    expect(Object.isFrozen(LEAN_DRIFT)).toBe(true);
  });

  test('too few kept articles is "too few to judge" — never "ok"', () => {
    const d = leanDrift(mix(2, 2, 1, 1), mix(0, 2, 0, 0));
    expect(d.verdict).toBe('thin');
    expect(d.checks.map((c) => c.state)).toEqual(['thin', 'thin']);
    // One question judged ok, the other too thin: still not "ok" overall.
    expect(leanDrift(mix(3, 10, 3, 4), mix(3, 10, 2, 5)).verdict).toBe('thin');
  });

  test('similar mixes are ok', () => {
    const d = leanDrift(mix(10, 10, 10, 20), mix(12, 12, 10, 22));
    expect(d.verdict).toBe('ok');
    expect(d.checks.every((c) => c.state === 'ok')).toBe(true);
  });

  test('a date pass that brings in far more UNRATED outlets fires', () => {
    const d = leanDrift(mix(5, 5, 5, 45), mix(15, 15, 15, 15));
    expect(d.verdict).toBe('drift');
    expect(d.checks.find((c) => c.metric === 'rated')!.state).toBe('drift');
  });

  test('the left/right split fires the same size of shift EITHER way', () => {
    const toRight = leanDrift(mix(3, 20, 17, 10), mix(17, 20, 3, 10));
    const toLeft = leanDrift(mix(17, 20, 3, 10), mix(3, 20, 17, 10));
    expect(toRight.verdict).toBe('drift');
    expect(toLeft.verdict).toBe('drift');
    const zr = toRight.checks.find((c) => c.metric === 'split')!.z!;
    const zl = toLeft.checks.find((c) => c.metric === 'split')!.z!;
    expect(Math.abs(zr)).toBeCloseTo(Math.abs(zl), 10);
  });

  test('a big-looking swing on a handful of articles does not fire (z below 2.58)', () => {
    // 8 vs 8 partisan: 75% vs 38% right is a 37-point swing, but not significant.
    const d = leanDrift(mix(2, 10, 6, 2), mix(5, 10, 3, 2));
    expect(d.checks.find((c) => c.metric === 'split')!.state).toBe('ok');
  });

  test('a statistically solid but TINY shift does not fire (under 15 points)', () => {
    const d = leanDrift(mix(5000, 5000, 4500, 5500), mix(4500, 5000, 5000, 5500));
    const split = d.checks.find((c) => c.metric === 'split')!;
    expect(Math.abs(split.z!)).toBeGreaterThan(LEAN_DRIFT.z);
    expect(split.state).toBe('ok');
  });

  test('junk input reads as zero, never throws', () => {
    expect(leanDrift(undefined as never, { left: -3, center: Number.NaN } as never).verdict).toBe('thin');
  });

  test('formatLeanDrift leads with the verdict word pipeline-health parses', () => {
    expect(LEAN_DRIFT_WORD).toEqual({ ok: 'ok', drift: 'DRIFT', thin: 'too few to judge' });
    expect(formatLeanDrift(leanDrift(mix(5, 5, 5, 45), mix(15, 15, 15, 15)), 30)).toMatch(
      /^DRIFT — rated share: 30-day 25% of 60 vs whole-life 75% of 60 \(z=-?\d+\.\d\d\) SHIFTED · left\/right split: /,
    );
    expect(formatLeanDrift(leanDrift(mix(1, 1, 1, 1), mix(1, 1, 1, 1)), 30)).toBe(
      'too few to judge — rated share: too few to judge (30-day 4, whole-life 4 kept; need 10 each) · ' +
        'left/right split: too few to judge (30-day 2, whole-life 2 partisan-rated; need 8 each)',
    );
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
