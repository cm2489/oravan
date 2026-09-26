import { expect, test } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
// Pure module (no network, no disk) — see lib/question-press.mjs's header for
// the design every test below pins, and scripts/gdelt-intake.mjs's header for
// the rate-limit rules the collector tests pin. ZERO network here: every
// GDELT response is a literal handed to an injected fetch, and every wait is
// an injected sleep that records instead of waiting.
import {
  GDELT_ATTRIBUTION,
  GDELT_HOME,
  GDELT_MAX_QUERY_CHARS,
  LEGISLATIVE_CONTEXT_TERMS,
  MATCH_RULE,
  MAX_ARTICLES_PER_OUTLET,
  MAX_TERMS_PER_QUESTION,
  OUTLET_POLICY,
  QUESTION_PRESS_PATH,
  QUESTION_PRESS_SCHEMA,
  QUESTION_PRESS_WINDOW_DAYS,
  admitArticles,
  buildGdeltQuery,
  buildQuestionPress,
  countsFor,
  domainChunks,
  eligibleDomainsByLean,
  gdeltUrl,
  inWindow,
  lampLeanCounts,
  leanParity,
  parseArtList,
  questionTerms,
  seenDay,
  shouldWrite,
  termTitleHits,
  timespanFor,
  titleTermShare,
  verifyQuestionPress,
} from '../lib/question-press.mjs';
import { SILENT_CIRCUIT, TOO_LONG, USER_AGENT, collect, limitsFrom } from '../scripts/gdelt-intake.mjs';
// The one definition of a checkable article link (B-5), shared with the lamp.
import { normalizeArticleUrl } from '../lib/conversation.mjs';

const ROOT = process.cwd();
const NOW = Date.parse('2026-09-25T00:30:00Z');
const TODAY = '2026-09-25';

// A small rated table with every lean present, in data/media-bias.json's shape.
const BIAS: Record<string, string> = {
  'cnn.com': 'left',
  'politico.com': 'left',
  'npr.org': 'center',
  'thehill.com': 'center',
  'foxnews.com': 'right',
  'nypost.com': 'right',
};

const BILLS = [
  { full_identifier: 'hconres-89-119', press_names: null, short_title: null, news_query: 'President "Iran hostilities"', sponsor_bioguide_id: 'J000298' },
  { full_identifier: 's-4668-119', press_names: ['Protect College Sports Act'], short_title: null, news_query: 'college athletes "NIL deals"', sponsor_bioguide_id: 'C001098' },
  { full_identifier: 's-3172-119', press_names: null, short_title: null, news_query: 'Syria sanctions repeal', sponsor_bioguide_id: 'S001181' },
];

type Article = { url: string; seen: string };
type Outlet = { domain: string; lean: string; firstSeen: string; lastSeen: string; articles: Article[] };
type Entry = { checkedOn: string; terms: string[]; counts: unknown; outlets: Outlet[] };
type Doc = ReturnType<typeof buildQuestionPress>;
type Moment = { status: string; aliases: { en: string[]; es?: string[] }; vehicles: Array<{ slug: string }> };

const MOMENTS: Record<string, Moment> = {
  'iran-war-powers': {
    status: 'live',
    aliases: { en: ['iran', 'war powers', 'War Powers', 'operation epic fury', 'hormuz'], es: ['irán'] },
    vehicles: [{ slug: 'hconres-89-119' }],
  },
  'paying-college-athletes': {
    status: 'live',
    aliases: { en: ['S. 4668'], es: ['S. 4668'] },
    vehicles: [{ slug: 's-4668-119' }],
  },
  'syria-sanctions-repeal': {
    status: 'live',
    aliases: { en: ['S. 3172'], es: ['S. 3172'] },
    vehicles: [{ slug: 's-3172-119' }],
  },
  'an-old-question': { status: 'retired', aliases: { en: ['war powers'] }, vehicles: [] },
};

/** One GDELT ArtList article, in the shape the DOC 2.0 API returned live on
 *  2026-09-26 (these eight keys, in this order; seendate as YYYYMMDDTHHMMSSZ;
 *  domain bare, url on www.). */
function art(domain: string, path: string, seendate = '20260924T211500Z', title = 'Senate votes on war powers resolution') {
  return {
    url: `https://www.${domain}/${path}`,
    url_mobile: '',
    title,
    seendate,
    socialimage: '',
    domain,
    language: 'English',
    sourcecountry: 'United States',
  };
}

/** Which lean a request URL was restricted to, read off its domainis: list. */
function leanOfRequest(url: string): string {
  const q = new URL(url).searchParams.get('query') ?? '';
  if (q.includes('domainis:cnn.com')) return 'left';
  if (q.includes('domainis:npr.org')) return 'center';
  if (q.includes('domainis:foxnews.com')) return 'right';
  throw new Error(`unrecognised lean in ${q}`);
}

type Reply = { status: number; body: string } | Error;

/** A scripted fetch: `script(url, n)` returns the reply for the n-th request. */
function fakeNet(script: (url: string, n: number) => Reply) {
  const calls: Array<{ url: string; ua: string }> = [];
  const sleeps: number[] = [];
  let t = NOW;
  const fetchImpl = async (url: string, init: { headers?: Record<string, string> }) => {
    calls.push({ url, ua: init?.headers?.['User-Agent'] ?? '' });
    const r = script(url, calls.length);
    if (r instanceof Error) throw r;
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => r.body };
  };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    t += ms;
  };
  const clock = () => t;
  return { fetchImpl, sleep, clock, calls, sleeps };
}

const LIMITS = limitsFrom({}); // the production defaults, exactly
const quiet = () => {};

// ---------------------------------------------------------------------------
test.describe('the alias rules (plan §4)', () => {
  const billsBySlug = new Map(BILLS.map((b) => [b.full_identifier, b]));

  test('single words and bill numbers are dropped; phrases are kept, lowercased, once', () => {
    const { terms, dropped } = questionTerms(MOMENTS['iran-war-powers'], billsBySlug);
    expect(terms).toEqual(['war powers', 'operation epic fury']);
    expect(dropped.map((d) => [d.term, d.reason])).toEqual([
      ['iran', 'single word'],
      ['hormuz', 'single word'],
    ]);
    const college = questionTerms(MOMENTS['paying-college-athletes'], billsBySlug);
    expect(college.terms).toEqual(['protect college sports act']);
    expect(college.dropped[0].reason).toMatch(/bill number/);
  });

  test('a question with only placeholder aliases and no multi-word bill name has no terms', () => {
    expect(questionTerms(MOMENTS['syria-sanctions-repeal'], billsBySlug).terms).toEqual([]);
  });

  test('sponsors and the AI-generated news_query never enter a search (every lead sponsor or none: none)', () => {
    for (const id of Object.keys(MOMENTS)) {
      const { terms } = questionTerms(MOMENTS[id], billsBySlug);
      const joined = terms.join(' | ');
      expect(joined).not.toMatch(/hostilities|nil deals|syria sanctions repeal/);
      for (const b of BILLS) expect(joined).not.toContain(b.sponsor_bioguide_id.toLowerCase());
    }
  });

  test('Spanish aliases are not searched (the rated outlets publish in English)', () => {
    const spanishOnly = { aliases: { en: [] as string[], es: ['poderes de guerra'] }, vehicles: [] };
    const { terms } = questionTerms(spanishOnly, billsBySlug);
    expect(terms).toEqual([]);
  });

  test('a year suffix comes off a bill name, and the term cap holds', () => {
    const many = { aliases: { en: Array.from({ length: 20 }, (_, i) => `phrase number ${i}`) }, vehicles: [] };
    const { terms, dropped } = questionTerms(many, new Map());
    expect(terms).toHaveLength(MAX_TERMS_PER_QUESTION);
    expect(dropped.filter((d) => /cap/.test(d.reason))).toHaveLength(20 - MAX_TERMS_PER_QUESTION);
    const named = questionTerms(
      { aliases: { en: [] }, vehicles: [{ slug: 'x' }] },
      new Map([['x', { press_names: ['Protect College Sports Act of 2026'] }]])
    );
    expect(named.terms).toEqual(['protect college sports act']);
  });
});

// ---------------------------------------------------------------------------
test.describe('the request', () => {
  test('one query = the terms AND a legislative word AND one lean’s rated domains', () => {
    const q = buildGdeltQuery({ terms: ['war powers', 'operation epic fury'], domains: ['foxnews.com', 'nypost.com'] });
    expect(q).toBe(
      `("war powers" OR "operation epic fury") (${LEGISLATIVE_CONTEXT_TERMS.map((t) => (t.includes(' ') ? `"${t}"` : t)).join(' OR ')}) (domainis:foxnews.com OR domainis:nypost.com)`
    );
    // no nested OR groups — GDELT does not support them
    expect(q).not.toMatch(/\([^)]*\(/);
    // the context words are symmetric: no party nouns, both chambers
    expect(LEGISLATIVE_CONTEXT_TERMS.join(' ')).not.toMatch(/gop|republican|democrat|dems/i);
    expect(LEGISLATIVE_CONTEXT_TERMS).toEqual(expect.arrayContaining(['senate', 'house vote']));
  });

  test('a single term or domain goes bare, and quotes/parentheses cannot break out of a phrase', () => {
    const q = buildGdeltQuery({ terms: ['war "powers) x'], domains: ['npr.org'] });
    expect(q.startsWith('"war powers x" (')).toBe(true);
    expect(q.endsWith(') domainis:npr.org')).toBe(true);
    expect(() => buildGdeltQuery({ terms: [], domains: ['npr.org'] })).toThrow();
  });

  test('ArtList + JSON + newest first, never a tone mode, timespan clamped to the window', () => {
    const u = new URL(gdeltUrl({ query: 'x', timespanDays: 30 }));
    expect(u.origin + u.pathname).toBe('https://api.gdeltproject.org/api/v2/doc/doc');
    expect(u.searchParams.get('mode')).toBe('ArtList');
    expect(u.searchParams.get('format')).toBe('json');
    expect(u.searchParams.get('sort')).toBe('DateDesc');
    expect(u.searchParams.get('maxrecords')).toBe('250');
    expect(u.searchParams.get('timespan')).toBe(`${QUESTION_PRESS_WINDOW_DAYS}d`);
    expect(u.toString().toLowerCase()).not.toContain('tone');
    expect(timespanFor(null, TODAY)).toBe(7);
    expect(timespanFor('2026-09-24', TODAY)).toBe(2);
    expect(timespanFor('2026-09-20', TODAY)).toBe(6);
    expect(timespanFor('2026-01-01', TODAY)).toBe(7);
  });

  test('every rated domain is searched, grouped by its lean — and nothing unrated', () => {
    expect(eligibleDomainsByLean({ ...BIAS, 'blog.example': 'nonsense' })).toEqual({
      left: ['cnn.com', 'politico.com'],
      center: ['npr.org', 'thehill.com'],
      right: ['foxnews.com', 'nypost.com'],
    });
    const real = JSON.parse(readFileSync(join(ROOT, 'data/media-bias.json'), 'utf8')).outlets;
    const byLean = eligibleDomainsByLean(real);
    const total = byLean.left.length + byLean.center.length + byLean.right.length;
    expect(total).toBe(Object.keys(real).length);
  });
});

// ---------------------------------------------------------------------------
test.describe('the response', () => {
  test('JSON parses to four fields and nothing else; {} is an empty result; text is an error', () => {
    const r = parseArtList(JSON.stringify({ articles: [{ ...art('foxnews.com', 'a'), tone: -4.2 }] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.articles[0]).sort()).toEqual(['domain', 'seendate', 'title', 'url']);
    expect(parseArtList('{}')).toEqual({ ok: true, articles: [] });
    const bad = parseArtList('The specified phrase is too short.');
    expect(bad.ok).toBe(false);
    expect(parseArtList(JSON.stringify({ articles: 'nope' })).ok).toBe(false);
    // a raw control character inside a title is rescued, not a lost question
    const raw = JSON.stringify({ articles: [art('npr.org', 'x', '20260924T211500Z', 'TITLE')] }).replace('TITLE', 'a\u0007b\tc');
    const rescued = parseArtList(raw);
    expect(rescued.ok).toBe(true);
    if (rescued.ok) expect(rescued.articles[0].url).toBe('https://www.npr.org/x');
  });

  test('admission: rated, rated as the searched lean, on its own domain, inside the week', () => {
    const { admitted, rejected } = admitArticles(
      [
        art('foxnews.com', 'politics/ok?utm_source=x#frag'),
        art('cnn.com', 'wrong-lean'), // rated, but left — answered the right-lean search
        art('example-blog.test', 'unrated'),
        { ...art('foxnews.com', 'x'), url: 'https://evil.example/foxnews.com/x' }, // link off the outlet's domain
        art('foxnews.com', 'old', '20260901T000000Z'),
        art('foxnews.com', 'future', '20261001T000000Z'),
        { ...art('foxnews.com', 'baddate'), seendate: 'yesterday' },
      ],
      { lean: 'right', bias: BIAS, today: TODAY }
    );
    // the lamp's B-5 link gate: query and fragment are quoted evidence, kept as-is
    expect(admitted.map((a) => a.url)).toEqual(['https://www.foxnews.com/politics/ok?utm_source=x#frag']);
    expect(admitted[0]).toMatchObject({ domain: 'foxnews.com', lean: 'right', seen: '2026-09-24' });
    expect(rejected).toBe(6);
    expect(seenDay('20260924T211500Z')).toBe('2026-09-24');
    expect(normalizeArticleUrl('ftp://x.com/a')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
test.describe('the evidence document', () => {
  const admitted = (domain: string, lean: string, path: string, seen = '2026-09-24') => ({
    url: `https://www.${domain}/${path}`,
    domain,
    lean,
    seen,
    title: 'x',
  });

  test('links dedupe, newest first, capped per outlet; dates and counts come from the links', () => {
    const many = Array.from({ length: MAX_ARTICLES_PER_OUTLET + 3 }, (_, i) => admitted('foxnews.com', 'right', `a${i}`, `2026-09-2${i % 5}`));
    const doc = buildQuestionPress({
      previous: null,
      liveIds: ['iran-war-powers'],
      results: new Map([['iran-war-powers', { terms: ['war powers'], admitted: [...many, many[0], admitted('npr.org', 'center', 'n')] }]]),
      bias: BIAS,
      today: TODAY,
    });
    const q = doc.questions['iran-war-powers'] as Entry;
    const fox = q.outlets.find((o) => o.domain === 'foxnews.com')!;
    expect(fox.articles).toHaveLength(MAX_ARTICLES_PER_OUTLET);
    expect(fox.articles[0].seen >= fox.articles[fox.articles.length - 1].seen).toBe(true);
    expect(fox.firstSeen).toBe(fox.articles.map((a) => a.seen).sort()[0]);
    expect(q.counts).toEqual({ outlets: { left: 0, center: 1, right: 1 }, articles: { left: 0, center: 1, right: MAX_ARTICLES_PER_OUTLET } });
    expect(q.outlets.map((o) => o.lean)).toEqual(['center', 'right']); // lean order, then domain
    expect(doc._meta).toMatchObject({ schema: QUESTION_PRESS_SCHEMA, outlet_policy: OUTLET_POLICY, window_days: QUESTION_PRESS_WINDOW_DAYS });
    expect(doc._meta.attribution).toContain(GDELT_HOME);
    expect(verifyQuestionPress({ data: doc, fileBytes: 100, bias: BIAS, moments: MOMENTS, now: NOW }).failures).toEqual([]);
  });

  test('a question that failed this run carries forward untouched except for the window prune', () => {
    const prev = buildQuestionPress({
      previous: null,
      liveIds: ['iran-war-powers', 'paying-college-athletes'],
      results: new Map([
        ['iran-war-powers', { terms: ['war powers'], admitted: [admitted('cnn.com', 'left', 'old', '2026-09-17'), admitted('cnn.com', 'left', 'new', '2026-09-23')] }],
        ['paying-college-athletes', { terms: ['protect college sports act'], admitted: [admitted('nypost.com', 'right', 'c')] }],
      ]),
      bias: BIAS,
      today: '2026-09-23',
    });
    const next = buildQuestionPress({ previous: prev, liveIds: ['iran-war-powers', 'paying-college-athletes'], results: new Map(), bias: BIAS, today: TODAY });
    const iran = next.questions['iran-war-powers'] as Entry;
    expect(iran.checkedOn).toBe('2026-09-23'); // NOT advanced — nothing was checked
    expect(iran.terms).toEqual(['war powers']);
    expect(iran.outlets[0].articles.map((a) => a.url)).toEqual(['https://www.cnn.com/new']); // 09-17 (8 days old) aged out
    expect(shouldWrite({ previous: prev, next })).toBe(true);
    expect(shouldWrite({ previous: next, next: buildQuestionPress({ previous: next, liveIds: ['iran-war-powers', 'paying-college-athletes'], results: new Map(), bias: BIAS, today: TODAY }) })).toBe(false);
  });

  test('carried evidence is re-judged against the current bias table; retired and never-checked questions are absent', () => {
    const prev = buildQuestionPress({
      previous: null,
      liveIds: ['iran-war-powers', 'an-old-question'],
      results: new Map([
        ['iran-war-powers', { terms: ['war powers'], admitted: [admitted('cnn.com', 'left', 'a'), admitted('nypost.com', 'right', 'b')] }],
        ['an-old-question', { terms: ['war powers'], admitted: [admitted('cnn.com', 'left', 'c')] }],
      ]),
      bias: BIAS,
      today: TODAY,
    });
    const reRated = { ...BIAS, 'cnn.com': 'center' } as Record<string, string>;
    delete reRated['nypost.com'];
    const next = buildQuestionPress({ previous: prev, liveIds: ['iran-war-powers', 'paying-college-athletes'], results: new Map(), bias: reRated, today: TODAY });
    expect(Object.keys(next.questions)).toEqual(['iran-war-powers']);
    expect((next.questions['iran-war-powers'] as Entry).outlets.map((o) => [o.domain, o.lean])).toEqual([['cnn.com', 'center']]);
  });
});

// ---------------------------------------------------------------------------
test.describe('the gate', () => {
  const good = () =>
    buildQuestionPress({
      previous: null,
      liveIds: ['iran-war-powers'],
      results: new Map([['iran-war-powers', { terms: ['war powers'], admitted: [{ url: 'https://www.foxnews.com/a', domain: 'foxnews.com', lean: 'right', seen: TODAY }] }]]),
      bias: BIAS,
      today: TODAY,
    });

  test('never tone, never text: any key the format does not define fails', () => {
    for (const mutate of [
      (d: Doc) => ((d.questions['iran-war-powers'] as Entry).outlets[0] as Outlet & { tone?: number }).tone = -2,
      (d: Doc) => (((d.questions['iran-war-powers'] as Entry).outlets[0].articles[0] as Article & { title?: string }).title = 'headline'),
      (d: Doc) => ((d.questions['iran-war-powers'] as Entry & { sentiment?: number }).sentiment = 0.3),
      (d: Doc) => ((d._meta as Record<string, unknown>).avg_tone = 1),
      (d: Doc) => ((d as unknown as Record<string, unknown>).extra = true),
    ]) {
      const d = good();
      mutate(d);
      expect(verifyQuestionPress({ data: d, bias: BIAS, moments: MOMENTS, now: NOW }).failures.length).toBeGreaterThan(0);
    }
  });

  test('rated-only, and the GDELT citation must travel with the data', () => {
    const unrated = good();
    unrated.questions['iran-war-powers'].outlets[0].domain = 'rollcall.com';
    expect(verifyQuestionPress({ data: unrated, bias: BIAS, now: NOW }).failures.join(' ')).toMatch(/no AllSides rating|not on rollcall/);
    const uncited = good();
    uncited._meta.attribution = 'news';
    expect(verifyQuestionPress({ data: uncited, bias: BIAS, now: NOW }).failures.join(' ')).toMatch(/GDELT/);
    expect(GDELT_ATTRIBUTION).toContain('GDELT Project');
  });

  test('the file is judged against the day it was written, never the wall clock (the midnight bug)', () => {
    // Day D. The first run admits a link GDELT saw on the window's edge (7
    // days old) and one from yesterday — an edge link is near-certain on any
    // active question, since the first search spans the whole window.
    const D = '2026-09-26';
    const doc = buildQuestionPress({
      previous: null,
      liveIds: ['iran-war-powers'],
      results: new Map([
        [
          'iran-war-powers',
          {
            terms: ['war powers'],
            admitted: [
              { url: 'https://www.foxnews.com/politics/edge', domain: 'foxnews.com', lean: 'right', seen: '2026-09-19' },
              { url: 'https://www.npr.org/2026/09/25/b', domain: 'npr.org', lean: 'center', seen: '2026-09-25' },
            ],
          },
        ],
      ]),
      bias: BIAS,
      today: D,
    });
    expect(doc._meta.as_of).toBe(D);
    expect((doc.questions['iran-war-powers'] as Entry).outlets.map((o) => o.domain)).toEqual(['npr.org', 'foxnews.com']); // the 7-day-old link is IN
    const at = (iso: string) => verifyQuestionPress({ data: doc, fileBytes: 1000, bias: BIAS, moments: MOMENTS, now: Date.parse(iso) });
    // Before the fix this failed from 00:00 UTC until the first collector run
    // of D+1 — in CI, and in the nightly's pre-commit verify-sync.
    for (const iso of ['2026-09-26T23:59:00Z', '2026-09-27T00:30:00Z', '2026-09-27T09:30:00Z']) expect(at(iso).failures).toEqual([]);
    // Days later: still no failure — lateness is a warning (N8-A2), never damage.
    const late = at('2026-09-29T12:00:00Z');
    expect(late.failures).toEqual([]);
    expect(late.warnings.join(' ')).toMatch(/last pruned on 2026-09-26, 3 days ago/);
    expect(late.warnings.join(' ')).toMatch(/has not succeeded for 3 days/);
    expect(at('2026-12-01T00:00:00Z').failures).toEqual([]);
    // The only wall-clock failure: a file dated more than a day in the future.
    expect(at('2026-09-24T12:00:00Z').failures.join(' ')).toMatch(/as_of 2026-09-26 is in the future/);
    expect(at('2026-09-25T12:00:00Z').failures).toEqual([]); // one day of clock skew is tolerated, like the lamp's gate
  });

  test('damage is still damage when judged against the file\'s own day', () => {
    const base = good();
    const past = structuredClone(base);
    (past.questions['iran-war-powers'] as Entry).outlets[0].articles[0].seen = '2026-09-17'; // 8 days before as_of
    (past.questions['iran-war-powers'] as Entry).outlets[0].firstSeen = '2026-09-17';
    (past.questions['iran-war-powers'] as Entry).outlets[0].lastSeen = '2026-09-17';
    expect(verifyQuestionPress({ data: past, bias: BIAS, moments: MOMENTS, now: NOW }).failures.join(' ')).toMatch(/outside the 7-day window ending 2026-09-25/);
    const after = structuredClone(base);
    after._meta.as_of = '2026-09-24'; // the link (seen 09-25) postdates the file
    expect(verifyQuestionPress({ data: after, bias: BIAS, moments: MOMENTS, now: NOW }).failures.join(' ')).toMatch(/after the day the file was written/);
    const noDay = structuredClone(base) as unknown as { _meta: Record<string, unknown> };
    delete noDay._meta.as_of;
    expect(verifyQuestionPress({ data: noDay, bias: BIAS, moments: MOMENTS, now: NOW }).failures.join(' ')).toMatch(/as_of undefined is not a YYYY-MM-DD day/);
    const stale = structuredClone(base);
    (stale.questions['iran-war-powers'] as Entry).checkedOn = '2026-09-10';
    expect(verifyQuestionPress({ data: stale, bias: BIAS, moments: MOMENTS, now: NOW }).failures.join(' ')).toMatch(/last checked 2026-09-10, outside the 7-day window/);
    const unstated = structuredClone(base);
    (unstated._meta as Record<string, unknown>).matches = '';
    expect(verifyQuestionPress({ data: unstated, bias: BIAS, moments: MOMENTS, now: NOW }).failures.join(' ')).toMatch(/_meta.matches/);
    expect(base._meta.matches).toBe(MATCH_RULE);
    expect(MATCH_RULE).toMatch(/anywhere in its text/);
  });

  test('the window is the lamp\'s: 0 to 7 whole days old, inclusive — the same edge in the writer, the admission rule and the gate', () => {
    expect(inWindow('2026-09-18', TODAY)).toBe(true); // 7 days
    expect(inWindow('2026-09-17', TODAY)).toBe(false); // 8 days
    expect(inWindow('2026-09-26', TODAY)).toBe(false); // after the day
    const { admitted } = admitArticles([art('foxnews.com', 'edge', '20260918T010000Z'), art('foxnews.com', 'over', '20260917T235900Z')], { lean: 'right', bias: BIAS, today: TODAY });
    expect(admitted.map((a) => a.url)).toEqual(['https://www.foxnews.com/edge']);
    // The lamp keeps the same edge (lib/conversation.mjs pruneList: age <= 7).
    const conversation = { _meta: { window_days: 7 }, slugs: { 'hconres-89-119': { outlets7d: [{ domain: 'foxnews.com', lean: 'right', lastSeen: '2026-09-18' }, { domain: 'nypost.com', lean: 'right', lastSeen: '2026-09-17' }] } } };
    expect(lampLeanCounts(conversation, ['hconres-89-119'], TODAY).right).toEqual(['foxnews.com']);
  });

  test('a carried entry whose last check fell out of the window leaves the file: "not checked", never "no coverage"', () => {
    const prev = buildQuestionPress({
      previous: null,
      liveIds: ['iran-war-powers'],
      results: new Map([['iran-war-powers', { terms: ['war powers'], admitted: [] }]]),
      bias: BIAS,
      today: '2026-09-17',
    });
    expect((prev.questions['iran-war-powers'] as Entry).counts).toEqual(countsFor([]));
    const within = buildQuestionPress({ previous: prev, liveIds: ['iran-war-powers'], results: new Map(), bias: BIAS, today: '2026-09-24' });
    expect(within.questions['iran-war-powers']).toBeDefined(); // 7 days: kept, and the gate warns it is late
    const beyond = buildQuestionPress({ previous: prev, liveIds: ['iran-war-powers'], results: new Map(), bias: BIAS, today: TODAY });
    expect(beyond.questions['iran-war-powers']).toBeUndefined(); // 8 days: gone
  });

  test('a question no longer live is a warning; one never heard of is a failure; a stale check is a warning', () => {
    const d = good();
    const warned = verifyQuestionPress({ data: d, bias: BIAS, moments: { 'iran-war-powers': { status: 'retired' } }, now: NOW });
    expect(warned.failures).toEqual([]);
    expect(warned.warnings.join(' ')).toMatch(/no longer live/);
    expect(verifyQuestionPress({ data: d, bias: BIAS, moments: {}, now: NOW }).failures.join(' ')).toMatch(/no such question/);
    const later = verifyQuestionPress({ data: d, bias: BIAS, moments: MOMENTS, now: NOW + 3 * 86_400_000 });
    expect(later.warnings.join(' ')).toMatch(/has not succeeded for 3 days/);
  });
});

// ---------------------------------------------------------------------------
test.describe('the collector (mocked GDELT)', () => {
  const byLeanReply = (url: string) => {
    const lean = leanOfRequest(url);
    const articles =
      lean === 'left'
        ? [art('cnn.com', 'l1'), art('politico.com', 'l2', '20260923T120000Z', 'Operation Epic Fury vote')]
        : lean === 'center'
          ? [art('npr.org', 'c1')]
          : [art('foxnews.com', 'r1'), art('example-blog.test', 'r-unrated')];
    return { status: 200, body: JSON.stringify({ articles }) };
  };

  test('happy path: three lean searches per searchable question, spaced, honest User-Agent, rated evidence only', async () => {
    const net = fakeNet((url) => byLeanReply(url));
    const lines: string[] = [];
    const { doc, write, stats } = await collect({
      moments: MOMENTS,
      bills: BILLS,
      bias: BIAS,
      now: NOW,
      fetchImpl: net.fetchImpl,
      sleep: net.sleep,
      clock: net.clock,
      log: (l) => lines.push(l),
    });
    // Iran and college are searchable, Syria is not, the retired one is not live.
    expect(net.calls).toHaveLength(6);
    expect(net.calls.every((c) => c.ua === USER_AGENT)).toBe(true);
    expect(USER_AGENT).not.toMatch(/mozilla|chrome|safari/i);
    expect(net.sleeps.every((ms) => ms >= LIMITS.spacingMs - 1)).toBe(true);
    expect(net.sleeps).toHaveLength(5);
    expect(write).toBe(true);
    expect(stats.done.sort()).toEqual(['iran-war-powers', 'paying-college-athletes']);
    expect(stats.skipped).toEqual(['syria-sanctions-repeal']);
    expect(Object.keys(doc.questions).sort()).toEqual(['iran-war-powers', 'paying-college-athletes']);
    expect(doc.questions['iran-war-powers'].counts.outlets).toEqual({ left: 2, center: 1, right: 1 });
    expect(JSON.stringify(doc)).not.toContain('example-blog.test');
    expect(JSON.stringify(doc)).not.toContain('Operation Epic Fury vote'); // titles never stored
    expect(verifyQuestionPress({ data: doc, bias: BIAS, moments: MOMENTS, now: NOW }).failures).toEqual([]);
    // the lean-parity log
    expect(lines.some((l) => /iran-war-powers .*rated outlets L2\/2 \(100%\) C1\/2 \(50%\) R1\/2 \(50%\)/.test(l))).toBe(true);
    expect(lines.some((l) => /term "operation epic fury" in titles L1\/C0\/R0/.test(l))).toBe(true);
    expect(lines.some((l) => /syria-sanctions-repeal has no multi-word press vocabulary/.test(l))).toBe(true);
  });

  test('all three leans or nothing: one lean failing leaves the question exactly as it was', async () => {
    const prev = buildQuestionPress({
      previous: null,
      liveIds: ['iran-war-powers'],
      results: new Map([['iran-war-powers', { terms: ['war powers'], admitted: [{ url: 'https://www.cnn.com/old', domain: 'cnn.com', lean: 'left', seen: '2026-09-23' }] }]]),
      bias: BIAS,
      today: '2026-09-23',
    });
    const isIran = (url: string) => new URL(url).searchParams.get('query')!.includes('war powers');
    const net = fakeNet((url) => (isIran(url) && leanOfRequest(url) === 'right' ? { status: 503, body: '' } : byLeanReply(url)));
    const { doc, stats } = await collect({ moments: MOMENTS, bills: BILLS, bias: BIAS, previous: prev, now: NOW, fetchImpl: net.fetchImpl, sleep: net.sleep, clock: net.clock, log: quiet });
    expect(stats.failed).toContain('iran-war-powers');
    const iran = doc.questions['iran-war-powers'] as Entry;
    expect(iran.checkedOn).toBe('2026-09-23');
    expect(iran.outlets.map((o) => o.domain)).toEqual(['cnn.com']); // the left/center results were NOT recorded alone
    expect(stats.done).toEqual(['paying-college-athletes']);
  });

  test('a GDELT plain-text query error fails that question, not the run', async () => {
    const net = fakeNet((url) =>
      new URL(url).searchParams.get('query')!.includes('protect college sports act') ? { status: 200, body: 'The specified phrase is too short.' } : byLeanReply(url)
    );
    const { stats } = await collect({ moments: MOMENTS, bills: BILLS, bias: BIAS, now: NOW, fetchImpl: net.fetchImpl, sleep: net.sleep, clock: net.clock, log: quiet });
    expect(stats.failed).toEqual(['paying-college-athletes']);
    expect(stats.done).toEqual(['iran-war-powers']);
    // the college question stopped after its first failed lean — no wasted requests
    expect(net.calls.filter((c) => c.url.includes('protect+college') || c.url.includes('protect%20college'))).toHaveLength(1);
  });

  test('429: two backoffs, then the circuit opens and NOTHING else is requested this run', async () => {
    const net = fakeNet(() => ({ status: 429, body: 'Please limit requests to one every 5 seconds' }));
    const lines: string[] = [];
    const { doc, write, stats } = await collect({ moments: MOMENTS, bills: BILLS, bias: BIAS, now: NOW, fetchImpl: net.fetchImpl, sleep: net.sleep, clock: net.clock, log: (l) => lines.push(l) });
    expect(net.calls).toHaveLength(1 + LIMITS.backoffMs.length);
    expect(net.sleeps.filter((ms) => LIMITS.backoffMs.includes(ms))).toEqual(LIMITS.backoffMs);
    expect(stats.circuitOpen).toBe(true);
    expect(stats.done).toEqual([]);
    expect(doc.questions).toEqual({});
    expect(write).toBe(false); // no file yet and no evidence: no empty first commit
    expect(lines.some((l) => /circuit open/.test(l))).toBe(true);
  });

  test('a 429 that clears on retry carries on normally', async () => {
    const net = fakeNet((url, n) => (n === 1 ? { status: 429, body: '' } : byLeanReply(url)));
    const { stats } = await collect({ moments: MOMENTS, bills: BILLS, bias: BIAS, now: NOW, fetchImpl: net.fetchImpl, sleep: net.sleep, clock: net.clock, log: quiet });
    expect(stats.done.sort()).toEqual(['iran-war-powers', 'paying-college-athletes']);
    expect(net.calls).toHaveLength(7);
  });

  test('the request cap and the run-time cap both stop a run', async () => {
    const net = fakeNet((url) => byLeanReply(url));
    const capped = await collect({ moments: MOMENTS, bills: BILLS, bias: BIAS, now: NOW, fetchImpl: net.fetchImpl, sleep: net.sleep, clock: net.clock, limits: { ...LIMITS, maxRequests: 4 }, log: quiet });
    // Iran spends 3; college needs 3 more and only 1 is left, so it is never
    // started — no half-searched question that spends requests and records nothing.
    expect(net.calls).toHaveLength(3);
    expect(capped.stats.budgetStop).toMatch(/request cap/);
    expect(capped.stats.done).toHaveLength(1);
    const net2 = fakeNet((url) => byLeanReply(url));
    const timed = await collect({ moments: MOMENTS, bills: BILLS, bias: BIAS, now: NOW, fetchImpl: net2.fetchImpl, sleep: net2.sleep, clock: net2.clock, limits: { ...LIMITS, maxRunMs: LIMITS.spacingMs * 2 }, log: quiet });
    expect(timed.stats.budgetStop).toMatch(/run-time cap/);
    expect(net2.calls.length).toBeLessThan(6);
  });

  test('once per question per UTC day: a second run the same day makes no request and writes nothing', async () => {
    const first = fakeNet((url) => byLeanReply(url));
    const a = await collect({ moments: MOMENTS, bills: BILLS, bias: BIAS, now: NOW, fetchImpl: first.fetchImpl, sleep: first.sleep, clock: first.clock, log: quiet });
    const second = fakeNet((url) => byLeanReply(url));
    const b = await collect({ moments: MOMENTS, bills: BILLS, bias: BIAS, previous: a.doc, now: NOW + 3_600_000, fetchImpl: second.fetchImpl, sleep: second.sleep, clock: second.clock, log: quiet });
    expect(second.calls).toHaveLength(0);
    expect(b.write).toBe(false);
    // the next UTC day searches again, from the last check (2 days back), oldest check first
    const third = fakeNet((url) => byLeanReply(url));
    await collect({ moments: MOMENTS, bills: BILLS, bias: BIAS, previous: a.doc, now: NOW + 86_400_000, fetchImpl: third.fetchImpl, sleep: third.sleep, clock: third.clock, log: quiet });
    expect(third.calls).toHaveLength(6);
    expect(third.calls.every((c) => new URL(c.url).searchParams.get('timespan') === '2d')).toBe(true);
  });

  test('a question that lost its search terms loses its entry — no record of a search nobody can re-run', async () => {
    const prev = buildQuestionPress({
      previous: null,
      liveIds: ['syria-sanctions-repeal'],
      results: new Map([['syria-sanctions-repeal', { terms: ['syria sanctions'], admitted: [{ url: 'https://www.npr.org/s', domain: 'npr.org', lean: 'center', seen: TODAY }] }]]),
      bias: BIAS,
      today: TODAY,
    });
    const net = fakeNet((url) => byLeanReply(url));
    const { doc } = await collect({ moments: MOMENTS, bills: BILLS, bias: BIAS, previous: prev, now: NOW, fetchImpl: net.fetchImpl, sleep: net.sleep, clock: net.clock, log: quiet });
    expect(doc.questions['syria-sanctions-repeal']).toBeUndefined();
  });

  test('network errors are a failed question, never a crash — and two in a row open the circuit', async () => {
    const net = fakeNet(() => new Error('ECONNRESET'));
    const lines: string[] = [];
    const { stats } = await collect({ moments: MOMENTS, bills: BILLS, bias: BIAS, now: NOW, fetchImpl: net.fetchImpl, sleep: net.sleep, clock: net.clock, log: (l) => lines.push(l) });
    expect(stats.done).toEqual([]);
    expect(stats.failed.sort()).toEqual(['iran-war-powers', 'paying-college-athletes']);
    expect(SILENT_CIRCUIT).toBe(2);
    expect(net.calls).toHaveLength(SILENT_CIRCUIT);
    expect(stats.circuitOpen).toBe(true);
    expect(lines.some((l) => /got no answer from GDELT .*circuit open/.test(l))).toBe(true);
  });

  test('a hang is a silent request too: timeouts open the circuit instead of adding 45 s per question per hour', async () => {
    const net = fakeNet(() => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    const { stats } = await collect({ moments: MOMENTS, bills: BILLS, bias: BIAS, now: NOW, fetchImpl: net.fetchImpl, sleep: net.sleep, clock: net.clock, log: quiet });
    expect(net.calls).toHaveLength(SILENT_CIRCUIT);
    expect(stats.circuitWhy).toBe('no answer');
  });

  test('one silent request between answers does not open the circuit', async () => {
    const net = fakeNet((url, n) => (n === 1 ? new Error('ECONNRESET') : byLeanReply(url)));
    const { stats } = await collect({ moments: MOMENTS, bills: BILLS, bias: BIAS, now: NOW, fetchImpl: net.fetchImpl, sleep: net.sleep, clock: net.clock, log: quiet });
    expect(stats.circuitOpen).toBe(false);
    expect(stats.failed).toEqual(['iran-war-powers']);
    expect(stats.done).toEqual(['paying-college-athletes']);
  });

  test('GDELT returning articles that are all refused is a ::warning::, never a silent "0 outlets"', async () => {
    // A response whose field names changed (`link` for `url`): every article
    // is refused, and the run must say so instead of recording an absence.
    const net = fakeNet((url) => {
      const lean = leanOfRequest(url);
      const d = lean === 'left' ? 'cnn.com' : lean === 'center' ? 'npr.org' : 'foxnews.com';
      const { url: link, ...rest } = art(d, 'x');
      return { status: 200, body: JSON.stringify({ articles: [{ ...rest, link }] }) };
    });
    const lines: string[] = [];
    const { stats } = await collect({ moments: MOMENTS, bills: BILLS, bias: BIAS, now: NOW, fetchImpl: net.fetchImpl, sleep: net.sleep, clock: net.clock, log: (l) => lines.push(l) });
    expect(stats.done.length).toBe(2);
    expect(lines.filter((l) => /^::warning::.*returned 1 article\(s\) and none was admitted/.test(l))).toHaveLength(6);
    expect(lines.some((l) => /^::warning::.*not one article was admitted/.test(l))).toBe(true);
  });

  test('a quiet week (GDELT returns nothing) is not a warning', async () => {
    const net = fakeNet(() => ({ status: 200, body: '{}' }));
    const lines: string[] = [];
    await collect({ moments: MOMENTS, bills: BILLS, bias: BIAS, now: NOW, fetchImpl: net.fetchImpl, sleep: net.sleep, clock: net.clock, log: (l) => lines.push(l) });
    expect(lines.some((l) => /none was admitted/.test(l))).toBe(false);
  });

  test('an unsearchable question warns once a day, not every hourly run', async () => {
    const first = fakeNet((url) => byLeanReply(url));
    const linesA: string[] = [];
    const a = await collect({ moments: MOMENTS, bills: BILLS, bias: BIAS, now: NOW, fetchImpl: first.fetchImpl, sleep: first.sleep, clock: first.clock, log: (l) => linesA.push(l) });
    expect(linesA.some((l) => /^::warning::.*syria-sanctions-repeal has no multi-word press vocabulary/.test(l))).toBe(true);
    const linesB: string[] = [];
    const second = fakeNet((url) => byLeanReply(url));
    await collect({ moments: MOMENTS, bills: BILLS, bias: BIAS, previous: a.doc, now: NOW + 3_600_000, fetchImpl: second.fetchImpl, sleep: second.sleep, clock: second.clock, log: (l) => linesB.push(l) });
    expect(linesB.some((l) => /syria-sanctions-repeal has no multi-word press vocabulary/.test(l))).toBe(true);
    expect(linesB.some((l) => /^::warning::.*syria-sanctions-repeal/.test(l))).toBe(false);
  });

  test("GDELT's query-length limit: each lean is split into searches that fit, and every rated domain is searched exactly once", async () => {
    const real = JSON.parse(readFileSync(join(ROOT, 'data/media-bias.json'), 'utf8')).outlets as Record<string, string>;
    const byLean = eligibleDomainsByLean(real);
    const net = fakeNet((url) => {
      const q = new URL(url).searchParams.get('query')!;
      const domains = [...q.matchAll(/domainis:([a-z0-9.-]+)/g)].map((m) => m[1]);
      // one article per searched domain, so every search shows up in the evidence
      return { status: 200, body: JSON.stringify({ articles: domains.map((d) => art(d, `p-${d}`)) }) };
    });
    const { doc, stats } = await collect({ moments: MOMENTS, bills: BILLS, bias: real, now: NOW, fetchImpl: net.fetchImpl, sleep: net.sleep, clock: net.clock, log: quiet });
    expect(stats.done.sort()).toEqual(['iran-war-powers', 'paying-college-athletes']);
    expect(net.calls.length).toBeGreaterThan(6); // more than one search per lean at the real table's size
    for (const c of net.calls) expect(new URL(c.url).searchParams.get('query')!.length).toBeLessThanOrEqual(GDELT_MAX_QUERY_CHARS);
    for (const id of stats.done) {
      const marker = id === 'iran-war-powers' ? '"war powers"' : '"protect college sports act"';
      const searched = net.calls
        .map((c) => new URL(c.url).searchParams.get('query')!)
        .filter((q) => q.includes(marker))
        .flatMap((q) => [...q.matchAll(/domainis:([a-z0-9.-]+)/g)].map((m) => m[1]));
      expect(searched.sort()).toEqual([...byLean.left, ...byLean.center, ...byLean.right].sort()); // each once, none missing
      const counts = (doc.questions[id] as Entry).counts as { outlets: Record<string, number> };
      expect(counts.outlets).toEqual({ left: byLean.left.length, center: byLean.center.length, right: byLean.right.length });
    }
  });

  // GDELT's real answer to an over-long query, measured 2026-09-26 at 436–1,002 characters.
  const REFUSAL = 'Your query was too short or too long. ';

  test('GDELT refusing a query as too long halves the group, lowers the run\'s limit, and still searches every domain once', async () => {
    expect(TOO_LONG.test(REFUSAL)).toBe(true);
    const real = JSON.parse(readFileSync(join(ROOT, 'data/media-bias.json'), 'utf8')).outlets as Record<string, string>;
    const byLean = eligibleDomainsByLean(real);
    const CEILING = 300; // a GDELT stricter than the configured starting limit
    const net = fakeNet((url) => {
      const q = new URL(url).searchParams.get('query')!;
      if (q.length > CEILING) return { status: 200, body: REFUSAL };
      const domains = [...q.matchAll(/domainis:([a-z0-9.-]+)/g)].map((m) => m[1]);
      return { status: 200, body: JSON.stringify({ articles: domains.map((d) => art(d, `p-${d}`)) }) };
    });
    const lines: string[] = [];
    const { doc, stats } = await collect({
      moments: MOMENTS,
      bills: BILLS,
      bias: real,
      now: NOW,
      fetchImpl: net.fetchImpl,
      sleep: net.sleep,
      clock: net.clock,
      limits: { ...LIMITS, maxRequests: 200, maxRunMs: 1e9 },
      log: (l) => lines.push(l),
    });
    expect(stats.done.sort()).toEqual(['iran-war-powers', 'paying-college-athletes']);
    const answered = net.calls.map((c) => new URL(c.url).searchParams.get('query')!).filter((q) => q.length <= CEILING);
    for (const id of stats.done) {
      const marker = id === 'iran-war-powers' ? '"war powers"' : '"protect college sports act"';
      const searched = answered.filter((q) => q.includes(marker)).flatMap((q) => [...q.matchAll(/domainis:([a-z0-9.-]+)/g)].map((m) => m[1]));
      expect(searched.sort()).toEqual([...byLean.left, ...byLean.center, ...byLean.right].sort()); // none lost to a refusal, none twice
      const counts = (doc.questions[id] as Entry).counts as { outlets: Record<string, number> };
      expect(counts.outlets).toEqual({ left: byLean.left.length, center: byLean.center.length, right: byLean.right.length });
    }
    // The limit is learned once and kept: the refusals are few, not one per search.
    const refused = net.calls.length - answered.length;
    expect(refused).toBeGreaterThan(0);
    expect(refused).toBeLessThanOrEqual(3);
    expect(lines.some((l) => /^::warning::.*GDELT refused a \d+-character query as too long/.test(l))).toBe(true);
    expect(lines.some((l) => new RegExp(`query length — longest GDELT answered this run \\d+, shortest it refused as too long \\d+ \\(configured limit ${GDELT_MAX_QUERY_CHARS}`).test(l))).toBe(true);
    expect(GDELT_MAX_QUERY_CHARS).toBeLessThan(333); // below the shortest length GDELT was measured refusing
  });

  test('a question whose terms cannot fit beside one domain is not searched: no request, a once-a-day warning, no entry', async () => {
    const long = { status: 'live', aliases: { en: Array.from({ length: 10 }, (_, i) => `a rather long press phrase number ${i}`) }, vehicles: [] };
    const net = fakeNet((url) => byLeanReply(url));
    const lines: string[] = [];
    const { doc, stats } = await collect({ moments: { 'too-long': long }, bills: [], bias: BIAS, now: NOW, fetchImpl: net.fetchImpl, sleep: net.sleep, clock: net.clock, log: (l) => lines.push(l) });
    expect(net.calls).toHaveLength(0);
    expect(stats.skipped).toEqual(['too-long']);
    expect(doc.questions).toEqual({});
    expect(lines.some((l) => new RegExp(`^::warning::.*too-long: its search terms alone do not fit GDELT's ${GDELT_MAX_QUERY_CHARS}-character query limit`).test(l))).toBe(true);
  });

  test('a single domain GDELT still refuses fails the question with GDELT\'s own sentence — never a silent partial lean', async () => {
    const net = fakeNet(() => ({ status: 200, body: REFUSAL }));
    const lines: string[] = [];
    const { doc, stats } = await collect({ moments: MOMENTS, bills: BILLS, bias: BIAS, now: NOW, fetchImpl: net.fetchImpl, sleep: net.sleep, clock: net.clock, log: (l) => lines.push(l) });
    expect(stats.done).toEqual([]);
    expect(Object.keys(doc.questions)).toEqual([]);
    expect(lines.some((l) => /GDELT answered not JSON: Your query was too short or too long/.test(l))).toBe(true);
  });

  test('one failed search inside a lean leaves the whole question as it was', async () => {
    const real = JSON.parse(readFileSync(join(ROOT, 'data/media-bias.json'), 'utf8')).outlets as Record<string, string>;
    let n = 0;
    const net = fakeNet((url) => {
      const q = new URL(url).searchParams.get('query')!;
      if (q.includes('"war powers"') && ++n === 2) return { status: 503, body: '' }; // Iran's SECOND search — still the left lean
      return { status: 200, body: '{}' };
    });
    const { doc, stats } = await collect({ moments: MOMENTS, bills: BILLS, bias: real, now: NOW, fetchImpl: net.fetchImpl, sleep: net.sleep, clock: net.clock, log: quiet });
    expect(stats.failed).toContain('iran-war-powers');
    expect(doc.questions['iran-war-powers']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
test.describe('parity helpers', () => {
  test('lean parity divides by the domains each lean searched; the lamp comparison reads the vehicles only', () => {
    const entry = { outlets: [{ domain: 'cnn.com', lean: 'left', articles: [{}, {}] }, { domain: 'foxnews.com', lean: 'right', articles: [{}] }] };
    const p = leanParity(entry, { left: ['a', 'b', 'c', 'd'], center: ['e'], right: ['f', 'g'] });
    expect(p.left).toEqual({ outlets: 1, articles: 2, searched: 4, share: 0.25 });
    expect(p.right.share).toBe(0.5);
    expect(countsFor(entry.outlets)).toEqual({ outlets: { left: 1, center: 0, right: 1 }, articles: { left: 2, center: 0, right: 1 } });
    const conversation = {
      _meta: { window_days: 7 },
      slugs: {
        'hconres-89-119': { outlets7d: [{ domain: 'politico.com', lean: 'left', lastSeen: TODAY }, { domain: 'npr.org', lean: 'center', lastSeen: '2026-09-01' }] },
        'hr-1-119': { outlets7d: [{ domain: 'foxnews.com', lean: 'right', lastSeen: TODAY }] },
      },
    };
    expect(lampLeanCounts(conversation, ['hconres-89-119'], TODAY)).toEqual({ left: ['politico.com'], center: [], right: [] });
    expect(termTitleHits([{ lean: 'right', title: 'War Powers vote fails' }], ['war powers'])).toEqual({ 'war powers': { left: 0, center: 0, right: 1 } });
  });

  test('the precision reading: per lean, admitted articles whose TITLE names a term (the rest matched in the body)', () => {
    const share = titleTermShare(
      [
        { lean: 'left', title: 'Senate rejects War Powers resolution' },
        { lean: 'left', title: 'Oil prices climb as Strait of Hormuz tensions rise' },
        { lean: 'right', title: 'What the Iran war means for gas prices' },
        { lean: 'center', title: 'Markets close higher' },
      ],
      ['war powers', 'iran war']
    );
    expect(share).toEqual({ left: { admitted: 2, titled: 1 }, center: { admitted: 1, titled: 0 }, right: { admitted: 1, titled: 1 } });
  });

  test('domainChunks: every query fits the limit, every domain once, in order; terms too long for one domain → null', () => {
    const domains = Array.from({ length: 30 }, (_, i) => `outlet${String(i).padStart(2, '0')}.example.com`);
    const terms = ['war powers', 'operation epic fury'];
    const chunks = domainChunks({ terms, domains, maxChars: 400 })!;
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(domains);
    for (const c of chunks) expect(buildGdeltQuery({ terms, domains: c }).length).toBeLessThanOrEqual(400);
    expect(domainChunks({ terms, domains, maxChars: 100_000 })).toEqual([domains]);
    expect(domainChunks({ terms, domains: [], maxChars: 400 })).toEqual([]);
    expect(domainChunks({ terms: ['a very long alias '.repeat(40).trim()], domains, maxChars: 400 })).toBeNull();
  });

  test('every live question in data/moments.json either fits the query limit with every rated domain once, or is not searchable at all', () => {
    const real = JSON.parse(readFileSync(join(ROOT, 'data/media-bias.json'), 'utf8')).outlets as Record<string, string>;
    const moments = JSON.parse(readFileSync(join(ROOT, 'data/moments.json'), 'utf8')) as Record<string, Moment>;
    const bills = JSON.parse(readFileSync(join(ROOT, 'data/bills.json'), 'utf8')) as Array<{ full_identifier: string }>;
    const bySlug = new Map(bills.map((b) => [b.full_identifier, b]));
    const byLean = eligibleDomainsByLean(real);
    for (const [id, m] of Object.entries(moments)) {
      if (m.status !== 'live') continue;
      const { terms } = questionTerms(m, bySlug);
      if (!terms.length) continue;
      // Never a partial split: either every lean fits, or none is searched
      // (the collector then skips the question with a warning — pinned below).
      const plans = (['left', 'center', 'right'] as const).map((lean) => [lean, domainChunks({ terms, domains: byLean[lean] })] as const);
      const fits = plans.map(([, c]) => c !== null);
      expect(new Set(fits).size, id).toBe(1);
      for (const [lean, chunks] of plans) {
        if (!chunks) continue;
        expect(chunks.flat().sort(), `${id} ${lean}`).toEqual([...byLean[lean]].sort());
        for (const c of chunks) expect(buildGdeltQuery({ terms, domains: c }).length, `${id} ${lean}`).toBeLessThanOrEqual(GDELT_MAX_QUERY_CHARS);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// THE BOUNDARIES. Evidence gathered because a question is live must never
// feed the report that decides which questions should be live, and nothing on
// the site reads it until the owner rules on question-level cards.
test.describe('boundaries', () => {
  const walk = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir).flatMap((name) => {
          const p = join(dir, name);
          return statSync(p).isDirectory() ? walk(p) : [p];
        })
      : [];

  test('scripts/moment-candidates.mjs never reads this evidence', () => {
    const src = readFileSync(join(ROOT, 'scripts/moment-candidates.mjs'), 'utf8');
    expect(src).not.toMatch(/question-press|gdelt/i);
  });

  test('no page, component, API route or lib/*.ts reads it — the homepage band is unchanged', () => {
    const readers = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components')), ...walk(join(ROOT, 'lib'))]
      .filter((p) => /\.(ts|tsx|mjs|js)$/.test(p))
      .filter((p) => /question-press/.test(readFileSync(p, 'utf8')))
      .map((p) => p.slice(ROOT.length + 1));
    expect(readers).toEqual(['lib/question-press.mjs']);
  });

  test('only the collector, the gates and this test touch it', () => {
    const touching = walk(join(ROOT, 'scripts'))
      .filter((p) => p.endsWith('.mjs') && readFileSync(p, 'utf8').includes('question-press'))
      .map((p) => p.slice(ROOT.length + 1))
      .sort();
    expect(touching).toEqual(['scripts/check-question-press.mjs', 'scripts/gdelt-intake.mjs', 'scripts/verify-sync.mjs']);
    expect(QUESTION_PRESS_PATH).toBe('data/question-press.json');
  });

  test('wired: newsdesk.yml runs it after the newsdesk and before the commit, never able to cost the hour; CI and the nightly gate it', () => {
    const newsdesk = readFileSync(join(ROOT, '.github/workflows/newsdesk.yml'), 'utf8');
    const at = newsdesk.indexOf('run: node scripts/gdelt-intake.mjs');
    expect(at).toBeGreaterThan(newsdesk.indexOf('run: node scripts/newsdesk.mjs'));
    expect(at).toBeLessThan(newsdesk.indexOf('- name: Commit data'));
    const stepStart = newsdesk.lastIndexOf('- name:', at);
    const step = newsdesk.slice(stepStart, at);
    expect(step).toContain('continue-on-error: true');
    expect(step).toMatch(/timeout-minutes: \d+/);
    expect(step).not.toMatch(/secrets\./); // needs no key
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('node scripts/check-question-press.mjs --self-test');
    expect(ci).toContain('node scripts/check-question-press.mjs\n');
    expect(readFileSync(join(ROOT, 'scripts/verify-sync.mjs'), 'utf8')).toContain('verifyQuestionPress(');
  });
});
