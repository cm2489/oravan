import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/*
 * scripts/sync-coverage.mjs, run END TO END against a throwaway data/ corpus
 * with every network call mocked (tests/fixtures/sync-coverage-fetch-mock.mjs
 * replaces globalThis.fetch before the script loads; TheNewsAPI and the
 * Anthropic gate both answer from a scenario file). ZERO network, zero spend.
 *
 * What it pins — the 2026-09-26 recency pass and the outlet-floor bookkeeping:
 *   - priority bills (Big Question vehicles, the news pool, live tier-0 floor
 *     bills) get a date-sorted 30-day pass AND the whole-life pass; everyone
 *     else gets one request; the total never exceeds COVERAGE_TOP_N;
 *   - a night's result MERGES into what is stored, newest first, instead of
 *     replacing it — an empty night erases nothing;
 *   - the gate sees dates;
 *   - a bill signed within 14 days is still checked; one signed 23 days ago is
 *     not, and is reported as a skipped priority slug;
 *   - every stored article records `rated`;
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
  // A Big Question vehicle signed 23 days ago: past the grace window.
  bill('hr', 6500, { status: 'signed', last_action_date: daysAgo(23), press_names: ['Stopgap Funding Act'] }),
  // In the news pool (C1: two rated outlets this week).
  bill('s', 4668, { press_names: ['Protect College Sports Act'] }),
  // A live tier-0 floor signal.
  bill('hr', 500, { press_names: ['Tier Zero Act'] }),
  // Signed 7 days ago: inside the 14-day grace.
  bill('hr', 5334, { status: 'signed', last_action_date: daysAgo(7), press_names: ['Russia Sanctions Act'] }),
  // Ordinary bills.
  ...[101, 102, 103, 104, 105, 106].map((n) => bill('hr', n, { press_names: [`Ordinary ${n} Act`] })),
  // Undecoded: never eligible.
  bill('hr', 200, { ai_headline: null, press_names: ['Undecoded Act'] }),
];

const art = (title: string, source: string, day: string, path = title.replace(/\W+/g, '-')) => ({
  title,
  url: `https://www.${source}/${path}`,
  source,
  description: `About ${title}.`,
  published_at: `${day}T12:00:00.000000Z`,
});

const STORED = {
  'hconres-89-119': [
    { title: 'Old Iran story', url: 'https://www.politico.com/old-iran', source: 'politico.com', snippet: null, publishedAt: daysAgo(120) },
  ],
  'hr-101-119': [
    { title: 'Older 101 piece', url: 'https://www.foxnews.com/101-a', source: 'foxnews.com', snippet: null, publishedAt: daysAgo(90) },
    { title: 'Older 101 piece two', url: 'https://www.cnn.com/101-b', source: 'cnn.com', snippet: null, publishedAt: daysAgo(80) },
  ],
  _checkedAt: { 'hconres-89-119': daysAgo(6), 'hr-101-119': daysAgo(6) },
};

const baseScenario = {
  keepMarker: 'KEEP',
  news: [
    // hconres-89: the date pass finds the vote week; the relevance pass finds old history.
    {
      match: 'Iran Powers Resolution',
      sort: 'published_at',
      articles: [
        art('Senate vote KEEP', 'cbsnews.com', daysAgo(1)),
        art('Fringe take KEEP', 'thegatewaypundit.com', daysAgo(2)),
        art('Unrelated war story', 'nbcnews.com', daysAgo(3)),
      ],
    },
    { match: 'Iran Powers Resolution', sort: null, articles: [art('Senate vote KEEP', 'cbsnews.com', daysAgo(1)), art('Fringe take KEEP', 'thegatewaypundit.com', daysAgo(2))] },
    { match: 'Iran Powers Resolution', sort: 'relevance_score', articles: [art('Spring hearing KEEP', 'reuters.com', daysAgo(150))] },
    { match: 'Protect College Sports Act', sort: 'published_at', articles: [art('Cloture KEEP', 'nytimes.com', daysAgo(1)), art('Floor fight KEEP', 'foxnews.com', daysAgo(2))] },
    { match: 'Protect College Sports Act', sort: null, articles: [art('Cloture KEEP', 'nytimes.com', daysAgo(1))] },
    { match: 'Protect College Sports Act', sort: 'relevance_score', articles: [art('Markup KEEP', 'apnews.com', daysAgo(60))] },
    { match: 'Tier Zero Act', sort: 'published_at', articles: [art('Tier zero KEEP', 'npr.org', daysAgo(0)), art('Tier zero two KEEP', 'reuters.com', daysAgo(1))] },
    { match: 'Tier Zero Act', sort: null, articles: [art('Tier zero KEEP', 'npr.org', daysAgo(0))] },
    { match: 'Russia Sanctions Act', sort: 'relevance_score', articles: [art('Signed into law KEEP', 'reuters.com', daysAgo(7))] },
    // hr-101 finds nothing tonight: its stored coverage must survive.
    { match: 'Ordinary 102 Act', sort: 'relevance_score', articles: [art('Ordinary 102 news KEEP', 'axios.com', daysAgo(10))] },
  ],
};

function runSync(scenario: Json, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-coverage-runner-'));
  mkdirSync(join(dir, 'data'));
  const put = (name: string, value: unknown) => writeFileSync(join(dir, 'data', name), JSON.stringify(value));
  put('bills.json', BILLS);
  put('coverage.json', STORED);
  copyFileSync(join(REPO, 'data/media-bias.json'), join(dir, 'data/media-bias.json'));
  put('moments.json', {
    'iran-war-powers': { status: 'live', vehicles: [{ slug: 'hconres-89-119' }, { slug: 'hr-6500-119' }] },
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
      COVERAGE_TOP_N: '14',
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
  const coverage = JSON.parse(readFileSync(join(dir, 'data/coverage.json'), 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  const output = `${run.stdout}\n${run.stderr}`;
  return { run, output, requests, coverage };
}

const newsFor = (requests: Json[], match: string) =>
  requests.filter((r) => r.kind === 'news' && String(r.search).includes(match));

test.describe('sync-coverage.mjs end to end (mocked network)', () => {
  test('priority bills get two passes, everyone else one, and the night stays inside COVERAGE_TOP_N', () => {
    const { run, output, requests } = runSync(baseScenario);
    expect(run.status, output).toBe(0);
    const news = requests.filter((r) => r.kind === 'news');
    expect(news.length).toBeLessThanOrEqual(14);
    expect(news.every((r) => r.token_sent)).toBe(true);

    const windowStart = daysAgo(30);
    for (const [match, born] of [
      ['Iran Powers Resolution', '2026-04-23'],
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
    // Never queried: past the grace window, or undecoded.
    expect(newsFor(requests, 'Stopgap Funding Act')).toEqual([]);
    expect(newsFor(requests, 'Undecoded Act')).toEqual([]);
    expect(output).toContain("priority slugs not in tonight's eligible set");
    expect(output).toContain('hr-6500-119');
  });

  test('a night MERGES into what is stored — newest first — and an empty night erases nothing', () => {
    const { run, output, coverage } = runSync(baseScenario);
    expect(run.status, output).toBe(0);

    const iran = coverage['hconres-89-119'];
    expect(iran.map((a: Json) => a.title)).toEqual([
      'Senate vote KEEP',
      'Fringe take KEEP',
      'Old Iran story', // stored 120 days ago — newer than the 150-day-old relevance hit
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
    expect(coverage['hr-6500-119']).toBeUndefined();
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
    expect(output).toMatch(/DATE PASS: sort=published_at sent on 3 request\(s\); 3 came back newest-first, 0 did not/);
    expect(output).toMatch(/ARTICLE AGE: newest stored article is older than 30d for/);
    expect(output).not.toContain('REJECTED');
  });

  test('the changed query is MEASURED by lean every night, with the whole-life pass as the control', () => {
    const { output } = runSync(baseScenario);
    expect(output).toContain(
      'LEAN MIX (kept tonight, AllSides): priority bills — 30-day pass L2/C2/R1/unrated 1, ' +
        'whole-life pass L0/C2/R0/unrated 0; all other bills L0/C2/R0/unrated 0',
    );
  });

  test('a REJECTED sort value is probed, named in a warning, and dropped for the rest of the run', () => {
    const { run, output, requests, coverage } = runSync({ ...baseScenario, rejectDateSort: true });
    expect(run.status, output).toBe(0);
    expect(output).toContain('::warning::coverage sync: TheNewsAPI REJECTED sort=published_at (HTTP 400: malformed_parameters: The sort parameter is invalid.)');
    // Sent once (CONCURRENCY=1), then never again; the 30-day window carries on unsorted.
    const dated = requests.filter((r) => r.kind === 'news' && r.sort === 'published_at');
    expect(dated).toHaveLength(1);
    const unsortedRecent = requests.filter((r) => r.kind === 'news' && r.sort === null);
    expect(unsortedRecent).toHaveLength(3);
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
