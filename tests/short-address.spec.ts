import { expect, test } from '@playwright/test';
import billsJson from '../data/bills.json';
import {
  decodeNameTables,
  decodeShortAddressFallback,
  decodeShortAddressIndex,
  encodeShortAddressFallback,
  encodeShortAddressIndex,
  nameAddressTarget,
  SHORT_ADDRESS_CONGRESS,
  shortAddressTarget,
} from '../lib/short-address';
import { nameTablesForBuild } from '../lib/short-address-build';

/*
 * Short addresses for bills, against the production build: /hr9340 answers
 * with a 307 to that bill's canonical page, in both languages, with the
 * request's query string dropped; an unknown number is the site's normal 404.
 * The parser, the index and the no-collision proof are pure-Node unit specs
 * in tests/short-address.unit.spec.ts.
 *
 * Every expectation is computed from the corpus with the same two tables
 * next.config.ts builds (the tracked Congress's, then the most recently ended
 * Congress's, under the owner's ruling of Nov 14, 2026), so this spec holds
 * before the change of Congress and after it, with no edit at the switch.
 */

type CorpusBill = { bill_type: string; bill_number: number; congress_number: number };
const corpus = billsJson as unknown as CorpusBill[];
const bills = corpus.filter((b) => b.congress_number === SHORT_ADDRESS_CONGRESS);
const INDEX = decodeShortAddressIndex(encodeShortAddressIndex(corpus, SHORT_ADDRESS_CONGRESS));
const FALLBACK = decodeShortAddressFallback(encodeShortAddressFallback(corpus));
/** Where the built site must send a path: the target path, or null for the 404. */
const expectedTarget = (path: string) => shortAddressTarget(path, ['en', 'es'], 'en', INDEX, FALLBACK);

/** A short address the built site answers, and the bill it must open. */
type Sample = { bill_type: string; bill_number: number; slug: string };

/**
 * Up to three real addresses of different types, drawn from EVERY bill a
 * short address answers (the tracked Congress's, else an ended Congress's),
 * in the data file's own order. So this holds today, on switch day before the
 * new Congress has a bill, and after. Never throws: a file that throws while
 * it loads aborts the whole browser run.
 */
function samples(): Sample[] {
  const out: Sample[] = [];
  for (const type of ['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres']) {
    for (const b of corpus) {
      if (b.bill_type !== type) continue;
      const target = expectedTarget(`/${b.bill_type}${b.bill_number}`);
      if (!target) continue;
      out.push({ bill_type: b.bill_type, bill_number: b.bill_number, slug: target.replace(/^\/bills\//, '') });
      break;
    }
    if (out.length === 3) break;
  }
  return out;
}
const SAMPLES = samples();

const slugOf = (b: CorpusBill) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`;

/** A House bill number no short address resolves (neither the tracked nor the ended Congress holds it). */
function unheldHouseNumber(): number {
  let n = 1;
  while (expectedTarget(`/hr${n}`) !== null) n++;
  return n;
}

test.describe('short addresses', () => {
  test('the corpus gives at least one short address to check', () => {
    expect(SAMPLES.length, 'no bill in data/bills.json has a short address the site answers').toBeGreaterThan(0);
  });

  for (const bill of SAMPLES) {
    const short = `${bill.bill_type}${bill.bill_number}`;
    const slug = bill.slug;

    test(`/${short} and its spellings redirect (307) to /bills/${slug}, in both languages`, async ({ request }) => {
      const cases: Array<[string, string]> = [
        [`/${short}`, `/bills/${slug}`],
        [`/${short.toUpperCase()}`, `/bills/${slug}`],
        [`/${bill.bill_type}-${bill.bill_number}`, `/bills/${slug}`],
        [`/en/${short}`, `/bills/${slug}`],
        [`/es/${short}`, `/es/bills/${slug}`],
        [`/es/${bill.bill_type.toUpperCase()}-${bill.bill_number}`, `/es/bills/${slug}`],
      ];
      for (const [from, to] of cases) {
        const res = await request.get(from, { maxRedirects: 0, headers: { accept: 'text/html' } });
        expect(res.status(), from).toBe(307);
        const location = new URL(res.headers()['location'] ?? '', 'http://x');
        expect(location.pathname, from).toBe(to);
        expect(location.search, from).toBe('');
        expect(res.headers()['cache-control'], from).toContain('no-store');
        expect(res.headers()['x-robots-tag'], from).toBe('noindex');
        expect(res.headers()['set-cookie'], from).toBeUndefined();
      }
    });

    test(`/${short} lands on the bill page itself, with its canonical URL unchanged`, async ({ page }) => {
      for (const [from, to, lang] of [
        [`/${short}`, `/bills/${slug}`, 'en'],
        [`/es/${short}`, `/es/bills/${slug}`, 'es'],
      ] as const) {
        const res = await page.goto(from);
        expect(res?.status(), from).toBe(200);
        expect(new URL(page.url()).pathname, from).toBe(to);
        await expect(page.locator('html')).toHaveAttribute('lang', lang);
        const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
        expect(new URL(canonical ?? '').pathname, from).toBe(to);
      }
    });
  }

  test('a query string on a short address is dropped, never forwarded', async ({ request }) => {
    const bill = SAMPLES[0];
    test.skip(!bill, 'no short address to check');
    for (const from of [
      `/${bill.bill_type}${bill.bill_number}?stance=support`,
      `/es/${bill.bill_type}${bill.bill_number}?stance=oppose&utm_source=x`,
    ]) {
      const res = await request.get(from, { maxRedirects: 0 });
      expect(res.status(), from).toBe(307);
      const location = res.headers()['location'] ?? '';
      expect(location, from).not.toContain('?');
      expect(location, from).not.toContain('stance');
    }
  });

  test('an unknown number is the site’s normal 404, in both languages', async ({ request }) => {
    const n = unheldHouseNumber();
    for (const [from, reference] of [
      [`/hr${n}`, '/this-page-does-not-exist-404'],
      [`/es/hr${n}`, '/es/this-page-does-not-exist-404'],
      ['/hr99999', '/this-page-does-not-exist-404'],
      ['/hres10', '/this-page-does-not-exist-404'],
    ] as const) {
      const res = await request.get(from, { maxRedirects: 0 });
      expect(res.status(), from).toBe(404);
      const ref = await request.get(reference, { maxRedirects: 0 });
      expect(ref.status()).toBe(404);
      const titleOf = (html: string) => /<title>([^<]*)<\/title>/.exec(html)?.[1];
      expect(titleOf(await res.text()), from).toBe(titleOf(await ref.text()));
    }
  });

  test('a real route is never taken for a short address', async ({ request }) => {
    for (const path of [
      '/bills', '/es/bills', '/about', '/today', '/reps', '/questions', '/call', '/citations', '/embeds',
      '/follow', '/glossary', '/mcp', '/nominations', '/partners', '/privacy', '/terms', '/record', '/why-call',
      '/es/privacy', '/es/today', '/llms.txt', '/robots.txt', '/sitemap.xml', '/feed/whats-moving.json',
      '/es/feed/whats-moving.json', '/icon.svg',
    ]) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).not.toBe(307);
    }
  });

  /*
   * The addresses named in the brief of 2026-11-13, each decided from the
   * corpus itself (a held bill redirects, an unheld one is the 404), so a
   * nightly sync can never make this test lie, and the change of Congress
   * cannot either: the expectation is the tracked Congress's bill, else the
   * ended Congress's, else the 404. S. 123, H.Res. 5 and S. 1 were not in
   * the corpus on 2026-11-13; H.R. 9340, H.J.Res. 1 and S.Con.Res. 29 were.
   */
  test('named addresses: each type and spelling, held or not', async ({ request }) => {
    for (const from of [
      '/hr9340', '/HR9340', '/hr-9340', '/es/hr9340', '/en/hr9340', '/s123', '/s1', '/hjres1', '/HJRES1',
      '/sconres29', '/es/sconres29', '/hres5', '/sres5', '/hr1', '/es/HR-1',
    ]) {
      const expected = expectedTarget(from);
      const res = await request.get(from, { maxRedirects: 0, headers: { accept: 'text/html' } });
      if (expected) {
        expect(res.status(), from).toBe(307);
        expect(new URL(res.headers()['location'] ?? '', 'http://x').pathname, from).toBe(expected);
        expect(res.headers()['cache-control'], from).toContain('no-store');
        expect(res.headers()['x-robots-tag'], from).toBe('noindex');
      } else {
        expect(res.status(), `${from} (not in the corpus)`).toBe(404);
      }
    }
  });

  test('after the change of Congress, a number only an ended Congress holds opens its page, with no call to make', async ({
    request,
  }) => {
    // Runs only once lib/congress.mjs lists an ended Congress and the corpus
    // holds its bills (from the January 2027 switch on); until then there is
    // no fallback table and nothing to check.
    test.skip(FALLBACK.length === 0, 'no ended Congress in the corpus yet');
    const ended = corpus.find(
      (b) =>
        b.congress_number === FALLBACK[0].congress &&
        !bills.some((t) => t.bill_type === b.bill_type && t.bill_number === b.bill_number),
    );
    test.skip(!ended, 'every ended bill number is already held by the tracked Congress');
    const slug = slugOf(ended!);
    for (const [from, to] of [
      [`/${ended!.bill_type}${ended!.bill_number}`, `/bills/${slug}`],
      [`/es/${ended!.bill_type.toUpperCase()}-${ended!.bill_number}?stance=support`, `/es/bills/${slug}`],
    ] as const) {
      const res = await request.get(from, { maxRedirects: 0, headers: { accept: 'text/html' } });
      expect(res.status(), from).toBe(307);
      const location = new URL(res.headers()['location'] ?? '', 'http://x');
      expect(location.pathname, from).toBe(to);
      expect(location.search, from).toBe('');
      const page = await request.get(to, { headers: { accept: 'text/html' } });
      expect(page.status(), to).toBe(200);
      // An unfinished bill shows the ended note (EndedPanel); one that became
      // law or was otherwise decided shows its outcome (SettledPanel). Either
      // way the call panel's place holds no call.
      expect(await page.text(), `${to} shows the ended note or its outcome`).toMatch(/data-ended-panel|data-settled-panel/);
    }
  });

  test('a trailing slash still reaches the bill, with no query carried', async ({ request }) => {
    const bill = SAMPLES[0];
    test.skip(!bill, 'no short address to check');
    const short = `${bill.bill_type}${bill.bill_number}`;
    for (const [from, to] of [
      [`/${short}/`, `/bills/${bill.slug}`],
      [`/es/${short}/?stance=support`, `/es/bills/${bill.slug}`],
    ] as const) {
      const res = await request.get(from, { headers: { accept: 'text/html' } });
      expect(res.status(), from).toBe(200);
      const landed = new URL(res.url());
      expect(landed.pathname, from).toBe(to);
      expect(landed.search, from).toBe('');
    }
  });

  test('a fragment survives the redirect in the browser, and a query does not', async ({ page }) => {
    const bill = SAMPLES[0];
    test.skip(!bill, 'no short address to check');
    await page.goto(`/${bill.bill_type}${bill.bill_number}?stance=support#top`);
    const landed = new URL(page.url());
    expect(landed.pathname).toBe(`/bills/${bill.slug}`);
    expect(landed.search).toBe('');
    expect(landed.hash).toBe('#top');
  });

  test('the sitemap and robots.txt carry no short address', async ({ request }) => {
    const shortShape = /^(?:\/(?:en|es))?\/(?:hconres|sconres|hjres|sjres|hres|sres|hr|s)-?\d+\/?$/i;
    const sitemap = await (await request.get('/sitemap.xml')).text();
    const paths = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
    expect(paths.length).toBeGreaterThan(1000);
    expect(paths.some((p) => p.startsWith('/bills/'))).toBe(true);
    expect(paths.filter((p) => shortShape.test(p))).toEqual([]);
    const robots = await (await request.get('/robots.txt')).text();
    const rules = robots.split('\n').map((l) => l.replace(/^(?:Allow|Disallow):\s*/i, '').trim());
    expect(rules.filter((r) => shortShape.test(r))).toEqual([]);
  });
});

/*
 * NAME ADDRESSES (the owner's card 191, Nov 14, 2026: "Names beside numbers.
 * Each name comes from the bill's own official short title in the record,
 * never chosen by Oravan."). The names are picked from the table the build
 * makes from data/short-titles.json, BY KIND (the first name one bill alone
 * carries, the first name two or more bills share), never by a hard-coded
 * name, so a nightly can never make this lie. Until the nightly first fills
 * data/short-titles.json there is no table, and every test here skips with
 * that reason.
 */
const NAMES = decodeNameTables(nameTablesForBuild(corpus));
const NO_NAMES = 'data/short-titles.json holds no short title yet (the nightly fills it), so no name resolves';
const nameOf = (shared: boolean): { name: string; target: string | null } | undefined => {
  for (const table of NAMES) {
    for (const [name, address] of table.names) {
      if ((address === null) !== shared) continue;
      // The expectation through the same order the proxy uses: a number first, then a name.
      return { name, target: expectedTarget(`/${name}`) ?? nameAddressTarget(`/${name}`, ['en', 'es'], 'en', NAMES) };
    }
  }
  return undefined;
};

test.describe('name addresses', () => {
  test('a name one bill alone carries redirects (307) to that bill, in both languages and any case', async ({ request }) => {
    test.skip(NAMES.length === 0, NO_NAMES);
    const unique = nameOf(false);
    test.skip(!unique, 'no name is carried by one bill alone');
    const to = unique!.target!;
    expect(to).toMatch(/^\/bills\/[a-z]+-\d+-\d+$/);
    for (const [from, expected] of [
      [`/${unique!.name}`, to],
      [`/${unique!.name.toUpperCase()}`, to],
      [`/en/${unique!.name}`, to],
      [`/es/${unique!.name}`, `/es${to}`],
      [`/${unique!.name}?stance=support&utm_source=x`, to],
      [`/es/${unique!.name}?stance=oppose`, `/es${to}`],
    ] as const) {
      const res = await request.get(from, { maxRedirects: 0, headers: { accept: 'text/html' } });
      expect(res.status(), from).toBe(307);
      const location = new URL(res.headers()['location'] ?? '', 'http://x');
      expect(location.pathname, from).toBe(expected);
      expect(location.search, from).toBe('');
      expect(res.headers()['cache-control'], from).toContain('no-store');
      expect(res.headers()['x-robots-tag'], from).toBe('noindex');
      expect(res.headers()['set-cookie'], from).toBeUndefined();
    }
  });

  test('a name lands on the bill page itself, with its canonical URL unchanged', async ({ page }) => {
    test.skip(NAMES.length === 0, NO_NAMES);
    const unique = nameOf(false);
    test.skip(!unique, 'no name is carried by one bill alone');
    const to = unique!.target!;
    for (const [from, landed, lang] of [
      [`/${unique!.name}/`, to, 'en'],
      [`/es/${unique!.name}`, `/es${to}`, 'es'],
    ] as const) {
      const res = await page.goto(from);
      expect(res?.status(), from).toBe(200);
      expect(new URL(page.url()).pathname, from).toBe(landed);
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
      expect(new URL(canonical ?? '').pathname, from).toBe(landed);
    }
  });

  test('a name two or more bills share opens their page (307); a near miss is the normal 404; a reserved word is the real page', async ({ request }) => {
    test.skip(NAMES.length === 0, NO_NAMES);
    const shared = nameOf(true);
    const unique = nameOf(false);
    const titleOf = (html: string) => /<title>([^<]*)<\/title>/.exec(html)?.[1];
    if (shared) {
      // The owner's card 193 (Nov 14, 2026): "Build the small page for shared names, so a name never breaks."
      for (const [from, to] of [
        [`/${shared.name}`, shared.target!],
        [`/es/${shared.name}?stance=support`, `/es${shared.target!}`],
      ] as const) {
        expect(to).toMatch(/^(\/es)?\/names\/\d+\/[a-z0-9-]+$/);
        const res = await request.get(from, { maxRedirects: 0, headers: { accept: 'text/html' } });
        expect(res.status(), from).toBe(307);
        const location = new URL(res.headers()['location'] ?? '', 'http://x');
        expect(location.pathname, from).toBe(to);
        expect(location.search, from).toBe('');
        expect(res.headers()['cache-control'], from).toContain('no-store');
        expect(res.headers()['x-robots-tag'], from).toBe('noindex');
        expect(res.headers()['set-cookie'], from).toBeUndefined();
        const page = await request.get(to, { headers: { accept: 'text/html' } });
        expect(page.status(), to).toBe(200);
      }
    }
    const reference = {
      en: titleOf(await (await request.get('/this-page-does-not-exist-404')).text()),
      es: titleOf(await (await request.get('/es/this-page-does-not-exist-404')).text()),
    };
    const notFound = [
      ...(unique ? [`/${unique.name}-x`, `/x-${unique.name}`, `/${unique.name.replace(/-/g, '_')}`] : []),
      ...(shared ? [`/names/1/${shared.name}`, `/names/${SHORT_ADDRESS_CONGRESS}/${shared.name}-x`] : []),
    ].filter((p) => expectedTarget(p) === null && nameAddressTarget(p, ['en', 'es'], 'en', NAMES) === null);
    for (const from of notFound) {
      const res = await request.get(from, { maxRedirects: 0 });
      expect(res.status(), from).toBe(404);
      expect(titleOf(await res.text()), from).toBe(from.startsWith('/es/') ? reference.es : reference.en);
    }
    for (const path of ['/privacy', '/es/privacy', '/bills', '/today', '/about']) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).not.toBe(307);
    }
  });

  test('a shared name\u2019s page lists its bills and nothing to act on, and stays out of search', async ({ page }) => {
    test.skip(NAMES.length === 0, NO_NAMES);
    const shared = nameOf(true);
    test.skip(!shared, 'no name is shared by two bills in the data');
    for (const locale of ['en', 'es'] as const) {
      const to = locale === 'es' ? `/es${shared!.target!}` : shared!.target!;
      const res = await page.goto(to);
      expect(res?.status(), to).toBe(200);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
      const items = page.locator('main ul > li');
      expect(await items.count(), to).toBeGreaterThan(1);
      const links = await page.locator('main ul > li a').evaluateAll((as) => as.map((a) => new URL((a as HTMLAnchorElement).href).pathname));
      for (const href of links) expect(href, to).toMatch(/^(\/es)?\/bills\/[a-z]+-\d+-\d+$/);
      // Nothing to act on: no form, no stance radio, no call link, no tel: link.
      await expect(page.locator('main form, main [role="radio"], main a[href*="/call"], main a[href^="tel:"]')).toHaveCount(0);
    }
  });
});
