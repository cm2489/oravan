import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { EMBEDS_PAGES_PUBLIC } from '../lib/site';
import { embedProbes, hiddenLocalePages, localeProbes, localeUrl } from './routes';

/*
 * The /embeds pages, hidden until embeds come back (owner, 2026-09-28,
 * open-questions F: "Nothing half-filled stays public"). While lib/site.ts's
 * EMBEDS_PAGES_PUBLIC is false:
 *
 *   - /embeds and /embeds/terms are real 404s in both locales, inside the
 *     locale layout;
 *   - no page links to either one (footer, /follow, /partners and the rest),
 *     and llms.txt and sitemap.xml name neither;
 *   - the widget routes under /embed/* still answer, and no page links to
 *     them or loads the loader — they are for sites that already carry them;
 *   - POST /api/brand, the configurator's paid theme suggestion, answers 404
 *     (owner, 2026-09-29: "brand off").
 *
 * When the constant flips back to true this file skips, and the page specs
 * (tests/embeds-configurator.spec.ts, embeds-terms, the cold walkthrough) run
 * again.
 */

test.skip(EMBEDS_PAGES_PUBLIC, 'The /embeds pages are public again; tests/embeds-*.spec.ts cover them.');

const MESSAGES = { en, es } as const;

for (const path of hiddenLocalePages()) {
  for (const locale of ['en', 'es'] as const) {
    test(`${locale}: ${path} is a 404 inside the locale layout`, async ({ page }) => {
      const res = await page.goto(localeUrl(locale, path));
      expect(res?.status(), `${localeUrl(locale, path)} status`).toBe(404);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(MESSAGES[locale].notFound.title);
    });
  }
}

test('no page links to a hidden page, and none links to or loads a widget route', async ({ request }) => {
  // Every page route in both locales (dynamic ones through their corpus
  // probe), the hidden pages themselves excluded: their 404 is checked above.
  const pages = localeProbes().filter(
    (p) => p.route.kind === 'page' && !hiddenLocalePages().includes(p.route.pattern),
  );
  expect(pages.length).toBeGreaterThan(10);
  for (const { url } of pages) {
    const html = await (await request.get(url)).text();
    expect(html, `${url} links a hidden /embeds page`).not.toMatch(/href="[^"]*\/embeds(?:[/"?#])/);
    expect(html, `${url} links or loads an /embed/ widget route or the loader`).not.toMatch(
      /(?:href|src)="[^"]*\/embed(?:\/|\.js)/,
    );
  }
});

test('llms.txt and sitemap.xml name neither hidden page', async ({ request }) => {
  for (const file of ['/llms.txt', '/sitemap.xml']) {
    const body = await (await request.get(file)).text();
    expect(body, `${file} names /embeds`).not.toMatch(/\/embeds(?:[/<"\s)]|$)/m);
  }
});

test('the widget routes still answer: hiding the pages leaves /embed/* and the loader alone', async ({
  request,
}) => {
  const probes = embedProbes();
  for (const name of ['rep-lookup', 'bill-card', 'action-panel'] as const) {
    const res = await request.get(probes[name]);
    expect(res.status(), `${probes[name]} status`).toBe(200);
  }
  const loader = await request.get('/embed.js');
  expect(loader.status()).toBe(200);
});

test('the brand preview is off: POST /api/brand answers 404 not_found', async ({ request }) => {
  // An address the SSRF guard refuses, so a route that wrongly ran its live
  // path would answer 400 here and still reach nothing outside this machine.
  const res = await request.post('/api/brand', {
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.168.201.7' },
    data: { url: 'https://10.0.0.1/' },
  });
  expect(res.status()).toBe(404);
  expect(await res.json()).toEqual({ error: 'not_found' });
});
