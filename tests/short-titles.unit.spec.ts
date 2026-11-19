import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { alarms, parseShortTitlesTrouble } from '../lib/pipeline-health.mjs';
import {
  planShortTitleReads,
  readTitlesAnswer,
  retryWaitDays,
  serializeRetries,
  verifyShortTitleRetries,
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
  expect(fail({ ...LIVE, pagination: { count: 4 } })).toContain('incomplete');
  // The count is required, and a count sent as a string still counts.
  expect(fail({ ...LIVE, pagination: {} })).toContain('no count');
  expect(fail({ request: LIVE.request, titles: LIVE.titles })).toContain('no count');
  expect(fail({ ...LIVE, pagination: { count: 'many' } })).toContain('no count');
  expect(fail({ ...LIVE, pagination: { count: '40' } })).toContain('incomplete');
  expect(readTitlesAnswer({ ...LIVE, pagination: { count: String(LIVE.titles.length) } }, hr9770).ok).toBe(true);
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
  expect(SHORT_TITLES_MAX_PER_NIGHT).toBe(300);
  expect(SHORT_TITLES_REFRESH_DAYS).toBe(56);
  expect(SHORT_TITLES_MAX_CONSECUTIVE_FAILURES).toBe(10);
});

test('a failed bill waits 1, 2, 4, 8, 16, then 32 days, and comes after every other bill when its wait is over', () => {
  expect([1, 2, 3, 4, 5, 6, 7, 50].map(retryWaitDays)).toEqual([1, 2, 4, 8, 16, 32, 32, 32]);
  const bills = [bill('hr', 1, '2026-01-01', 0.9), bill('hr', 2, '2026-01-01', 0.8), bill('hr', 3, '2026-01-01', 0.1), bill('hr', 4, '2026-01-01', 0.05)];
  const retry = {
    'hr-1-119': { failures: 1, last_tried: '2026-11-14', reason: 'HTTP 404' }, // waited 1 day: due, at the back
    'hr-2-119': { failures: 3, last_tried: '2026-11-13', reason: 'HTTP 404' }, // 2 of 4 days: still waiting
  };
  const plan = planShortTitleReads({ bills, file: {}, retry, cap: 10, today: TODAY });
  expect(plan.run).toEqual(['hr-3-119', 'hr-4-119', 'hr-1-119']);
  expect(plan).toMatchObject({ neverRead: 2, retrying: 1, waiting: 1 });
  expect(planShortTitleReads({ bills, file: {}, retry, cap: 2, today: TODAY }).run).toEqual(['hr-3-119', 'hr-4-119']);
});

test('the retry file has its own gate', () => {
  const bills = [bill('s', 5, null)];
  const ok = { 's-5-119': { failures: 2, last_tried: TODAY, reason: 'HTTP 404' } };
  expect(verifyShortTitleRetries({ data: ok, bills }).failures).toEqual([]);
  expect(verifyShortTitleRetries({ data: { 's-6-119': ok['s-5-119'] }, bills }).failures).toEqual([]); // a note
  for (const bad of [[], { abc: ok['s-5-119'] }, { 's-5-119': { failures: 0, last_tried: TODAY, reason: 'x' } }, { 's-5-119': { failures: 1, last_tried: 'x', reason: 'x' } }, { 's-5-119': { failures: 1, last_tried: TODAY, reason: '' } }, { 's-5-119': { failures: 1, last_tried: TODAY } }]) {
    expect(verifyShortTitleRetries({ data: bad, bills }).failures.length, JSON.stringify(bad)).toBeGreaterThan(0);
  }
  expect(serializeRetries({ 's-5-119': ok['s-5-119'], 'hr-1-119': ok['s-5-119'] }, bills)).toBe(
    '{\n"s-5-119":{"failures":2,"last_tried":"2026-11-15","reason":"HTTP 404"}\n}\n',
  );
});

test('the daily pipeline-health digest raises the TROUBLE line as an alarm', () => {
  const changed = 'nightly\tRead the record\'s short titles\t2026-11-15T14:40:00.0Z SHORT TITLES TROUBLE: the source has changed: 20 of 20 answers tonight were refused for the same reason ("x"); stopped, and no bill is marked as failed for it; 0 bill(s) read before it are kept';
  expect(parseShortTitlesTrouble(changed)).toMatchObject({ sourceChanged: true });
  expect(alarms({ nightly: { conclusion: 'success' }, shortTitlesTrouble: parseShortTitlesTrouble(changed) }).map((a) => a.code)).toContain('short-titles-source-changed');
  const down = 'SHORT TITLES TROUBLE: stopped early: 10 requests in a row got no usable answer from Congress.gov (no answer, an error page or a broken connection); 3 bill(s) read before it are kept';
  expect(parseShortTitlesTrouble(down)).toMatchObject({ sourceChanged: false });
  expect(alarms({ nightly: { conclusion: 'success' }, shortTitlesTrouble: parseShortTitlesTrouble(down) }).map((a) => a.code)).toContain('short-titles-stopped');
  expect(parseShortTitlesTrouble('short titles: 500 request(s), 500 bill(s) read')).toBeNull();
  // The script prints exactly that line.
  expect(readFileSync(join(process.cwd(), 'scripts/sync-short-titles.mjs'), 'utf8')).toContain('console.log(`SHORT TITLES TROUBLE: ${reason}`);');
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
  // A bill the corpus no longer holds: a note, not a failure (the name table only walks the corpus).
  expect(fails({ ...good, 's-6-119': { titles: [], as_of: null, ...R } })).toEqual([]);
  expect(fails({ ...good, 's-5-119': { titles: ['A'], as_of: null, ...R, extra: 1 } }).join()).toContain('expected [as_of,read_on,titles]');
  expect(fails({ ...good, 's-5-119': { titles: ['A'], as_of: null } }).join()).toContain('read_on');
  expect(fails({ ...good, 's-5-119': { titles: [''], as_of: null, ...R } }).join()).toContain('empty');
  expect(fails({ ...good, 's-5-119': { titles: ['x'.repeat(401)], as_of: null, ...R } }).join()).toContain('over 400');
  expect(fails({ ...good, 's-5-119': { titles: ['A\tB'], as_of: null, ...R } }).join()).toContain('control');
  expect(fails({ ...good, 's-5-119': { titles: ['A', 'A'], as_of: null, ...R } }).join()).toContain('repeats');
  expect(fails({ ...good, 's-5-119': { titles: ['B', 'A'], as_of: null, ...R } }).join()).toContain('code-point order');
  expect(fails({ ...good, 's-5-119': { titles: [], as_of: '2025-1-1', ...R } }).join()).toContain('as_of');
  expect(fails({ ...good, 's-5-119': { titles: 'A', as_of: null, ...R } }).join()).toContain('not an array');
  // A bill whose record no longer gives a short title: a note (hard rule 6: the name goes).
  expect(fails({ ...good, 's-5-119': { titles: [], as_of: null, ...R } }, good)).toEqual([]);
  expect(verifyShortTitles({ data: { ...good, 's-5-119': { titles: [], as_of: null, ...R } }, bills, before: good }).notes.join()).toContain('now gives it none');
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`hr-${i + 1}-119`, { titles: [`Act ${i}`], as_of: null, ...R }]));
  const manyBills = Array.from({ length: 30 }, (_, i) => bill('hr', i + 1, null));
  const shrunk = Object.fromEntries(Object.entries(many).slice(0, 20));
  expect(verifyShortTitles({ data: shrunk, bills: manyBills, before: many }).failures.join()).toContain('fell 30 -> 20');
});

test('the nightly runs the gate before it writes, the step is bounded, and it can never hold the night', () => {
  const sync = readFileSync(join(process.cwd(), 'scripts/sync-short-titles.mjs'), 'utf8');
  // The gate runs in settleNight (lib/short-titles-night.mjs), before anything is written.
  expect(sync.indexOf('settleNight(')).toBeGreaterThan(0);
  expect(sync.indexOf('settleNight(')).toBeLessThan(sync.indexOf('writeWhole(OUT'));
  // The titles file is written only when the gate gave a write (settled.write), never otherwise.
  expect(sync).toContain('if (settled.write?.titles) {\n      writeWhole(OUT, settled.write.text);');
  const night = readFileSync(join(process.cwd(), 'lib/short-titles-night.mjs'), 'utf8');
  expect(night).toContain('verifyShortTitles({ data: JSON.parse(text), bills, before, allowDrop })');
  // The URL carries the key: no line of the script prints it or a message built from it.
  expect(sync).not.toMatch(/console\.\w+\([^)]*\burl\b/);
  const verify = readFileSync(join(process.cwd(), 'scripts/verify-sync.mjs'), 'utf8');
  // verify-sync checks the three files through verifyShortTitlesFiles, which calls the same verifyShortTitles.
  expect(verify).toContain('const { failures, notes, warnings } = verifyShortTitlesFiles({');
  const nightLib = readFileSync(join(process.cwd(), 'lib/short-titles-night.mjs'), 'utf8');
  expect(nightLib).toContain('const v = verifyShortTitles({ data: titles, bills, before, allowDrop });');
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
 * A scratch place for the script's two files, kept across several "nights".
 * Each run replaces globalThis.fetch with `stub` (a function body with `url`
 * and `init` in scope, returning a Response or a Promise) on a small corpus.
 * Nothing reaches the network, and nothing is written in the repository.
 */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'short-titles-'));
  const outFile = join(dir, 'short-titles.json');
  const retryFile = join(dir, 'short-titles-retry.json');
  // Every file the script writes goes to the scratch folder, never into data/.
  const trendFile = join(dir, 'short-titles-trend.json');
  const read = (f: string) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
  return {
    seed(before: unknown) {
      writeFileSync(outFile, JSON.stringify(before));
    },
    seedRetry(retry: unknown) {
      writeFileSync(retryFile, JSON.stringify(retry));
    },
    night(stub: string, corpus: unknown[], env: Record<string, string> = {}) {
      const corpusFile = join(dir, 'bills.json');
      writeFileSync(corpusFile, JSON.stringify(corpus));
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
          SHORT_TITLES_RETRY_FILE: retryFile,
          SHORT_TITLES_TREND_FILE: trendFile,
          SHORT_TITLES_BILLS: corpusFile,
          SHORT_TITLES_REQUEST_TIMEOUT_MS: '300',
          SHORT_TITLES_RETRY_DELAY_MS: '10',
          SHORT_TITLES_TODAY: TODAY,
          ...env,
        },
      });
      const out = `${r.stdout}\n${r.stderr}`;
      const calls = Number(/STUB-CALLS (\d+)/.exec(out)?.[1] ?? -1);
      return { status: r.status, out, calls, after: read(outFile), retry: read(retryFile) };
    },
    done() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** One-night shorthand. */
function runOffline(stub: string, opts: { corpus: unknown[]; before?: unknown; env?: Record<string, string> }) {
  const sc = scratch();
  try {
    if (opts.before) sc.seed(opts.before);
    return sc.night(stub, opts.corpus, opts.env);
  } finally {
    sc.done();
  }
}

/** The bill a request is about, from its URL. */
const WHO = `const [, congress, type, number] = /\\/bill\\/(\\d+)\\/([a-z]+)\\/(\\d+)\\/titles/.exec(url.pathname);`;
/** Answers each bill with LIVE's shape, about the bill the URL names, its short titles renamed for it. */
const ANSWER = `
  const titles = ${JSON.stringify(LIVE.titles)}.map((t) => ({ ...t, title: t.titleType.startsWith('Short') ? 'Fixture ' + type + number + ' Act' : t.title }));
  return new Response(JSON.stringify({ pagination: { count: titles.length }, request: { billNumber: number, billType: type, congress, format: 'json' }, titles }), { status: 200 });
`;
const ANSWER_FOR_URL = `${WHO}${ANSWER}`;

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
  expect(r.calls).toBe(3);
  expect(r.retry).toBeNull(); // nothing failed: no retry file written
  expect(r.out).not.toContain('offline-test-key');
});

test('offline: an answer about another bill is a failed read and keeps what was stored', () => {
  const wrong = `return new Response(JSON.stringify({ ...${JSON.stringify(LIVE)}, request: { billNumber: '1', billType: 'hr', congress: '119' } }), { status: 200 });`;
  const r = runOffline(wrong, { corpus, before: good });
  expect(r.status).toBe(0);
  expect(r.out).toContain('another bill');
  expect(r.after).toEqual(good);
  expect(Object.keys(r.retry).sort()).toEqual(['hr-29-119', 'hr-9770-119', 's-5-119']);
});

test('offline: a reshaped answer or an error body marks nothing as read', () => {
  const reshaped = `${WHO} return new Response(JSON.stringify({ request: { billNumber: number, billType: type, congress }, bill_titles: [] }), { status: 200 });`;
  const r = runOffline(reshaped, { corpus, before: good });
  expect(r.status).toBe(0);
  expect(r.out).toContain('no list of titles');
  expect(r.after).toEqual(good);
  const errorBody = `return new Response(JSON.stringify({ error: { code: 'API_KEY_INVALID', message: 'x' } }), { status: 200 });`;
  expect(runOffline(errorBody, { corpus, before: good }).after).toEqual(good);
});

/** 40 bills, most urgent first; the ten most urgent always come back refused. */
const forty = Array.from({ length: 40 }, (_, i) => bill('hr', i + 1, '2026-01-01', 1 - i / 100));
const BAD_TEN = `/\\/hr\\/(10|[1-9])\\/titles/.test(url.pathname)`;

for (const [label, bad] of [
  ['an empty list', `return new Response(JSON.stringify({ pagination: { count: 0 }, request: { billNumber: number, billType: type, congress }, titles: [] }), { status: 200 });`],
  ['a 404', `return new Response('{}', { status: 404 });`],
] as const) {
  test(`offline, three nights: ten bills that always answer with ${label} never block the bills behind them`, () => {
    const sc = scratch();
    try {
      const stub = `${WHO} if (${BAD_TEN}) { ${bad} } ${ANSWER}`;
      const cap = { SHORT_TITLES_MAX: '15' };
      // Night 1: the ten bad bills are refused (their own failure, not the
      // source's), and the five bills behind them are read in the same night.
      const n1 = sc.night(stub, forty, { ...cap, SHORT_TITLES_TODAY: '2026-11-15' });
      expect(n1.status).toBe(0);
      expect(n1.out).not.toContain('SHORT TITLES TROUBLE');
      expect(Object.keys(n1.after).sort()).toEqual(['hr-11-119', 'hr-12-119', 'hr-13-119', 'hr-14-119', 'hr-15-119']);
      expect(Object.keys(n1.retry)).toHaveLength(10);
      expect(n1.retry['hr-1-119']).toMatchObject({ failures: 1, last_tried: '2026-11-15' });
      // Night 2: their one-day wait is over, so they come LAST; the queue reads 15 new bills first.
      const n2 = sc.night(stub, forty, { ...cap, SHORT_TITLES_TODAY: '2026-11-16' });
      expect(Object.keys(n2.after)).toHaveLength(20);
      expect(n2.calls).toBe(15);
      expect(n2.retry['hr-1-119']).toMatchObject({ failures: 1 }); // not tried tonight
      // Night 3: the rest of the corpus, then the ten bad ones at the back, tried again and failed again.
      const n3 = sc.night(stub, forty, { SHORT_TITLES_TODAY: '2026-11-17' });
      expect(Object.keys(n3.after)).toHaveLength(30);
      expect(n3.retry['hr-1-119']).toMatchObject({ failures: 2, last_tried: '2026-11-17' });
      // Night 4, a day later: their wait is now two days, so none is tried.
      const n4 = sc.night(stub, forty, { SHORT_TITLES_TODAY: '2026-11-18' });
      expect(n4.calls).toBe(0);
    } finally {
      sc.done();
    }
  });
}

test('offline: a bill that failed before and now reads cleanly leaves the retry file', () => {
  const sc = scratch();
  try {
    sc.seedRetry({ 'hr-29-119': { failures: 3, last_tried: '2026-11-01', reason: 'HTTP 404' }, 's-5-119': { failures: 1, last_tried: TODAY, reason: 'HTTP 404' } });
    const r = sc.night(ANSWER_FOR_URL, corpus);
    expect(r.after['hr-29-119'].titles).toEqual(['Fixture hr29 Act']);
    expect(r.retry).toEqual({ 's-5-119': { failures: 1, last_tried: TODAY, reason: 'HTTP 404' } }); // still waiting, untouched
  } finally {
    sc.done();
  }
});

test('offline: ten TRANSPORT failures in a row stop the night with one TROUBLE line; the reads before them are kept', () => {
  const many = Array.from({ length: 30 }, (_, i) => bill('hr', i + 1, '2026-01-01', 1 - i / 100));
  const stub = `if (/\\/hr\\/(1|2)\\/titles/.test(url.pathname)) { ${ANSWER_FOR_URL} } return new Response('down', { status: 503 });`;
  const r = runOffline(stub, { corpus: many });
  expect(r.status).toBe(0);
  expect(r.out).toContain('SHORT TITLES TROUBLE: stopped early: 10 requests in a row got no usable answer');
  expect(Object.keys(r.after).sort()).toEqual(['hr-1-119', 'hr-2-119']);
  // 2 good requests, then 10 bills with one retry each: 22. Never more.
  expect(r.calls).toBe(22);
  expect(Object.keys(r.retry)).toHaveLength(10);
});

test('offline: when most answers are refused for one reason, the source has changed: said once, judged on the whole night, and the refused bills back off', () => {
  const reshaped = `${WHO} return new Response(JSON.stringify({ request: { billNumber: number, billType: type, congress }, data: { titles: [] } }), { status: 200 });`;
  const r = runOffline(reshaped, { corpus: forty, before: good });
  expect(r.status).toBe(1);
  // Judged at the end of the night (2026-11-15), so every planned bill is asked once.
  expect(r.calls).toBe(40);
  expect(r.out.match(/SHORT TITLES TROUBLE: the source has changed/g)).toHaveLength(1);
  expect(r.out).toContain('::error::short titles: the source has changed');
  expect(r.after).toEqual(good);
  // Since 2026-11-15 every bill refused that night is recorded, so it backs off.
  expect(Object.keys(r.retry)).toHaveLength(40);
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
  // Each bill costs two 300 ms ceilings: the 1.5 s budget runs out after about three bills.
  expect(r.out).toMatch(/SHORT TITLES TROUBLE: stopped early: the step's \d+-minute budget ran out/);
  expect(r.out).toContain('no answer within 300 ms');
  expect(r.after).toEqual(good);
  expect(ms).toBeLessThan(30_000);
});

/** Pages of 250 for a bill with `n` titles (short ones every 100th), honouring offset and limit. */
const PAGED = (n: string) => `${WHO}
  const total = ${n};
  const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit'));
  const all = Array.from({ length: Number(total) }, (_, i) => i % 100 === 0
    ? { title: 'Part ' + i + ' Act', titleType: 'Short Title(s) as Introduced', titleTypeCode: 101, updateDate: 'x' }
    : { title: 'Title ' + i, titleType: i === 1 ? 'Official Title as Introduced' : 'Official Title from EH (Engrossed in House) bill text', titleTypeCode: 6, updateDate: 'x' });
  return new Response(JSON.stringify({ pagination: { count: total }, request: { billNumber: number, billType: type, congress }, titles: all.slice(offset, offset + limit) }), { status: 200 });`;

test('offline: a bill with more than 250 titles is read page by page, up to 4 pages; more is that bill’s failure', () => {
  const one = [bill('hr', 8800, '2026-09-01')];
  const r = runOffline(PAGED('612'), { corpus: one });
  expect(r.status).toBe(0);
  expect(r.calls).toBe(3);
  expect(r.after['hr-8800-119'].titles).toEqual(['Part 0 Act', 'Part 100 Act', 'Part 200 Act', 'Part 300 Act', 'Part 400 Act', 'Part 500 Act', 'Part 600 Act']);
  // A count sent as a string still decides the pages and the completeness check.
  const asString = runOffline(PAGED("'612'"), { corpus: one });
  expect(asString.after['hr-8800-119'].titles).toHaveLength(7);
  // 1,001 titles: past the 4-page cap, one clear line, the bill waits to be tried again.
  const huge = runOffline(PAGED('1001'), { corpus: one });
  expect(huge.calls).toBe(1);
  expect(huge.out).toContain('the bill has 1001 titles, more than the 1000 this step reads');
  expect(huge.after).toBeNull();
  expect(huge.retry['hr-8800-119'].failures).toBe(1);
});

test('offline: when the record’s whole answer no longer lists a short title, the name goes with it (hard rule 6)', () => {
  const officialOnly = `${WHO} const titles = ${JSON.stringify(LIVE.titles.filter((t: { titleType: string }) => !/^Short/.test(t.titleType)))};
    return new Response(JSON.stringify({ pagination: { count: titles.length }, request: { billNumber: number, billType: type, congress }, titles }), { status: 200 });`;
  const r = runOffline(officialOnly, { corpus: [corpus[0]], before: good });
  expect(r.status).toBe(0);
  expect(r.after['hr-9770-119'].titles).toEqual([]);
  expect(r.out).toContain('::warning::hr-9770-119: the record’s whole titles list no longer gives a short title'.replace('’', "'"));
});

test('an entry for a bill the corpus dropped is a note for the gate, and the next write prunes it', () => {
  const stale = { ...good, 'hr-99999-119': { titles: ['Gone Act'], as_of: null, read_on: '2026-10-01' } };
  // What verify-sync sees on a night the titles step read nothing (or crashed): a note, not a failure.
  const v = verifyShortTitles({ data: stale, bills: corpus, before: stale });
  expect(v.failures).toEqual([]);
  expect(v.notes.join('\n')).toContain('hr-99999-119');
  expect(v.notes.join('\n')).toContain('no longer holds');
  // A night that reads nothing leaves the file as it was, and does not fail.
  const nothing = runOffline(`return new Response('down', { status: 503 });`, { corpus, before: stale });
  expect(nothing.status).toBe(0);
  expect(nothing.after).toEqual(stale);
  expect(nothing.out).not.toContain('::error::');
  // A night that reads: the entry is gone.
  const r = runOffline(ANSWER_FOR_URL, { corpus, before: stale });
  expect(r.after['hr-99999-119']).toBeUndefined();
});
