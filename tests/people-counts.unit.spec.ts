import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): plain lib modules resolve under the unit runner.
import {
  __resetSaltMemoForTests,
  browserAddressKey,
  distinctAddressDay,
  distinctAddressElement,
  distinctAddressExpiresAt,
  distinctAddressKey,
  distinctSaltKey,
  noteBrowserAddress,
  noteDistinctAddress,
  readBrowserAddressCount,
} from '../lib/ratelimit';
import {
  PAGEVIEW_SURFACES,
  __memoryUsageCountForTests,
  browserPageviewUsageKey,
  isBrowserPageLoad,
  isCountablePageviewRequest,
  isSelfDeclaredCrawler,
  noteBrowserPageview,
  noteRepLookup,
  noteScriptServed,
  readPeopleSignalsWindow,
  repLookupUsageKey,
  scriptServedUsageKey,
  usageDayKey,
} from '../lib/usage';
import { PEOPLE_CAVEAT, formatDigestBody, formatPeopleLines, peopleEstimate } from '../lib/traffic-metrics.mjs';
import { scanText } from '../scripts/check-key-namespaces.mjs';
import { COUNTERS_URL, MockUpstash, installUpstashFetch, setUpstashEnv } from './upstash-mock';

/*
 * Counting real people, step 1 (owner's answer of 2026-11-23, 12:23 PM ET,
 * card `people`, option b). Pins:
 *   - the browser label (lib/usage.ts isBrowserPageLoad) and the documented
 *     crawler list, as a pure truth table;
 *   - the four new key shapes, and that nothing about a request reaches them;
 *   - the second daily sketch: same day salt, same element, same deadline,
 *     its own key and no other dimension;
 *   - the routes' wiring (source) and proxy.ts's (source);
 *   - the digest's People block and the pure estimate the weekly note can call;
 *   - the key-namespace gate's new teeth against the real files.
 */

test.describe.configure({ mode: 'serial' }); // shared env + global-fetch swaps

let restoreFetch: (() => void) | null = null;
let restoreEnv: (() => void) | null = null;

test.beforeEach(() => {
  __resetSaltMemoForTests();
});

test.afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  restoreEnv?.();
  restoreEnv = null;
});

function useMock(): MockUpstash {
  restoreEnv = setUpstashEnv();
  const mock = new MockUpstash();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });
  return mock;
}

function headers(h: Record<string, string>): Headers {
  return new Headers(h);
}

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IOS_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';
const SAMSUNG =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36';
// A real phone brand whose model name contains the three letters "bot".
const CUBOT =
  'Mozilla/5.0 (Linux; Android 13; CUBOT KINGKONG 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const BROWSER_OPEN = {
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'accept-language': 'en-US,en;q=0.9',
};

// --- the browser label ----------------------------------------------------------------

test.describe('isBrowserPageLoad', () => {
  test('a browser opening a page is "browser", for every mainstream engine', () => {
    for (const ua of [CHROME, IOS_SAFARI, FIREFOX, SAMSUNG, CUBOT]) {
      expect(isBrowserPageLoad(headers({ ...BROWSER_OPEN, 'user-agent': ua })), ua).toBe(true);
    }
  });

  test('each of the three header signals is required', () => {
    const base = { ...BROWSER_OPEN, 'user-agent': CHROME };
    const without = (name: string) => {
      const h = { ...base } as Record<string, string>;
      delete h[name];
      return headers(h);
    };
    expect(isBrowserPageLoad(without('sec-fetch-dest'))).toBe(false);
    expect(isBrowserPageLoad(without('sec-fetch-mode'))).toBe(false);
    expect(isBrowserPageLoad(without('accept-language'))).toBe(false);
    expect(isBrowserPageLoad(headers({ ...base, 'accept-language': '   ' }))).toBe(false);
    // An iframe, an image or a fetch is not a page being opened.
    expect(isBrowserPageLoad(headers({ ...base, 'sec-fetch-dest': 'iframe' }))).toBe(false);
    expect(isBrowserPageLoad(headers({ ...base, 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' }))).toBe(false);
    expect(isBrowserPageLoad(headers({ ...base, 'sec-fetch-mode': 'no-cors' }))).toBe(false);
  });

  test('a prerender or prefetch (Sec-Purpose present) is never "browser", though it sends document + navigate', () => {
    const base = { ...BROWSER_OPEN, 'user-agent': CHROME };
    expect(isBrowserPageLoad(headers(base))).toBe(true);
    for (const purpose of ['prefetch', 'prefetch;prerender', 'prefetch;anonymous-client-ip', '']) {
      expect(isBrowserPageLoad(headers({ ...base, 'sec-purpose': purpose })), purpose).toBe(false);
    }
  });

  test('a self-declared crawler is never "browser", even with a browser\'s headers', () => {
    const crawlers = [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
      'CCBot/2.0 (https://commoncrawl.org/faq/)',
      'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
      'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)',
      'Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Twitterbot/1.0',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
      'python-requests/2.32.3',
      'curl/8.7.1',
      'Go-http-client/2.0',
      'Mozilla/5.0 (compatible; SomeNewCrawler/1.0)',
      'Mozilla/5.0 (compatible; bot)',
    ];
    for (const ua of crawlers) {
      expect(isSelfDeclaredCrawler(ua), ua).toBe(true);
      expect(isBrowserPageLoad(headers({ ...BROWSER_OPEN, 'user-agent': ua })), ua).toBe(false);
    }
    for (const ua of [CHROME, IOS_SAFARI, FIREFOX, SAMSUNG, CUBOT, '']) {
      expect(isSelfDeclaredCrawler(ua), ua).toBe(false);
    }
    expect(isSelfDeclaredCrawler(null)).toBe(false);
  });

  test('pure: same headers, same answer, and the headers object is only read', () => {
    const reads: string[] = [];
    const h = {
      get(name: string) {
        reads.push(name.toLowerCase());
        return ({ ...BROWSER_OPEN, 'user-agent': CHROME } as Record<string, string>)[name.toLowerCase()] ?? null;
      },
    };
    expect(isBrowserPageLoad(h)).toBe(true);
    expect(isBrowserPageLoad(h)).toBe(true);
    expect(new Set(reads)).toEqual(new Set(['sec-fetch-dest', 'sec-fetch-mode', 'sec-purpose', 'accept-language', 'user-agent']));
  });
});

// --- key shapes ---------------------------------------------------------------------

test.describe('the new key shapes', () => {
  test('exact shapes: env prefix, family, (template,) UTC day — nothing else', () => {
    const day = '2026-11-23';
    expect(browserPageviewUsageKey('home', day)).toBe('dev:usage:pageview-browser:home:2026-11-23');
    expect(repLookupUsageKey(day)).toBe('dev:usage:rep-lookup:2026-11-23');
    expect(scriptServedUsageKey(day)).toBe('dev:usage:script-served:2026-11-23');
    expect(browserAddressKey(day)).toBe('dev:uniques-browser:2026-11-23');
  });

  test('the browser page-view key narrows a hostile label onto the closed vocabulary', () => {
    const hostile = ['/bills/hr-1-119', 'bill:hr-1', 'es', '../x', '*'];
    for (const label of hostile) {
      expect(browserPageviewUsageKey(label as never, '2026-11-23')).toBe('dev:usage:pageview-browser:other:2026-11-23');
    }
    for (const surface of PAGEVIEW_SURFACES) {
      expect(browserPageviewUsageKey(surface, '2026-11-23')).toBe(`dev:usage:pageview-browser:${surface}:2026-11-23`);
    }
  });

  test('the two totals take no argument: nothing from a request can reach them', () => {
    expect(noteRepLookup.length).toBe(0);
    expect(noteScriptServed.length).toBe(0);
    expect(repLookupUsageKey.length).toBe(1);
    expect(scriptServedUsageKey.length).toBe(1);
    expect(browserAddressKey.length).toBe(1);
  });

  test('without a counters database each write lands in per-instance memory, one integer, nothing else', async () => {
    const day = usageDayKey();
    const before = {
      lookup: __memoryUsageCountForTests(repLookupUsageKey(day)),
      served: __memoryUsageCountForTests(scriptServedUsageKey(day)),
      browser: __memoryUsageCountForTests(browserPageviewUsageKey('bill', day)),
    };
    await noteRepLookup();
    await noteScriptServed();
    await noteScriptServed();
    await noteBrowserPageview('bill');
    expect(__memoryUsageCountForTests(repLookupUsageKey(day))).toBe(before.lookup + 1);
    expect(__memoryUsageCountForTests(scriptServedUsageKey(day))).toBe(before.served + 2);
    expect(__memoryUsageCountForTests(browserPageviewUsageKey('bill', day))).toBe(before.browser + 1);
  });

  test('durable writes: each count is created with its 90-day expiry, then incremented', async () => {
    const mock = useMock();
    await noteRepLookup();
    await noteScriptServed();
    await noteBrowserPageview('home');
    const day = usageDayKey();
    for (const key of [repLookupUsageKey(day), scriptServedUsageKey(day), browserPageviewUsageKey('home', day)]) {
      expect(mock.exec(['GET', key])).toBe('1');
      const ttl = mock.exec(['TTL', key]) as number;
      expect(ttl).toBeGreaterThan(89 * 24 * 60 * 60);
      expect(ttl).toBeLessThanOrEqual(90 * 24 * 60 * 60);
    }
  });
});

// --- the second sketch ----------------------------------------------------------------

test.describe('the browser-address sketch', () => {
  test('same day salt, same element as the first sketch, its own key, the same absolute deadline', async () => {
    const mock = useMock();
    const now = new Date('2026-11-23T15:00:00Z');
    await noteDistinctAddress('203.0.113.10', now);
    await noteBrowserAddress('203.0.113.10', now);
    await noteBrowserAddress('203.0.113.10', now); // repeat address: one element
    await noteBrowserAddress('198.51.100.7', now);

    const day = distinctAddressDay(now);
    expect(mock.keys().sort()).toEqual([distinctAddressKey(day), browserAddressKey(day), distinctSaltKey(day)].sort());
    const daySalt = String(mock.store.get(distinctSaltKey(day))?.value);
    const element = distinctAddressElement('203.0.113.10', daySalt);
    expect(mock.hll.get(distinctAddressKey(day))?.has(element)).toBe(true);
    expect(mock.hll.get(browserAddressKey(day))?.has(element)).toBe(true);
    expect(mock.exec(['PFCOUNT', browserAddressKey(day)])).toBe(2);

    // The deadline: EXPIREAT at the same absolute instant as the first sketch.
    const expireats = mock.commands.filter((c) => c[0] === 'EXPIREAT' && c[1] === browserAddressKey(day));
    expect(expireats.length).toBeGreaterThan(0);
    for (const c of expireats) expect(c[2]).toBe(String(distinctAddressExpiresAt(day)));

    // No raw address ever crossed the wire.
    const wire = mock.commands.map((c) => c.join(' ')).join('\n');
    expect(wire).not.toContain('203.0.113');
    expect(wire).not.toContain('198.51.100');
  });

  test('an absent address and an unconfigured database add nothing', async () => {
    const mock = useMock();
    await noteBrowserAddress('unknown');
    await noteBrowserAddress('   ');
    expect(mock.commands).toEqual([]);
    restoreFetch?.();
    restoreFetch = null;
    restoreEnv?.();
    restoreEnv = null;
    // No env: a true no-op that must not throw.
    await noteBrowserAddress('203.0.113.10');
  });

  test('the digest read: estimate, absent sketch, and fail-closed', async () => {
    const mock = useMock();
    const now = new Date('2026-11-22T10:00:00Z');
    await noteBrowserAddress('203.0.113.10', now);
    const read = await readBrowserAddressCount('2026-11-22');
    expect(read).toEqual({ ok: true, count: 1, noExpiry: false });
    expect(await readBrowserAddressCount('2026-11-01')).toEqual({ ok: true, count: null, noExpiry: false });
    void mock;
    restoreFetch?.();
    restoreFetch = null;
    restoreEnv?.();
    restoreEnv = null;
    expect(await readBrowserAddressCount('2026-11-22')).toEqual({ ok: false });
  });
});

// --- the people read ----------------------------------------------------------------

test('readPeopleSignalsWindow: one MGET, day order kept, fail-closed without a database', async () => {
  const mock = useMock();
  mock.exec(['SET', browserPageviewUsageKey('home', '2026-11-22'), '40']);
  mock.exec(['SET', browserPageviewUsageKey('bill', '2026-11-22'), '300']);
  mock.exec(['SET', repLookupUsageKey('2026-11-22'), '12']);
  mock.exec(['SET', scriptServedUsageKey('2026-11-22'), '5']);
  mock.exec(['SET', scriptServedUsageKey('2026-11-21'), '3']);
  const read = await readPeopleSignalsWindow(['2026-11-22', '2026-11-21']);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.browserSurfaces.home).toEqual([40, 0]);
  expect(read.browserSurfaces.bill).toEqual([300, 0]);
  expect(read.repLookups).toEqual([12, 0]);
  expect(read.scriptsServed).toEqual([5, 3]);
  expect(mock.commands.filter((c) => c[0] === 'MGET')).toHaveLength(1);
  restoreFetch?.();
  restoreFetch = null;
  restoreEnv?.();
  restoreEnv = null;
  expect(await readPeopleSignalsWindow(['2026-11-22'])).toEqual({ ok: false });
});

// --- the estimate and the digest ----------------------------------------------------

test.describe('People (estimate)', () => {
  test('actions are the two totals side by side, never a floor; browsers is the browser sketch; bots share of loads', () => {
    const e = peopleEstimate({
      pageLoads: 4410,
      browserPageLoads: 441,
      repLookups: 30,
      scriptsServed: 12,
      browserAddresses: { ok: true, count: 150, noExpiry: false },
    });
    expect(e).not.toHaveProperty('floor');
    expect(e.repLookups).toBe(30);
    expect(e.scriptsServed).toBe(12);
    expect(e.browsers).toBe(150);
    expect(e.browsersState).toBe('read');
    expect(e.botShare).toBeCloseTo(0.9, 5);
    const lines = formatPeopleLines(e).join('\n');
    expect(lines).toContain('actions   30 / 12');
    expect(lines).toContain('ZIP lookups that found a district / call scripts shown, at least (actions, not people)');
    expect(lines).toContain('browsers  150');
    expect(lines).toContain('distinct browser addresses');
  });

  test('every unread or empty state is said, never invented', () => {
    const notRead = peopleEstimate({ pageLoads: 0, browserPageLoads: 0, repLookups: 0, scriptsServed: 0, browserAddresses: { ok: false } });
    expect(notRead.browsers).toBeNull();
    expect(notRead.browsersState).toBe('not-read');
    expect(notRead.botShare).toBeNull();
    const lines = formatPeopleLines(notRead).join('\n');
    expect(lines).toContain('browsers  not read');
    expect(lines).toContain('no page loads counted');

    const absent = peopleEstimate({ pageLoads: 10, browserPageLoads: 4, repLookups: 1, scriptsServed: 2, browserAddresses: { ok: true, count: null, noExpiry: false } });
    expect(absent.browsersState).toBe('not-recorded');
    expect(formatPeopleLines(absent).join('\n')).toContain('not recorded');

    expect(formatPeopleLines(null)[0]).toMatch(/^People \(estimate\): not read/);
  });

  test('no line, caveat or field calls the actions a floor or a lower bound', () => {
    const e = peopleEstimate({ pageLoads: 100, browserPageLoads: 50, repLookups: 80, scriptsServed: 3, browserAddresses: { ok: true, count: 20, noExpiry: false } });
    const text = [...formatPeopleLines(e), PEOPLE_CAVEAT].join('\n');
    expect(text).not.toMatch(/\bfloor\b/i);
    // "lower bound" appears only in its denial.
    expect(text.match(/lower bound/gi) ?? []).toHaveLength(1);
    expect(Object.keys(e).join(' ')).not.toMatch(/floor/i);
    expect(PEOPLE_CAVEAT).toContain('not a lower bound on people');
  });

  test('the browser-address sketch is never called a ceiling: it is not an upper bound', () => {
    // Shared addresses undercount and browsers without Sec-Fetch headers are
    // left out, so "ceiling" would be a false claim (review of 2026-11-23).
    const e = peopleEstimate({ pageLoads: 100, browserPageLoads: 50, repLookups: 80, scriptsServed: 3, browserAddresses: { ok: true, count: 20, noExpiry: false } });
    const unread = peopleEstimate({ pageLoads: 0, browserPageLoads: 0, repLookups: 0, scriptsServed: 0, browserAddresses: { ok: false } });
    const text = [...formatPeopleLines(e), ...formatPeopleLines(unread), ...formatPeopleLines(null), PEOPLE_CAVEAT].join('\n');
    expect(text).not.toMatch(/ceiling/i);
    expect(Object.keys(e).join(' ')).not.toMatch(/ceiling/i);
    expect(PEOPLE_CAVEAT).toContain('not an upper bound on people');
    // The People code in the digest library and its runner, source included.
    const metrics = read('lib/traffic-metrics.mjs');
    const block = metrics.slice(metrics.indexOf('// --- People (estimate)'), metrics.indexOf('export function formatSiteLines'));
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toMatch(/ceiling/i);
    const digest = read('scripts/daily-metrics.mjs');
    expect(digest.match(/[^\n]*ceiling[^\n]*/gi) ?? []).toEqual([]);
    expect(read('lib/usage.ts')).not.toMatch(/ceiling/i);
  });

  test('the digest prints the block and its caveat only when supplied; old callers are unchanged', () => {
    const stats = { latest: 0, med: 0, wow: null, threshold: 0, spike: false };
    const base = {
      date: '2026-11-22',
      mcpTools: [{ tool: 'get_bill', stats }],
      mcpTotal: stats,
      script: stats,
    };
    const without = formatDigestBody(base as never);
    expect(without).not.toContain('People (estimate)');
    const e = peopleEstimate({ pageLoads: 10, browserPageLoads: 4, repLookups: 2, scriptsServed: 1, browserAddresses: { ok: true, count: 3, noExpiry: false } });
    const withPeople = formatDigestBody({ ...base, people: e, browserBySurface: [{ surface: 'home', latest: 4 }] } as never);
    expect(withPeople).toContain('People (estimate)');
    expect(withPeople).toContain('browser page loads by template: home 4');
    expect(withPeople).toContain(PEOPLE_CAVEAT);
    expect(formatDigestBody({ ...base, people: null } as never)).toContain('People (estimate): not read');
  });
});

// --- wiring (source) ------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

test('proxy.ts: the browser counts sit inside the countable gate, behind isBrowserPageLoad, each in its own waitUntil, the address never beside the label', () => {
  const src = read('proxy.ts');
  const from = src.indexOf('export default function proxy');
  const body = src.slice(from, src.indexOf('\n}\n', from) + 2);
  const gate = body.indexOf('if (isCountablePageviewRequest(req))');
  const label = body.indexOf('if (isBrowserPageLoad(req.headers))');
  expect(gate).toBeGreaterThan(-1);
  expect(label).toBeGreaterThan(gate);
  expect(body).toContain('event.waitUntil(noteBrowserPageview(surface).catch(() => {}));');
  expect(body).toContain('event.waitUntil(noteBrowserAddress(callerIp(req.headers)).catch(() => {}));');
  expect(body.indexOf('noteBrowserPageview(')).toBeGreaterThan(label);
  expect(body.indexOf('noteBrowserAddress(')).toBeGreaterThan(label);
  // Exactly one argument each: the label OR the address, never both.
  expect(body.match(/noteBrowserAddress\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)).toEqual(['noteBrowserAddress(callerIp(req.headers))']);
  expect(body.match(/noteBrowserPageview\(([^()]*)\)/g)).toEqual(['noteBrowserPageview(surface)']);
  expect(body).not.toMatch(/\bawait\b/);
});

test('the routes: one argument-free count each, after the answer is built; the ZIP, bill and stance never reach it', () => {
  const reps = read('app/api/reps/route.ts');
  expect(reps.match(/noteRepLookup\(([^)]*)\)/g)).toEqual(['noteRepLookup()']);
  expect(reps).toContain('if (districts.length > 0) {');
  expect(reps).toContain('after(() => noteRepLookup());');
  expect(reps.indexOf('noteRepLookup()')).toBeGreaterThan(reps.indexOf('const districts = districtsForZip(zip);'));

  // Since 2026-11-24 the route hands the count to lib/script-serve.ts, which
  // runs it deferred (after()) once the request has every stance of the bill
  // available: a full cache hit, or a fill whose drafts all came back and were
  // stored. Behaviour, including the partial-failure undercount, is pinned in
  // tests/script-stance-blind.unit.spec.ts.
  const script = read('app/api/script/route.ts');
  expect(script.match(/noteScriptServed\(([^)]*)\)/g)).toEqual(['noteScriptServed()']);
  expect(script).toContain('served: () => noteScriptServed(),');
  expect(script).toContain('defer: (task) => after(task),');
  const serve = read('lib/script-serve.ts');
  const record = serve.slice(serve.indexOf('async function recordCounts('), serve.indexOf('export async function serveStanceBlind('));
  expect(record).toContain('if (fill === null || fill.complete) await deps.note.served();');
  // The count is taken after the write it depends on.
  const fill = serve.slice(serve.indexOf('async function fillMissing('), serve.indexOf('async function recordCounts('));
  expect(fill).toContain('await deps.cache.setStances(set, drafted);');
  expect(serve).toContain('deps.defer(() => recordCounts(null, deps));');
});

// --- the gate's new teeth, on the real files ----------------------------------------

test('the key-namespace gate passes the real registries and catches each new shape going wrong', () => {
  for (const file of ['lib/usage.ts', 'lib/ratelimit.ts', 'proxy.ts', 'app/api/reps/route.ts', 'app/api/script/route.ts']) {
    expect(scanText(file, read(file)), file).toEqual([]);
  }
  const rules = (file: string, text: string) => scanText(file, text).map((v: { rule: string }) => v.rule);
  expect(rules('lib/usage.ts', 'const k = `${keyPrefix()}:usage:people:${day}`;')).toContain('usage-shape');
  expect(rules('lib/usage.ts', 'const k = `${keyPrefix()}:usage:rep-lookup:${zip}:${day}`;')).toContain('usage-caller');
  expect(rules('lib/ratelimit.ts', 'const k = `${keyPrefix()}:uniques-browser:${route}:${day}`;')).toContain('distinct-shape');
  expect(rules('lib/ratelimit.ts', 'const k = `${keyPrefix()}:uniques-readers:${day}`;')).toContain('distinct-shape');
  expect(rules('app/api/reps/route.ts', "await c.cmd(['PFADD', `${keyPrefix()}:uniques-browser:${day}`, h]);")).toContain('distinct-confinement');
});

// The request object the proxy hands both predicates, so the label is only
// ever asked of a load that is already counted.
test('only a countable load is ever labelled: a prefetch with browser headers is neither', () => {
  const req = {
    method: 'GET',
    headers: headers({ ...BROWSER_OPEN, accept: 'text/html', 'user-agent': CHROME, 'next-router-prefetch': '1' }),
  };
  expect(isCountablePageviewRequest(req)).toBe(false);
});
