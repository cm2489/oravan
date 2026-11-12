import { expect, test, type Page, type Request } from '@playwright/test';
import { createTranslator } from 'next-intl';
import { districtsForZip, repsForDistrict } from '../lib/core';
import { seedZip } from './helpers';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * NO ZIP IN THE MEMBERS PAGE'S ADDRESS (owner, 2026-11-12; CLAUDE.md rule 1).
 *
 * Until that day a lookup opened /reps?zip=NNNNN, so the reader's ZIP sat in
 * the host's request log, the browser's history and every link they shared.
 * Now the ZIP travels only in a POST body (lib/members-action.ts,
 * components/RepsLookup.tsx). These tests watch every request the page makes,
 * in both languages, with JavaScript on and off, and fail if the ZIP shows up
 * in any address: the page's own, a navigation, a fetch, a prefetch, an
 * image. A request BODY may carry it; that is where it belongs.
 *
 * The old-link path is here too: /reps?zip=… still shows the members and
 * leaves the clean address behind without adding a history entry. That first
 * request's address, with the ZIP in it, does reach the host's log; the page
 * cannot un-send it, and the test does not pretend otherwise.
 */

const ZIP = '78501';
/** A split ZIP: NY-10 (Daniel S. Goldman) and NY-12 (Jerrold Nadler), as tests/district.spec.ts uses it. */
const SPLIT_ZIP = '10001';
const LOOKUP_IN_ADDRESS = /[?&](zip|district)=/;
const SPLIT_TOKEN = new RegExp(`(?<![0-9A-Za-z])${SPLIT_ZIP}(?![0-9A-Za-z])`);

/*
 * Nothing in this file reaches a paid or outside service: the call script
 * and the street-address geocoder are answered here. Every address below
 * resolves to NY-12.
 */
test.beforeEach(async ({ page }) => {
  await page.route('**/api/script', (route) => route.abort());
  await page.route('**/api/district', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'NY', district: 12 }) })
  );
});
const MEMBERS = districtsForZip(ZIP).flatMap(repsForDistrict).map((l) => l.name);

/** The ZIP as a token of its own: not inside a longer run of letters or digits (a chunk hash). */
const ZIP_TOKEN = new RegExp(`(?<![0-9A-Za-z])${ZIP}(?![0-9A-Za-z])`);

/** Every request the page makes from now on, recorded with its body. */
function recordRequests(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (r) => seen.push(r));
  return seen;
}

function expectNoZipInAnyAddress(requests: Request[], page: Page) {
  expect(page.url(), 'the page address').not.toMatch(ZIP_TOKEN);
  expect(page.url(), 'the page address').not.toMatch(/[?&](zip|district)=/);
  for (const r of requests) {
    expect(r.url(), `${r.method()} ${r.url()}`).not.toMatch(ZIP_TOKEN);
    expect(r.url(), `${r.method()} ${r.url()}`).not.toMatch(/[?&](zip|district)=/);
  }
}

async function expectMembers(page: Page) {
  expect(MEMBERS.length, `the fixture ZIP ${ZIP} must resolve to members in data/`).toBeGreaterThan(0);
  for (const name of MEMBERS) await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
}

for (const [prefix, m] of [
  ['', en],
  ['/es', es],
] as const) {
  const label = prefix || '/en';

  test.describe(`${label}: a ZIP lookup never puts the ZIP in an address`, () => {
    test('from the home page: the members on bare /reps, the ZIP only in a POST body', async ({ page }) => {
      const requests = recordRequests(page);
      await page.goto(`${prefix}/`);
      await page.getByLabel(m.home.zipLabel).fill(ZIP);
      await page.getByRole('button', { name: m.home.zipCta }).click();
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps$`));
      await expectMembers(page);
      // Let the page settle, so prefetches of its links are recorded too.
      await page.waitForLoadState('networkidle');
      expectNoZipInAnyAddress(requests, page);
      const carried = requests.filter((r) => r.method() === 'POST' && (r.postData() ?? '').includes(ZIP));
      expect(carried.length, 'the ZIP went somewhere: in a POST body').toBeGreaterThan(0);
    });

    test('on /reps itself: typing a ZIP shows the members and the address stays bare', async ({ page }) => {
      const requests = recordRequests(page);
      await page.goto(`${prefix}/reps`);
      await page.getByLabel(m.home.zipLabel).fill(ZIP);
      await page.getByRole('button', { name: m.home.zipCta }).click();
      await expectMembers(page);
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps$`));
      expectNoZipInAnyAddress(requests, page);
    });

    test('a saved ZIP: bare /reps opens on the members with nothing in the address', async ({ page }) => {
      await page.goto(`${prefix}/privacy`);
      await seedZip(page, ZIP);
      const requests = recordRequests(page);
      await page.goto(`${prefix}/reps`);
      await expectMembers(page);
      await page.waitForLoadState('networkidle');
      expectNoZipInAnyAddress(requests, page);
    });

    test('an old /reps?zip= link shows the members and ends on the clean address, with no new history entry', async ({
      page,
    }) => {
      await page.goto(`${prefix}/privacy`);
      await page.goto(`${prefix}/reps?zip=${ZIP}`);
      await expectMembers(page);
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps$`));
      // An old link saves nothing on this device, as before.
      await expect(page.locator('[data-zip-kept]')).toHaveCount(0);
      expect(await page.evaluate(() => localStorage.getItem('oravan.prefs'))).toBeNull();
      // The address was replaced, not pushed: Back leaves the page.
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${prefix}/privacy$`));
    });
  });

  test.describe(`${label}: with JavaScript off the lookup still works, by a POST`, () => {
    test.use({ javaScriptEnabled: false });

    for (const start of ['/', '/reps'] as const) {
      test(`from ${start}: the form POSTs the ZIP to ${prefix}/reps and the server renders the members`, async ({
        page,
      }) => {
        const requests = recordRequests(page);
        await page.goto(`${prefix}${start === '/' ? '' : start}` || '/');
        await page.getByLabel(m.home.zipLabel).fill(ZIP);
        const submit = page.waitForRequest((r) => r.isNavigationRequest() && r.method() === 'POST');
        await page.getByRole('button', { name: m.home.zipCta }).click();
        const post = await submit;
        expect(new URL(post.url()).pathname).toBe(`${prefix}/reps`);
        expect(post.postData() ?? '').toContain(ZIP);
        await page.waitForLoadState('load');
        await expectMembers(page);
        await expect(page.locator('[data-zip-line]')).toBeVisible();
        expectNoZipInAnyAddress(requests, page);
      });
    }

    test('an old /reps?zip= link still shows the members (the address cannot be cleaned without JavaScript)', async ({
      page,
    }) => {
      await page.goto(`${prefix}/reps?zip=${ZIP}`);
      await expectMembers(page);
    });
  });
}

/*
 * The refinement keeps the district out of the address too: an old link with
 * ?district= renders the one district and is cleaned on arrival like ?zip=.
 */
test('an old /reps?zip=&district= link renders the refined view and drops both from the address', async ({ page }) => {
  await page.goto('/reps?zip=10001&district=NY-12');
  await expect(page.getByText('Jerrold Nadler')).toBeVisible();
  await expect(page.getByText('Daniel S. Goldman')).toHaveCount(0);
  await expect(page).toHaveURL(/\/reps$/);
});

/*
 * OLD LINKS, AFTER THE FIRST REQUEST (2026-11-12 review). The old link's own
 * request carries the ZIP; nothing after it may. The address is cleaned one
 * tick after the page runs, once Next.js's own history hooks are in place, so
 * the router learns the clean address (lib/members-entry.ts). Before that
 * fix every later lookup POSTed to /reps?zip=…&district=…, and Back from a
 * bill left the bill on screen.
 */
for (const [prefix, m] of [
  ['', en],
  ['/es', es],
] as const) {
  const label = prefix || '/en';
  const t = createTranslator({ locale: prefix ? 'es' : 'en', messages: prefix ? es : en, namespace: 'reps' });

  test.describe(`${label}: an old link's ZIP goes no further than its own request`, () => {
    test('every later request, of any method, has a clean address', async ({ page }) => {
      await page.goto(`${prefix}/reps?zip=${SPLIT_ZIP}&district=NY-12`);
      await expect(page.getByText('Jerrold Nadler').first()).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps$`));
      // The router took the clean address, with its own state kept in the entry.
      await expect.poll(() => page.evaluate(() => Boolean(window.history.state?.__NA))).toBe(true);
      const requests = recordRequests(page);

      // "Show all districts": a lookup, then a second street-address refinement.
      await page.getByRole('link', { name: t('showAllDistricts', { zip: SPLIT_ZIP }) }).click();
      await expect(page.getByText('Daniel S. Goldman').first()).toBeVisible();
      await page.getByLabel(t('addressLabel')).fill('421 8th Ave');
      await page.getByRole('button', { name: t('refineCta') }).click();
      await expect(page.getByText('Daniel S. Goldman')).toHaveCount(0);
      await expect(page.getByText('Jerrold Nadler').first()).toBeVisible();
      await page.waitForLoadState('networkidle');

      const posts = requests.filter((r) => r.method() === 'POST');
      expect(posts.length, 'the lookups were made').toBeGreaterThanOrEqual(2);
      for (const r of requests) {
        expect(r.url(), `${r.method()} ${r.url()}`).not.toMatch(SPLIT_TOKEN);
        expect(r.url(), `${r.method()} ${r.url()}`).not.toMatch(LOOKUP_IN_ADDRESS);
      }
    });

    test('old link, then a bill, then Back: the members are on screen again', async ({ page }) => {
      await page.goto(`${prefix}/reps?zip=${ZIP}`);
      await expectMembers(page);
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps$`));
      await expect.poll(() => page.evaluate(() => Boolean(window.history.state?.__NA))).toBe(true);
      const bill = page.locator('main a[href*="/bills/"]').first();
      const href = await bill.getAttribute('href');
      await bill.click();
      await expect(page).toHaveURL(new RegExp(`${href}$`));
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps$`));
      await expectMembers(page);
      await expect(page.locator('main a[href*="/bills/"]').first()).toBeVisible();
    });

    test('the page load sends no Referer that carries the ZIP, and /reps says why', async ({ page }) => {
      await page.goto(`${prefix}/privacy`);
      const requests = recordRequests(page);
      const response = await page.goto(`${prefix}/reps?zip=${SPLIT_ZIP}&district=NY-12`);
      expect(response?.headers()['referrer-policy']).toBe('strict-origin');
      await expect(page.getByText('Jerrold Nadler').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      const origin = new URL(page.url()).origin;
      const referers: string[] = [];
      for (const r of requests) {
        const referer = await r.headerValue('referer');
        if (referer === null) continue;
        referers.push(referer);
        expect(referer, `Referer of ${r.method()} ${r.url()}`).not.toMatch(SPLIT_TOKEN);
        expect(referer, `Referer of ${r.method()} ${r.url()}`).not.toMatch(LOOKUP_IN_ADDRESS);
      }
      // The header is there to be read: the page's own requests send the
      // origin and nothing after it. (A request the previous page started
      // can still finish here, with that page's address; it carries no ZIP.)
      expect(referers, 'Referers sent while the old link loaded').toContain(`${origin}/`);
    });
  });

  test.describe(`${label}: an old link with JavaScript off`, () => {
    test.use({ javaScriptEnabled: false });

    test('the next page clicked gets no Referer with the ZIP', async ({ page }) => {
      await page.goto(`${prefix}/reps?zip=${SPLIT_ZIP}&district=NY-12`);
      await expect(page.getByText('Jerrold Nadler').first()).toBeVisible();
      const bill = page.locator('main a[href*="/bills/"]').first();
      const next = page.waitForRequest((r) => r.isNavigationRequest() && r.url().includes('/bills/'));
      await bill.click();
      const referer = await (await next).headerValue('referer');
      expect(referer ?? '').not.toMatch(SPLIT_TOKEN);
      expect(referer ?? '').not.toMatch(LOOKUP_IN_ADDRESS);
    });
  });

  /*
   * RELOAD AND BACK KEEP THE REFINEMENT, WITH NOTHING STORED (2026-11-12).
   * The district is kept in this tab's history entry only: not the address,
   * not web storage, not a cookie.
   */
  test.describe(`${label}: a refined district survives Reload and Back`, () => {
    test('typed ZIP, refined: Reload keeps the one district, Back shows them all, Forward refines again', async ({
      page,
      context,
    }) => {
      await page.goto(`${prefix}/reps`);
      await page.getByLabel(m.home.zipLabel).fill(SPLIT_ZIP);
      await page.getByRole('button', { name: m.home.zipCta }).click();
      await expect(page.getByText('Daniel S. Goldman').first()).toBeVisible();
      await page.getByLabel(t('addressLabel')).fill('421 8th Ave');
      await page.getByRole('button', { name: t('refineCta') }).click();
      await expect(page.getByText('Daniel S. Goldman')).toHaveCount(0);

      await page.reload();
      await expect(page.getByText('Jerrold Nadler').first()).toBeVisible();
      await expect(page.getByText('Daniel S. Goldman')).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps$`));

      await page.goBack();
      await expect(page.getByText('Daniel S. Goldman').first()).toBeVisible();
      await expect(page.getByText('Jerrold Nadler').first()).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps$`));

      await page.goForward();
      await expect(page.getByText('Daniel S. Goldman')).toHaveCount(0);
      await expect(page.getByText('Jerrold Nadler').first()).toBeVisible();

      // Where it was kept: nowhere but this tab's history.
      const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
      expect(stored).not.toContain('NY-12');
      expect(await context.cookies()).toEqual([]);
    });

    test('an old refined link: Reload keeps the refined view on the clean address', async ({ page }) => {
      await page.goto(`${prefix}/reps?zip=${SPLIT_ZIP}&district=NY-12`);
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps$`));
      await expect.poll(() => page.evaluate(() => Boolean(window.history.state?.oravanMembers))).toBe(true);
      await page.reload();
      await expect(page.getByText('Jerrold Nadler').first()).toBeVisible();
      await expect(page.getByText('Daniel S. Goldman')).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps$`));
    });
  });

  /*
   * STORAGE BLOCKED (Safari "Block all cookies", 2026-11-12). localStorage
   * throws; the ZIP typed on the home page reaches /reps through this
   * visit's memory (lib/local.ts), and Reload through the history entry.
   * A fresh full page load has neither, so /reps asks for the ZIP: that
   * cannot work with storage blocked, by design.
   */
  test.describe(`${label}: with storage blocked`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get() {
            throw new DOMException('The operation is insecure.', 'SecurityError');
          },
        });
      });
    });

    test('a ZIP typed on the home page shows the members on /reps, and Reload keeps them', async ({ page }) => {
      await page.goto(`${prefix}/`);
      expect(await page.evaluate(() => {
        try {
          return typeof window.localStorage;
        } catch {
          return 'blocked';
        }
      })).toBe('blocked');
      await page.getByLabel(m.home.zipLabel).fill(ZIP);
      await page.getByRole('button', { name: m.home.zipCta }).click();
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps$`));
      await expectMembers(page);
      await page.reload();
      await expectMembers(page);
    });

    test('a fresh page load of /reps asks for the ZIP (nothing was kept)', async ({ page }) => {
      await page.goto(`${prefix}/reps`);
      await expect(page.getByText(m.reps.noZip)).toBeVisible();
    });
  });
}
