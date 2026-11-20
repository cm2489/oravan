import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { getAllBills } from '../lib/core';
import { NAMES_FIXTURE_ENV, NAMES_FIXTURE_ON } from '../lib/names-fixture.mjs';
import { sharedNamePages, sharedNamePath, type SharedNamePage } from '../lib/shared-names';
import { decodeNameTables, nameAddressTarget } from '../lib/short-address';
import { nameTablesForBuild } from '../lib/short-address-build';

/*
 * THE LIST PAGE IN A BROWSER, ON CI (the independent check of #510, Nov 19,
 * 2026: "make CI see the list page").
 *
 * Runs only in the `names-fixture` job of .github/workflows/ci.yml, which
 * builds the site with ORAVAN_E2E_NAMES_FIXTURE=1 (lib/names-fixture.mjs: a
 * small FIXTURE titles file, test data only, never the live data). Every other
 * run skips it with that reason. The pages are read from the build's own
 * tables (sharedNamePages, nameTablesForBuild), never hard-coded, so the
 * expectations are the build's.
 *
 * That job also runs tests/names-a11y.spec.ts (the accessibility floor, and
 * its @reflow test at 320px) and tests/short-address.spec.ts (whose name tests
 * include a shared name's 307 to its list page, in both languages).
 */

const OFF = `runs only in the CI names-fixture job (${NAMES_FIXTURE_ENV}=1)`;
const PAGES: SharedNamePage[] = NAMES_FIXTURE_ON ? sharedNamePages(getAllBills()) : [];
const TABLES = NAMES_FIXTURE_ON ? decodeNameTables(nameTablesForBuild(getAllBills())) : [];
/** The page the pictures show: two spellings of the title, if the fixture still gives one, else the first. */
const SHOWN = PAGES.find((p) => new Set(p.bills.flatMap((b) => b.titles)).size > 1) ?? PAGES[0];
const SHOTS = path.join(process.cwd(), 'names-fixture-shots');

async function sideways(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const vw = doc.clientWidth;
    let worst = 0;
    for (const el of Array.from(document.querySelectorAll('main ul[aria-label] *'))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0) worst = Math.max(worst, r.right - vw);
    }
    return { page: doc.scrollWidth - vw, element: Math.ceil(worst) };
  });
}

test.describe('the list page, built from the CI names fixture', () => {
  test.beforeEach(() => {
    test.skip(!NAMES_FIXTURE_ON, OFF);
  });

  test('at least three list pages exist; each opens in both languages and lists exactly its bills', async ({ request }, testInfo) => {
    test.skip(testInfo.project.name !== 'webkit-desktop', 'run once');
    expect(PAGES.length).toBeGreaterThanOrEqual(3);
    for (const p of PAGES) {
      for (const prefix of ['', '/es']) {
        const to = `${prefix}${sharedNamePath(p.congress, p.name)}`;
        const res = await request.get(to, { headers: { accept: 'text/html' } });
        expect(res.status(), to).toBe(200);
        const html = await res.text();
        for (const b of p.bills) expect(html, `${to} lists ${b.slug}`).toContain(`${prefix}/bills/${b.slug}"`);
      }
    }
  });

  test('every shared name redirects (307) to its own list page, in both languages, with nothing carried', async ({ request }, testInfo) => {
    test.skip(testInfo.project.name !== 'webkit-desktop', 'run once');
    // The newest Congress's page for each name is the one the bare name reaches.
    const reached = PAGES.filter((p) => nameAddressTarget(`/${p.name}`, ['en', 'es'], 'en', TABLES) === sharedNamePath(p.congress, p.name));
    expect(reached.length).toBeGreaterThanOrEqual(3);
    for (const p of reached) {
      for (const [from, to] of [
        [`/${p.name}`, sharedNamePath(p.congress, p.name)],
        [`/${p.name.toUpperCase()}?stance=support`, sharedNamePath(p.congress, p.name)],
        [`/es/${p.name}?utm_source=x`, `/es${sharedNamePath(p.congress, p.name)}`],
      ] as const) {
        const res = await request.get(from, { maxRedirects: 0, headers: { accept: 'text/html' } });
        expect(res.status(), from).toBe(307);
        const location = new URL(res.headers()['location'] ?? '', 'http://x');
        expect(location.pathname, from).toBe(to);
        expect(location.search, from).toBe('');
        expect(res.headers()['cache-control'], from).toContain('no-store');
        expect(res.headers()['x-robots-tag'], from).toBe('noindex');
        expect(res.headers()['set-cookie'], from).toBeUndefined();
      }
    }
  });

  test('two spellings of the title are heard with "or", on the heading and on each card’s own title line', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'webkit-mobile', 'run once, at 390px');
    const two = PAGES.find((p) => new Set(p.bills.flatMap((b) => b.titles)).size > 1);
    test.skip(!two, 'the fixture gives no name with two spellings');
    for (const [prefix, or] of [
      ['', ` ${en.namesPage.titleOr} `],
      ['/es', ` ${es.namesPage.titleOr} `],
    ] as const) {
      await page.goto(`${prefix}${sharedNamePath(two!.congress, two!.name)}`);
      await expect(page.locator('main h1 .sr-only').first()).toHaveText(or);
      // A card whose own titles are two spellings: the same pattern, a hidden slash and a spoken "or".
      const cardWithTwo = two!.bills.findIndex((b) => b.titles.length > 1);
      if (cardWithTwo >= 0) {
        const item = page.locator('main ul[aria-label] > li').nth(cardWithTwo);
        await expect(item.locator('.sr-only').first()).toHaveText(or);
        await expect(item.locator('[aria-hidden]').filter({ hasText: '/' }).first()).toBeAttached();
      }
    }
  });

  for (const width of [360, 390, 430]) {
    test(`the rows: the longest status line and the longest status word stay inside a ${width}px screen, both languages`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'webkit-mobile', 'sets its own widths; run once');
      await page.setViewportSize({ width, height: 844 });
      for (const [prefix, lines, words] of [
        ['', Object.values(en.moments.status.line), Object.values(en.bills.status)],
        ['/es', Object.values(es.moments.status.line), Object.values(es.bills.status)],
      ] as const) {
        const longest = (xs: readonly string[]) => [...xs].map((x) => x.replace(/\{[^{}]*\{([^{}]*)\}[^{}]*\}/g, '$1')).sort((a, b) => b.length - a.length)[0];
        for (const p of PAGES) {
          const to = `${prefix}${sharedNamePath(p.congress, p.name)}`;
          await page.goto(to);
          // Each row's line, as the longest line and then the longest status word (the label an ended bill's card prints).
          for (const text of [longest(lines), longest(words)]) {
            const n = await page.evaluate((t) => {
              const rows = Array.from(document.querySelectorAll('main ul[aria-label] > li'));
              for (const li of rows) {
                const line = li.querySelector('p.font-semibold, p.text-ink');
                if (line) line.textContent = t;
              }
              return rows.length;
            }, text);
            expect(n, to).toBe(p.bills.length);
            const o = await sideways(page);
            expect(o.page, `${to} with "${text}": the page scrolls sideways`).toBeLessThanOrEqual(0);
            expect(o.element, `${to} with "${text}": a row ends past the screen`).toBeLessThanOrEqual(0);
          }
        }
      }
    });
  }

  test('every list page, no sideways scroll at 320px, both languages @reflow', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'webkit-320', 'the 320px project');
    for (const p of PAGES) {
      for (const prefix of ['', '/es']) {
        const to = `${prefix}${sharedNamePath(p.congress, p.name)}`;
        await page.goto(to);
        const o = await sideways(page);
        expect(o.page, to).toBeLessThanOrEqual(0);
        expect(o.element, to).toBeLessThanOrEqual(0);
      }
    }
  });

  test('pictures for the reviewer: one list page, full height, English and Spanish, at 320 and 390px (taken by CI)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'webkit-desktop', 'run once; sets its own widths');
    fs.mkdirSync(SHOTS, { recursive: true });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const [prefix, lang] of [
        ['', 'en'],
        ['/es', 'es'],
      ] as const) {
        await page.goto(`${prefix}${sharedNamePath(SHOWN.congress, SHOWN.name)}`);
        const file = path.join(SHOTS, `${SHOWN.name}-${lang}-${width}.png`);
        await page.screenshot({ path: file, fullPage: true });
        await testInfo.attach(`${lang}-${width}`, { path: file, contentType: 'image/png' });
      }
    }
  });
});
