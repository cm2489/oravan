import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { alarms, parseCoverageDone, parseCoverageLean, parseCoverageOutage } from '../lib/pipeline-health.mjs';

/*
 * scripts/sync-coverage.mjs, run END TO END against a throwaway data/ corpus
 * with every network call mocked (tests/fixtures/sync-coverage-fetch-mock.mjs
 * replaces globalThis.fetch before the script loads; TheNewsAPI and the
 * Anthropic gate both answer from a scenario file). ZERO network, zero spend.
 *
 * What it pins — the 2026-09-26 recency pass, its follow-ups, and the
 * outlet-floor bookkeeping:
 *   - priority bills (Big Question vehicles, the news pool, live tier-0 floor
 *     bills) get a date-sorted 30-day pass AND the whole-life pass; everyone
 *     else gets one request; the total never exceeds COVERAGE_TOP_N;
 *   - a priority bill is checked WHATEVER its status (H.R. 6500, a live
 *     vehicle signed 23 days ago); a non-priority bill signed 23 days ago is
 *     not, and its stored coverage ages out;
 *   - the priority set stops at 20% of the night, loudly, and a deferred
 *     priority bill still gets an ordinary slot;
 *   - a night's result MERGES into what is stored, newest first, instead of
 *     replacing it — an empty night erases nothing — EXCEPT a stored article
 *     tonight's gate was shown and rejected, which is dropped, and only when
 *     the reply was complete and well-formed (a truncated or off-script reply
 *     drops nothing);
 *   - a night whose gate drops half or more of what it re-judged raises the
 *     coverage-mass-drop ⛔, and a night TheNewsAPI answers not at all prints
 *     the COVERAGE OUTAGE line (raised as coverage-outage), leaving
 *     data/coverage.json byte-for-byte as it was;
 *   - the gate sees dates;
 *   - every stored article records `rated`;
 *   - the date pass is measured by lean against the whole-life pass, and a
 *     shift raises a warning that lib/pipeline-health.mjs turns into a ⛔ —
 *     fed this script's REAL output, so printer and parser cannot drift;
 *   - a rejected sort value is PROBED, warned about by name, and dropped for
 *     the rest of the run, while a merely bad query is not mistaken for one;
 *   - the API token never appears in the script's output.
 */

const REPO = process.cwd();
const SCRIPT = join(REPO, 'scripts/sync-coverage.mjs');
const MOCK = pathToFileURL(join(REPO, 'tests/fixtures/sync-coverage-fetch-mock.mjs')).href;
const TOKEN = 'test-news-token-DO-NOT-PRINT';

const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10);
const TODAY = daysAgo(0);

type Json = Record<string, unknown>;
const bill = (type: string, number: number, over: Json) => ({
  bill_type: type,
  bill_number: number,
  congress_number: 119,
  full_identifier: `${type}-${number}-119`,
  title: `${type.toUpperCase()} ${number}`,
  ai_headline: `Headline ${number}`,
  ai_sections: { tldr: `What ${number} does.` },
  status: 'committee',
  introduced_date: '2025-06-01',
  last_action_date: daysAgo(4),
  last_action_text: 'Referred to committee.',
  press_names: null,
  ...over,
});

const BILLS = [
  // A live Big Question vehicle (priority: vehicle).
  bill('hconres', 89, { status: 'passed_chamber', introduced_date: '2026-04-23', press_names: ['Iran Powers Resolution'] }),
  // A live Big Question vehicle signed 23 days ago — past the 14-day grace,
  // but a vehicle, so still checked (the H.R. 6500 case).
  bill('hr', 6500, { status: 'signed', last_action_date: daysAgo(23), press_names: ['Stopgap Funding Act'] }),
  // In the news pool (C1: two rated outlets this week).
  bill('s', 4668, { press_names: ['Protect College Sports Act'] }),
  // A live tier-0 floor signal.
  bill('hr', 500, { press_names: ['Tier Zero Act'] }),
  // Signed 7 days ago: inside the 14-day grace.
  bill('hr', 5334, { status: 'signed', last_action_date: daysAgo(7), press_names: ['Russia Sanctions Act'] }),
  // Signed 23 days ago and NOT priority: out of the sweep, as before.
  bill('hr', 6400, { status: 'signed', last_action_date: daysAgo(23), press_names: ['Old Law Act'] }),
  // Ordinary bills.
  ...[101, 102, 103, 104, 105, 106].map((n) => bill('hr', n, { press_names: [`Ordinary ${n} Act`] })),
  // Undecoded: never eligible — not even as a Big Question vehicle.
  bill('hr', 200, { ai_headline: null, press_names: ['Undecoded Act'] }),
];

const art = (title: string, source: string, day: string, path = title.replace(/\W+/g, '-')) => ({
  title,
  url: `https://www.${source}/${path}`,
  source,
  description: `About ${title}.`,
  published_at: `${day}T12:00:00.000000Z`,
});

// A stored article an earlier gate kept by mistake — tonight's search returns
// it again and tonight's gate says no.
const WRONGLY_KEPT = art('Wrongly kept 102 piece', 'naturalnews.com', daysAgo(40));
// A stored article tonight's search returns again, but the gate's reply is empty.
const STORED_103 = art('Stored 103 piece', 'cnn.com', daysAgo(50));
// A search hit the fake gate WOULD keep (its title carries the marker), but
// that names neither the resolution nor its number — the H.Con.Res. 89 shape
// in the 2026-09-27 audit (SY-04).
const UNCITED_IRAN = art('Market open KEEP', 'naturalnews.com', daysAgo(4));
// A non-vehicle's stored article from a laxer night, returned again tonight,
// still naming nothing.
const UNCITED_105 = art('Unrelated 105 piece KEEP', 'rttnews.com', daysAgo(15));
const stored = (a: ReturnType<typeof art>) => ({ title: a.title, url: a.url, source: a.source, snippet: null, publishedAt: a.published_at.slice(0, 10) });

const STORED = {
  'hconres-89-119': [
    { title: 'Old Iran Powers Resolution story', url: 'https://www.politico.com/old-iran', source: 'politico.com', snippet: null, publishedAt: daysAgo(120) },
    // Kept by an earlier, laxer night: it names neither the resolution nor its
    // number (the H.Con.Res. 89 case in the 2026-09-27 audit, SY-04). This is
    // a live Big Question vehicle, so it is held to the keep rule tonight
    // whether or not the search returns it.
    { title: 'Indian shares seen higher at open', url: 'https://www.marketwire.example/open', source: 'marketwire.example', snippet: 'Shares opened higher as yields eased.', publishedAt: daysAgo(20) },
  ],
  'hr-6500-119': [
    { title: 'Old Stopgap Funding Act story', url: 'https://www.apnews.com/old-stopgap', source: 'apnews.com', snippet: null, publishedAt: daysAgo(30) },
  ],
  'hr-6400-119': [
    { title: 'Old law story', url: 'https://www.apnews.com/old-law', source: 'apnews.com', snippet: null, publishedAt: daysAgo(25) },
  ],
  'hr-101-119': [
    { title: 'Older 101 piece', url: 'https://www.foxnews.com/101-a', source: 'foxnews.com', snippet: null, publishedAt: daysAgo(90) },
    { title: 'Older 101 piece two', url: 'https://www.cnn.com/101-b', source: 'cnn.com', snippet: null, publishedAt: daysAgo(80) },
  ],
  'hr-102-119': [
    stored(WRONGLY_KEPT),
    { title: 'Kept 102 older', url: 'https://www.npr.org/102-older', source: 'npr.org', snippet: null, publishedAt: daysAgo(60) },
  ],
  'hr-103-119': [stored(STORED_103)],
  'hr-105-119': [stored(UNCITED_105)],
  _checkedAt: { 'hconres-89-119': daysAgo(6), 'hr-101-119': daysAgo(6), 'hr-6400-119': daysAgo(9) },
};

/* Every search hit a rule below returns NAMES the bill it was searched for (the
   press name is in its snippet), so it reaches the fake gate exactly as it did
   before the keep rule existed — except the hits passed as `uncited`, which
   come back as they are. Those are what exercise the keep rule (citesBill,
   scripts/coverage-query.mjs). */
type Article = ReturnType<typeof art>;
const named = (match: string, articles: Article[]) =>
  articles.map((a) => ({ ...a, description: `${a.description} On the ${match}.` }));
const rule = (match: string, sort: string | null, articles: Article[], uncited: Article[] = []) => ({
  match,
  sort,
  articles: [...named(match, articles), ...uncited],
});

const baseScenario = {
  keepMarker: 'KEEP',
  gateNoAnswer: ['HR 103 '],
  news: [
    // hconres-89: the date pass finds the vote week (and one hit that never
    // names the resolution); the relevance pass finds old history.
    rule(
      'Iran Powers Resolution',
      'published_at',
      [
        art('Senate vote KEEP', 'cbsnews.com', daysAgo(1)),
        art('Fringe take KEEP', 'thegatewaypundit.com', daysAgo(2)),
        art('Unrelated war story', 'nbcnews.com', daysAgo(3)),
      ],
      [UNCITED_IRAN],
    ),
    rule('Iran Powers Resolution', null, [art('Senate vote KEEP', 'cbsnews.com', daysAgo(1)), art('Fringe take KEEP', 'thegatewaypundit.com', daysAgo(2))]),
    rule('Iran Powers Resolution', 'relevance_score', [art('Spring hearing KEEP', 'reuters.com', daysAgo(150))]),
    rule('Stopgap Funding Act', 'published_at', [art('Shutdown deadline KEEP', 'apnews.com', daysAgo(2))]),
    rule('Protect College Sports Act', 'published_at', [art('Cloture KEEP', 'nytimes.com', daysAgo(1)), art('Floor fight KEEP', 'foxnews.com', daysAgo(2))]),
    rule('Protect College Sports Act', null, [art('Cloture KEEP', 'nytimes.com', daysAgo(1))]),
    rule('Protect College Sports Act', 'relevance_score', [art('Markup KEEP', 'apnews.com', daysAgo(60))]),
    rule('Tier Zero Act', 'published_at', [art('Tier zero KEEP', 'npr.org', daysAgo(0)), art('Tier zero two KEEP', 'reuters.com', daysAgo(1))]),
    rule('Tier Zero Act', null, [art('Tier zero KEEP', 'npr.org', daysAgo(0))]),
    rule('Russia Sanctions Act', 'relevance_score', [art('Signed into law KEEP', 'reuters.com', daysAgo(7))]),
    // hr-101 finds nothing tonight: its stored coverage must survive.
    // hr-102: one new article, and the wrongly kept one shown again (no KEEP).
    rule('Ordinary 102 Act', 'relevance_score', [art('Ordinary 102 news KEEP', 'axios.com', daysAgo(10)), WRONGLY_KEPT]),
    // hr-103: its stored article is shown again, but the gate's reply is empty.
    rule('Ordinary 103 Act', 'relevance_score', [STORED_103]),
    // hr-105: its stored article comes back again, still naming nothing.
    rule('Ordinary 105 Act', 'relevance_score', [], [UNCITED_105]),
  ],
};

function runSync(scenario: Json, env: Record<string, string> = {}, { stored = STORED as Json } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-coverage-runner-'));
  mkdirSync(join(dir, 'data'));
  const put = (name: string, value: unknown) => writeFileSync(join(dir, 'data', name), JSON.stringify(value));
  put('bills.json', BILLS);
  put('coverage.json', stored);
  copyFileSync(join(REPO, 'data/media-bias.json'), join(dir, 'data/media-bias.json'));
  put('moments.json', {
    'iran-war-powers': { status: 'live', vehicles: [{ slug: 'hconres-89-119' }, { slug: 'hr-6500-119' }] },
    'an-undecoded-vehicle': { status: 'live', vehicles: [{ slug: 'hr-200-119' }] },
  });
  const outlet = (domain: string, lean: string) => ({ domain, lean, firstSeen: daysAgo(2), lastSeen: daysAgo(1) });
  put('conversation.json', {
    _meta: { schema: 'conversation/v1', fetched_at: new Date(NOW).toISOString() },
    slugs: {
      's-4668-119': { outlets7d: [outlet('nytimes.com', 'left'), outlet('foxnews.com', 'right')], unratedOutlets7d: [], mostViewed: null },
    },
  });
  put('floor-signals.json', {
    _meta: { schema: 'floor-signals/v1', fetched_at: new Date(NOW - 3_600_000).toISOString() },
    signals: { 'hr-500-119': { tier0: { source: 'daily-digest', chamber: 'house', covers: TODAY } } },
  });
  const scenarioPath = join(dir, 'scenario.json');
  const logPath = join(dir, 'requests.jsonl');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  writeFileSync(logPath, '');

  const run = spawnSync(process.execPath, ['--import', MOCK, SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    // A MINIMAL env, not process.env: no real key, base URL or proxy setting
    // from the developer's shell can reach the child.
    env: {
      PATH: process.env.PATH ?? '',
      NEWS_API_KEY: TOKEN,
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      // 40 requests: 20% of it (the default priority ceiling) is 8 — room for
      // exactly the four eligible priority bills at two requests each.
      COVERAGE_TOP_N: '40',
      COVERAGE_TAIL_SHARE: '0.5',
      COVERAGE_CONCURRENCY: '1',
      MOCK_SCENARIO: scenarioPath,
      MOCK_LOG: logPath,
      ...env,
    } as unknown as NodeJS.ProcessEnv,
  });
  const requests = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const coverageRaw = readFileSync(join(dir, 'data/coverage.json'), 'utf8');
  const coverage = JSON.parse(coverageRaw);
  rmSync(dir, { recursive: true, force: true });
  const output = `${run.stdout}\n${run.stderr}`;
  return { run, output, requests, coverage, coverageRaw };
}

// A nightly that succeeded, so alarms() raises only what the coverage lines say.
const NIGHTLY_OK = { nightly: { conclusion: 'success' } };

const newsFor = (requests: Json[], match: string) =>
  requests.filter((r) => r.kind === 'news' && String(r.search).includes(match));

test.describe('sync-coverage.mjs end to end (mocked network)', () => {
  test('priority bills get two passes, everyone else one, and the night stays inside COVERAGE_TOP_N', () => {
    const { run, output, requests } = runSync(baseScenario);
    expect(run.status, output).toBe(0);
    const news = requests.filter((r) => r.kind === 'news');
    // 4 priority bills x 2 + 7 others x 1.
    expect(news).toHaveLength(15);
    expect(news.every((r) => r.token_sent)).toBe(true);

    const windowStart = daysAgo(30);
    for (const [match, born] of [
      ['Iran Powers Resolution', '2026-04-23'],
      ['Stopgap Funding Act', '2025-06-01'],
      ['Protect College Sports Act', '2025-06-01'],
      ['Tier Zero Act', '2025-06-01'],
    ] as const) {
      const reqs = newsFor(requests, match);
      expect(reqs.map((r) => r.sort), match).toEqual(['published_at', 'relevance_score']);
      expect(reqs[0].published_after, match).toBe(born > windowStart ? born : windowStart);
      expect(reqs[1].published_after, match).toBe(born);
    }
    for (const match of ['Russia Sanctions Act', 'Ordinary 101 Act', 'Ordinary 106 Act']) {
      expect(newsFor(requests, match).map((r) => r.sort), match).toEqual(['relevance_score']);
    }
    // Never queried: signed past the grace window and NOT priority, or undecoded
    // (even as a Big Question vehicle).
    expect(newsFor(requests, 'Old Law Act')).toEqual([]);
    expect(newsFor(requests, 'Undecoded Act')).toEqual([]);
    expect(output).toContain("priority slugs not in tonight's eligible set (undecoded, or not in the corpus): hr-200-119");
    expect(output).not.toContain('priority ceiling');
  });

  test('a live vehicle is checked whatever its status; a non-priority law past the grace window ages out', () => {
    const { coverage, output } = runSync(baseScenario);
    // H.R. 6500: signed 23 days ago, still the question's vehicle — checked,
    // and tonight's find merged with what was stored.
    expect(coverage['hr-6500-119'].map((a: Json) => a.title)).toEqual(['Shutdown deadline KEEP', 'Old Stopgap Funding Act story']);
    expect(coverage._checkedAt['hr-6500-119']).toBe(TODAY);
    expect(output).toMatch(/hr-6500-119: 1 candidates \(1 from the 30-day pass\) -> 1 kept -> 2 stored/);
    // H.R. 6400: signed 23 days ago, not priority — not checked, and its
    // coverage and check date age out of the file exactly as before.
    expect(coverage['hr-6400-119']).toBeUndefined();
    expect(coverage._checkedAt['hr-6400-119']).toBeUndefined();
  });

  test('a night MERGES into what is stored — newest first — and an empty night erases nothing', () => {
    const { run, output, coverage } = runSync(baseScenario);
    expect(run.status, output).toBe(0);

    const iran = coverage['hconres-89-119'];
    expect(iran.map((a: Json) => a.title)).toEqual([
      'Senate vote KEEP',
      'Fringe take KEEP',
      'Old Iran Powers Resolution story', // stored 120 days ago — newer than the 150-day-old relevance hit
      'Spring hearing KEEP',
    ]);
    expect(iran.map((a: Json) => a.title)).not.toContain('Unrelated war story');

    // hr-101 found nothing tonight; before 2026-09-26 that replaced its two
    // stored articles with nothing.
    expect(coverage['hr-101-119'].map((a: Json) => a.url)).toEqual([
      'https://www.cnn.com/101-b',
      'https://www.foxnews.com/101-a',
    ]);
    expect(coverage._checkedAt['hr-101-119']).toBe(TODAY);

    // Signed 7 days ago: checked, and its coverage kept.
    expect(coverage['hr-5334-119'].map((a: Json) => a.title)).toEqual(['Signed into law KEEP']);
    expect(coverage._checkedAt['hr-5334-119']).toBe(TODAY);
  });

  test('a stored article the gate was SHOWN tonight and rejected is dropped — the merge does not make an old yes permanent', () => {
    const { output, coverage } = runSync(baseScenario);
    // hr-102: the wrongly kept article came back in tonight's search, the gate
    // said no, and it is gone. The stored article tonight's search did NOT
    // return keeps its earlier verdict.
    expect(coverage['hr-102-119'].map((a: Json) => a.title)).toEqual(['Ordinary 102 news KEEP', 'Kept 102 older']);
    expect(output).toContain("hr-102-119: 2 candidates -> 1 kept, 1 stored article(s) dropped on tonight's gate verdict -> 2 stored");
  });

  test('…but only on a complete, well-formed reply — an EMPTY reply keeps nothing and drops nothing', () => {
    const { output, coverage } = runSync(baseScenario);
    expect(coverage['hr-103-119'].map((a: Json) => a.title)).toEqual(['Stored 103 piece']);
    expect(output).toContain(
      "hr-103-119: 1 candidates -> 0 kept (the gate's reply was not complete and well-formed: nothing kept, no stored article dropped) -> 1 stored",
    );
  });

  test('a TRUNCATED reply keeps nothing and drops nothing, even when what survived of it looks like a clean list', () => {
    // hr-102's gate reply is "0" — exactly what a finished reply would say —
    // but the API reports the model was cut off at max_tokens, so "0" may
    // have been the start of "0, 1" or of "10". The wrongly kept article
    // it would otherwise drop stays stored — and, since 2026-09-27, the
    // article it would otherwise KEEP is not added either: the keep path is
    // as strict as the drop path.
    const truncated = { ...baseScenario, gateReplies: [{ match: 'HR 102 ', text: '{kept}', stop_reason: 'max_tokens' }] };
    const { run, output, coverage, requests } = runSync(truncated);
    expect(run.status, output).toBe(0);
    const gate = requests.find((r) => r.kind === 'gate' && String(r.prompt).includes('HR 102 '))!;
    expect(gate.text).toBe('0');
    expect(gate.stop_reason).toBe('max_tokens');
    expect(coverage['hr-102-119'].map((a: Json) => a.title)).toEqual([
      'Wrongly kept 102 piece', // 40 days old
      'Kept 102 older', // 60
    ]);
    expect(output).toContain(
      "hr-102-119: 2 candidates -> 0 kept (the gate's reply was not complete and well-formed: nothing kept, no stored article dropped) -> 2 stored",
    );
    const done = parseCoverageDone(output)!;
    expect(done.droppedOnVerdict).toBe(0);
    expect(done.rejudged).toBe(0);
    expect(done.unansweredGates).toBe(2); // hr-102 and hr-103
  });

  test('an OFF-SCRIPT reply keeps nothing and drops nothing, even with valid indexes in it', () => {
    for (const text of [
      '{kept} — the other article is about a different bill.',
      'Article {kept} is about this bill.',
      '{kept}\n\nThe second one is general news.',
      '{kept},',
      'none. Article 0 is close, but about another bill.',
      '0, 0',
    ]) {
      const offScript = { ...baseScenario, gateReplies: [{ match: 'HR 102 ', text, stop_reason: 'end_turn' }] };
      const { output, coverage } = runSync(offScript);
      expect(coverage['hr-102-119'].map((a: Json) => a.title), text).toContain('Wrongly kept 102 piece');
      // The keep path reads the same bar: an index inside a reply that is not
      // an answer adds nothing (before 2026-09-27, "Article 0 is about this
      // bill." kept article 0).
      expect(coverage['hr-102-119'].map((a: Json) => a.title), text).not.toContain('Ordinary 102 news KEEP');
      expect(parseCoverageDone(output)!.keptTonight, text).toBe(10);
      expect(output, text).not.toContain("hr-102-119: 2 candidates -> 1 kept, 1 stored article(s) dropped");
      expect(parseCoverageDone(output)!.droppedOnVerdict, text).toBe(0);
    }
  });

  test('a well-formed reply in quotes, or with a trailing period, still counts', () => {
    for (const text of ['"{kept}"', '{kept}.', '  {kept}\n']) {
      const tidy = { ...baseScenario, gateReplies: [{ match: 'HR 102 ', text, stop_reason: 'end_turn' }] };
      const { coverage, output } = runSync(tidy);
      expect(coverage['hr-102-119'].map((a: Json) => a.title), text).toEqual(['Ordinary 102 news KEEP', 'Kept 102 older']);
      expect(parseCoverageDone(output)!.droppedOnVerdict, text).toBe(1);
    }
  });

  test('the DONE line says what TONIGHT found, and pipeline-health reads it off this real output', () => {
    const { output } = runSync(baseScenario);
    expect(output).toMatch(
      /DONE: \d+\/11 bills with coverage, \d+ articles total.*; kept tonight: 11 article\(s\) on 6 bill\(s\); 1 of 1 re-judged stored article\(s\) dropped on tonight's gate verdict; 1 gate reply\(ies\) not complete and well-formed \(nothing kept and no stored article dropped on them\)/,
    );
    const done = parseCoverageDone(output)!;
    expect(done).not.toBeNull();
    expect(done.checked).toBe(11);
    expect(done.keptTonight).toBe(11);
    expect(done.billsKeptTonight).toBe(6);
    expect(done.droppedOnVerdict).toBe(1);
    expect(done.rejudged).toBe(1);
    expect(done.unansweredGates).toBe(1);
    // One drop out of one re-judged is 100%, but it is one article: no ⛔.
    expect(alarms({ ...NIGHTLY_OK, coverageRun: done }).map((a) => a.code)).toEqual([]);
  });

  test('an EMPTY night still erases nothing, and now says it kept nothing', () => {
    const { run, output, coverage } = runSync({ keepMarker: 'KEEP', news: [] });
    expect(run.status, output).toBe(0);
    expect(output).toContain('; kept tonight: 0 article(s) on 0 bill(s); 0 of 0 re-judged stored article(s) dropped');
    expect(parseCoverageDone(output)!.keptTonight).toBe(0);
    expect(coverage['hr-101-119']).toHaveLength(2);
    expect(coverage['hconres-89-119']).toHaveLength(1);
  });

  test('a gate that turns on what it kept before raises coverage-mass-drop off the real output', () => {
    // hr-104 has 24 stored articles, tonight's search returns every one of
    // them, and a well-formed "none" rejects them all. The drop is real (the
    // reply is a complete answer) and it is loud.
    const many = Array.from({ length: 24 }, (_, i) => art(`Stored 104 piece ${i}`, 'apnews.com', daysAgo(40 + i)));
    const scenario = {
      ...baseScenario,
      news: [...baseScenario.news, rule('Ordinary 104 Act', 'relevance_score', many)],
    };
    const { run, output, coverage } = runSync(scenario, {}, { stored: { ...STORED, 'hr-104-119': many.map(stored) } });
    expect(run.status, output).toBe(0);
    expect(coverage['hr-104-119']).toBeUndefined();
    const done = parseCoverageDone(output)!;
    expect(done.droppedOnVerdict).toBe(25); // 24 on hr-104, 1 on hr-102
    expect(done.rejudged).toBe(25);
    const raised = alarms({ ...NIGHTLY_OK, coverageRun: done });
    expect(raised.map((a) => a.code)).toEqual(['coverage-mass-drop']);
    expect(raised[0].text).toContain('dropped 25 of the 25 stored articles its relevance gate re-judged (100%)');
  });

  test('a HARD outage — TheNewsAPI answers nothing — prints the OUTAGE line, leaves the file byte-for-byte, and raises coverage-outage', () => {
    // Every request 400s: no retries, so the test stays fast; the exit path is
    // the same one a night of 5xx or network errors reaches after retrying.
    const { run, output, coverageRaw } = runSync({ ...baseScenario, brokenQueries: [''] });
    expect(run.status, output).toBe(0);
    expect(coverageRaw).toBe(JSON.stringify(STORED));
    expect(output).not.toMatch(/^DONE: /m);
    expect(output).toContain(
      'COVERAGE OUTAGE: 0 of 11 planned bill(s) got a TheNewsAPI response tonight (11 failed) — data/coverage.json left unchanged, no bill checked',
    );
    expect(output).toContain("::warning::coverage sync: TheNewsAPI answered none of tonight's requests");
    expect(parseCoverageDone(output)).toBeNull();
    const outage = parseCoverageOutage(output);
    expect(outage).toEqual({ planned: 11, failed: 11, quotaStopped: false });
    const raised = alarms({ ...NIGHTLY_OK, coverageOutage: outage });
    expect(raised.map((a) => a.code)).toEqual(['coverage-outage']);
    expect(output).not.toContain(TOKEN);
  });

  test('a quota stop before any response is an outage too, and says so', () => {
    const { run, output, coverageRaw } = runSync({ ...baseScenario, quotaExhausted: true });
    expect(run.status, output).toBe(0);
    expect(coverageRaw).toBe(JSON.stringify(STORED));
    expect(output).toContain('(0 failed; the daily quota stopped the run)');
    expect(parseCoverageOutage(output)).toEqual({ planned: 11, failed: 0, quotaStopped: true });
  });

  test('every stored article records whether its outlet is AllSides-rated — and nothing is filtered by it', () => {
    const { coverage } = runSync(baseScenario);
    const all = Object.entries(coverage)
      .filter(([k]) => !k.startsWith('_'))
      .flatMap(([, arts]) => arts as Json[]);
    expect(all.length).toBeGreaterThan(5);
    for (const a of all) expect(typeof a.rated, String(a.url)).toBe('boolean');
    const bySource = (s: string) => all.find((a) => a.source === s)!;
    expect(bySource('thegatewaypundit.com').rated).toBe(false); // stored, flagged — the page decides
    expect(bySource('cbsnews.com').rated).toBe(true);
    expect(bySource('politico.com').rated).toBe(true); // carried-forward rows are stamped too
  });

  test('the gate sees dates, and room for every index', () => {
    const { requests } = runSync(baseScenario);
    const gates = requests.filter((r) => r.kind === 'gate');
    expect(gates.length).toBeGreaterThan(0);
    const iran = gates.find((g) => String(g.prompt).includes('HCONRES 89'))!;
    expect(iran.prompt).toMatch(/\n0\. \[\d{4}-\d{2}-\d{2}\] /);
    expect(iran.prompt).toContain('Latest action (');
    for (const g of gates) expect(Number(g.max_tokens)).toBeGreaterThanOrEqual(80);
  });

  test('the DATE PASS summary is printed for the first nightly to verify the sort value', () => {
    const { output } = runSync(baseScenario);
    expect(output).toMatch(/DATE PASS: sort=published_at sent on 4 request\(s\); 3 came back newest-first, 0 did not/);
    expect(output).toMatch(/ARTICLE AGE: newest stored article is older than 30d for/);
    expect(output).not.toContain('REJECTED');
  });

  test('the changed query is MEASURED by lean every night, with the whole-life pass as the control', () => {
    const { output } = runSync(baseScenario);
    expect(output).toContain(
      'LEAN MIX (kept tonight, AllSides): priority bills — 30-day pass L2/C3/R1/unrated 1, ' +
        'whole-life pass L0/C2/R0/unrated 0; all other bills L0/C2/R0/unrated 0',
    );
    // Seven kept against two is not a sample: the verdict says so rather than "ok".
    expect(output).toMatch(/LEAN DRIFT: too few to judge — rated share: too few to judge \(30-day 7, whole-life 2 kept; need 10 each\)/);
    expect(output).not.toContain('::warning::coverage sync: LEAN DRIFT');
    const lean = parseCoverageLean(output)!;
    expect(lean.recent).toEqual({ left: 2, center: 3, right: 1, unrated: 1 });
    expect(lean.wholeLife).toEqual({ left: 0, center: 2, right: 0, unrated: 0 });
    expect(lean.verdict).toBe('thin');
    expect(alarms({ coverageLean: lean }).map((a) => a.code)).not.toContain('coverage-lean-drift');
  });

  test('a date pass that shifts the outlet mix FIRES — a warning in the run, a ⛔ in the digest', () => {
    // The Iran vehicle's date pass brings back twelve outlets AllSides does
    // not rate; its whole-life pass, twelve rated ones.
    const unrated = Array.from({ length: 12 }, (_, i) => art(`Recent ${i} KEEP`, `outlet${i}.example`, daysAgo(1 + i)));
    const rated = ['cnn.com', 'foxnews.com', 'npr.org', 'reuters.com', 'nytimes.com', 'nypost.com'].flatMap((d, i) => [
      art(`History ${i}a KEEP`, d, daysAgo(100 + i)),
      art(`History ${i}b KEEP`, d, daysAgo(110 + i)),
    ]);
    const shifted = {
      ...baseScenario,
      news: [
        rule('Iran Powers Resolution', 'published_at', unrated),
        rule('Iran Powers Resolution', 'relevance_score', rated),
        ...baseScenario.news.filter((r) => r.match !== 'Iran Powers Resolution'),
      ],
    };
    const { run, output } = runSync(shifted);
    expect(run.status, output).toBe(0);
    expect(output).toMatch(/LEAN DRIFT: DRIFT — rated share: 30-day \d+% of \d+ vs whole-life \d+% of \d+ \(z=-?\d+\.\d\d\) SHIFTED/);
    expect(output).toContain('::warning::coverage sync: LEAN DRIFT — the 30-day date-sorted pass kept a different outlet mix');
    const lean = parseCoverageLean(output)!;
    expect(lean.verdict).toBe('drift');
    const raised = alarms({ coverageLean: lean });
    expect(raised.map((a) => a.code)).toContain('coverage-lean-drift');
    expect(raised.find((a) => a.code === 'coverage-lean-drift')!.text).toContain('SHIFTED');
  });

  test('the priority set stops at 20% of the night — the rest are deferred, loudly, and still get an ordinary slot', () => {
    // 20 requests: 20% is 4, i.e. two priority bills. The vehicles come first.
    const { run, output, requests } = runSync(baseScenario, { COVERAGE_TOP_N: '20' });
    expect(run.status, output).toBe(0);
    expect(requests.filter((r) => r.kind === 'news').length).toBeLessThanOrEqual(20);
    for (const match of ['Iran Powers Resolution', 'Stopgap Funding Act']) {
      expect(newsFor(requests, match).map((r) => r.sort), match).toEqual(['published_at', 'relevance_score']);
    }
    for (const match of ['Protect College Sports Act', 'Tier Zero Act']) {
      expect(newsFor(requests, match).map((r) => r.sort), match).toEqual(['relevance_score']);
    }
    expect(output).toContain(
      '::warning::coverage sync: 2 priority bill(s) over the 20% priority ceiling (2 bills of 20 requests) get no 30-day pass tonight',
    );
    expect(output).toContain('s-4668-119, hr-500-119');
  });

  test('a REJECTED sort value is probed, named in a warning, and dropped for the rest of the run', () => {
    const { run, output, requests, coverage } = runSync({ ...baseScenario, rejectDateSort: true });
    expect(run.status, output).toBe(0);
    expect(output).toContain('::warning::coverage sync: TheNewsAPI REJECTED sort=published_at (HTTP 400: malformed_parameters: The sort parameter is invalid.)');
    // Sent once (CONCURRENCY=1), then never again; the 30-day window carries on unsorted.
    const dated = requests.filter((r) => r.kind === 'news' && r.sort === 'published_at');
    expect(dated).toHaveLength(1);
    const unsortedRecent = requests.filter((r) => r.kind === 'news' && r.sort === null);
    // The probe for the first priority bill, then the other three priority bills.
    expect(unsortedRecent).toHaveLength(4);
    for (const r of unsortedRecent) expect(r.published_after >= daysAgo(30) || r.published_after === '2026-04-23').toBe(true);
    expect(coverage['hconres-89-119'][0].title).toBe('Senate vote KEEP');
    expect(output).toMatch(/DATE PASS: .*REJECTED: HTTP 400/);
  });

  test('a bad QUERY is not mistaken for a rejected sort', () => {
    const { run, output, requests } = runSync({ ...baseScenario, brokenQueries: ['Protect College Sports Act'] });
    expect(run.status, output).toBe(0);
    expect(output).toContain('FAIL s-4668-119: TheNewsAPI 400');
    expect(output).not.toContain('REJECTED');
    // The later priority bill still gets the date sort.
    expect(newsFor(requests, 'Tier Zero Act').map((r) => r.sort)).toEqual(['published_at', 'relevance_score']);
    // A 400 is not retried six times: the date pass + one probe, then the bill fails.
    expect(newsFor(requests, 'Protect College Sports Act')).toHaveLength(2);
  });

  test('a sort that is accepted but IGNORED is flagged', () => {
    const reversed = {
      ...baseScenario,
      news: baseScenario.news.map((r) => (r.sort === 'published_at' ? { ...r, articles: [...r.articles].reverse() } : r)),
    };
    const { output } = runSync(reversed);
    expect(output).toMatch(/::warning::coverage sync: \d+ response\(s\) sent with sort=published_at were NOT newest-first/);
  });

  test('the API token never reaches the log', () => {
    for (const scenario of [baseScenario, { ...baseScenario, rejectDateSort: true }, { ...baseScenario, brokenQueries: ['Iran'] }]) {
      const { output } = runSync(scenario);
      expect(output).not.toContain(TOKEN);
    }
  });
});

/*
 * THE KEEP RULE (2026-09-27, the 2026-09-27 audit's SY-04): the keep path is as
 * strict as the drop path. A search hit reaches the relevance gate only when
 * its title or snippet cites the bill or prints a name it is known by; stored
 * articles that fail the rule leave when the search returns them again, and a
 * live Big Question vehicle's stored coverage is held to the rule every night.
 */
test.describe('sync-coverage.mjs keep rule (mocked network)', () => {
  const gateFor = (requests: Json[], marker: string) =>
    requests.filter((r) => r.kind === 'gate' && String(r.prompt).includes(marker));

  test('a hit that names neither the bill nor its number never reaches the gate — even one the gate would keep', () => {
    const { run, output, coverage, requests } = runSync(baseScenario);
    expect(run.status, output).toBe(0);
    // The fake gate keeps any title carrying the marker, and UNCITED_IRAN does:
    // only the keep rule stands between it and the page.
    const iranGate = gateFor(requests, 'HCONRES 89')[0];
    expect(iranGate.prompt).toContain('Senate vote KEEP');
    expect(iranGate.prompt).not.toContain(UNCITED_IRAN.title);
    expect(coverage['hconres-89-119'].map((a: Json) => a.url)).not.toContain(UNCITED_IRAN.url);
    expect(output).toContain(
      'hconres-89-119: 5 candidates (4 from the 30-day pass), 1 citing neither the bill nor a name it is known by (not shown to the gate) -> 3 kept -> 4 stored',
    );
  });

  test('a bill whose every hit is uncited costs no gate call at all', () => {
    const { requests, output } = runSync(baseScenario);
    expect(newsFor(requests, 'Ordinary 105 Act')).toHaveLength(1);
    expect(gateFor(requests, 'HR 105 ')).toEqual([]);
    expect(output).toContain('hr-105-119: 1 candidates, 1 citing neither the bill nor a name it is known by (not shown to the gate) -> 0 kept');
  });

  test('a STORED article the search returns again and that fails the rule is dropped — on the rule, not as a gate verdict', () => {
    const { output, coverage } = runSync(baseScenario);
    // hr-105 is not a Big Question vehicle; its stored article came back
    // tonight, still naming nothing, and leaves. With nothing else stored the
    // bill leaves the file, as an uncovered bill does.
    expect(coverage['hr-105-119']).toBeUndefined();
    expect(output).toContain('hr-105-119: 1 candidates, 1 citing neither the bill nor a name it is known by (not shown to the gate) -> 0 kept, 1 stored article(s) dropped on the keep rule -> 0 stored');
    // The mass-drop alarm reads the GATE's drops; a deterministic rule doing
    // what it always does is not a model turning on its earlier yeses.
    const done = parseCoverageDone(output)!;
    expect(done.droppedOnVerdict).toBe(1); // hr-102's, as before
    expect(done.rejudged).toBe(1);
  });

  test('a stored article the search does NOT return keeps its old verdict — on a bill that is not a live vehicle', () => {
    const { coverage } = runSync(baseScenario);
    // hr-101's two stored articles name nothing either, but nothing re-judged
    // them tonight and hr-101 is not a Big Question vehicle.
    expect(coverage['hr-101-119'].map((a: Json) => a.title)).toEqual(['Older 101 piece two', 'Older 101 piece']);
  });

  test("a live Big Question vehicle's stored coverage is held to the rule whether or not tonight's search returns it", () => {
    const { output, coverage } = runSync(baseScenario);
    const titles = coverage['hconres-89-119'].map((a: Json) => a.title);
    expect(titles).toContain('Old Iran Powers Resolution story'); // names the resolution: stays
    expect(titles).not.toContain('Indian shares seen higher at open'); // names nothing: goes
    expect(output).toContain(
      'keep rule: hconres-89-119 (live Big Question vehicle) — 1 of 2 stored article(s) cite neither the bill nor a name it is known by, dropped',
    );
  });

  test('…including a vehicle the run never reached (carried forward, still held)', () => {
    // Every request fails for the Iran vehicle, so it is not processed and its
    // stored coverage is carried forward — held to the rule all the same.
    const { run, output, coverage } = runSync({ ...baseScenario, brokenQueries: ['Iran Powers Resolution'] });
    expect(run.status, output).toBe(0);
    expect(output).toContain('FAIL hconres-89-119');
    expect(coverage['hconres-89-119'].map((a: Json) => a.title)).toEqual(['Old Iran Powers Resolution story']);
  });

  test('a hit that CITES the bill by number passes with no name at all — how a subject-only resolution is covered', () => {
    const cited = art('Senate rejects war powers measure KEEP', 'apnews.com', daysAgo(1));
    const scenario = {
      ...baseScenario,
      news: [
        rule('Iran Powers Resolution', 'published_at', [], [{ ...cited, description: 'The Senate voted 47-53 on H. Con. Res. 89 on Thursday.' }]),
        ...baseScenario.news.filter((r) => r.match !== 'Iran Powers Resolution'),
      ],
    };
    const { coverage, output } = runSync(scenario);
    expect(coverage['hconres-89-119'].map((a: Json) => a.title)).toContain(cited.title);
    expect(output).toMatch(/hconres-89-119: 1 candidates \(1 from the 30-day pass\) -> 1 kept/);
  });

  test('the CITE RULE line counts what the rule stopped and what it dropped', () => {
    const { output } = runSync(baseScenario);
    expect(output).toMatch(
      /CITE RULE: 2 of \d+ candidate\(s\) cited neither the bill nor a name it is known by and were not shown to the gate; 2 stored article\(s\) dropped on the keep rule \(1 held on live Big Question vehicles, 1 returned again by tonight's search\)/,
    );
  });

  test('an outage night still leaves the file byte-for-byte — the vehicle hold is never written on its own', () => {
    const { coverageRaw, output } = runSync({ ...baseScenario, brokenQueries: [''] });
    expect(output).toContain('COVERAGE OUTAGE:');
    expect(coverageRaw).toBe(JSON.stringify(STORED));
  });
});
