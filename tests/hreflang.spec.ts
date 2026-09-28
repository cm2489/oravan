import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { decodedBillSlug, undecodedBillSlug } from './corpus-samples';
import { hiddenLocalePages, localeRoutes, probePathFor } from './routes';

/*
 * S22 — hreflang correctness pass. Industry data says ~75% of hreflang
 * implementations contain errors; before this pass, the bill detail page
 * (PR #30) was the ONLY page type with any canonical/alternates at all —
 * every other page type (home, /bills, /reps, /about, /privacy, /terms,
 * /why-call, /record) had none, which is its own kind of error (a silent
 * absence, not a subtly-wrong tag).
 *
 * This crawls every PAGE route under app/[locale] (tests/routes.ts reads them
 * off the tree, so a new page is covered the day it lands) — each static page
 * once and each dynamic route through its corpus probe — plus the bill page
 * across the decode-status range (two decoded bills and one undecoded one,
 * all drawn from the committed corpus by tests/corpus-samples.ts) and
 * asserts the actual Google reciprocity rules: every alternate is absolute,
 * every page is self-referential (its own locale's alternate equals its own
 * canonical), every pair is reciprocal (page A's alternate to B equals B's
 * own canonical, and vice versa), and x-default is present and consistent
 * everywhere.
 *
 * The locale catch-all is left out: it is a 404, and a 404 declares no
 * canonical. So are the hidden pages (tests/routes.ts hiddenLocalePages —
 * /embeds and /embeds/terms since 2026-09-28), for the same reason;
 * tests/embeds-hidden.spec.ts asserts their 404.
 */

const SITE_ORIGIN = 'https://oravan.org';

/** [test label, locale-relative path]. Labels name the route, not the
 *  corpus record behind a dynamic probe, so a test keeps its identity when the
 *  corpus turns over. */
const PATHS: Array<[string, string]> = [
  ...localeRoutes()
    .filter((r) => r.kind === 'page' && !r.catchAll && !hiddenLocalePages().includes(r.pattern))
    .map((r): [string, string] => [r.pattern, probePathFor(r)]),
  // The bill page across the decode-status range (the route's own probe above
  // is decoded bill #1).
  ['/bills/[id] (a second decoded bill)', `/bills/${decodedBillSlug(1)}`],
  ['/bills/[id] (an undecoded bill)', `/bills/${undecodedBillSlug()}`],
];

function localePath(locale: 'en' | 'es', path: string): string {
  if (locale !== 'es') return path;
  return path === '/' ? '/es' : `/es${path}`;
}

/*
 * The URL string a page's own <link> tags actually carry — not just the
 * browser-navigable path. Next's Metadata resolver collapses the bare root
 * path to the origin with no trailing slash (resolveAbsoluteUrlWithPathname
 * in next/dist/lib/metadata/resolvers/resolve-url.js), and lib/hreflang.ts's
 * absoluteUrl() matches that rule on purpose — so the expected value here
 * has to match it too, or this test would be asserting its own wrong guess
 * rather than the real reciprocity contract.
 */
function localeUrl(locale: 'en' | 'es', path: string): string {
  if (locale === 'en' && path === '/') return SITE_ORIGIN;
  return `${SITE_ORIGIN}${localePath(locale, path)}`;
}

interface HreflangDoc {
  canonical: string | null;
  languages: Record<string, string>;
}

async function readHreflang(page: Page): Promise<HreflangDoc> {
  const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
  const pairs = await page
    .locator('link[rel="alternate"][hreflang]')
    .evaluateAll((els) =>
      els.map((el) => [el.getAttribute('hreflang')!, el.getAttribute('href')!] as [string, string])
    );
  return { canonical, languages: Object.fromEntries(pairs) };
}

test.describe('hreflang correctness (Google reciprocity rules)', () => {
  for (const [label, path] of PATHS) {
    test(`${label}: absolute, self-referential, reciprocal, x-default consistent`, async ({ page }) => {
      const enUrl = localeUrl('en', path);
      const esUrl = localeUrl('es', path);

      await page.goto(localePath('en', path));
      const en = await readHreflang(page);

      await page.goto(localePath('es', path));
      const es = await readHreflang(page);

      for (const [label, doc] of [['en', en] as const, ['es', es] as const]) {
        expect(doc.canonical, `${label} canonical must be present`).toBeTruthy();
        expect(doc.canonical!.startsWith(SITE_ORIGIN), `${label} canonical must be absolute`).toBe(
          true
        );
        expect(doc.canonical, `${label} canonical must be query-free`).not.toContain('?');

        // Exactly the two supported locales plus x-default — no partial map,
        // no stray extra entries.
        expect(Object.keys(doc.languages).sort(), `${label} hreflang set`).toEqual([
          'en',
          'es',
          'x-default',
        ]);
        for (const [hreflang, href] of Object.entries(doc.languages)) {
          expect(href.startsWith(SITE_ORIGIN), `${label} alternate[${hreflang}] must be absolute`).toBe(
            true
          );
        }
        // x-default always resolves to the site's default locale (en —
        // i18n/routing.ts's defaultLocale), on every page type.
        expect(doc.languages['x-default'], `${label} x-default`).toBe(enUrl);
      }

      // Self-referential: each document's own-locale alternate equals its
      // own canonical.
      expect(en.languages['en'], 'en self-reference').toBe(en.canonical);
      expect(es.languages['es'], 'es self-reference').toBe(es.canonical);

      // Reciprocal: the EN document's ES alternate points at the ES
      // document's own canonical URL, and vice versa — the actual
      // pairwise link-back Google's hreflang guidelines require, not just
      // "both pages happen to declare an alternate."
      expect(en.languages['es'], 'en -> es reciprocity').toBe(esUrl);
      expect(es.languages['en'], 'es -> en reciprocity').toBe(enUrl);
      expect(en.languages['es']).toBe(es.canonical);
      expect(es.languages['en']).toBe(en.canonical);
    });
  }
});
