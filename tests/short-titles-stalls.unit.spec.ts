import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { alarms, parseShortTitlesSummary, parseShortTitlesTrouble } from '../lib/pipeline-health.mjs';
import {
  readTitlesAnswer,
  SHORT_TITLE_MAX_LENGTH,
  SHORT_TITLES_MAX_REQUESTS,
  shortTitleProblem,
  verifyShortTitles,
} from '../lib/short-titles.mjs';
import { Refused, RETRY_PILE_MIN, runShortTitlesNight, settleNight } from '../lib/short-titles-night.mjs';

/*
 * NO STALL, NO SILENT STOP (2026-11-15, after three independent checks found
 * new ways for the nightly short-titles read to stall for good while the run
 * stayed green). Three parts:
 *
 *   1. THE EXIT PATHS, as a table: every way scripts/sync-short-titles.mjs
 *      ends a night early, refuses to write or exits non-zero, driven through
 *      the real script with the network stubbed, each asserting its exit code,
 *      its one "SHORT TITLES TROUBLE:" line and what lib/pipeline-health.mjs
 *      makes of it. A source check fails when the script sets an exit code
 *      anywhere but its one finish() helper, so a new exit path without a row
 *      is hard to add.
 *   2. THE REVIEWER'S SIMULATIONS, night by night: (i) one bill's odd titles,
 *      (ii) an 11% drop and the one-run override, (iii) 20 refused bills at the
 *      head, (iv) 120 nights with 25 bills that always 404 and a trickle of new
 *      bills, (v) a source reshaped for good.
 *   3. THE PER-BILL TEST AND THE FILE'S GATE CANNOT DISAGREE.
 */

const TODAY = '2026-11-15';
const LIVE = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/congress-gov-titles-hr-9770-119.json'), 'utf8'));
const OFFICIAL = LIVE.titles.filter((t: { titleType: string }) => !/^Short/.test(t.titleType));
const bill = (n: number, last = '2026-01-01', urgency = 1 - n / 100000) => ({
  bill_type: 'hr',
  bill_number: n,
  congress_number: 119,
  last_action_date: last,
  urgency_score: urgency,
});
const slug = (n: number) => `hr-${n}-119`;

/** An answer for a bill: its short titles, plus the official titles every bill has. */
function answer(type: string, number: number | string, shortTitles: string[]) {
  const titles = [
    ...OFFICIAL,
    ...shortTitles.map((title) => ({ title, titleType: 'Short Title(s) as Introduced', titleTypeCode: 101, updateDate: 'x' })),
  ];
  return { pagination: { count: titles.length }, request: { billNumber: String(number), billType: type, congress: '119', format: 'json' }, titles };
}

// --- running the real script offline -------------------------------------------------

type Files = {
  corpus?: unknown;
  corpusText?: string;
  before?: unknown;
  beforeText?: string;
  retry?: unknown;
  retryText?: string;
  trend?: unknown;
  trendText?: string;
};

function runScript(stub: string, files: Files, env: Record<string, string> = {}, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'short-titles-stall-'));
  try {
    const corpusFile = join(dir, 'bills.json');
    const outFile = join(dir, 'short-titles.json');
    const retryFile = join(dir, 'short-titles-retry.json');
    const trendFile = join(dir, 'short-titles-trend.json');
    const put = (file: string, text: string | undefined, value: unknown) => {
      if (text !== undefined) writeFileSync(file, text);
      else if (value !== undefined) writeFileSync(file, JSON.stringify(value));
    };
    put(corpusFile, files.corpusText, files.corpus);
    put(outFile, files.beforeText, files.before);
    put(retryFile, files.retryText, files.retry);
    put(trendFile, files.trendText, files.trend);
    const preload = join(dir, 'stub.mjs');
    writeFileSync(
      preload,
      `globalThis.__calls = 0;\nglobalThis.fetch = async (input, init) => { globalThis.__calls++; const url = new URL(String(input)); const [, congress, type, number] = /\\/bill\\/(\\d+)\\/([a-z]+)\\/(\\d+)\\/titles/.exec(url.pathname) ?? []; ${stub} };\nprocess.on('exit', () => console.log('STUB-CALLS ' + globalThis.__calls));\n`,
    );
    const r = spawnSync(process.execPath, ['--import', preload, 'scripts/sync-short-titles.mjs', ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH ?? '',
        CONGRESS_API_KEY: 'offline-test-key',
        SHORT_TITLES_FILE: outFile,
        SHORT_TITLES_RETRY_FILE: retryFile,
        SHORT_TITLES_TREND_FILE: trendFile,
        SHORT_TITLES_BILLS: corpusFile,
        SHORT_TITLES_REQUEST_TIMEOUT_MS: '300',
        SHORT_TITLES_RETRY_DELAY_MS: '5',
        SHORT_TITLES_TODAY: TODAY,
        ...env,
      },
    });
    const out = `${r.stdout}\n${r.stderr}`;
    const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
    return { code: r.status, out, after: read(outFile), retry: read(retryFile), trend: read(trendFile), dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A stub body answering every bill well, with one short title named for it. */
const GOOD = `const titles = ${JSON.stringify(OFFICIAL)}.concat([{ title: 'Fixture ' + type + number + ' Act', titleType: 'Short Title(s) as Introduced', titleTypeCode: 101, updateDate: 'x' }]);
  return new Response(JSON.stringify({ pagination: { count: titles.length }, request: { billNumber: number, billType: type, congress }, titles }), { status: 200 });`;
const RESHAPED = `return new Response(JSON.stringify({ request: { billNumber: number, billType: type, congress }, data: { titles: [] } }), { status: 200 });`;
const OFFICIAL_ONLY = `return new Response(JSON.stringify({ pagination: { count: ${OFFICIAL.length} }, request: { billNumber: number, billType: type, congress }, titles: ${JSON.stringify(OFFICIAL)} }), { status: 200 });`;
const HANG = `return new Promise((_, reject) => { const socket = setInterval(() => {}, 1000); init.signal.addEventListener('abort', () => { clearInterval(socket); reject(init.signal.reason); }); });`;

const range = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);
const titled = (ns: number[]) => Object.fromEntries(ns.map((n) => [slug(n), { titles: [`Old ${n} Act`], as_of: '2026-01-01', read_on: '2026-11-01' }]));

/**
 * EVERY OUTCOME AND TROUBLE PATH, its setup, and what it must print and
 * return. `outcome` is the summary line's outcome; `line` the TROUBLE line it
 * must print (null: none). The source test below fails if the script has an
 * outcome that no row here names.
 */
const EXIT_PATHS: Array<{
  path: string;
  stub: string;
  files: Files;
  env?: Record<string, string>;
  args?: string[];
  code: number;
  outcome: string;
  line: RegExp | null;
  sourceChanged?: boolean;
}> = [
  { path: 'an ordinary night', stub: GOOD, files: { corpus: range(3).map((n) => bill(n)) }, code: 0, outcome: 'done', line: null },
  { path: 'a dry run', stub: GOOD, files: { corpus: range(3).map((n) => bill(n)) }, args: ['--dry-run'], code: 0, outcome: 'dry-run', line: null },
  { path: 'no API key', stub: GOOD, files: { corpus: [bill(1)] }, env: { CONGRESS_API_KEY: '' }, code: 1, outcome: 'no-key', line: /CONGRESS_API_KEY is not set, so 0 bills could be read/ },
  { path: 'corpus missing', stub: GOOD, files: {}, code: 1, outcome: 'corpus-unreadable', line: /the corpus \(.*\) could not be read/ },
  { path: 'corpus not a list', stub: GOOD, files: { corpusText: '{}' }, code: 1, outcome: 'corpus-unreadable', line: /could not be read \(not a list of bills\)/ },
  { path: 'titles file not JSON', stub: GOOD, files: { corpus: [bill(1)], beforeText: 'not json' }, code: 1, outcome: 'titles-file-unreadable', line: /short-titles\.json is not valid JSON .*Restore it from git/ },
  { path: 'retry file not JSON', stub: GOOD, files: { corpus: [bill(1)], retryText: 'oops' }, code: 0, outcome: 'done', line: /short-titles-retry\.json is not valid JSON .*the step starts it afresh the next time it writes it/ },
  { path: 'retry file not an object', stub: GOOD, files: { corpus: [bill(1)], retryText: '[]' }, code: 0, outcome: 'done', line: /short-titles-retry\.json is not an object; the step starts it afresh the next time it writes it/ },
  { path: 'history damaged', stub: GOOD, files: { corpus: [bill(1)], trendText: '{"nights":"x"}' }, code: 0, outcome: 'done', line: /short-titles-trend\.json could not be used .*the step starts the 14-night history afresh the next time it writes it/ },
  { path: 'history missing beside a titles file', stub: GOOD, files: { corpus: [bill(1)], before: titled([1]) }, code: 0, outcome: 'done', line: /short-titles-trend\.json is missing while .* exists; the step starts the 14-night history afresh the next time it writes it/ },
  { path: 'breaker: 10 transport failures in a row', stub: `return new Response('down', { status: 503 });`, files: { corpus: range(30).map((n) => bill(n)) }, code: 0, outcome: 'stopped-early', line: /stopped early: 10 requests in a row got no usable answer/ },
  { path: 'a 403 is access, not the source changing', stub: `return new Response('no', { status: 403 });`, files: { corpus: range(30).map((n) => bill(n)) }, code: 0, outcome: 'stopped-early', line: /stopped early: Congress\.gov refused the key 10 times in a row \(HTTP 403\): check CONGRESS_API_KEY; 0 bill\(s\) read before it are kept/ },
  { path: 'the hourly limit: 429s say so', stub: `return new Response('slow down', { status: 429 });`, files: { corpus: range(30).map((n) => bill(n)) }, code: 0, outcome: 'stopped-early', line: /stopped early: Congress\.gov answered HTTP 429 to 10 requests in a row, so the key's hourly request limit was reached; 0 bill\(s\) read before it are kept/ },
  { path: 'a 200 with an HTML page is transport, not the source changing', stub: `return new Response('<html><body>maintenance</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });`, files: { corpus: range(30).map((n) => bill(n)) }, code: 0, outcome: 'stopped-early', line: /stopped early: 10 requests in a row/ },
  {
    path: 'an answer body that stops arriving is transport',
    // (A held timer stands in for the open socket that keeps a real process waiting.)
    stub: `return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"x":')); const socket = setInterval(() => {}, 1000); init.signal.addEventListener('abort', () => { clearInterval(socket); c.error(init.signal.reason); }); } }), { status: 200 });`,
    files: { corpus: range(30).map((n) => bill(n)) },
    code: 0,
    outcome: 'stopped-early',
    line: /stopped early: 10 requests in a row/,
  },
  { path: 'request cap', stub: GOOD, files: { corpus: range(SHORT_TITLES_MAX_REQUESTS + 20).map((n) => bill(n)) }, env: { SHORT_TITLES_MAX: '1000' }, code: 0, outcome: 'stopped-early', line: new RegExp(`stopped early: the night's ${SHORT_TITLES_MAX_REQUESTS}-request cap is spent`) },
  { path: 'time budget', stub: HANG, files: { corpus: range(30).map((n) => bill(n)) }, env: { SHORT_TITLES_BUDGET_MS: '700' }, code: 0, outcome: 'stopped-early', line: /stopped early: the step's \d+-minute budget ran out/ },
  { path: 'source changed', stub: RESHAPED, files: { corpus: range(40).map((n) => bill(n)) }, code: 1, outcome: 'source-changed', line: /the source has changed: 40 of 40 answers/, sourceChanged: true },
  { path: 'source changed, with the HTTP status in words', stub: `return new Response('{}', { status: 404 });`, files: { corpus: range(40).map((n) => bill(n)) }, code: 1, outcome: 'source-changed', line: /refused for the same reason \("HTTP 404"\)/, sourceChanged: true },
  {
    path: 'retry pile',
    stub: GOOD,
    files: {
      corpus: range(100).map((n) => bill(n)),
      retry: Object.fromEntries(range(60).map((n) => [slug(n), { failures: 3, last_tried: TODAY, reason: 'HTTP 404' }])),
    },
    code: 0,
    outcome: 'done',
    line: /60 of 100 bills are waiting to be read again \(more than 50\)/,
  },
  {
    path: 'gate refusal (a damaged committed file)',
    stub: GOOD,
    files: { corpus: range(3).map((n) => bill(n)), before: { [slug(1)]: { titles: ['Bad\tTitle'], as_of: '2026-01-01', read_on: TODAY } } },
    code: 1,
    outcome: 'refused-by-gate',
    line: /the file's gate refused tonight's files \(1 problem\(s\); first: .*control character\), so nothing was written/,
  },
  {
    path: 'drop floor',
    stub: `if (Number(number) <= 4) { ${OFFICIAL_ONLY} } ${GOOD}`,
    files: { corpus: range(30).map((n) => bill(n, '2026-02-01')), before: titled(range(30)) },
    code: 1,
    outcome: 'drop-floor',
    line: /bills with a short title would fall 30 -> 26, more than 10% in one night, so nothing was written/,
  },
  {
    path: 'drop floor with the one-run override',
    stub: `if (Number(number) <= 4) { ${OFFICIAL_ONLY} } ${GOOD}`,
    files: { corpus: range(30).map((n) => bill(n, '2026-02-01')), before: titled(range(30)) },
    env: { SHORT_TITLES_ALLOW_DROP: '1', GITHUB_EVENT_NAME: 'workflow_dispatch' },
    code: 0,
    outcome: 'done',
    line: /bills with a short title fell 30 -> 26 .*the one-run override let it through/,
  },
  {
    path: 'drop floor, override ignored on a schedule',
    stub: `if (Number(number) <= 4) { ${OFFICIAL_ONLY} } ${GOOD}`,
    files: { corpus: range(30).map((n) => bill(n, '2026-02-01')), before: titled(range(30)) },
    env: { SHORT_TITLES_ALLOW_DROP: '1', GITHUB_EVENT_NAME: 'schedule' },
    code: 1,
    outcome: 'drop-floor',
    line: /would fall 30 -> 26/,
  },
  { path: 'write error, nothing written', stub: GOOD, files: { corpus: [bill(1)] }, env: { SHORT_TITLES_FILE: '/nonexistent-dir-for-test/x/short-titles.json' }, code: 1, outcome: 'write-error', line: /could not write the files .*written: none; not written: .*short-titles\.json/ },
  { path: 'write error after the titles file was written', stub: GOOD, files: { corpus: [bill(1)] }, env: { SHORT_TITLES_TREND_FILE: '/nonexistent-dir-for-test/x/trend.json' }, code: 1, outcome: 'write-error', line: /could not write the files .*written: .*short-titles\.json.*; not written: .*trend\.json/ },
  { path: 'uncaught exception', stub: GOOD, files: { corpusText: '[null]' }, code: 1, outcome: 'crashed', line: /the step crashed/ },
];

for (const row of EXIT_PATHS) {
  test(`exit path: ${row.path}: exactly one summary line, and the TROUBLE line the digest raises`, () => {
    const r = runScript(row.stub, row.files, row.env, row.args);
    expect(r.code, r.out.slice(-800)).toBe(row.code);
    expect(r.out).not.toContain('offline-test-key');
    // S1: one summary line on every path, with this path's outcome and the day.
    const summaries = r.out.split('\n').filter((l) => l.startsWith('SHORT TITLES SUMMARY: '));
    expect(summaries, r.out.slice(-800)).toHaveLength(1);
    const summary = parseShortTitlesSummary(r.out);
    expect(summary?.outcome).toBe(row.outcome);
    expect(summary?.day).toBe(TODAY);
    // The fill's progress (hotfix 2026-11-17): an ordinary night of 3 bills, all read, leaves none unread.
    if (row.path === 'an ordinary night') expect(summary?.unread).toBe(0);
    const troubles = r.out.split('\n').filter((l) => l.startsWith('SHORT TITLES TROUBLE: '));
    if (row.line === null) {
      expect(troubles, r.out.slice(-800)).toEqual([]);
      return;
    }
    expect(troubles.some((l) => row.line!.test(l)), r.out.slice(-800)).toBe(true);
    const parsed = parseShortTitlesTrouble(r.out);
    expect(parsed).not.toBeNull();
    expect(parsed!.sourceChanged).toBe(row.sourceChanged === true);
    const codes = alarms({ nightly: { conclusion: 'success' }, shortTitlesTrouble: parsed }).map((a) => a.code);
    expect(codes).toContain(row.sourceChanged ? 'short-titles-source-changed' : 'short-titles-stopped');
  });
}

test('main() leaves only through finish(), every outcome has a row, and the exit code is set in one place', () => {
  const src = readFileSync(join(process.cwd(), 'scripts/sync-short-titles.mjs'), 'utf8');
  expect(src.match(/process\.exitCode/g)).toHaveLength(1);
  expect(src).not.toMatch(/process\.exit\(/);
  // Every `return` in main() is `return finish(…)`: a silent `return 0;`, a `return 2;` or a bare `return 1;` fails here.
  const main = src.slice(src.indexOf('async function main()'), src.indexOf('\nmain()'));
  const returns = main.split('\n').filter((l) => /^\s*return\b/.test(l));
  expect(returns.length).toBeGreaterThan(5);
  for (const l of returns) expect(l.trim(), 'a return in main() that skips finish()').toMatch(/^return finish\(/);
  // The script's one entry point hands every way out, a crash included, to finish().
  expect(src).toMatch(/\nmain\(\)\.catch\(\(e\) => finish\(\{ code: 1, outcome: 'crashed'/);
  // Every outcome the script can name is in the table.
  const outcomes = new Set<string>();
  for (const m of main.matchAll(/outcome: '([a-z-]+)'/g)) outcomes.add(m[1]);
  const computed = main.slice(main.indexOf('const outcome ='), main.indexOf(';', main.indexOf('const outcome =')));
  for (const m of computed.matchAll(/'([a-z-]+)'/g)) outcomes.add(m[1]);
  outcomes.add('crashed');
  expect([...outcomes].sort()).toEqual([...new Set(EXIT_PATHS.map((r) => r.outcome))].sort());
  // finish() prints a TROUBLE line for any non-zero code, reason or not, then the summary.
  const fin = src.slice(src.indexOf('function finish('), src.indexOf('\n}\n', src.indexOf('function finish(')));
  expect(fin).toMatch(/if \(reason\) trouble\(reason/);
  expect(fin).toMatch(/else if \(code !== 0\) trouble\(/);
  expect(fin).toMatch(/console\.log\(summaryLine\(/);
});

// --- (i) to (v), night by night ---------------------------------------------------------

test('(i) one bill with a tab, one with a newline, one with a 401-character title: every other bill still updates that night', () => {
  const corpus = range(10).map((n) => bill(n, '2026-02-01'));
  const odd: Record<number, string> = { 2: 'Tab\tAct', 5: 'New\nline Act', 8: 'L'.repeat(SHORT_TITLE_MAX_LENGTH + 1) };
  const stub = `const odd = ${JSON.stringify(odd)}; if (odd[number]) { const titles = ${JSON.stringify(OFFICIAL)}.concat([{ title: odd[number], titleType: 'Short Title(s) as Introduced', titleTypeCode: 101, updateDate: 'x' }]);
    return new Response(JSON.stringify({ pagination: { count: titles.length }, request: { billNumber: number, billType: type, congress }, titles }), { status: 200 }); } ${GOOD}`;
  const before = titled(range(10));
  const r = runScript(stub, { corpus, before, trend: { nights: [] } });
  expect(r.code, r.out).toBe(0);
  expect(r.out).not.toContain('SHORT TITLES TROUBLE');
  const after = JSON.parse(r.after!);
  for (const n of range(10)) {
    if (odd[n]) expect(after[slug(n)], `hr${n} keeps what it had`).toEqual(before[slug(n)]);
    else expect(after[slug(n)].titles, `hr${n} updated`).toEqual([`Fixture hr${n} Act`]);
  }
  const retry = JSON.parse(r.retry!);
  expect(Object.keys(retry).sort()).toEqual([slug(2), slug(5), slug(8)].sort());
  expect(retry[slug(2)].reason).toBe('a short title the file cannot hold: a title with a control character');
  expect(retry[slug(8)].reason).toBe(`a short title the file cannot hold: a title over ${SHORT_TITLE_MAX_LENGTH} characters`);
});

test('(ii) 11% of titled bills lose their short title: refused loudly, nothing written; the one-run override writes it', () => {
  const corpus = range(100).map((n) => bill(n, '2026-02-01'));
  const before = titled(range(100));
  const stub = `if (Number(number) <= 11) { ${OFFICIAL_ONLY} } ${GOOD}`;
  const refused = runScript(stub, { corpus, before });
  expect(refused.code).toBe(1);
  expect(refused.out).toMatch(/SHORT TITLES TROUBLE: bills with a short title would fall 100 -> 89/);
  expect(JSON.parse(refused.after!)).toEqual(before);
  const through = runScript(stub, { corpus, before }, { SHORT_TITLES_ALLOW_DROP: '1', GITHUB_EVENT_NAME: 'workflow_dispatch' });
  expect(through.code).toBe(0);
  expect(through.out).toMatch(/SHORT TITLES TROUBLE: bills with a short title fell 100 -> 89 .*override let it through/);
  const after = JSON.parse(through.after!);
  expect(after[slug(3)].titles).toEqual([]);
  expect(after[slug(50)].titles).toEqual(['Fixture hr50 Act']);
  // Round 6: the history marks the override night, and the summary names it, so the falling alarm can say so.
  expect(JSON.parse(String(through.trend)).nights.at(-1)).toEqual({ day: TODAY, titled: 89, bills: 100, allow_drop: true, filled: true });
  expect(through.out).toMatch(new RegExp(`SHORT TITLES SUMMARY: .* drop_approved_on=${TODAY} unread=0 untried=0 filled_before=no$`, 'm'));
  expect(JSON.parse(String(refused.trend)).nights.at(-1)).not.toHaveProperty('allow_drop');
});

/** One night in-process: the same two functions the script runs, with the files carried over. */
async function simulateNight(state: { file: Record<string, unknown>; retry: Record<string, unknown> }, bills: ReturnType<typeof bill>[], today: string, fetchPage: (b: { bill_number: number; bill_type: string }, offset: number) => Promise<unknown>) {
  const night = await runShortTitlesNight({ bills, file: state.file, retry: state.retry, today, fetchPage });
  const settled = settleNight({ night, bills, before: Object.keys(state.file).length ? state.file : null });
  if (settled.write) {
    if (settled.write.titles) state.file = JSON.parse(settled.write.text);
    state.retry = JSON.parse(settled.write.retryText);
  }
  return { night, settled };
}

const day = (start: string, plus: number) => new Date(Date.parse(`${start}T00:00:00Z`) + plus * 86_400_000).toISOString().slice(0, 10);

test('(iii) 20 bills refused for one reason at the head of the queue: the bills behind them are read by night 2', async () => {
  const bills = range(60).map((n) => bill(n)); // hr1..hr20 most urgent
  const fetchPage = async (b: { bill_number: number; bill_type: string }) => {
    if (b.bill_number <= 20) throw new Refused('HTTP 404');
    return answer('hr', b.bill_number, [`Fixture hr${b.bill_number} Act`]);
  };
  const state = { file: {}, retry: {} };
  await simulateNight(state, bills, day(TODAY, 0), fetchPage);
  const n2 = await simulateNight(state, bills, day(TODAY, 1), fetchPage);
  for (const n of range(40, 21)) expect(Object.keys(state.file), `hr${n} read by night 2`).toContain(slug(n));
  expect(n2.settled.troubles).toEqual([]); // retrying bills never count toward "the source has changed"
  expect(Object.keys(state.retry)).toHaveLength(20);
});

test('bills already retrying never count toward "the source has changed": 30 due retries refused, 25 healthy bills read', async () => {
  const bills = range(55).map((n) => bill(n));
  const retry = Object.fromEntries(range(30).map((n) => [slug(n), { failures: 1, last_tried: day(TODAY, -3), reason: 'HTTP 404' }]));
  const fetchPage = async (b: { bill_number: number }) => {
    if (b.bill_number <= 30) throw new Refused('HTTP 404');
    return answer('hr', b.bill_number, [`Fixture hr${b.bill_number} Act`]);
  };
  const night = await runShortTitlesNight({ bills, file: {}, retry, today: TODAY, fetchPage });
  expect(night.read).toBe(25);
  expect(night.failed).toBe(30);
  expect(night.sourceChanged).toBe(false);
  expect(night.trouble).toBeNull();
  // The same night with every refusal coming from a bill NOT already retrying is the source changing.
  const freshNight = await runShortTitlesNight({ bills, file: {}, retry: {}, today: TODAY, fetchPage });
  expect(freshNight.sourceChanged).toBe(true);
  // And the other way round: 25 bills not retrying, every one refused alike, while 30 retrying bills read fine,
  // is the source changing: the retrying answers are not in the count at all.
  const flipped = async (b: { bill_number: number }) => {
    if (b.bill_number > 30) throw new Refused('HTTP 404');
    return answer('hr', b.bill_number, [`Fixture hr${b.bill_number} Act`]);
  };
  const mixed = await runShortTitlesNight({ bills, file: {}, retry, today: TODAY, fetchPage: flipped });
  expect(mixed.read).toBe(30);
  expect(mixed.sourceChanged).toBe(true);
});

test('(iv) 120 nights, 25 bills that always 404 and a trickle of new and moved bills: no false alarm, every healthy bill read in time, the retry file bounded', async () => {
  // A seeded generator, so the run is the same every time.
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const START = '2027-01-04';
  // 2,000 healthy bills already read, their reads spread over the last 56 days; 25 bad bills never read.
  const bills: ReturnType<typeof bill>[] = range(2000).map((n) => bill(n, '2026-12-01', rand()));
  const bad = new Set(range(25, 5001));
  for (const n of bad) bills.push(bill(n, '2026-12-01', rand()));
  const state: { file: Record<string, { titles: string[]; as_of: string | null; read_on: string }>; retry: Record<string, unknown> } = {
    file: Object.fromEntries(range(2000).map((n) => [slug(n), { titles: [`Fixture hr${n} Act`], as_of: '2026-12-01', read_on: day(START, -1 - (n % 56)) }])),
    retry: {},
  };
  const fetchPage = async (b: { bill_number: number }) => {
    if (bad.has(b.bill_number)) throw new Refused('HTTP 404');
    return answer('hr', b.bill_number, [`Fixture hr${b.bill_number} Act`]);
  };
  let nextNumber = 2001;
  const troubles: string[] = [];
  let maxRetry = 0;
  let maxDue = 0;
  const late: string[] = [];
  for (let night = 0; night < 120; night++) {
    const today = day(START, night);
    // A trickle: 0 to 6 new bills, and 20 to 40 bills whose last action moves.
    const added = Math.floor(rand() * 7);
    for (let i = 0; i < added; i++) bills.push(bill(nextNumber++, today, rand()));
    const moved = 20 + Math.floor(rand() * 21);
    for (let i = 0; i < moved; i++) bills[Math.floor(rand() * 2000)].last_action_date = today;
    const { settled } = await simulateNight(state, bills, today, fetchPage);
    troubles.push(...settled.troubles.map((t) => `night ${night + 1}: ${t.reason}`));
    maxRetry = Math.max(maxRetry, Object.keys(state.retry).length);
    // THE BOUND: after each night, every healthy bill is read, current with its last action, and read within 56 days.
    // (Checked in plain code and asserted once below: a million expect() calls would take minutes.)
    for (const b of bills) {
      if (bad.has(b.bill_number)) continue;
      const e = state.file[slug(b.bill_number)];
      if (!e) late.push(`hr${b.bill_number} not read by night ${night + 1}`);
      else if (e.as_of !== b.last_action_date) late.push(`hr${b.bill_number} not current after night ${night + 1}`);
      else maxDue = Math.max(maxDue, (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${e.read_on}T00:00:00Z`)) / 86_400_000);
    }
  }
  expect(late.slice(0, 5)).toEqual([]);
  expect(troubles, 'no TROUBLE line, and so no "needs a person" alarm, in 120 nights').toEqual([]);
  expect(maxRetry).toBe(25);
  expect(maxDue).toBeLessThanOrEqual(56);
});

test('(v) every answer reshaped for good: a TROUBLE line every night, and the titles file is never written', async () => {
  const bills = range(100).map((n) => bill(n));
  const fetchPage = async (b: { bill_number: number }) => ({ request: { billNumber: String(b.bill_number), billType: 'hr', congress: '119' }, data: { titles: [] } });
  const state = { file: titled(range(100)) as Record<string, unknown>, retry: {} };
  const original = JSON.stringify(state.file);
  for (let night = 0; night < 40; night++) {
    // Every bill due: their last action moves each night.
    for (const b of bills) b.last_action_date = day(TODAY, night);
    const { settled } = await simulateNight(state, bills, day(TODAY, night), fetchPage);
    expect(settled.troubles.length, `night ${night + 1}`).toBeGreaterThan(0);
    const text = settled.troubles.map((t) => `SHORT TITLES TROUBLE: ${t.reason}`).join('\n');
    expect(parseShortTitlesTrouble(text), `night ${night + 1}`).not.toBeNull();
  }
  expect(JSON.stringify(state.file)).toBe(original);
  expect(Object.keys(state.retry).length).toBeGreaterThan(RETRY_PILE_MIN);
});

// --- the per-bill test and the file's gate cannot disagree ----------------------------------

test('a bill answer the reader accepts always passes the file gate, and one the gate would refuse is refused for that bill alone', () => {
  const samples = ['Plain Act', ' Spaced Act ', 'Tab\tAct', 'Line\nAct', 'Return\rAct', 'Del\u007fAct', 'x'.repeat(400), 'x'.repeat(401), ' Act', 'Ünïcode Act', '日本 Act'];
  for (const title of samples) {
    const verdict = readTitlesAnswer(answer('hr', 1, [title]), bill(1));
    const gate = verifyShortTitles({ data: { [slug(1)]: { titles: [title], as_of: null, read_on: TODAY } }, bills: [bill(1)] });
    expect(verdict.ok, JSON.stringify(title)).toBe(gate.failures.length === 0);
    expect(verdict.ok).toBe(shortTitleProblem(title) === null);
  }
  // Both call the same function.
  const lib = readFileSync(join(process.cwd(), 'lib/short-titles.mjs'), 'utf8');
  expect(lib.match(/shortTitleProblem\(t\)/g)!.length).toBeGreaterThanOrEqual(2);
});

test('follow-up 3: a night with no key and a damaged history writes nothing, and its TROUBLE line says the history will be started afresh, not that it was', () => {
  const r = runScript(GOOD, { corpus: [bill(1)], trendText: '{"nights":"x"}' }, { CONGRESS_API_KEY: '' });
  expect(r.code).toBe(1);
  expect(r.out).toMatch(/SHORT TITLES TROUBLE: .*short-titles-trend\.json could not be used .*; the step starts the 14-night history afresh the next time it writes it/);
  expect(r.out).not.toContain('was started afresh');
  expect(r.trend).toBe('{"nights":"x"}');
});

test('follow-up 5: the script carries the history’s `filled` mark forward on a night that leaves bills unread', () => {
  const yesterday = day(TODAY, -1);
  const r = runScript(GOOD, { corpus: range(5).map((n) => bill(n)), trend: { nights: [{ day: yesterday, titled: 0, bills: 5, filled: true }] } }, { SHORT_TITLES_MAX: '2' });
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/SHORT TITLES SUMMARY: .* unread=3 untried=3 filled_before=yes$/m);
  expect(JSON.parse(String(r.trend)).nights.at(-1)).toMatchObject({ day: TODAY, filled: true });
  // Without the mark, such a night does not set it.
  const before = runScript(GOOD, { corpus: range(5).map((n) => bill(n)), trend: { nights: [] } }, { SHORT_TITLES_MAX: '2' });
  expect(JSON.parse(String(before.trend)).nights.at(-1)).not.toHaveProperty('filled');
});
