import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Pure module (no network, no disk) — see lib/question-press.mjs's header for
// the design every test below pins, and scripts/gdelt-intake.mjs's header for
// the budget and circuit rules the collector tests pin. ZERO network here:
// every GDELT response is a literal handed to an injected fetch, every wait is
// an injected sleep that records instead of waiting, and every timeout is an
// injected timer on a fake clock.
import {
  GDELT_ATTRIBUTION,
  GDELT_HOME,
  GDELT_LENGTH_EVIDENCE,
  GDELT_MAX_QUERY_CHARS,
  GDELT_MAX_RECORDS,
  LEGISLATIVE_CONTEXT_TERMS,
  MATCH_RULE,
  MAX_ARTICLES_PER_OUTLET,
  MAX_TERMS_PER_QUESTION,
  OUTLET_POLICY,
  QUERY_SHAPE,
  QUESTION_PRESS_PATH,
  QUESTION_PRESS_SCHEMA,
  QUESTION_PRESS_WINDOW_DAYS,
  admitArticles,
  buildGdeltQuery,
  buildQuestionPress,
  countsFor,
  eligibleDomainsByLean,
  gdeltDateTime,
  gdeltUrl,
  inWindow,
  lampLeanCounts,
  leanParity,
  parseArtList,
  questionTerms,
  ratedDomainFor,
  seenDay,
  seenStamp,
  shouldWrite,
  termTitleHits,
  titleTermShare,
  verifyQuestionPress,
  windowStartDay,
} from '../lib/question-press.mjs';
import { REFUSAL_CIRCUIT, SILENT_CIRCUIT, USER_AGENT, collect, limitsFrom, readCircuit } from '../scripts/gdelt-intake.mjs';
// The one definition of a checkable article link (B-5), shared with the lamp.
import { normalizeArticleUrl } from '../lib/conversation.mjs';

const ROOT = process.cwd();
const NOW = Date.parse('2026-09-25T02:43:00Z');
const TODAY = '2026-09-25';

// A small rated table with every lean present, in data/media-bias.json's shape.
const BIAS: Record<string, string> = {
  'cnn.com': 'left',
  'politico.com': 'left',
  'abcnews.go.com': 'left',
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
type Entry = { checkedOn: string; terms: string[]; counts: { outlets: Record<string, number>; articles: Record<string, number> }; outlets: Outlet[] };
type Doc = ReturnType<typeof buildQuestionPress>;
type Moment = { status: string; aliases: { en: string[]; es?: string[] }; vehicles: Array<{ slug: string }> };
type Circuit = { open: true; reason: string; openedAt: string; lastTryAt: string; tries: number };

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
// Iran searches two terms, college one; Syria has none; the retired one is not live.
const TERMS_PER_RUN = 3;

/** One GDELT ArtList article, in the shape the DOC 2.0 API returned live
 *  (these eight keys, in this order; seendate as YYYYMMDDTHHMMSSZ; domain
 *  bare, url on www.). */
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

const queryOf = (url: string) => new URL(url).searchParams.get('query') ?? '';
const termOf = (url: string) => /^"([^"]+)"/.exec(queryOf(url))?.[1] ?? '';

/** GDELT answering every term with a mix of rated and unrated outlets. */
const mixedReply = (url: string) => {
  const term = termOf(url).replace(/ /g, '-');
  const articles = [
    art('cnn.com', `l-${term}`),
    art('npr.org', `c-${term}`, '20260923T120000Z', 'Operation Epic Fury vote'),
    art('foxnews.com', `r-${term}`),
    art('example-blog.test', `u-${term}`),
    art('dailymail.co.uk', `u2-${term}`),
  ];
  return { status: 200, body: JSON.stringify({ articles }) };
};

type Reply =
  | { status: number; body: string; takesMs?: number }
  | { status: number; hangBody: true }
  | 'hang'
  | Error;

/** A scripted GDELT on a fake clock. `script(url, n)` returns the reply for
 *  the n-th request. `timer` fires on a macrotask, so any answer that arrives
 *  (a microtask) always wins the race against it, exactly as a real answer
 *  that beats its timeout would. */
function fakeNet(script: (url: string, n: number) => Reply) {
  const calls: Array<{ url: string; ua: string; at: number }> = [];
  const sleeps: number[] = [];
  let t = NOW;
  const fetchImpl = async (url: string, init: { headers?: Record<string, string> }) => {
    calls.push({ url, ua: init?.headers?.['User-Agent'] ?? '', at: t });
    const r = script(url, calls.length);
    if (r === 'hang') return new Promise<never>(() => {});
    if (r instanceof Error) throw r;
    if ('hangBody' in r) return { status: r.status, ok: r.status >= 200 && r.status < 300, text: () => new Promise<string>(() => {}) };
    if (r.takesMs) t += r.takesMs;
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => r.body };
  };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    t += ms;
  };
  const timer = (ms: number) => {
    let cancelled = false;
    const promise = new Promise<void>((resolve) =>
      setImmediate(() => {
        if (!cancelled) t += ms;
        resolve();
      })
    );
    return { promise, cancel: () => (cancelled = true) };
  };
  const clock = () => t;
  return { fetchImpl, sleep, timer, clock, calls, sleeps, elapsed: () => t - NOW };
}

const LIMITS = limitsFrom({}); // the production defaults, exactly
const quiet = () => {};

const run = (net: ReturnType<typeof fakeNet>, over: Record<string, unknown> = {}) =>
  collect({
    moments: MOMENTS,
    bills: BILLS,
    bias: BIAS,
    now: NOW,
    fetchImpl: net.fetchImpl,
    sleep: net.sleep,
    timer: net.timer,
    clock: net.clock,
    log: quiet,
    ...over,
  } as Parameters<typeof collect>[0]);

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
    expect(questionTerms(spanishOnly, billsBySlug).terms).toEqual([]);
  });

  test('a year suffix comes off a bill name, the term cap holds, and a phrase too long for the query cap is never sent', () => {
    const many = { aliases: { en: Array.from({ length: 20 }, (_, i) => `phrase number ${i}`) }, vehicles: [] };
    const { terms, dropped } = questionTerms(many, new Map());
    expect(terms).toHaveLength(MAX_TERMS_PER_QUESTION);
    expect(dropped.filter((d) => /cap/.test(d.reason))).toHaveLength(20 - MAX_TERMS_PER_QUESTION);
    const named = questionTerms(
      { aliases: { en: [] }, vehicles: [{ slug: 'x' }] },
      new Map([['x', { press_names: ['Protect College Sports Act of 2026'] }]])
    );
    expect(named.terms).toEqual(['protect college sports act']);
    const long = questionTerms({ aliases: { en: ['a phrase that is far too long to fit inside the measured query length cap of this pipeline'] }, vehicles: [] }, new Map());
    expect(long.terms).toEqual([]);
    expect(long.dropped[0].reason).toMatch(new RegExp(`over the ${GDELT_MAX_QUERY_CHARS}-character limit`));
  });
});

// ---------------------------------------------------------------------------
test.describe('the request: short, and the same for every lean', () => {
  test('one query = ONE quoted phrase AND a small congressional OR group — no domain, no lean, no nesting', () => {
    const q = buildGdeltQuery('war powers');
    expect(q).toBe('"war powers" (congress OR senate OR representatives OR lawmakers)');
    expect(q).toBe(QUERY_SHAPE.replace('<term>', 'war powers'));
    expect(q).not.toMatch(/domain/i);
    expect(q).not.toMatch(/\([^)]*\(/); // GDELT does not nest OR groups
    expect(LEGISLATIVE_CONTEXT_TERMS.length).toBeLessThanOrEqual(4);
    // symmetric: no party nouns, both chambers
    expect(LEGISLATIVE_CONTEXT_TERMS.join(' ')).not.toMatch(/gop|republican|democrat|dems/i);
    expect(LEGISLATIVE_CONTEXT_TERMS).toEqual(expect.arrayContaining(['senate', 'representatives']));
    // quotes and parentheses cannot break out of the phrase
    expect(buildGdeltQuery('war "powers) x').startsWith('"war powers x" (')).toBe(true);
    expect(() => buildGdeltQuery('')).toThrow();
  });

  test('the cap is the longest length GDELT was MEASURED answering, far under the shortest it refused', () => {
    const answered = GDELT_LENGTH_EVIDENCE.answered.map((a: { chars: number }) => a.chars);
    const refused = GDELT_LENGTH_EVIDENCE.refused.map((r: { chars: number }) => r.chars);
    expect(answered.length).toBeGreaterThan(0);
    expect(GDELT_MAX_QUERY_CHARS).toBeLessThanOrEqual(Math.max(...answered));
    expect(GDELT_MAX_QUERY_CHARS * 3).toBeLessThan(Math.min(...refused));
  });

  test('every live question in data/moments.json searches only queries within the measured cap', () => {
    const moments = JSON.parse(readFileSync(join(ROOT, 'data/moments.json'), 'utf8')) as Record<string, Moment>;
    const bills = JSON.parse(readFileSync(join(ROOT, 'data/bills.json'), 'utf8')) as Array<{ full_identifier: string }>;
    const bySlug = new Map(bills.map((b) => [b.full_identifier, b]));
    for (const [id, m] of Object.entries(moments)) {
      if (m.status !== 'live') continue;
      for (const t of questionTerms(m, bySlug).terms) {
        const q = buildGdeltQuery(t);
        expect(q.length, `${id}: ${q}`).toBeLessThanOrEqual(GDELT_MAX_QUERY_CHARS);
        expect(t.split(' ').length, `${id}: ${t}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  test('ArtList + JSON + newest first over an exact window, never a tone mode', () => {
    const u = new URL(gdeltUrl({ query: 'x', startDay: '2026-09-18', end: Date.parse('2026-09-25T02:43:07Z') }));
    expect(u.origin + u.pathname).toBe('https://api.gdeltproject.org/api/v2/doc/doc');
    expect(u.searchParams.get('mode')).toBe('ArtList');
    expect(u.searchParams.get('format')).toBe('json');
    expect(u.searchParams.get('sort')).toBe('DateDesc');
    expect(u.searchParams.get('maxrecords')).toBe(String(GDELT_MAX_RECORDS));
    expect(u.searchParams.get('startdatetime')).toBe('20260918000000');
    expect(u.searchParams.get('enddatetime')).toBe('20260925024307');
    expect(u.searchParams.get('timespan')).toBeNull();
    expect(u.toString().toLowerCase()).not.toContain('tone');
    expect(new URL(gdeltUrl({ query: 'x', startDay: '2026-09-18', end: '20260920101500' })).searchParams.get('enddatetime')).toBe('20260920101500');
    expect(gdeltDateTime(Date.parse('2026-01-02T03:04:05Z'))).toBe('20260102030405');
  });

  test('the window starts on the last day checked, never before the 7-day window', () => {
    expect(windowStartDay(null, TODAY)).toBe('2026-09-18');
    expect(windowStartDay('2026-09-24', TODAY)).toBe('2026-09-24');
    expect(windowStartDay('2026-09-18', TODAY)).toBe('2026-09-18');
    expect(windowStartDay('2026-09-01', TODAY)).toBe('2026-09-18');
    expect(windowStartDay('2026-09-30', TODAY)).toBe('2026-09-18'); // a future stamp is not trusted
  });
});

// ---------------------------------------------------------------------------
test.describe('the response', () => {
  test('parseArtList names the kind of answer: ok, refused, empty, malformed', () => {
    const r = parseArtList(JSON.stringify({ articles: [{ ...art('foxnews.com', 'a'), tone: -4.2 }] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.articles[0]).sort()).toEqual(['domain', 'seendate', 'title', 'url']);
    expect(parseArtList('{}')).toEqual({ ok: true, articles: [] }); // GDELT's "no matches"
    expect(parseArtList('Your query was too short or too long. ')).toMatchObject({ ok: false, kind: 'refused' });
    expect(parseArtList('The specified phrase is too short.')).toMatchObject({ ok: false, kind: 'refused' });
    expect(parseArtList('')).toMatchObject({ ok: false, kind: 'empty' });
    expect(parseArtList('   \n')).toMatchObject({ ok: false, kind: 'empty' });
    expect(parseArtList('<html><body>502 Bad Gateway</body></html>')).toMatchObject({ ok: false, kind: 'malformed' });
    expect(parseArtList('{"articles": [{"url": "https://www.npr.org/x"')).toMatchObject({ ok: false, kind: 'malformed' }); // truncated
    expect(parseArtList(JSON.stringify({ articles: 'nope' }))).toMatchObject({ ok: false, kind: 'malformed' });
    expect(parseArtList('[1,2]')).toMatchObject({ ok: false, kind: 'malformed' });
    // a raw control character inside a title is rescued, not a lost question
    const raw = JSON.stringify({ articles: [art('npr.org', 'x', '20260924T211500Z', 'TITLE')] }).replace('TITLE', 'a\u0007b\tc');
    const rescued = parseArtList(raw);
    expect(rescued.ok).toBe(true);
    if (rescued.ok) expect(rescued.articles[0].url).toBe('https://www.npr.org/x');
  });

  test('the local rated filter: GDELT’s domain or the link’s host, and the link must be on the rated domain', () => {
    expect(ratedDomainFor(art('foxnews.com', 'a'), BIAS)).toMatchObject({ domain: 'foxnews.com', lean: 'right' });
    expect(ratedDomainFor({ url: 'https://edition.cnn.com/2026/x', domain: 'edition.cnn.com' }, BIAS)).toMatchObject({ domain: 'cnn.com', lean: 'left' });
    expect(ratedDomainFor({ url: 'https://abcnews.go.com/Politics/x', domain: 'abcnews.go.com' }, BIAS)).toMatchObject({ domain: 'abcnews.go.com', lean: 'left' });
    expect(ratedDomainFor({ url: 'https://go.com/x', domain: 'go.com' }, BIAS)).toBeNull();
    expect(ratedDomainFor({ url: 'https://evil.example/foxnews.com/x', domain: 'foxnews.com' }, BIAS)).toBeNull(); // the link is not on the outlet
    expect(ratedDomainFor(art('example-blog.test', 'a'), BIAS)).toBeNull();
    expect(ratedDomainFor({ url: 'javascript:alert(1)', domain: 'foxnews.com' }, BIAS)).toBeNull();
  });

  test('admission: rated, on its own domain, inside the week — and the rejects are counted by kind', () => {
    const r = admitArticles(
      [
        art('foxnews.com', 'politics/ok?utm_source=x#frag'),
        art('example-blog.test', 'unrated'),
        { ...art('foxnews.com', 'x'), url: 'https://evil.example/foxnews.com/x' }, // link off the outlet's domain
        art('foxnews.com', 'old', '20260901T000000Z'),
        art('foxnews.com', 'future', '20261001T000000Z'),
        { ...art('foxnews.com', 'baddate'), seendate: 'yesterday' },
        { ...art('foxnews.com', 'nolink'), url: '' },
      ],
      { bias: BIAS, today: TODAY }
    );
    // the lamp's B-5 link gate: query and fragment are quoted evidence, kept as-is
    expect(r.admitted.map((a) => a.url)).toEqual(['https://www.foxnews.com/politics/ok?utm_source=x#frag']);
    expect(r.admitted[0]).toMatchObject({ domain: 'foxnews.com', lean: 'right', seen: '2026-09-24' });
    expect({ unrated: r.unrated, outOfWindow: r.outOfWindow, unreadable: r.unreadable }).toEqual({ unrated: 2, outOfWindow: 2, unreadable: 2 });
    expect(seenDay('20260924T211500Z')).toBe('2026-09-24');
    expect(seenStamp('20260924T211500Z')).toBe('20260924211500');
    expect(normalizeArticleUrl('ftp://x.com/a')).toBeNull();
  });

  test('every rated domain is eligible, grouped by lean — the parity denominators', () => {
    expect(eligibleDomainsByLean({ ...BIAS, 'blog.example': 'nonsense' })).toEqual({
      left: ['abcnews.go.com', 'cnn.com', 'politico.com'],
      center: ['npr.org', 'thehill.com'],
      right: ['foxnews.com', 'nypost.com'],
    });
    const real = JSON.parse(readFileSync(join(ROOT, 'data/media-bias.json'), 'utf8')).outlets;
    const byLean = eligibleDomainsByLean(real);
    expect(byLean.left.length + byLean.center.length + byLean.right.length).toBe(Object.keys(real).length);
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

  test('links dedupe, newest first, capped per outlet; dates and counts come from the links; the query shape travels', () => {
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
    expect(doc._meta).toMatchObject({ schema: QUESTION_PRESS_SCHEMA, outlet_policy: OUTLET_POLICY, window_days: QUESTION_PRESS_WINDOW_DAYS, query_shape: QUERY_SHAPE });
    expect(doc._meta.source).not.toMatch(/per AllSides lean|split/);
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

  test('WRITES: at most once a day, unless the counts actually change', () => {
    const doc = (today: string, admittedList: ReturnType<typeof admitted>[], checked = true, previous: Doc | null = null) =>
      buildQuestionPress({
        previous,
        liveIds: ['iran-war-powers'],
        results: checked ? new Map([['iran-war-powers', { terms: ['war powers'], admitted: admittedList }]]) : new Map(),
        bias: BIAS,
        today,
      });
    const a = [admitted('cnn.com', 'left', 'a', '2026-09-24')];
    // no file yet: write only when there is something to record
    expect(shouldWrite({ previous: null, next: doc(TODAY, a) })).toBe(true);
    expect(shouldWrite({ previous: null, next: buildQuestionPress({ previous: null, liveIds: [], results: new Map(), bias: BIAS, today: TODAY }) })).toBe(false);
    const d1 = doc(TODAY, a);
    // same day, same counts (even a re-found link on another day): no write
    expect(shouldWrite({ previous: d1, next: doc(TODAY, a, true, d1) })).toBe(false);
    // same day, a count moved: write
    expect(shouldWrite({ previous: d1, next: doc(TODAY, [...a, admitted('foxnews.com', 'right', 'b')], true, d1) })).toBe(true);
    // next day, the question was checked again with the same result: ONE write
    const d2 = doc('2026-09-26', a, true, d1);
    expect(shouldWrite({ previous: d1, next: d2 })).toBe(true);
    expect(shouldWrite({ previous: d2, next: doc('2026-09-26', a, true, d2) })).toBe(false);
    // next day, nothing checked and nothing aged out: only as_of would move — no restamp
    expect(shouldWrite({ previous: d1, next: doc('2026-09-26', [], false, d1) })).toBe(false);
    // ...but a link aging out IS a count change
    expect(shouldWrite({ previous: d1, next: doc('2026-10-02', [], false, d1) })).toBe(true);
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

  test('rated-only; the GDELT citation and the query shape must travel with the data', () => {
    const unrated = good();
    unrated.questions['iran-war-powers'].outlets[0].domain = 'rollcall.com';
    expect(verifyQuestionPress({ data: unrated, bias: BIAS, now: NOW }).failures.join(' ')).toMatch(/no AllSides rating|not on rollcall/);
    const uncited = good();
    uncited._meta.attribution = 'news';
    expect(verifyQuestionPress({ data: uncited, bias: BIAS, now: NOW }).failures.join(' ')).toMatch(/GDELT/);
    const shapeless = good() as unknown as { _meta: Record<string, unknown> };
    delete shapeless._meta.query_shape;
    expect(verifyQuestionPress({ data: shapeless, bias: BIAS, now: NOW }).failures.join(' ')).toMatch(/query_shape/);
    expect(GDELT_ATTRIBUTION).toContain('GDELT Project');
  });

  test('the file is judged against the day it was written, never the wall clock (the midnight bug)', () => {
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
    for (const iso of ['2026-09-26T23:59:00Z', '2026-09-27T00:30:00Z', '2026-09-27T09:30:00Z']) expect(at(iso).failures).toEqual([]);
    // Days later (GDELT down all week, nothing written): still no failure — lateness is a warning (N8-A2), never damage.
    const late = at('2026-09-29T12:00:00Z');
    expect(late.failures).toEqual([]);
    expect(late.warnings.join(' ')).toMatch(/last pruned on 2026-09-26, 3 days ago/);
    expect(late.warnings.join(' ')).toMatch(/has not succeeded for 3 days/);
    expect(at('2026-12-01T00:00:00Z').failures).toEqual([]);
    // The only wall-clock failure: a file dated more than a day in the future.
    expect(at('2026-09-24T12:00:00Z').failures.join(' ')).toMatch(/as_of 2026-09-26 is in the future/);
    expect(at('2026-09-25T12:00:00Z').failures).toEqual([]); // one day of clock skew is tolerated, like the lamp's gate
  });

  test("damage is still damage when judged against the file's own day", () => {
    const base = good();
    const past = structuredClone(base);
    (past.questions['iran-war-powers'] as Entry).outlets[0].articles[0].seen = '2026-09-17';
    (past.questions['iran-war-powers'] as Entry).outlets[0].firstSeen = '2026-09-17';
    (past.questions['iran-war-powers'] as Entry).outlets[0].lastSeen = '2026-09-17';
    expect(verifyQuestionPress({ data: past, bias: BIAS, moments: MOMENTS, now: NOW }).failures.join(' ')).toMatch(/outside the 7-day window ending 2026-09-25/);
    const after = structuredClone(base);
    after._meta.as_of = '2026-09-24';
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

  test("the window is the lamp's: 0 to 7 whole days old, inclusive — the same edge in the writer, the admission rule and the gate", () => {
    expect(inWindow('2026-09-18', TODAY)).toBe(true);
    expect(inWindow('2026-09-17', TODAY)).toBe(false);
    expect(inWindow('2026-09-26', TODAY)).toBe(false);
    const { admitted } = admitArticles([art('foxnews.com', 'edge', '20260918T010000Z'), art('foxnews.com', 'over', '20260917T235900Z')], { bias: BIAS, today: TODAY });
    expect(admitted.map((a) => a.url)).toEqual(['https://www.foxnews.com/edge']);
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
    expect(buildQuestionPress({ previous: prev, liveIds: ['iran-war-powers'], results: new Map(), bias: BIAS, today: '2026-09-24' }).questions['iran-war-powers']).toBeDefined();
    expect(buildQuestionPress({ previous: prev, liveIds: ['iran-war-powers'], results: new Map(), bias: BIAS, today: TODAY }).questions['iran-war-powers']).toBeUndefined();
  });

  test('a question no longer live is a warning; one never heard of is a failure; a stale check is a warning', () => {
    const d = good();
    const warned = verifyQuestionPress({ data: d, bias: BIAS, moments: { 'iran-war-powers': { status: 'retired' } }, now: NOW });
    expect(warned.failures).toEqual([]);
    expect(warned.warnings.join(' ')).toMatch(/no longer live/);
    expect(verifyQuestionPress({ data: d, bias: BIAS, moments: {}, now: NOW }).failures.join(' ')).toMatch(/no such question/);
    expect(verifyQuestionPress({ data: d, bias: BIAS, moments: MOMENTS, now: NOW + 3 * 86_400_000 }).warnings.join(' ')).toMatch(/has not succeeded for 3 days/);
  });
});

// ---------------------------------------------------------------------------
test.describe('the collector (mocked GDELT): the happy path', () => {
  test('one short request per term, spaced, honest User-Agent; the rated filter runs locally; titles never stored', async () => {
    const net = fakeNet((url) => mixedReply(url));
    const lines: string[] = [];
    const { doc, write, stats, circuit } = await run(net, { log: (l: string) => lines.push(l) });
    expect(net.calls).toHaveLength(TERMS_PER_RUN);
    expect(net.calls.every((c) => c.ua === USER_AGENT)).toBe(true);
    expect(USER_AGENT).not.toMatch(/mozilla|chrome|safari/i);
    for (const c of net.calls) {
      const q = queryOf(c.url);
      expect(q).not.toMatch(/domain/i); // no outlet in any query
      expect(q.length).toBeLessThanOrEqual(GDELT_MAX_QUERY_CHARS);
      expect(new URL(c.url).searchParams.get('startdatetime')).toBe('20260918000000'); // never checked: the whole window
    }
    expect(net.sleeps.every((ms) => ms >= LIMITS.spacingMs - 1)).toBe(true);
    expect(write).toBe(true);
    expect(circuit).toBeNull();
    expect(stats.done.sort()).toEqual(['iran-war-powers', 'paying-college-athletes']);
    expect(stats.skipped).toEqual(['syria-sanctions-repeal']);
    const iran = doc.questions['iran-war-powers'] as Entry;
    expect(iran.terms).toEqual(['war powers', 'operation epic fury']);
    expect(iran.counts.outlets).toEqual({ left: 1, center: 1, right: 1 });
    expect(iran.counts.articles).toEqual({ left: 2, center: 2, right: 2 }); // one link per term per outlet
    const json = JSON.stringify(doc);
    expect(json).not.toContain('example-blog.test');
    expect(json).not.toContain('dailymail.co.uk');
    expect(json).not.toContain('Operation Epic Fury vote'); // titles never stored
    expect(verifyQuestionPress({ data: doc, bias: BIAS, moments: MOMENTS, now: NOW }).failures).toEqual([]);
    // the lean-parity, per-term and precision logs
    expect(lines.some((l) => /iran-war-powers .*rated outlets L1\/3 \(33%\) C1\/2 \(50%\) R1\/2 \(50%\)/.test(l))).toBe(true);
    expect(lines.some((l) => /"war powers" — returned 5 in 1 page\(s\): 3 from rated outlets \(L1\/C1\/R1\), 2 unrated/.test(l))).toBe(true);
    expect(lines.some((l) => /term "operation epic fury" in titles L0\/C2\/R0/.test(l))).toBe(true);
    expect(lines.some((l) => /syria-sanctions-repeal has no multi-word press vocabulary/.test(l))).toBe(true);
  });

  test('a quiet week (GDELT answers {}) is recorded as zero, with no warning', async () => {
    const net = fakeNet(() => ({ status: 200, body: '{}' }));
    const lines: string[] = [];
    const { doc, stats } = await run(net, { log: (l: string) => lines.push(l) });
    expect(stats.done.sort()).toEqual(['iran-war-powers', 'paying-college-athletes']);
    expect((doc.questions['iran-war-powers'] as Entry).counts).toEqual(countsFor([]));
    expect(lines.some((l) => l.startsWith('::warning::') && !/syria/.test(l))).toBe(false);
  });

  test('once per question per UTC day; the next day searches from the last day checked', async () => {
    const first = fakeNet((url) => mixedReply(url));
    const a = await run(first);
    const second = fakeNet((url) => mixedReply(url));
    const b = await run(second, { previous: a.doc, now: NOW + 12 * 3_600_000 });
    expect(second.calls).toHaveLength(0);
    expect(b.write).toBe(false);
    const third = fakeNet((url) => mixedReply(url));
    await run(third, { previous: a.doc, now: NOW + 86_400_000 });
    expect(third.calls).toHaveLength(TERMS_PER_RUN);
    expect(third.calls.every((c) => new URL(c.url).searchParams.get('startdatetime') === '20260925000000')).toBe(true);
  });

  test('a question that lost its search terms loses its entry — no record of a search nobody can re-run', async () => {
    const prev = buildQuestionPress({
      previous: null,
      liveIds: ['syria-sanctions-repeal'],
      results: new Map([['syria-sanctions-repeal', { terms: ['syria sanctions'], admitted: [{ url: 'https://www.npr.org/s', domain: 'npr.org', lean: 'center', seen: TODAY }] }]]),
      bias: BIAS,
      today: TODAY,
    });
    const { doc } = await run(fakeNet((url) => mixedReply(url)), { previous: prev });
    expect(doc.questions['syria-sanctions-repeal']).toBeUndefined();
  });

  test('an unsearchable question warns once a day, not every run', async () => {
    const linesA: string[] = [];
    const a = await run(fakeNet((url) => mixedReply(url)), { log: (l: string) => linesA.push(l) });
    expect(linesA.some((l) => /^::warning::.*syria-sanctions-repeal has no multi-word press vocabulary/.test(l))).toBe(true);
    const linesB: string[] = [];
    await run(fakeNet((url) => mixedReply(url)), { previous: a.doc, now: NOW + 12 * 3_600_000, log: (l: string) => linesB.push(l) });
    expect(linesB.some((l) => /syria-sanctions-repeal has no multi-word press vocabulary/.test(l))).toBe(true);
    expect(linesB.some((l) => /^::warning::.*syria-sanctions-repeal/.test(l))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
test.describe('the collector (mocked GDELT): every failure mode', () => {
  const REFUSAL = 'Your query was too short or too long. ';
  const prevWithIran = () =>
    buildQuestionPress({
      previous: null,
      liveIds: ['iran-war-powers'],
      results: new Map([['iran-war-powers', { terms: ['war powers'], admitted: [{ url: 'https://www.cnn.com/old', domain: 'cnn.com', lean: 'left', seen: '2026-09-23' }] }]]),
      bias: BIAS,
      today: '2026-09-23',
    });

  test('TOO LONG: a refused term is left out with GDELT’s own sentence; the question still moves on its answered terms', async () => {
    const net = fakeNet((url) => (termOf(url) === 'operation epic fury' ? { status: 200, body: REFUSAL } : mixedReply(url)));
    const lines: string[] = [];
    const { doc, stats, circuit } = await run(net, { log: (l: string) => lines.push(l) });
    expect(net.calls).toHaveLength(TERMS_PER_RUN); // one request for the refused term, never a halving loop
    expect(stats.done.sort()).toEqual(['iran-war-powers', 'paying-college-athletes']);
    expect((doc.questions['iran-war-powers'] as Entry).terms).toEqual(['war powers']); // stored terms = what GDELT answered
    expect(stats.refused).toEqual([{ id: 'iran-war-powers', term: 'operation epic fury', chars: buildGdeltQuery('operation epic fury').length, answer: expect.stringMatching(/too short or too long/) }]);
    expect(lines.some((l) => /^::warning::.*GDELT refused the \d+-character query for "operation epic fury" \(GDELT refused the query: Your query was too short or too long/.test(l))).toBe(true);
    expect(lines.some((l) => /"operation epic fury" — REFUSED by GDELT as a query/.test(l))).toBe(true);
    expect(circuit).toBeNull();
  });

  test('TOO LONG, every query: three refusals in a row open the circuit — a refusing GDELT is not asked all day', async () => {
    const moments = {
      q: { status: 'live', aliases: { en: ['alpha beta', 'gamma delta', 'epsilon zeta', 'eta theta', 'iota kappa'] }, vehicles: [] },
    };
    const net = fakeNet(() => ({ status: 200, body: REFUSAL }));
    const { stats, circuit, write } = await run(net, { moments, bills: [] });
    expect(REFUSAL_CIRCUIT).toBe(3);
    expect(net.calls).toHaveLength(REFUSAL_CIRCUIT);
    expect(stats.circuitWhy).toBe('queries refused');
    expect(circuit).toMatchObject({ open: true, reason: 'queries refused', tries: 1 });
    expect(write).toBe(false);
  });

  test('429: two backoffs, then the circuit opens, is persisted, and nothing else is requested this run', async () => {
    const net = fakeNet(() => ({ status: 429, body: 'Please limit requests to one every 5 seconds' }));
    const lines: string[] = [];
    const { doc, write, stats, circuit } = await run(net, { log: (l: string) => lines.push(l) });
    expect(net.calls).toHaveLength(1 + LIMITS.backoffMs.length);
    expect(net.sleeps.filter((ms) => LIMITS.backoffMs.includes(ms))).toEqual(LIMITS.backoffMs);
    expect(stats.circuitOpen).toBe(true);
    expect(circuit).toMatchObject({ open: true, reason: '429', tries: 1, openedAt: new Date(NOW + LIMITS.backoffMs[0] + LIMITS.backoffMs[1]).toISOString() });
    expect(stats.done).toEqual([]);
    expect(doc.questions).toEqual({});
    expect(write).toBe(false); // no file yet and no evidence: no empty first commit
    expect(lines.some((l) => /circuit open/.test(l))).toBe(true);
  });

  test('429 that clears on retry carries on normally', async () => {
    const net = fakeNet((url, n) => (n === 1 ? { status: 429, body: '' } : mixedReply(url)));
    const { stats, circuit } = await run(net);
    expect(stats.done.sort()).toEqual(['iran-war-powers', 'paying-college-athletes']);
    expect(net.calls).toHaveLength(TERMS_PER_RUN + 1);
    expect(circuit).toBeNull();
  });

  test('HANG (no headers ever): each request is cut at its timeout, and two in a row open the circuit', async () => {
    const net = fakeNet(() => 'hang');
    const { stats, circuit } = await run(net);
    expect(net.calls).toHaveLength(SILENT_CIRCUIT);
    expect(stats.circuitWhy).toBe('no answer');
    expect(circuit).toMatchObject({ open: true, reason: 'no answer' });
    // bounded: two timeouts plus one spacing, not minutes per question
    expect(net.elapsed()).toBeLessThanOrEqual(SILENT_CIRCUIT * LIMITS.timeoutMs + LIMITS.spacingMs);
  });

  test('HANG (headers arrive, the body never finishes): counted by the circuit breaker exactly like silence', async () => {
    const net = fakeNet(() => ({ status: 200, hangBody: true }));
    const lines: string[] = [];
    const { stats, circuit } = await run(net, { log: (l: string) => lines.push(l) });
    expect(net.calls).toHaveLength(SILENT_CIRCUIT);
    expect(stats.circuitWhy).toBe('no answer');
    expect(circuit).toMatchObject({ open: true, reason: 'no answer' });
    expect(lines.some((l) => /its body did not finish/.test(l))).toBe(true);
  });

  test('network errors: one between answers fails that question only; two in a row open the circuit', async () => {
    const one = fakeNet((url, n) => (n === 1 ? new Error('ECONNRESET') : mixedReply(url)));
    const a = await run(one);
    expect(a.stats.circuitOpen).toBe(false);
    expect(a.stats.failed).toEqual(['iran-war-powers']);
    expect(a.stats.done).toEqual(['paying-college-athletes']);
    const two = fakeNet(() => Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }));
    const b = await run(two);
    expect(two.calls).toHaveLength(SILENT_CIRCUIT);
    expect(b.circuit).toMatchObject({ open: true, reason: 'no answer' });
  });

  test('EMPTY body: never read as "no coverage" — the question is not updated, and the run says why', async () => {
    const net = fakeNet(() => ({ status: 200, body: '' }));
    const lines: string[] = [];
    const { doc, stats, circuit } = await run(net, { previous: prevWithIran(), log: (l: string) => lines.push(l) });
    expect(stats.done).toEqual([]);
    expect(stats.failed.sort()).toEqual(['iran-war-powers', 'paying-college-athletes']);
    expect((doc.questions['iran-war-powers'] as Entry).checkedOn).toBe('2026-09-23'); // carried, not re-dated
    expect((doc.questions['iran-war-powers'] as Entry).outlets.map((o) => o.domain)).toEqual(['cnn.com']);
    expect(lines.some((l) => /^::warning::.*an empty body — never read as "no coverage"/.test(l))).toBe(true);
    expect(circuit).toBeNull(); // GDELT answered: not a circuit matter
  });

  test('MALFORMED body (HTML error page, truncated JSON, wrong shape): the question is not updated', async () => {
    for (const body of ['<html>502 Bad Gateway</html>', '{"articles": [{"url": "https://www.npr.org/x"', '{"articles": "nope"}']) {
      const net = fakeNet(() => ({ status: 200, body }));
      const lines: string[] = [];
      const { stats, write } = await run(net, { log: (l: string) => lines.push(l) });
      expect(stats.done, body).toEqual([]);
      expect(write, body).toBe(false);
      expect(lines.some((l) => /^::warning::.*a malformed body/.test(l)), body).toBe(true);
    }
  });

  test('HTTP 5xx fails that question and the run moves on', async () => {
    const net = fakeNet((url) => (termOf(url) === 'war powers' ? { status: 503, body: '' } : mixedReply(url)));
    const { stats } = await run(net);
    expect(stats.failed).toEqual(['iran-war-powers']);
    expect(stats.done).toEqual(['paying-college-athletes']);
    // Iran stopped at its first failed term — no wasted request on its second
    expect(net.calls.filter((c) => termOf(c.url) === 'operation epic fury')).toHaveLength(0);
  });

  test('all or nothing: one failed term leaves the whole question exactly as it was', async () => {
    const net = fakeNet((url) => (termOf(url) === 'operation epic fury' ? { status: 503, body: '' } : mixedReply(url)));
    const { doc, stats } = await run(net, { previous: prevWithIran() });
    expect(stats.failed).toContain('iran-war-powers');
    const iran = doc.questions['iran-war-powers'] as Entry;
    expect(iran.checkedOn).toBe('2026-09-23');
    expect(iran.outlets.map((o) => o.domain)).toEqual(['cnn.com']); // "war powers"'s answer was NOT recorded alone
  });

  test('UNREADABLE articles (GDELT renamed its fields): a ::warning::, never a silent "0 outlets"', async () => {
    const net = fakeNet(() => {
      const { url: link, ...rest } = art('cnn.com', 'x');
      return { status: 200, body: JSON.stringify({ articles: [{ ...rest, link }] }) };
    });
    const lines: string[] = [];
    await run(net, { log: (l: string) => lines.push(l) });
    expect(lines.filter((l) => /^::warning::.*not one had a usable link and seen-date/.test(l))).toHaveLength(TERMS_PER_RUN);
  });
});

// ---------------------------------------------------------------------------
test.describe('the collector: budgets by TIME and by count', () => {
  test('one slow question costs its own deadline, then the run moves on — it cannot hold the rest', async () => {
    // Every Iran answer takes 25 s (inside the 30 s request timeout) and fills
    // a whole 250-record page, so each term pages; college answers at once.
    let hour = 23;
    const net = fakeNet((url) => {
      if (termOf(url) === 'protect college sports act') return mixedReply(url);
      const h = String(Math.max(0, hour--)).padStart(2, '0');
      const articles = Array.from({ length: GDELT_MAX_RECORDS }, (_, i) => art('unrated.example', `p${hour}-${i}`, `20260924T${h}0000Z`));
      return { status: 200, body: JSON.stringify({ articles }), takesMs: 25_000 };
    });
    const moments = {
      'iran-war-powers': { ...MOMENTS['iran-war-powers'], aliases: { en: ['war powers', 'operation epic fury', 'strikes on iran', 'war with iran', 'strait of hormuz'] } },
      'paying-college-athletes': MOMENTS['paying-college-athletes'],
    };
    const lines: string[] = [];
    const { stats } = await run(net, { moments, log: (l: string) => lines.push(l) });
    expect(stats.failed).toEqual(['iran-war-powers']);
    expect(stats.done).toEqual(['paying-college-athletes']);
    expect(lines.some((l) => /iran-war-powers: its 240-s deadline would pass/.test(l))).toBe(true);
    // No Iran request STARTED after the point where it could not finish in time.
    const iranCalls = net.calls.filter((c) => termOf(c.url) !== 'protect college sports act');
    for (const c of iranCalls) expect(c.at - NOW + LIMITS.timeoutMs).toBeLessThanOrEqual(LIMITS.questionDeadlineMs);
  });

  test('the run deadline is checked before every request: no request starts that could end past it', async () => {
    const aliases = Array.from({ length: MAX_TERMS_PER_QUESTION }, (_, i) => `term number ${i}`);
    const moments = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`q${i}`, { status: 'live', aliases: { en: aliases }, vehicles: [] }]));
    const net = fakeNet(() => ({ status: 200, body: '{}', takesMs: 20_000 }));
    const { stats } = await run(net, { moments, bills: [], limits: { ...LIMITS, maxRequests: 1000 } });
    expect(stats.budgetStop).toMatch(/run deadline/);
    for (const c of net.calls) expect(c.at - NOW + LIMITS.timeoutMs).toBeLessThanOrEqual(LIMITS.runDeadlineMs);
    expect(net.elapsed()).toBeLessThanOrEqual(LIMITS.runDeadlineMs);
    expect(stats.done.length).toBeGreaterThan(0);
  });

  test('a 429 backoff that would pass a deadline is not slept — the run stops instead', async () => {
    const net = fakeNet(() => ({ status: 429, body: '' }));
    const { stats } = await run(net, { limits: { ...LIMITS, runDeadlineMs: 60_000 } });
    expect(net.sleeps).not.toContain(LIMITS.backoffMs[1]);
    expect(stats.budgetStop ?? stats.circuitWhy).toBeTruthy();
    expect(net.elapsed()).toBeLessThanOrEqual(60_000);
  });

  test('the request cap: a question the remaining cap cannot even start is not started', async () => {
    const net = fakeNet((url) => mixedReply(url));
    const { stats } = await run(net, { limits: { ...LIMITS, maxRequests: 2 } });
    // Iran (never checked, id order) takes 2; college needs 1 more and 0 are left.
    expect(net.calls).toHaveLength(2);
    expect(stats.budgetStop).toMatch(/request cap/);
    expect(stats.done).toEqual(['iran-war-powers']);
  });
});

// ---------------------------------------------------------------------------
test.describe('the collector: paging a full page backwards in time', () => {
  const full = (from: number, stampFor: (i: number) => string) =>
    Array.from({ length: GDELT_MAX_RECORDS }, (_, i) => art(i % 2 ? 'cnn.com' : 'unrated.example', `p${from + i}`, stampFor(i)));

  test('a 250-record answer is paged from its oldest article; the pages together are the evidence', async () => {
    const moments = { 'iran-war-powers': { ...MOMENTS['iran-war-powers'], aliases: { en: ['war powers'] } } };
    const net = fakeNet((url, n) => {
      if (n === 1) return { status: 200, body: JSON.stringify({ articles: full(0, (i) => `2026092${4 - (i > 200 ? 1 : 0)}T${String(23 - (i % 20)).padStart(2, '0')}0000Z`) }) };
      return { status: 200, body: JSON.stringify({ articles: [art('foxnews.com', 'older', '20260920T090000Z')] }) };
    });
    const lines: string[] = [];
    const { doc } = await run(net, { moments, log: (l: string) => lines.push(l) });
    expect(net.calls).toHaveLength(2);
    expect(new URL(net.calls[1].url).searchParams.get('enddatetime')).toBe('20260923040000'); // the oldest of page 1
    expect(new URL(net.calls[1].url).searchParams.get('startdatetime')).toBe('20260918000000'); // same window start
    expect((doc.questions['iran-war-powers'] as Entry).outlets.map((o) => o.domain)).toEqual(['cnn.com', 'foxnews.com']);
    expect(lines.some((l) => /TRUNCATED|still filled/.test(l))).toBe(false);
  });

  test('pages run out: the term is TRUNCATED, said loudly, and still recorded (a cut in time, the same for every lean)', async () => {
    const moments = { 'iran-war-powers': { ...MOMENTS['iran-war-powers'], aliases: { en: ['war powers'] } } };
    let hour = 23;
    const net = fakeNet(() => {
      const h = String(hour--).padStart(2, '0');
      return { status: 200, body: JSON.stringify({ articles: full(hour * 1000, () => `20260924T${h}0000Z`) }) };
    });
    const lines: string[] = [];
    const { stats } = await run(net, { moments, log: (l: string) => lines.push(l) });
    expect(net.calls).toHaveLength(LIMITS.maxPagesPerTerm);
    expect(stats.done).toEqual(['iran-war-powers']);
    expect(lines.some((l) => /^::warning::.*"war powers" still filled GDELT's 250-record page after 4 page\(s\)/.test(l))).toBe(true);
  });

  test('a full page that does not move backwards stops paging instead of looping', async () => {
    const moments = { 'iran-war-powers': { ...MOMENTS['iran-war-powers'], aliases: { en: ['war powers'] } } };
    const net = fakeNet(() => ({ status: 200, body: JSON.stringify({ articles: full(0, () => '20260924T120000Z') }) }));
    const { stats } = await run(net, { moments });
    expect(net.calls).toHaveLength(2);
    expect(stats.done).toEqual(['iran-war-powers']);
  });
});

// ---------------------------------------------------------------------------
test.describe('the collector: the persisted circuit', () => {
  const openAt = (msAgo: number, reason = '429'): Circuit => ({
    open: true,
    reason,
    openedAt: new Date(NOW - 86_400_000).toISOString(),
    lastTryAt: new Date(NOW - msAgo).toISOString(),
    tries: 2,
  });

  test('inside the cooldown: NO request at all, and the circuit is carried unchanged', async () => {
    const net = fakeNet((url) => mixedReply(url));
    const lines: string[] = [];
    const c = openAt(60 * 60_000);
    const { stats, circuit, write } = await run(net, { circuit: c, log: (l: string) => lines.push(l) });
    expect(net.calls).toHaveLength(0);
    expect(stats.circuitSkipped).toBe(true);
    expect(circuit).toEqual(c);
    expect(write).toBe(false);
    expect(lines.some((l) => /^::warning::.*circuit has been open since .* no request this run/.test(l))).toBe(true);
  });

  test('after the cooldown, HALF-OPEN: a still-refusing GDELT costs ONE request, no backoff, and the circuit stays open', async () => {
    const net = fakeNet(() => ({ status: 429, body: '' }));
    const { circuit } = await run(net, { circuit: openAt(LIMITS.circuitCooldownMs + 1) });
    expect(net.calls).toHaveLength(1);
    expect(net.sleeps.filter((ms) => LIMITS.backoffMs.includes(ms))).toEqual([]);
    expect(circuit).toMatchObject({ open: true, reason: '429', tries: 3, openedAt: new Date(NOW - 86_400_000).toISOString(), lastTryAt: new Date(NOW).toISOString() });
    const silent = fakeNet(() => 'hang');
    const s = await run(silent, { circuit: openAt(LIMITS.circuitCooldownMs + 1) });
    expect(silent.calls).toHaveLength(1); // one silent answer is enough when half-open
    expect(s.circuit).toMatchObject({ open: true, reason: 'no answer' });
  });

  test('after the cooldown, HALF-OPEN: an answer closes the circuit and the run carries on', async () => {
    const net = fakeNet((url) => mixedReply(url));
    const { circuit, stats } = await run(net, { circuit: openAt(LIMITS.circuitCooldownMs + 1) });
    expect(circuit).toBeNull();
    expect(net.calls).toHaveLength(TERMS_PER_RUN);
    expect(stats.done.sort()).toEqual(['iran-war-powers', 'paying-college-athletes']);
  });

  test('GDELT_FORCE (local re-measurement only) skips the cooldown but still probes half-open', async () => {
    const net = fakeNet((url) => mixedReply(url));
    const { circuit } = await run(net, { circuit: openAt(60_000), limits: { ...LIMITS, force: true } });
    expect(net.calls).toHaveLength(TERMS_PER_RUN);
    expect(circuit).toBeNull();
  });

  test('the state file: unreadable or missing is a closed circuit; a valid open one round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gdelt-state-'));
    const p = join(dir, 'state.json');
    expect(readCircuit(p)).toBeNull();
    writeFileSync(p, '{not json');
    expect(readCircuit(p)).toBeNull();
    writeFileSync(p, JSON.stringify({ circuit: { open: true, reason: '429', openedAt: 'x', lastTryAt: 'not a date', tries: 1 } }));
    expect(readCircuit(p)).toBeNull();
    const c = openAt(1000);
    writeFileSync(p, JSON.stringify({ circuit: c }));
    expect(readCircuit(p)).toEqual(c);
    writeFileSync(p, JSON.stringify({ circuit: null }));
    expect(readCircuit(p)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
test.describe('parity helpers', () => {
  test('lean parity divides by the rated domains per lean; the lamp comparison reads the vehicles only', () => {
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
});

// ---------------------------------------------------------------------------
// THE BOUNDARIES. Evidence gathered because a question is live must never
// feed the report that decides which questions should be live, nothing on the
// site reads it until the owner rules on question-level cards, and nothing
// about GDELT can sit on another workflow's commit path.
test.describe('boundaries', () => {
  const walk = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir).flatMap((name) => {
          const p = join(dir, name);
          return statSync(p).isDirectory() ? walk(p) : [p];
        })
      : [];
  const wf = (name: string) => readFileSync(join(ROOT, '.github/workflows', name), 'utf8');

  test('scripts/moment-candidates.mjs never reads this evidence', () => {
    expect(readFileSync(join(ROOT, 'scripts/moment-candidates.mjs'), 'utf8')).not.toMatch(/question-press|gdelt/i);
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

  test('OFF THE COMMIT PATH: no data-sync workflow runs the collector', () => {
    for (const name of readdirSync(join(ROOT, '.github/workflows'))) {
      if (name === 'question-press.yml') continue;
      expect(wf(name), name).not.toMatch(/run: node scripts\/gdelt-intake\.mjs/);
    }
  });

  test('its own workflow: own concurrency group, stdlib only, no secret, deadlines inside the job, stages ONE file', () => {
    const yml = wf('question-press.yml');
    const group = /concurrency:[\s\S]*?\n\s+group:\s*(\S+)/.exec(yml)?.[1];
    expect(group).toBeTruthy();
    expect(group).not.toBe('data-sync');
    expect(yml).toContain('cancel-in-progress: false');
    expect(yml).not.toMatch(/secrets\./);
    expect(yml).not.toMatch(/run: npm ci/);
    expect(yml).not.toMatch(/GDELT_FORCE|GDELT_MAX_QUERY_CHARS/); // local re-measurement knobs, never in the workflow
    expect(yml).toMatch(/timeout-minutes: \d+/);
    // the collector's own run deadline sits inside the step's and the job's timeouts
    const stepTimeout = Number(/timeout-minutes: (\d+)\n\s+env:\n\s+GDELT_STATE_PATH/.exec(yml)?.[1]);
    expect(stepTimeout * 60_000).toBeGreaterThan(LIMITS.runDeadlineMs);
    // the circuit survives between runs
    expect(yml).toContain('GDELT_STATE_PATH: .gdelt-state/state.json');
    expect(yml).toMatch(/actions\/cache\/restore@v\d+[\s\S]*path: \.gdelt-state/);
    expect(yml).toMatch(/if: always\(\)\n\s+uses: actions\/cache\/save@v\d+/);
    // the commit stages the one file only this workflow writes — the disjoint set that makes its push safe
    const commit = yml.slice(yml.indexOf('- name: Commit data'));
    expect(commit).toContain('git add data/question-press.json');
    expect(commit).not.toMatch(/git add data\/\s*$/m);
    expect(commit).toMatch(/git rebase origin\/main/);
    expect(yml.indexOf('run: node scripts/gdelt-intake.mjs')).toBeLessThan(yml.indexOf('- name: Commit data'));
    // twice a day, never on the hour or half hour
    const crons = [...yml.matchAll(/-\s*cron:\s*'(\d+)\s+([\d,]+)\s/g)];
    expect(crons).toHaveLength(1);
    expect(Number(crons[0][1]) % 30).not.toBe(0);
    expect(crons[0][2].split(',')).toHaveLength(2);
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf8')).toMatch(/^\.gdelt-state\/$/m);
  });

  test('CI and the nightly still gate the file', () => {
    const ci = wf('ci.yml');
    expect(ci).toContain('node scripts/check-question-press.mjs --self-test');
    expect(ci).toContain('node scripts/check-question-press.mjs\n');
    expect(readFileSync(join(ROOT, 'scripts/verify-sync.mjs'), 'utf8')).toContain('verifyQuestionPress(');
  });
});
