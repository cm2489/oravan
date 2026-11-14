import { expect, test } from '@playwright/test';
import billsJson from '../data/bills.json';
import { SHORT_ADDRESS_CONGRESS } from '../lib/short-address';

/*
 * Short addresses for bills, against the production build: /hr9340 answers
 * with a 307 to that bill's canonical page, in both languages, with the
 * request's query string dropped; an unknown number is the site's normal 404.
 * The parser, the index and the no-collision proof are pure-Node unit specs
 * in tests/short-address.unit.spec.ts.
 */

type CorpusBill = { bill_type: string; bill_number: number; congress_number: number };
const bills = (billsJson as unknown as CorpusBill[]).filter((b) => b.congress_number === SHORT_ADDRESS_CONGRESS);

/** Three real bills of different types, in the data file's own order. */
function samples(): CorpusBill[] {
  const out: CorpusBill[] = [];
  for (const type of ['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres']) {
    const bill = bills.find((b) => b.bill_type === type);
    if (bill) out.push(bill);
    if (out.length === 3) break;
  }
  if (out.length < 3) throw new Error('the corpus holds fewer than three bill types of the current Congress');
  return out;
}

const slugOf = (b: CorpusBill) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`;

/** A House bill number the corpus does not hold. */
function unheldHouseNumber(): number {
  const held = new Set(bills.filter((b) => b.bill_type === 'hr').map((b) => b.bill_number));
  let n = 1;
  while (held.has(n)) n++;
  return n;
}

test.describe('short addresses', () => {
  for (const bill of samples()) {
    const short = `${bill.bill_type}${bill.bill_number}`;
    const slug = slugOf(bill);

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
    const bill = samples()[0];
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
   * nightly sync can never make this test lie. S. 123, H.Res. 5 and S. 1
   * are not in the corpus today; H.R. 9340, H.J.Res. 1 and S.Con.Res. 29 are.
   */
  test('named addresses: each type and spelling, held or not', async ({ request }) => {
    const held = new Set(bills.map(slugOf));
    const cases: Array<[string, string, string]> = [
      ['/hr9340', '', 'hr-9340'],
      ['/HR9340', '', 'hr-9340'],
      ['/hr-9340', '', 'hr-9340'],
      ['/es/hr9340', '/es', 'hr-9340'],
      ['/en/hr9340', '', 'hr-9340'],
      ['/s123', '', 's-123'],
      ['/s1', '', 's-1'],
      ['/hjres1', '', 'hjres-1'],
      ['/HJRES1', '', 'hjres-1'],
      ['/sconres29', '', 'sconres-29'],
      ['/es/sconres29', '/es', 'sconres-29'],
      ['/hres5', '', 'hres-5'],
      ['/sres5', '', 'sres-5'],
    ];
    for (const [from, prefix, stem] of cases) {
      const slug = `${stem}-${SHORT_ADDRESS_CONGRESS}`;
      const res = await request.get(from, { maxRedirects: 0, headers: { accept: 'text/html' } });
      if (held.has(slug)) {
        expect(res.status(), from).toBe(307);
        expect(new URL(res.headers()['location'] ?? '', 'http://x').pathname, from).toBe(`${prefix}/bills/${slug}`);
      } else {
        expect(res.status(), `${from} (not in the corpus)`).toBe(404);
      }
    }
  });

  test('a trailing slash still reaches the bill, with no query carried', async ({ request }) => {
    const bill = samples()[0];
    const short = `${bill.bill_type}${bill.bill_number}`;
    for (const [from, to] of [
      [`/${short}/`, `/bills/${slugOf(bill)}`],
      [`/es/${short}/?stance=support`, `/es/bills/${slugOf(bill)}`],
    ] as const) {
      const res = await request.get(from, { headers: { accept: 'text/html' } });
      expect(res.status(), from).toBe(200);
      const landed = new URL(res.url());
      expect(landed.pathname, from).toBe(to);
      expect(landed.search, from).toBe('');
    }
  });

  test('a fragment survives the redirect in the browser, and a query does not', async ({ page }) => {
    const bill = samples()[0];
    await page.goto(`/${bill.bill_type}${bill.bill_number}?stance=support#top`);
    const landed = new URL(page.url());
    expect(landed.pathname).toBe(`/bills/${slugOf(bill)}`);
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
