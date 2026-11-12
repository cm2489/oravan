import { expect, test, type Page, type Request } from '@playwright/test';
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
