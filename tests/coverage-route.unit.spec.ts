import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// Pure, I/O-free: scripts/coverage-route.mjs decides which measure a vote
// report belongs to, with #303's own disambiguation (scripts/newsdesk-match.mjs)
// and the chambers' roll-call record (data/votes.json). No network, no model.
import {
  OWN_VOTE_DAYS,
  VOTE_REPORT_DAYS,
  VOTE_REPORT_RE,
  chambersNamed,
  coverageDurability,
  createVoteRouter,
  markRouted,
  readSectionShows,
  refileStoredCoverage,
} from '../scripts/coverage-route.mjs';
import { FLOOR_RECORD_HOURS, NOT_A_CHAMBER_RE, looksLegislative } from '../scripts/newsdesk-match.mjs';
import { isRouted, mergeArticles } from '../scripts/coverage-query.mjs';
import { getCoverage } from '../lib/coverage';

/*
 * The corpus: the twelve Iran war-powers resolutions and their cross-country
 * siblings with their REAL titles and search inputs (data/bills.json,
 * 2026-09-27), two identical Keep Nine amendments, the Russia sanctions pair,
 * and padding so "resolution", "joint", "direct" and "president" are common
 * words, as they are in the real corpus (the same construction as
 * tests/newsdesk-floor-record.unit.spec.ts: distinctive-word tests only behave
 * like the corpus when the corpus has common words in it).
 */
const SJRES = 'A joint resolution to direct the removal of United States Armed Forces from hostilities within or against the Islamic Republic of Iran that have not been authorized by Congress.';
const HCONRES = 'Directing the President, pursuant to section 5(c) of the War Powers Resolution, to remove United States Armed Forces from hostilities with Iran.';
const HCONRES_75 = 'Directing the President, pursuant to section 5(c) of the War Powers Resolution, to remove the United States Armed Forces from hostilities against the Islamic Republic of Iran.';
const KEEP_NINE = 'Proposing an amendment to the Constitution of the United States to require that the Supreme Court of the United States be composed of nine justices.';
type B = { bill_type: string; bill_number: number; title: string; news_query: string | null; status: string; last_action_date: string; press_names?: string[] | null; ai_headline?: string | null };
const RAW: B[] = [
  { bill_type: 'sjres', bill_number: 98, title: 'A joint resolution to direct the removal of United States Armed Forces from hostilities within or against Venezuela that have not been authorized by Congress.', news_query: 'President "Venezuela hostilities"', status: 'passed_chamber', last_action_date: '2026-01-14' },
  { bill_type: 'sjres', bill_number: 124, title: 'A joint resolution to direct the removal of United States Armed Forces from hostilities within or against the Republic of Cuba that have not been authorized by Congress.', news_query: 'Congress "Cuba military"', status: 'floor_vote', last_action_date: '2026-04-28' },
  { bill_type: 'hconres', bill_number: 61, title: 'Directing the President, pursuant to section 5(c) of the War Powers Resolution, to remove United States Armed Forces from hostilities with presidentially designated terrorist organizations in the Western Hemisphere.', news_query: 'President "armed forces" Western', status: 'floor_vote', last_action_date: '2025-12-17' },
  { bill_type: 'sjres', bill_number: 185, title: SJRES, news_query: 'Iran "war powers"', status: 'floor_vote', last_action_date: '2026-06-24' },
  { bill_type: 'sjres', bill_number: 172, title: SJRES, news_query: 'Congress "Iran hostilities"', status: 'floor_vote', last_action_date: '2026-06-16' },
  { bill_type: 'hconres', bill_number: 38, title: 'Directing the President pursuant to section 5(c) of the War Powers Resolution to remove United States Armed Forces from unauthorized hostilities in the Islamic Republic of Iran.', news_query: 'President "Iran hostilities"', status: 'floor_vote', last_action_date: '2026-03-05' },
  { bill_type: 'sjres', bill_number: 180, title: SJRES, news_query: 'Congress "Iran withdrawal"', status: 'floor_vote', last_action_date: '2026-07-23' },
  { bill_type: 'sjres', bill_number: 181, title: SJRES, news_query: 'Congress "Iran hostilities"', status: 'floor_vote', last_action_date: '2026-07-30' },
  { bill_type: 'hconres', bill_number: 93, title: HCONRES, news_query: 'President "Iran hostilities"', status: 'passed_chamber', last_action_date: '2026-09-16' },
  { bill_type: 'hconres', bill_number: 75, title: HCONRES_75, news_query: 'War Powers Resolution', status: 'floor_vote', last_action_date: '2026-05-14' },
  { bill_type: 'hconres', bill_number: 86, title: HCONRES, news_query: 'President "Iran hostilities"', status: 'passed_chamber', last_action_date: '2026-06-24' },
  { bill_type: 'sjres', bill_number: 200, title: SJRES, news_query: 'Congress "military action Iran"', status: 'committee', last_action_date: '2026-07-13' },
  { bill_type: 'sjres', bill_number: 211, title: SJRES, news_query: 'Congress "Iran hostilities"', status: 'committee', last_action_date: '2026-08-06' },
  { bill_type: 'hconres', bill_number: 40, title: HCONRES, news_query: 'President "Iran hostilities"', status: 'floor_vote', last_action_date: '2026-04-16' },
  { bill_type: 'hconres', bill_number: 89, title: HCONRES, news_query: 'President "Iran hostilities"', status: 'floor_vote', last_action_date: '2026-09-24' },
  { bill_type: 'hjres', bill_number: 1, title: KEEP_NINE, news_query: 'Supreme Court "nine justices"', status: 'floor_vote', last_action_date: '2026-09-02' },
  { bill_type: 'hjres', bill_number: 28, title: KEEP_NINE, news_query: 'Supreme Court "court size"', status: 'committee', last_action_date: '2025-01-22' },
  { bill_type: 's', bill_number: 5025, title: 'Lindsey O. Graham Sanctioning Russia Act of 2026', news_query: 'Russia "sanctions tariffs"', press_names: ['Lindsey O. Graham Sanctioning Russia Act'], status: 'committee', last_action_date: '2026-07-16' },
  { bill_type: 'hr', bill_number: 5334, title: 'Lindsey O. Graham Sanctioning Russia and Iran Act of 2026', news_query: 'Russia "sanctions tariffs"', press_names: ['Lindsey O. Graham Sanctioning Russia and Iran Act'], status: 'signed', last_action_date: '2026-09-18' },
  { bill_type: 'hr', bill_number: 7001, title: 'Venezuela Advancing Democracy Act', news_query: null, status: 'committee', last_action_date: '2026-02-01' },
  { bill_type: 'hr', bill_number: 7003, title: 'Cuba Democracy and Human Rights Act', news_query: null, status: 'committee', last_action_date: '2026-02-01' },
  ...Array.from({ length: 30 }, (_, i) => ({
    bill_type: 'hjres', bill_number: 500 + i, title: `A joint resolution to direct the President to proclaim observance week number ${i}`, news_query: null, status: 'committee', last_action_date: '2026-01-01',
  })),
  ...Array.from({ length: 30 }, (_, i) => ({
    bill_type: 'hr', bill_number: 9000 + i, title: `Rural broadband grant improvement measure number ${i} for counties`, news_query: null, status: 'committee', last_action_date: '2026-01-01',
  })),
];
const BILLS = RAW.map((b) => ({ congress_number: 119, press_names: null, ai_headline: `Headline ${b.bill_number}`, ...b }));

/* The roll calls, with their real ids and dates (data/votes.json, 2026-09-27). */
const roll = (id: string, date: string, bill: string) => ({ id, chamber: id.startsWith('s-') ? 'senate' : 'house', date, bill, question: '', result: '' });
const VOTES = {
  rollCalls: [
    roll('s-119-2-184', '2026-06-23', 'hconres-86-119'),
    roll('s-119-2-192', '2026-06-24', 'sjres-185-119'),
    roll('s-119-2-207', '2026-07-23', 'sjres-180-119'),
    roll('h-119-2-282', '2026-07-23', 'hconres-89-119'),
    roll('s-119-2-216', '2026-07-30', 'sjres-181-119'),
    roll('s-119-2-224', '2026-08-07', 'hr-5334-119'),
    roll('h-119-2-293', '2026-09-02', 'hjres-1-119'),
    roll('h-119-2-307', '2026-09-15', 'hconres-93-119'),
    roll('s-119-2-244', '2026-09-24', 'hconres-89-119'),
  ],
};
const router = createVoteRouter({ bills: BILLS, votes: VOTES });

/* The five articles stored under S.J.Res. 185 on 2026-09-27, verbatim. */
const art = (title: string, url: string, source: string, snippet: string | null, publishedAt: string | null) => ({ title, url, source, snippet, publishedAt, rated: false });
const JPOST = art("Senate shoots down Democratic-led resolution curbing Trump's Iran war powers", 'https://www.jpost.com/american-politics/article-909711', 'jpost.com', 'The Senate voted 50 to 49 to reject the resolution, which had passed the House of Representatives in July. The vote was largely along party lines.', '2026-09-25');
const ZH = art('Senate Narrowly Defeats Iran War Powers Resolution', 'https://www.zerohedge.com/political/senate-narrowly-defeats-iran-war-powers-resolution', 'zerohedge.com', 'ZeroHedge - On a long enough timeline, the survival rate for everyone drops to zero', '2026-09-25');
const TRUTHOUT = { ...art('Fetterman Joins GOP to Block Iran War Powers Resolution — Again', 'https://truthout.org/articles/fetterman-joins-gop-to-block-iran-war-powers-resolution-again/', 'truthout.org', 'While four Republicans joined Democrats by voting in favor, Fetterman became the deciding vote.', '2026-09-25'), rated: true };
const ET = art("Senate rejects resolution to halt Trump's war with Iran as gas prices upend midterms", 'https://economictimes.indiatimes.com/news/international/world-news/senate-rejects-resolution-to-halt-trumps-war-with-iran-as-gas-prices-upend-midterms/articleshow/134473303.cms', 'economictimes.indiatimes.com', "The Senate recently voted against a resolution aimed at ending US President Trump's military actions in Iran. This vote, which resulted in a 49-50 tally, reflec...", '2026-09-25');
const INN = art('Senate narrowly rejects measure to block Iran military action without Congress', 'https://www.israelnationalnews.com/news/433627', 'israelnationalnews.com', 'The Senate votes 50-49 against a Democratic measure that would have required congressional authorization for further US military action in Iran.', '2026-09-25');
const SEPT24 = [JPOST, ZH, TRUTHOUT, ET, INN];

test.describe('the window, the vote words and the chamber', () => {
  test("the window is #303's floor-record window, in whole days", () => {
    expect(VOTE_REPORT_DAYS).toBe(Math.ceil(FLOOR_RECORD_HOURS / 24));
    expect(VOTE_REPORT_DAYS).toBe(2);
    expect(OWN_VOTE_DAYS).toBe(7);
  });

  test('a title that reports an outcome is a vote report; a preview or a push is not', () => {
    for (const t of [JPOST.title, ZH.title, TRUTHOUT.title, ET.title, INN.title, 'House Votes To Pass Iran War Powers Resolution', 'Senate passes Iran war powers resolution']) {
      expect(VOTE_REPORT_RE.test(t), t).toBe(true);
    }
    for (const t of ["'End this war': Senate Democrats turn up heat on Donald Trump, seek end to 'unauthorised' Iran hostilities", 'Cassidy Flips, Helps Advance War Powers Resolution', 'Democrats introduce a new war powers resolution']) {
      expect(VOTE_REPORT_RE.test(t), t).toBe(false);
    }
  });

  test('"White House" is not the House — the same regex #303 uses', () => {
    expect(chambersNamed('White House blocks Iran war powers resolution')).toEqual(new Set());
    expect(chambersNamed('House passes Iran war powers resolution')).toEqual(new Set(['house']));
    expect(chambersNamed('Senate rejects Iran war powers resolution')).toEqual(new Set(['senate']));
    expect(chambersNamed('House-passed measure dies in the Senate')).toEqual(new Set(['house', 'senate']));
    // One regex, shared: looksLegislative blanks the same phrase.
    expect(looksLegislative('White House press credentials')).toBe(false);
    expect('the White House said'.replace(NOT_A_CHAMBER_RE, ' ')).not.toMatch(/house/i);
  });
});

test.describe('route(): the 2026-09-24 Iran vote goes to the measure the Senate voted on', () => {
  test('all five reports stored under S.J.Res. 185 route to H.Con.Res. 89 (s-119-2-244)', () => {
    for (const a of SEPT24) {
      expect(router.route(a, 'sjres-185-119'), a.title).toEqual({ to: 'hconres-89-119', rollCall: 's-119-2-244', date: '2026-09-24', chamber: 'senate' });
    }
    // The same report stored under H.Con.Res. 86 goes there too.
    expect(router.route(ZH, 'hconres-86-119')?.to).toBe('hconres-89-119');
  });

  test('the separation test reads the TITLE: a snippet\'s prose ("would have required") does not keep a report on S.J.Res. 185', () => {
    // "have" is a distinctive word of every S.J.Res. title ("…that have not
    // been authorized…"); read from INN's snippet it would separate the two.
    expect(INN.snippet).toMatch(/\bhave\b/);
    expect(router.route(INN, 'sjres-185-119')?.to).toBe('hconres-89-119');
  });

  test('a report already filed under the measure that was voted on stays (the own-vote test)', () => {
    for (const a of SEPT24) expect(router.route(a, 'hconres-89-119')).toBeNull();
    // S.J.Res. 185's own 6/24 roll call: a report two days later stays with it.
    expect(router.route({ ...ZH, publishedAt: '2026-06-26' }, 'sjres-185-119')).toBeNull();
    // …and so does a late write-up a week after it.
    expect(router.route({ ...ZH, publishedAt: '2026-07-01' }, 'sjres-185-119')).toBeNull();
  });

  test('outside the window nothing moves: the day before the vote, and three days after', () => {
    expect(router.route({ ...ZH, publishedAt: '2026-09-23' }, 'sjres-185-119')).toBeNull();
    expect(router.route({ ...ZH, publishedAt: '2026-09-24' }, 'sjres-185-119')?.to).toBe('hconres-89-119');
    expect(router.route({ ...ZH, publishedAt: '2026-09-26' }, 'sjres-185-119')?.to).toBe('hconres-89-119');
    expect(router.route({ ...ZH, publishedAt: '2026-09-27' }, 'sjres-185-119')).toBeNull();
  });

  test('a title that names the other chamber, an undated article, or no vote word: nothing moves', () => {
    expect(router.route({ ...ZH, title: 'House narrowly defeats Iran war powers resolution' }, 'sjres-185-119')).toBeNull();
    expect(router.route({ ...ZH, publishedAt: null }, 'sjres-185-119')).toBeNull();
    expect(router.route({ ...ZH, title: 'What the Iran war powers resolution would do' }, 'sjres-185-119')).toBeNull();
  });

  test('two measures voted in the window is ambiguous and stays — unless the title names the chamber', () => {
    // 7/23: the House agreed to H.Con.Res. 89 and the Senate rejected the
    // motion to discharge S.J.Res. 180.
    const blocked = art('Resolution to Restrict Trump’s Iran War Powers blocked', 'https://example.org/a', 'example.org', null, '2026-07-24');
    expect(router.route(blocked, 'sjres-181-119')).toBeNull();
    const senate = art('Senate Blocks Resolution to Restrict Trump’s Iran War Powers – NaturalNews.com', 'https://www.naturalnews.com/2026-07-24-senate-blocks-resolution-restrict-trump-iran-war-powers.html', 'naturalnews.com', 'The U.S. Senate on Thursday blocked a resolution that would have prohibited President Donald Trump from waging war against Iran without congressional authorizat...', '2026-07-24');
    expect(router.route(senate, 'sjres-181-119')).toEqual({ to: 'sjres-180-119', rollCall: 's-119-2-207', date: '2026-07-23', chamber: 'senate' });
    expect(router.route(senate, 'sjres-172-119')?.to).toBe('sjres-180-119');
  });

  test('a headline that names ANOTHER subject is never taken by the Iran vote (#303\'s separation)', () => {
    const venezuela = art('Senate rejects Venezuela war powers resolution', 'https://example.org/v', 'example.org', null, '2026-09-25');
    expect(router.route(venezuela, 'sjres-98-119')).toBeNull();
    const cuba = art('Senate blocks Cuba war powers resolution', 'https://example.org/c', 'example.org', null, '2026-09-25');
    expect(router.route(cuba, 'sjres-124-119')).toBeNull();
  });

  test('a citation vetoes: the filed bill, or a third measure; citing the voted one is consistent', () => {
    expect(router.route({ ...ZH, snippet: 'The vote came three months after S.J.Res. 185 failed.' }, 'sjres-185-119')).toBeNull();
    expect(router.route({ ...ZH, snippet: 'Senators also discussed S.J.Res. 211.' }, 'sjres-185-119')).toBeNull();
    expect(router.route({ ...ZH, snippet: 'The Senate rejected H.Con.Res. 89, 49-50.' }, 'sjres-185-119')?.to).toBe('hconres-89-119');
  });

  test('no record, a malformed record, or a bill outside the corpus: nothing routes', () => {
    for (const votes of [undefined, null, {}, { rollCalls: 'x' }, { rollCalls: [{ id: 'x', chamber: 'senate', date: 'yesterday', bill: 'hconres-89-119' }] }]) {
      const r = createVoteRouter({ bills: BILLS, votes });
      expect(r.rollCalls).toBe(0);
      expect(r.route(ZH, 'sjres-185-119')).toBeNull();
    }
    expect(router.route(ZH, 'sjres-999-119')).toBeNull();
    expect(createVoteRouter({ bills: undefined, votes: VOTES }).route(ZH, 'sjres-185-119')).toBeNull();
  });

  test('the Keep Nine vote: an identical amendment\'s report goes to the one the House voted on', () => {
    const nbc = art('House Democrats block constitutional amendment to lock Supreme Court size at 9 justices', 'https://www.nbcnews.com/politics/congress/house-democrats-block-constitutional-amendment-supreme-court-justices-rcna595736', 'nbcnews.com', 'The Republican-led resolution, which requires two-thirds support in Congress, comes in response to increasing openness among Democrats to expand the court to 13...', '2026-09-02');
    expect(router.route(nbc, 'hjres-28-119')).toEqual({ to: 'hjres-1-119', rollCall: 'h-119-2-293', date: '2026-09-02', chamber: 'house' });
  });
});

test.describe('coverageDurability: a move never makes an article leave the file sooner', () => {
  const by = (slug: string) => BILLS.find((b) => `${b.bill_type}-${b.bill_number}-119` === slug);
  test('decoded and not terminal is 2; in the sweep only by an exception is 1; out of the sweep is 0', () => {
    expect(coverageDurability(by('hconres-89-119'), true)).toBe(2);
    expect(coverageDurability(by('hr-5334-119'), true)).toBe(1); // signed: kept through its grace window only
    expect(coverageDurability(by('s-5025-119'), true)).toBe(2);
    expect(coverageDurability(by('hconres-89-119'), false)).toBe(0);
    expect(coverageDurability(undefined, true)).toBe(0);
    expect(coverageDurability({ ...by('hconres-89-119'), ai_headline: null }, true)).toBe(1);
  });
});

test.describe('mergeArticles: own and routed rows are capped apart', () => {
  const row = (n: number, day: string, extra: object = {}) => ({ title: `t${n}`, url: `https://x.org/${n}`, source: `o${n}.com`, snippet: null, publishedAt: day, ...extra });
  const routedRow = (n: number, day: string) => row(n, day, { routed: { from: 'sjres-185-119', rollCall: 's-119-2-244' } });

  test('five own rows and five routed rows are all kept — a routed row never pushes an own row out', () => {
    const own = [1, 2, 3, 4, 5].map((n) => row(n, `2026-01-0${n}`));
    const routed = [6, 7, 8, 9].map((n) => routedRow(n, `2026-09-2${n - 5}`)).concat(routedRow(10, '2026-09-25'));
    const merged = mergeArticles(routed, own, 5);
    expect(merged).toHaveLength(10);
    for (const o of own) expect(merged).toContain(o);
    // One newest-first list.
    const days = merged.map((a) => a.publishedAt);
    expect(days).toEqual([...days].sort().reverse());
  });

  test('a sixth routed row ages out the OLDEST routed row, never an own row', () => {
    const own = [1, 2, 3, 4, 5].map((n) => row(n, `2026-01-0${n}`));
    const routed = [6, 7, 8, 9, 10, 11].map((n) => routedRow(n, `2026-09-${10 + n}`));
    const merged = mergeArticles(routed, own, 5);
    expect(merged.filter((a) => !isRouted(a))).toHaveLength(5);
    expect(merged.filter((a) => isRouted(a)).map((a) => a.url)).not.toContain('https://x.org/6');
  });

  test('with no routed rows the merge is exactly the old single cap', () => {
    const pool = Array.from({ length: 9 }, (_, i) => row(i, `2026-0${(i % 9) + 1}-01`));
    const merged = mergeArticles(pool.slice(0, 4), pool.slice(4), 5);
    const old = [...pool].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 5);
    expect(merged.map((a) => a.url)).toEqual(old.map((a) => a.url));
  });

  test("the bill's own copy of an article wins over a routed copy of it", () => {
    const merged = mergeArticles([row(1, '2026-09-25')], [routedRow(1, '2026-09-25')], 5);
    expect(merged).toHaveLength(1);
    expect(isRouted(merged[0])).toBe(false);
  });
});

test.describe('refileStoredCoverage: moves, never deletes, never hides, idempotent', () => {
  const STORED = {
    'sjres-185-119': SEPT24,
    'hconres-86-119': [ZH],
    _checkedAt: { 'sjres-185-119': '2026-09-27' },
    _note: 'metadata',
  };

  test('the 9/24 reports leave S.J.Res. 185 for H.Con.Res. 89, marked with where they came from', () => {
    const copy = JSON.parse(JSON.stringify(STORED));
    const res = refileStoredCoverage(STORED, router, { cap: 5 });
    expect(STORED).toEqual(copy); // input untouched
    expect(res.coverage['sjres-185-119']).toBeUndefined();
    expect(res.coverage['hconres-86-119']).toBeUndefined();
    const dest = res.coverage['hconres-89-119'];
    expect(dest.map((a: { url: string }) => a.url).sort()).toEqual(SEPT24.map((a) => a.url).sort());
    for (const a of dest) {
      expect(a.routed.rollCall).toBe('s-119-2-244');
      expect(['sjres-185-119', 'hconres-86-119']).toContain(a.routed.from);
    }
    // The twin stored under both S.J.Res. 185 and H.Con.Res. 86 is one row there.
    expect(res.moves.filter((m) => m.duplicate)).toHaveLength(1);
    expect(res.held).toEqual([]);
    expect(res.coverage._checkedAt).toBe(STORED._checkedAt);
    expect(res.coverage._note).toBe('metadata');
  });

  test('no article leaves the file: every URL stored before is stored after', () => {
    const res = refileStoredCoverage(STORED, router, { cap: 5 });
    const urls = (cov: Record<string, unknown>) =>
      new Set(Object.entries(cov).filter(([k, v]) => !k.startsWith('_') && Array.isArray(v)).flatMap(([, v]) => (v as { url: string }[]).map((a) => a.url)));
    expect(urls(res.coverage)).toEqual(urls(STORED));
  });

  test('idempotent: a second pass moves nothing and changes nothing', () => {
    const once = refileStoredCoverage(STORED, router, { cap: 5 });
    const twice = refileStoredCoverage(once.coverage, router, { cap: 5 });
    expect(twice.moves).toEqual([]);
    expect(twice.held).toEqual([]);
    expect(twice.coverage).toEqual(once.coverage);
  });

  test("the voted measure's own five rows all survive the move (two caps)", () => {
    const own = [1, 2, 3, 4, 5].map((n) => art(`Own ${n}`, `https://own.org/${n}`, `own${n}.com`, null, `2026-08-0${n}`));
    const res = refileStoredCoverage({ ...STORED, 'hconres-89-119': own }, router, { cap: 5 });
    const dest = res.coverage['hconres-89-119'];
    for (const o of own) expect(dest).toContain(o);
    expect(dest.filter((a: object) => isRouted(a))).toHaveLength(5);
  });

  test('no room: a row that would push out a routed row already stored stays where it is', () => {
    const earlier = [1, 2, 3, 4, 5].map((n) => markRouted(art(`Routed ${n}`, `https://r.org/${n}`, `r${n}.com`, null, '2026-09-26'), 'sjres-172-119', { rollCall: 's-119-2-244' }));
    const res = refileStoredCoverage({ 'sjres-185-119': SEPT24, 'hconres-89-119': earlier }, router, { cap: 5 });
    expect(res.moves).toEqual([]);
    expect(res.held.map((h) => h.reason)).toEqual(['room', 'room', 'room', 'room', 'room']);
    expect(res.coverage['sjres-185-119']).toEqual(SEPT24);
    expect(res.coverage['hconres-89-119']).toEqual(earlier);
  });

  test('never hides: a shown row that would be the lone outlet on its new bill stays shown where it is', () => {
    // H.Con.Res. 75 on 2026-09-27: five rows, four outlets, a Read section. Its
    // report of the House's 9/15 vote on H.Con.Res. 93 would be the only row
    // there, and one outlet is no Read section.
    const HC75 = [
      art("War-powers resolution advances to limit Trump's Iran war powers", 'https://www.jpost.com/middle-east/iran-news/article-896761', 'jpost.com', null, '2026-05-20'),
      art('House Votes To Pass Iran War Powers Resolution', 'https://www.zerohedge.com/political/house-votes-pass-iran-war-powers-resolution', 'zerohedge.com', null, '2026-09-16'),
      art('Senate passes Iran war powers resolution', 'https://www.jns.org/news/u-s-news/senate-passes-iran-war-powers-resolution', 'jns.org', 'Four Republicans joined with nearly every Democrat to direct U.S. President Donald Trump to remove American military forces from the conflict with Iran in a non...', '2026-06-23'),
      art('Cassidy Flips, Helps Advance War Powers Resolution', 'https://www.joemygod.com/2026/05/cassidy-flips-helps-advance-war-powers-resolution/', 'joemygod.com', null, '2026-05-19'),
    ];
    expect(router.route(HC75[1], 'hconres-75-119')?.to).toBe('hconres-93-119');
    expect(router.route(HC75[2], 'hconres-75-119')?.to).toBe('hconres-86-119');
    const res = refileStoredCoverage({ 'hconres-75-119': HC75 }, router, { cap: 5 });
    expect(res.moves).toEqual([]);
    expect(res.held.map((h) => [h.to, h.reason])).toEqual([
      ['hconres-93-119', 'visibility'],
      ['hconres-86-119', 'visibility'],
    ]);
    expect(res.coverage['hconres-75-119']).toEqual(HC75);
    // …and the day H.Con.Res. 93 can show it (a second outlet there), it moves.
    const other = art('House adopts Iran war powers measure', 'https://ap.org/x', 'apnews.com', null, '2026-09-15');
    const later = refileStoredCoverage({ 'hconres-75-119': HC75, 'hconres-93-119': [other] }, router, { cap: 5 });
    expect(later.moves.map((m) => m.to)).toContain('hconres-93-119');
    expect(readSectionShows(later.coverage['hconres-75-119'])).toBe(true);
  });

  test('never hides: moves that would drop the rows left behind below two outlets are taken back', () => {
    // Two outlets: the vote report, and two rows from one other outlet. Moving
    // the report would leave one outlet, and the two rows would stop showing.
    const left = [
      art('Iran war powers explainer', 'https://a.org/1', 'a.org', null, '2026-09-01'),
      art('Iran war powers explainer two', 'https://a.org/2', 'a.org', null, '2026-09-02'),
    ];
    const res = refileStoredCoverage({ 'sjres-185-119': [JPOST, ...left], 'hconres-89-119': [TRUTHOUT, ET] }, router, { cap: 5 });
    expect(res.moves).toEqual([]);
    expect(res.held).toEqual([expect.objectContaining({ from: 'sjres-185-119', to: 'hconres-89-119', reason: 'visibility' })]);
  });

  test('canReceive says no: nothing moves', () => {
    const res = refileStoredCoverage(STORED, router, { cap: 5, canReceive: () => false });
    expect(res.moves).toEqual([]);
    expect(res.coverage['sjres-185-119']).toEqual(SEPT24);
  });

  test('canReceive gets both ends: the Russia sanctions articles stay under S. 5025 when H.R. 5334 is only in its grace window', () => {
    const senate = art('Senate passes ‘Lindsey O. Graham Sanctioning Russia Act’ overwhelmingly', 'https://www.jns.org/x', 'jns.org', null, '2026-08-07');
    expect(router.route(senate, 's-5025-119')?.to).toBe('hr-5334-119');
    const rank = (s: string) => coverageDurability(BILLS.find((b) => `${b.bill_type}-${b.bill_number}-119` === s), true);
    const canReceive = (to: string, from: string) => rank(to) >= 1 && rank(to) >= rank(from);
    const res = refileStoredCoverage({ 's-5025-119': [senate] }, router, { cap: 5, canReceive });
    expect(res.moves).toEqual([]);
    expect(res.coverage['s-5025-119']).toEqual([senate]);
  });
});

test.describe('readSectionShows is the page\'s own rule', () => {
  test('it agrees with lib/coverage.ts getCoverage on every bill in the committed file', () => {
    const coverage = JSON.parse(readFileSync(join(process.cwd(), 'data/coverage.json'), 'utf8'));
    const slugs = Object.keys(coverage).filter((k) => !k.startsWith('_'));
    expect(slugs.length).toBeGreaterThan(100);
    const disagree = slugs.filter((s) => (getCoverage(s).length > 0) !== readSectionShows(coverage[s]));
    expect(disagree).toEqual([]);
  });

  test('two distinct outlets show; one outlet, or nothing, does not', () => {
    expect(readSectionShows([JPOST, ZH])).toBe(true);
    expect(readSectionShows([ZH, { ...ZH, url: 'https://www.zerohedge.com/other' }])).toBe(false);
    expect(readSectionShows([])).toBe(false);
    expect(readSectionShows(undefined)).toBe(false);
  });
});
