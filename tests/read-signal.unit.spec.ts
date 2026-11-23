import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from '@playwright/test';
import { NextRequest } from 'next/server';
// Relative imports (not '@/'): plain lib modules resolve under the unit runner.
import { POST } from '../app/api/seen/route';
import { pageShapeForPath } from '../lib/page-shape';
import {
  __resetSaltMemoForTests,
  distinctAddressDay,
  distinctSaltKey,
  readReaderAddressCount,
  readerAddressKey,
} from '../lib/ratelimit';
import { READ_SIGNAL_EVENTS, READ_SIGNAL_PATH, armReadSignal, sendReadSignal, type ReadSignalEnv } from '../lib/read-signal';
import { readCappedBody } from '../lib/capped-body';
import { PAGEVIEW_SURFACES, __memoryUsageCountForTests, noteRead, pageviewSurfaceForPath, readUsageKey, usageDayKey } from '../lib/usage';
import { PEOPLE_READ_CAVEAT, formatPeopleLines, peopleEstimate } from '../lib/traffic-metrics.mjs';
import { scanText } from '../scripts/check-key-namespaces.mjs';
import { COUNTERS_URL, MockUpstash, installUpstashFetch, setUpstashEnv } from './upstash-mock';

/*
 * Counting real people, step 2: the reading signal (owner's answer of
 * 2026-11-23, 12:23 PM ET, card `people`, option b). Pins:
 *   - the browser half (lib/read-signal.ts): nothing before a person's first
 *     trusted input on a visible page, then exactly one send, of the page
 *     shape only, with no cookie, no Referer, no storage, no identifier;
 *   - where it is mounted: main-site layout only, never /embed;
 *   - the receiver (app/api/seen): 204 always, counts only an exact page
 *     shape from a same-origin, non-crawler caller under its limit, and keeps
 *     the shape and the address in two separate structures;
 *   - the digest's "read" row; the gate against the real files.
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

const LOCALES = ['en', 'es'] as const;

// --- a fake browser -------------------------------------------------------------

type Handler = (event: { isTrusted?: boolean }) => void;

function fakeEnv(pathname: string, visibility: 'visible' | 'hidden' = 'visible') {
  const windowListeners = new Map<string, Set<Handler>>();
  const documentListeners = new Map<string, Set<Handler>>();
  const sent: Array<{ path: string; body: string }> = [];
  const target = (map: Map<string, Set<Handler>>) => ({
    addEventListener(type: string, h: Handler) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type)!.add(h);
    },
    removeEventListener(type: string, h: Handler) {
      map.get(type)?.delete(h);
    },
  });
  const doc = { ...target(documentListeners), visibilityState: visibility as string };
  const win = { ...target(windowListeners), location: { pathname } };
  const env: ReadSignalEnv = { document: doc, window: win, send: (path, body) => void sent.push({ path, body }) };
  const fire = (map: Map<string, Set<Handler>>, type: string, isTrusted = true) => {
    for (const h of [...(map.get(type) ?? [])]) h({ isTrusted });
  };
  return {
    env,
    sent,
    doc,
    win,
    act: (type: string, isTrusted = true) => fire(windowListeners, type, isTrusted),
    becomeVisible: () => {
      doc.visibilityState = 'visible';
      fire(documentListeners, 'visibilitychange');
    },
    listenerCount: () =>
      [...windowListeners.values(), ...documentListeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

test.describe('the browser half', () => {
  test('nothing is sent on load; the first trusted input on a visible page sends the page shape, once', () => {
    const b = fakeEnv('/es/bills/hr-1234-119');
    armReadSignal(b.env, LOCALES);
    expect(b.sent).toEqual([]);
    b.act('pointerdown');
    b.act('keydown');
    b.act('wheel');
    expect(b.sent).toEqual([{ path: '/api/seen', body: 'bill' }]);
    expect(b.listenerCount(), 'every listener removed after the one send').toBe(0);
  });

  test('each of the four person-made inputs triggers it; a script-fabricated event never does', () => {
    for (const type of READ_SIGNAL_EVENTS) {
      const b = fakeEnv('/');
      armReadSignal(b.env, LOCALES);
      b.act(type, false);
      expect(b.sent, `${type} untrusted`).toEqual([]);
      b.act(type, true);
      expect(b.sent, type).toEqual([{ path: READ_SIGNAL_PATH, body: 'home' }]);
    }
    // 'scroll' is deliberately not listened for: restoring the position on
    // Back or jumping to an #anchor fires it without a person doing anything.
    expect(READ_SIGNAL_EVENTS as readonly string[]).not.toContain('scroll');
  });

  test('a page opened in the background waits until it is visible, and only then listens', () => {
    const b = fakeEnv('/questions/iran', 'hidden');
    armReadSignal(b.env, LOCALES);
    b.act('pointerdown');
    expect(b.sent).toEqual([]);
    b.becomeVisible();
    expect(b.sent, 'becoming visible alone sends nothing').toEqual([]);
    b.act('keydown');
    expect(b.sent).toEqual([{ path: READ_SIGNAL_PATH, body: 'question' }]);
    expect(b.listenerCount()).toBe(0);
  });

  test('an input while the page is hidden again is ignored', () => {
    const b = fakeEnv('/bills');
    armReadSignal(b.env, LOCALES);
    b.doc.visibilityState = 'hidden';
    b.act('pointerdown');
    expect(b.sent).toEqual([]);
    b.doc.visibilityState = 'visible';
    b.act('pointerdown');
    expect(b.sent).toEqual([{ path: READ_SIGNAL_PATH, body: 'bills-index' }]);
  });

  test('disarmed before any input (unmount): nothing is ever sent, no listener left', () => {
    const b = fakeEnv('/reps/A000360');
    const disarm = armReadSignal(b.env, LOCALES);
    disarm();
    b.act('pointerdown');
    expect(b.sent).toEqual([]);
    expect(b.listenerCount()).toBe(0);
    const hidden = fakeEnv('/', 'hidden');
    armReadSignal(hidden.env, LOCALES)();
    expect(hidden.listenerCount()).toBe(0);
  });

  test('the body is only ever a page shape: the path, ids, query and locale never leave', () => {
    const cases: Array<[string, string]> = [
      ['/', 'home'],
      ['/es', 'home'],
      ['/bills/hr-1234-119', 'bill'],
      ['/es/reps/A000360', 'member'],
      ['/today/2026-11-20', 'today'],
      ['/nominations/pn-12-119', 'nominations'],
      ['/privacy', 'other'],
    ];
    for (const [path, shape] of cases) {
      const b = fakeEnv(path);
      armReadSignal(b.env, LOCALES);
      b.act('pointerdown');
      expect(b.sent[0]?.body, path).toBe(shape);
      expect(PAGEVIEW_SURFACES as readonly string[]).toContain(shape);
    }
  });

  test('the shape rule is the very one page views are counted by', () => {
    const paths = ['/', '/es/', '/bills', '/bills/x', '/questions', '/questions/x', '/reps', '/reps/x', '/reps/x/y', '/record', '/record/x', '/nominations', '/nominations/x', '/today', '/today/x', '/today/x/y', '/about', '/es/names/119/save-act'];
    for (const p of paths) expect(pageShapeForPath(p, LOCALES), p).toBe(pageviewSurfaceForPath(p, LOCALES));
  });

  test('the request: same-origin path, POST, plain text, keepalive, no cookie, no Referer, no cache', async () => {
    const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      sendReadSignal(READ_SIGNAL_PATH, 'bill');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/seen');
    expect(calls[0].init).toEqual({
      method: 'POST',
      body: 'bill',
      headers: { 'content-type': 'text/plain' },
      keepalive: true,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
  });

  test('a fetch that throws or rejects never breaks the page', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('no network');
    }) as unknown as typeof fetch;
    expect(() => sendReadSignal(READ_SIGNAL_PATH, 'home')).not.toThrow();
    globalThis.fetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(() => sendReadSignal(READ_SIGNAL_PATH, 'home')).not.toThrow();
    globalThis.fetch = realFetch;
  });
});

// --- source guarantees ----------------------------------------------------------

/** Code only: block comments and whole-line // comments removed. */
function codeOf(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

test('the browser code stores nothing, reads no cookie, keeps no identifier or time, and talks to no other origin', () => {
  for (const file of ['lib/read-signal.ts', 'components/ReadSignal.tsx', 'lib/page-shape.ts']) {
    const code = codeOf(file);
    expect(code, file).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|cookieStore/);
    expect(code, file).not.toMatch(/Date\.now|new Date|performance\.|crypto\.|randomUUID|Math\.random/);
    expect(code, file).not.toMatch(/sendBeacon|https?:\/\/|document\.referrer|\breferrer\s*:/);
    // The one referrer word allowed is the policy that drops it.
    expect((code.match(/referrer/gi) ?? []).length, file).toBe((code.match(/referrerPolicy: 'no-referrer'/g) ?? []).length * 2);
    expect(code, file).not.toMatch(/navigator\.(userAgent|language|platform)|screen\./);
  }
  // lib/page-shape.ts imports nothing, so the browser bundle pulls in no
  // counters code.
  expect(codeOf('lib/page-shape.ts')).not.toMatch(/^\s*import\b/m);
  expect(codeOf('lib/read-signal.ts').match(/^\s*import .*$/gm)).toEqual(["import { pageShapeForPath } from './page-shape';"]);
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

test('mounted once, by the main-site layout only — never by anything under /embed', () => {
  const importers = [...walk(join(process.cwd(), 'app')), ...walk(join(process.cwd(), 'components'))]
    .map((f) => relative(process.cwd(), f).replaceAll('\\', '/'))
    .filter((f) => /from '@\/components\/ReadSignal'|from '@\/lib\/read-signal'/.test(readFileSync(f, 'utf8')));
  expect(importers.sort()).toEqual(['app/[locale]/layout.tsx', 'components/ReadSignal.tsx']);
  const layout = readFileSync(join(process.cwd(), 'app/[locale]/layout.tsx'), 'utf8');
  expect(layout.match(/<ReadSignal \/>/g)).toHaveLength(1);
  // The embed tree has its own layout and never reaches the [locale] one.
  for (const f of walk(join(process.cwd(), 'app/embed'))) {
    expect(readFileSync(f, 'utf8'), f).not.toMatch(/ReadSignal|read-signal|api\/seen/);
  }
  // The devtools note no longer claims a silent Network tab.
  expect(layout).not.toContain("it's quiet in here");
  expect(layout).not.toContain('No analytics');
  // 2026-11-23 review: no claim no gate checks, and nothing that reads as
  // "the Network tab shows one request"; a mouse click is named.
  expect(layout).not.toContain('No third-party requests');
  expect(layout).not.toContain('Check the Network tab');
  expect(layout).toContain(
    'After your first scroll, click, tap or key press on a page, our own script sends one request to /api/seen that names the kind of page (a bill page, never which bill) and nothing else.',
  );
});

// --- the receiver -----------------------------------------------------------------

let octet = 0;
const nextIp = () => `198.51.100.${(++octet % 250) + 1}`;

function seen(body: string, ip: string, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest('http://localhost/api/seen', {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
        'x-forwarded-for': ip,
        ...headers,
      },
      body,
    })
  );
}

test.describe('POST /api/seen', () => {
  test('a valid signal: 204, no body, one count for that page shape', async () => {
    const key = readUsageKey(usageDayKey());
    const before = __memoryUsageCountForTests(key);
    const res = await seen('bill', nextIp());
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(__memoryUsageCountForTests(key)).toBe(before + 1);
  });

  test('refused silently, with the same 204: another site, a crawler, a made-up or oversized value, "short"', async () => {
    const day = usageDayKey();
    const total = () => __memoryUsageCountForTests(readUsageKey(day));
    const before = total();
    const refused = [
      await seen('bill', nextIp(), { 'sec-fetch-site': 'cross-site' }),
      await seen('bill', nextIp(), { 'sec-fetch-site': 'same-site' }),
      await seen('home', nextIp(), { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }),
      await seen('/bills/hr-1234-119', nextIp()),
      await seen('bill:hr-1234-119', nextIp()),
      await seen('BILL', nextIp()),
      await seen('short', nextIp()),
      await seen('', nextIp()),
      await seen('home'.padEnd(40, ' '), nextIp()),
    ];
    const noFetchSite = await POST(
      new NextRequest('http://localhost/api/seen', { method: 'POST', headers: { 'x-forwarded-for': nextIp() }, body: 'home' })
    );
    for (const res of [...refused, noFetchSite]) {
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
    }
    expect(total()).toBe(before);
  });

  test('one address cannot inflate the count past its limit', async () => {
    const ip = '203.0.113.200';
    const key = readUsageKey(usageDayKey());
    const before = __memoryUsageCountForTests(key);
    for (let i = 0; i < 15; i += 1) await seen('today', ip);
    // One signal per page load: five pages in ten minutes, then nothing more
    // from that address until the window ends (60 in the first draft let one
    // address add ~8,640 a day to the total).
    expect(__memoryUsageCountForTests(key) - before).toBe(5);
    // The digest caveat states the same limit the route enforces.
    const route = readFileSync(join(process.cwd(), 'app/api/seen/route.ts'), 'utf8');
    expect(route).toContain('const SEEN_MAX = 5;');
    expect(route).toContain('const SEEN_WINDOW_SEC = 600;');
    expect(route).toContain("createRateLimiter({ route: 'seen', max: SEEN_MAX, windowSec: SEEN_WINDOW_SEC })");
    expect(PEOPLE_READ_CAVEAT).toContain('5 per 10 minutes');
    expect(PEOPLE_READ_CAVEAT).not.toContain('60 per 10 minutes');
  });

  test('with the counters database: one dimensionless total and the address sketch; no key or command carries a page shape or the raw address', async () => {
    restoreEnv = setUpstashEnv();
    const mock = new MockUpstash();
    restoreFetch = installUpstashFetch({ [COUNTERS_URL]: mock });
    await seen('question', '192.0.2.44');
    await seen('bill', '192.0.2.44'); // same address, another page: one element
    await seen('bill', '192.0.2.45');

    const day = distinctAddressDay();
    const sketch = readerAddressKey(day);
    expect(mock.exec(['PFCOUNT', sketch])).toBe(2);
    // One total, no dimension: three signals from two kinds of page.
    expect(mock.exec(['GET', readUsageKey(usageDayKey())])).toBe('3');
    // The sketch key carries no page shape; no counter key carries an address.
    for (const key of mock.keys()) {
      if (key.includes('uniques')) expect(key, key).not.toMatch(/bill|question/);
      expect(key, key).not.toContain('192.0.2');
    }
    expect(mock.keys()).toContain(distinctSaltKey(day));
    const wire = mock.commands.map((c) => c.join(' ')).join('\n');
    expect(wire).not.toContain('192.0.2');
    // The shape was a validity check only: it reaches no key and no command.
    expect(wire).not.toMatch(/\bbill\b|question/);
    // Each PFADD names only the sketch and one hashed element.
    for (const c of mock.commands.filter((c) => c[0] === 'PFADD')) {
      expect(c).toHaveLength(3);
      expect(c[1]).toBe(sketch);
      expect(c[2]).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(await readReaderAddressCount(day)).toEqual({ ok: true, count: 2, noExpiry: false });
  });
});

// --- the read total and the capped body (2026-11-23 independent review) ----------

test('the read count is one daily total: no argument, no dimension in the key', () => {
  expect(noteRead.length).toBe(0);
  expect(readUsageKey.length).toBe(1);
  expect(readUsageKey('2026-11-23')).toBe('dev:usage:read:2026-11-23');
});

function streamOf(chunks: Uint8Array[], pulled: { n: number }): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) return controller.close();
      pulled.n += 1;
      controller.enqueue(chunks[i++]);
    },
  });
}

test.describe('the capped body read', () => {
  test('a short body is read whole; an empty or absent one is the empty string', async () => {
    const pulled = { n: 0 };
    expect(await readCappedBody(streamOf([new TextEncoder().encode('bi'), new TextEncoder().encode('ll')], pulled), 64)).toBe('bill');
    expect(await readCappedBody(streamOf([], pulled), 64)).toBe('');
    expect(await readCappedBody(null, 64)).toBe('');
  });

  test('a long chunked body stops one chunk past the cap and is never read whole', async () => {
    const pulled = { n: 0 };
    const chunk = new Uint8Array(40).fill(97);
    const chunks = Array.from({ length: 1000 }, () => chunk); // 40 KB
    expect(await readCappedBody(streamOf(chunks, pulled), 64)).toBeNull();
    expect(pulled.n).toBeLessThanOrEqual(3);
  });

  test('bytes that are not UTF-8 are refused', async () => {
    expect(await readCappedBody(streamOf([new Uint8Array([0xff, 0xfe])], { n: 0 }), 64)).toBeNull();
  });

  test('POST: a chunked body with no Content-Length past the cap is refused with the same 204, and not counted', async () => {
    const day = usageDayKey();
    const before = __memoryUsageCountForTests(readUsageKey(day));
    const pulled = { n: 0 };
    const big = Array.from({ length: 1000 }, () => new TextEncoder().encode('home'));
    const req = new NextRequest('http://localhost/api/seen', {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
        'x-forwarded-for': nextIp(),
      },
      body: streamOf(big, pulled),
      duplex: 'half',
    } as unknown as ConstructorParameters<typeof NextRequest>[1]);
    expect(req.headers.get('content-length')).toBeNull();
    const res = await POST(req);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(pulled.n).toBeLessThan(big.length);
    expect(__memoryUsageCountForTests(readUsageKey(day))).toBe(before);
  });
});

// --- digest and gate ----------------------------------------------------------------

test('the People block gains a "read" row only when the reader sketch is supplied', () => {
  const base = { pageLoads: 100, browserPageLoads: 40, repLookups: 3, scriptsServed: 2, browserAddresses: { ok: true as const, count: 30, noExpiry: false } };
  expect(formatPeopleLines(peopleEstimate(base)).join('\n')).not.toContain('reading signal');
  const withRead = peopleEstimate({ ...base, reads: 25, readerAddresses: { ok: true, count: 12, noExpiry: false } });
  const lines = formatPeopleLines(withRead);
  expect(lines.find((l) => l.startsWith('  read'))).toContain('12');
  expect(lines.join('\n')).toContain('25 signals');
  expect(formatPeopleLines(peopleEstimate({ ...base, reads: 0, readerAddresses: { ok: false } })).join('\n')).toMatch(/read +not read/);
});

test('the gate passes the real files and catches the read family going wrong', () => {
  for (const file of ['lib/usage.ts', 'lib/ratelimit.ts', 'lib/page-shape.ts', 'lib/read-signal.ts', 'lib/capped-body.ts', 'app/api/seen/route.ts', 'components/ReadSignal.tsx']) {
    expect(scanText(file, readFileSync(join(process.cwd(), file), 'utf8')), file).toEqual([]);
  }
  const rules = (file: string, text: string) => scanText(file, text).map((v: { rule: string }) => v.rule);
  expect(rules('lib/usage.ts', 'const k = `${keyPrefix()}:usage:read:${pathname}:${day}`;')).toContain('usage-raw-path');
  expect(rules('lib/usage.ts', 'const k = `${keyPrefix()}:usage:read:${asPageviewSurface(surface)}:${day}`;')).toContain('usage-shape');
  expect(rules('lib/ratelimit.ts', 'const k = `${keyPrefix()}:uniques-read:${surface}:${day}`;')).toContain('distinct-shape');
  expect(rules('app/api/seen/route.ts', "await c.cmd(['PFCOUNT', `${keyPrefix()}:uniques-read:${day}`]);")).toContain('distinct-confinement');
});
