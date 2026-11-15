import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  planShortTitleReads,
  readTitlesAnswer,
  serializeShortTitles,
  SHORT_TITLES_MAX_CONSECUTIVE_FAILURES,
  SHORT_TITLES_MAX_PER_NIGHT,
  SHORT_TITLES_REFRESH_DAYS,
  verifyShortTitles,
} from '../lib/short-titles.mjs';

/*
 * The nightly read of the record's short titles (scripts/sync-short-titles.mjs,
 * data/short-titles.json): which bills it reads, what counts as a read, the
 * file it writes, the gate scripts/verify-sync.mjs runs before the commit
 * (hard rule 11), and the script itself run offline against a stubbed
 * network: a wrong-bill answer, a reshaped answer, ten failures in a row and
 * a hang.
 */

const bill = (type: string, n: number, last: string | null, urgency = 0) => ({
  bill_type: type,
  bill_number: n,
  congress_number: 119,
  last_action_date: last,
  urgency_score: urgency,
});
const TODAY = '2026-11-15';

/** A real answer, read live for H.R. 9770 on 2026-11-15 (no key in it). */
const LIVE = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/congress-gov-titles-hr-9770-119.json'), 'utf8'));

test('the saved live answer has the shape the reader relies on, and no key', () => {
  expect(Object.keys(LIVE).sort()).toEqual(['pagination', 'request', 'titles']);
  expect(Object.keys(LIVE.request).sort()).toEqual(['billNumber', 'billType', 'billUrl', 'congress', 'contentType', 'format']);
  expect(LIVE.request).toMatchObject({ billNumber: '9770', billType: 'hr', congress: '119' });
  expect(LIVE.pagination.count).toBe(LIVE.titles.length);
  for (const t of LIVE.titles) expect(Object.keys(t)).toEqual(expect.arrayContaining(['title', 'titleType', 'titleTypeCode', 'updateDate']));
  expect(JSON.stringify(LIVE)).not.toMatch(/api_key/i);
  // Every bill's list holds an official title; this one also has short titles.
  expect(LIVE.titles.some((t: { titleType: string }) => /^Official Title/.test(t.titleType))).toBe(true);
  expect(readTitlesAnswer(LIVE, bill('hr', 9770, null))).toEqual({ ok: true, titles: ['Continuing Appropriations Act, 2027'] });
});

test('a read counts only when the answer is plainly about this bill and whole', () => {
  const hr9770 = bill('hr', 9770, null);
  const fail = (answer: unknown, b = hr9770) => {
    const v = readTitlesAnswer(answer, b);
    expect(v.ok, JSON.stringify(answer).slice(0, 80)).toBe(false);
    return (v as { reason: string }).reason;
  };
  // About another bill: another number, type or Congress.
  expect(fail({ ...LIVE, request: { ...LIVE.request, billNumber: '9771' } })).toContain('another bill');
  expect(fail({ ...LIVE, request: { ...LIVE.request, billType: 's' } })).toContain('another bill');
  expect(fail({ ...LIVE, request: { ...LIVE.request, congress: '118' } })).toContain('another bill');
  expect(fail(LIVE, bill('s', 9770, null))).toContain('another bill');
  expect(fail({ titles: LIVE.titles })).toContain('which bill');
  // Reshaped or broken.
  expect(fail({ request: LIVE.request, title_list: LIVE.titles })).toContain('no list');
  expect(fail({ request: LIVE.request, titles: { items: LIVE.titles } })).toContain('no list');
  expect(fail({ request: LIVE.request, titles: [] })).toContain('empty');
  expect(fail({ ...LIVE, pagination: { count: 40 } })).toContain('incomplete');
  expect(fail({ error: { code: 'OVER_RATE_LIMIT', message: 'x' } })).toContain('error');
  expect(fail({ ...LIVE, error: 'x' })).toContain('error');
  expect(fail(null)).toContain('not an object');
  expect(fail([])).toContain('not an object');
  // A bill with no short title: a whole list with none labelled short.
  const officialOnly = { ...LIVE, titles: LIVE.titles.filter((t: { titleType: string }) => !/^Short/.test(t.titleType)), pagination: { count: 3 } };
  expect(readTitlesAnswer(officialOnly, hr9770)).toEqual({ ok: true, titles: [] });
});

test('plan: never read, then last action moved, then not read for the refresh interval; never past the cap', () => {
  const bills = [bill('hr', 1, '2026-01-01', 0.2), bill('s', 5, '2026-02-01', 0.9), bill('hr', 4, '2026-03-01', 0.5), bill('hr', 9, '2026-03-02', 0.1), bill('hr', 10, '2026-03-02'), bill('hr', 11, '2026-03-02')];
  const file = {
    'hr-4-119': { titles: ['Rescissions Act of 2025'], as_of: '2026-02-15', read_on: TODAY }, // moved since
    'hr-9-119': { titles: [], as_of: '2026-03-02', read_on: TODAY }, // fresh: not read again
    'hr-10-119': { titles: [], as_of: '2026-03-02', read_on: '2026-09-01' }, // 75 days: due
    'hr-11-119': { titles: [], as_of: '2026-03-02', read_on: '2026-09-20' }, // 56 days: due
  };
  const plan = planShortTitleReads({ bills, file, cap: 10, today: TODAY });
  expect(plan.run).toEqual(['s-5-119', 'hr-1-119', 'hr-4-119', 'hr-10-119', 'hr-11-119']);
  expect(plan).toMatchObject({ neverRead: 2, stale: 1, overdue: 2, deferred: 0 });
  expect(planShortTitleReads({ bills, file, cap: 4, today: TODAY }).run).toEqual(['s-5-119', 'hr-1-119', 'hr-4-119', 'hr-10-119']);
  // 55 days: not yet due.
  expect(planShortTitleReads({ bills, file, cap: 10, today: '2026-11-14' }).overdue).toBe(1);
  expect(planShortTitleReads({ bills, file, cap: Number.NaN, today: TODAY }).run).toHaveLength(5);
  expect(SHORT_TITLES_MAX_PER_NIGHT).toBe(500);
  expect(SHORT_TITLES_REFRESH_DAYS).toBe(56);
  expect(SHORT_TITLES_MAX_CONSECUTIVE_FAILURES).toBe(10);
});

test('the file: one line per bill, sorted, bills the corpus no longer holds dropped', () => {
  const bills = [bill('s', 5, null), bill('hr', 4, null)];
  const text = serializeShortTitles(
    {
      's-5-119': { titles: ['Laken Riley Act'], as_of: '2025-01-29', read_on: TODAY },
      'hr-4-119': { titles: [], as_of: null, read_on: TODAY },
      'hr-77-119': { titles: ['Gone Act'], as_of: null, read_on: TODAY },
    },
    bills,
  );
  expect(text).toBe(
    '{\n"hr-4-119":{"titles":[],"as_of":null,"read_on":"2026-11-15"},\n"s-5-119":{"titles":["Laken Riley Act"],"as_of":"2025-01-29","read_on":"2026-11-15"}\n}\n',
  );
  expect(serializeShortTitles({}, bills)).toBe('{}\n');
});

test('the gate refuses every kind of damage it names, and passes a good file', () => {
  const bills = [bill('s', 5, null), bill('hr', 4, null)];
  const R = { read_on: TODAY };
  const good = { 's-5-119': { titles: ['Laken Riley Act'], as_of: '2025-01-29', ...R }, 'hr-4-119': { titles: [], as_of: null, ...R } };
  expect(verifyShortTitles({ data: good, bills }).failures).toEqual([]);
  const fails = (data: unknown, before: unknown = null) => verifyShortTitles({ data, bills, before }).failures;
  expect(fails([])).toHaveLength(1);
  expect(fails({ ...good, 'laken-riley-act': { titles: [], as_of: null, ...R } }).join()).toContain('not a bill slug');
  expect(fails({ ...good, 's-6-119': { titles: [], as_of: null, ...R } }).join()).toContain('not in data/bills.json');
  expect(fails({ ...good, 's-5-119': { titles: ['A'], as_of: null, ...R, extra: 1 } }).join()).toContain('expected [as_of,read_on,titles]');
  expect(fails({ ...good, 's-5-119': { titles: ['A'], as_of: null } }).join()).toContain('read_on');
  expect(fails({ ...good, 's-5-119': { titles: [''], as_of: null, ...R } }).join()).toContain('empty');
  expect(fails({ ...good, 's-5-119': { titles: ['x'.repeat(401)], as_of: null, ...R } }).join()).toContain('over 400');
  expect(fails({ ...good, 's-5-119': { titles: ['A\tB'], as_of: null, ...R } }).join()).toContain('control');
  expect(fails({ ...good, 's-5-119': { titles: ['A', 'A'], as_of: null, ...R } }).join()).toContain('repeats');
  expect(fails({ ...good, 's-5-119': { titles: ['B', 'A'], as_of: null, ...R } }).join()).toContain('code-point order');
  expect(fails({ ...good, 's-5-119': { titles: [], as_of: '2025-1-1', ...R } }).join()).toContain('as_of');
  expect(fails({ ...good, 's-5-119': { titles: 'A', as_of: null, ...R } }).join()).toContain('not an array');
  expect(fails({ ...good, 's-5-119': { titles: [], as_of: null, ...R } }, good).join()).toContain('now has none');
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`hr-${i + 1}-119`, { titles: [`Act ${i}`], as_of: null, ...R }]));
  const manyBills = Array.from({ length: 30 }, (_, i) => bill('hr', i + 1, null));
  const shrunk = Object.fromEntries(Object.entries(many).slice(0, 20));
  expect(verifyShortTitles({ data: shrunk, bills: manyBills, before: many }).failures.join()).toContain('fell 30 -> 20');
});

test('the nightly runs the gate before it writes, the step is bounded, and it can never hold the night', () => {
  const sync = readFileSync(join(process.cwd(), 'scripts/sync-short-titles.mjs'), 'utf8');
  expect(sync.indexOf('verifyShortTitles(')).toBeGreaterThan(0);
  expect(sync.indexOf('verifyShortTitles(')).toBeLessThan(sync.indexOf('writeFileSync(OUT'));
  // The URL carries the key: no line of the script prints it or a message built from it.
  expect(sync).not.toMatch(/console\.\w+\([^)]*\burl\b/);
  const verify = readFileSync(join(process.cwd(), 'scripts/verify-sync.mjs'), 'utf8');
  expect(verify).toContain('verifyShortTitles({ data: shortTitles');
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/sync-bills.yml'), 'utf8');
  const step = workflow.indexOf('run: node scripts/sync-short-titles.mjs');
  expect(step).toBeGreaterThan(workflow.indexOf('run: node scripts/sync-bills.mjs'));
  expect(step).toBeLessThan(workflow.indexOf('run: node scripts/verify-sync.mjs'));
  const block = workflow.slice(workflow.lastIndexOf('- name:', step), step);
  expect(block).toContain('continue-on-error: true');
  expect(block).toMatch(/timeout-minutes: 25\n/);
  expect(block).toContain('CONGRESS_API_KEY');
  expect(block).not.toMatch(/ANTHROPIC|NEWS_API|BLOB/);
});

// --- the script itself, offline -------------------------------------------------------

/**
 * Run scripts/sync-short-titles.mjs with globalThis.fetch replaced by `stub`
 * (a function body taking `url` and returning a Response or a Promise), on a
 * small corpus, writing to a scratch file. Nothing reaches the network.
 */
function runOffline(stub: string, opts: { corpus: unknown[]; before?: unknown; env?: Record<string, string> }) {
  const dir = mkdtempSync(join(tmpdir(), 'short-titles-'));
  try {
    const corpusFile = join(dir, 'bills.json');
    const outFile = join(dir, 'short-titles.json');
    writeFileSync(corpusFile, JSON.stringify(opts.corpus));
    if (opts.before) writeFileSync(outFile, JSON.stringify(opts.before));
    const preload = join(dir, 'stub.mjs');
    writeFileSync(
      preload,
      `globalThis.__calls = 0;\nglobalThis.fetch = async (input, init) => { globalThis.__calls++; const url = new URL(String(input)); ${stub} };\nprocess.on('exit', () => console.log('STUB-CALLS ' + globalThis.__calls));\n`,
    );
    const r = spawnSync(process.execPath, ['--import', preload, 'scripts/sync-short-titles.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH ?? '',
        CONGRESS_API_KEY: 'offline-test-key',
        SHORT_TITLES_FILE: outFile,
        SHORT_TITLES_BILLS: corpusFile,
        SHORT_TITLES_REQUEST_TIMEOUT_MS: '300',
        SHORT_TITLES_RETRY_DELAY_MS: '10',
        ...(opts.env ?? {}),
      },
    });
    const after = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : null;
    return { status: r.status, out: `${r.stdout}\n${r.stderr}`, after };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A stub that answers each bill with LIVE's shape, about the bill the URL names. */
const ANSWER_FOR_URL = `
  const [, congress, type, number] = /\\/bill\\/(\\d+)\\/([a-z]+)\\/(\\d+)\\/titles/.exec(url.pathname);
  const titles = ${JSON.stringify(LIVE.titles)}.map((t) => ({ ...t, title: t.titleType.startsWith('Short') ? 'Fixture ' + type + number + ' Act' : t.title }));
  return new Response(JSON.stringify({ pagination: { count: titles.length }, request: { billNumber: number, billType: type, congress, format: 'json' }, titles }), { status: 200 });
`;

const corpus = [bill('hr', 9770, '2026-11-01', 0.9), bill('s', 5, '2026-01-01', 0.5), bill('hr', 29, '2026-01-02', 0.1)];
const good = {
  'hr-9770-119': { titles: ['Continuing Appropriations Act, 2027'], as_of: '2026-10-01', read_on: '2026-10-01' },
};

test('offline: good answers are read, and the key never appears in what the script prints', () => {
  const r = runOffline(ANSWER_FOR_URL, { corpus });
  expect(r.status).toBe(0);
  expect(r.after['hr-9770-119'].titles).toEqual(['Fixture hr9770 Act']);
  expect(r.after['s-5-119'].titles).toEqual(['Fixture s5 Act']);
  expect(Object.keys(r.after)).toHaveLength(3);
  expect(r.out).toContain('STUB-CALLS 3');
  expect(r.out).not.toContain('offline-test-key');
});

test('offline: an answer about another bill is a failed read and keeps what was stored', () => {
  // Every request is answered with H.R. 1's titles, whatever bill it asked for.
  const wrong = `return new Response(JSON.stringify({ ...${JSON.stringify(LIVE)}, request: { billNumber: '1', billType: 'hr', congress: '119' } }), { status: 200 });`;
  const r = runOffline(wrong, { corpus, before: good });
  expect(r.status).toBe(0);
  expect(r.out).toContain('another bill');
  expect(r.after).toEqual(good); // nothing replaced, nothing new stored
  expect(r.out).toContain('no bill read');
});

test('offline: a reshaped answer (no titles list) marks nothing as read', () => {
  const reshaped = `return new Response(JSON.stringify({ request: { billNumber: url.pathname.split('/')[5], billType: url.pathname.split('/')[4], congress: '119' }, bill_titles: [] }), { status: 200 });`;
  const r = runOffline(reshaped, { corpus, before: good });
  expect(r.status).toBe(0);
  expect(r.out).toContain('no list of titles');
  expect(r.after).toEqual(good);
  // An error body, with a 200, is a failed read too.
  const errorBody = `return new Response(JSON.stringify({ error: { code: 'API_KEY_INVALID', message: 'x' } }), { status: 200 });`;
  expect(runOffline(errorBody, { corpus, before: good }).after).toEqual(good);
});

test('offline: ten failed reads in a row stop the night with one clear line; the reads before them are kept', () => {
  const many = Array.from({ length: 30 }, (_, i) => bill('hr', i + 1, '2026-01-01', 1 - i / 100));
  // The first two bills (most urgent) answer; every one after fails with a 503.
  const stub = `if (/\\/hr\\/(1|2)\\/titles/.test(url.pathname)) { ${ANSWER_FOR_URL} } return new Response('down', { status: 503 });`;
  const r = runOffline(stub, { corpus: many });
  expect(r.status).toBe(0);
  expect(r.out).toContain('stopped early because 10 reads in a row failed');
  expect(Object.keys(r.after).sort()).toEqual(['hr-1-119', 'hr-2-119']);
  // 2 good requests, then 10 bills with one retry each: 22. Never more.
  expect(r.out).toContain('STUB-CALLS 22');
});

test('offline: a hanging endpoint costs at most the per-request ceiling, twice, per bill, and the budget stops the night', () => {
  // Never answers; gives up only when the script's own ceiling aborts the request.
  // (A held timer stands in for the open socket that keeps a real process waiting.)
  const hang = `return new Promise((_, reject) => { const socket = setInterval(() => {}, 1000); init.signal.addEventListener('abort', () => { clearInterval(socket); reject(init.signal.reason); }); });`;
  const many = Array.from({ length: 30 }, (_, i) => bill('hr', i + 1, '2026-01-01'));
  const t0 = Date.now();
  const r = runOffline(hang, { corpus: many, before: good, env: { SHORT_TITLES_BUDGET_MS: '1500' } });
  const ms = Date.now() - t0;
  expect(r.status).toBe(0);
  // Each bill costs two 300 ms ceilings: the 1.5 s budget runs out after about three bills, long before ten failures.
  expect(r.out).toMatch(/stopped early because the step's \d+-minute budget ran out/);
  expect(r.out).toContain(`no answer within 300 ms`);
  expect(r.after).toEqual(good);
  expect(ms).toBeLessThan(30_000);
});
