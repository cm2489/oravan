import { expect, test, type Page, type Request } from '@playwright/test';
import vacancies from '../data/vacancies.json';
import { membersFor } from '../lib/members';
import { vacancySlug } from '../lib/core';
import { mockScriptApi, seedZip } from './helpers';
import { referenceBill } from './corpus-fixtures';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * THE MEMBERS' PICTURES ARRIVE INSIDE THE LOOKUP'S ANSWER (owner, 2026-11-12:
 * "Send the pictures inside the lookup's own answer, so no separate request
 * names a member. Nothing a visitor sees changes."; CLAUDE.md rule 1).
 *
 * Until that day the members page drew each picture through next/image, so
 * after a lookup the browser asked for `/_next/image?url=…/C001056.jpg…` on
 * its own, and a House member's id names one congressional district. Now the
 * pictures are `data:` addresses inside the answer (lib/member-portraits.ts).
 *
 * Each case below records every request the page makes from the moment the
 * visitor arrives, and fails when any of them has an address or a Referer
 * that holds one of the visitor's members' ids, one of their districts
 * ("NY-12", in any case) or a vacant seat's slug; then it checks that every
 * card's picture is really drawn: a 216 x 264 WebP decoded from a `data:`
 * address, filling the inside of the card's 72 x 88 frame, with pixels that
 * are not all one colour. A member's own page, which the visitor chooses to open, is
 * out of scope (it still loads its portrait by the member's id), and no case
 * opens one.
 */

const ZIP = '78501';
const SPLIT_ZIP = '10001';
const BILL = `/bills/${referenceBill().slug}`;

/** Every token that would name this visitor's seats: member ids, districts, vacant seats' slugs. */
function tokensFor(zip: string, district?: string): { ids: string[]; districts: RegExp[] } {
  const result = membersFor(zip, district)!;
  const ids = new Set<string>();
  const districts: RegExp[] = [];
  for (const d of result.districts) {
    for (const r of d.reps) ids.add(r.bioguide);
    districts.push(new RegExp(`(^|[^a-z0-9])${d.state}-0?${d.district}([^0-9]|$)`, 'i'));
    const vacant = (vacancies as { state: string; district: number }[]).find(
      (v) => v.state === d.state && v.district === d.district
    );
    if (vacant) ids.add(vacancySlug(vacant));
  }
  return { ids: [...ids], districts };
}

function recordRequests(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (r) => seen.push(r));
  return seen;
}

/** No request's address or Referer names one of the visitor's members, districts or seats. */
async function expectNothingNamed(requests: Request[], { ids, districts }: { ids: string[]; districts: RegExp[] }) {
  expect(ids.length, 'the case has members to look for').toBeGreaterThan(0);
  expect(requests.length, 'the page made requests to inspect').toBeGreaterThan(0);
  for (const r of requests) {
    const referer = (await r.allHeaders().catch(() => ({}) as Record<string, string>))['referer'] ?? '';
    for (const [what, value] of [
      ['address', r.url()],
      ['Referer', referer],
    ] as const) {
      for (const id of ids) expect(value, `${r.method()} ${r.url()}: its ${what} names ${id}`).not.toContain(id);
      for (const d of districts) expect(value, `${r.method()} ${r.url()}: its ${what}`).not.toMatch(d);
    }
    expect(new URL(r.url()).pathname, `${r.method()} ${r.url()}`).not.toMatch(/^\/_next\/image/);
  }
}

/** What every member card's picture is, read in the page. */
async function pictures(page: Page) {
  return page.locator('article').evaluateAll((cards) =>
    cards
      .filter((card) => card.querySelector('[data-rep-name-link]'))
      .map((card) => {
        const img = card.querySelector('img');
        if (!img) return { ok: false, why: 'no img' };
        const box = img.getBoundingClientRect();
        let distinct = 0;
        if (img.complete && img.naturalWidth > 0) {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          const seen = new Set<number>();
          for (let i = 0; i < data.length && seen.size < 64; i += 4 * 97) seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
          distinct = seen.size;
        }
        return {
          ok:
            img.getAttribute('src')!.startsWith('data:image/webp;base64,') &&
            img.complete &&
            img.naturalWidth === 216 &&
            img.naturalHeight === 264 &&
            // The frame is 72 x 88 with a 1.5px border; the picture fills
            // the inside of it (69 x 85), as it always has.
            (img.parentElement as HTMLElement).offsetWidth === 72 &&
            (img.parentElement as HTMLElement).offsetHeight === 88 &&
            Math.abs(box.width - img.parentElement!.clientWidth) < 1 &&
            Math.abs(box.height - img.parentElement!.clientHeight) < 1 &&
            img.getAttribute('alt') === '' &&
            distinct > 16,
          why: `${img.getAttribute('src')!.slice(0, 30)} ${img.naturalWidth}x${img.naturalHeight} box ${box.width}x${box.height} frame ${(img.parentElement as HTMLElement).offsetWidth}x${(img.parentElement as HTMLElement).offsetHeight} distinct ${distinct}`,
        };
      })
  );
}

/** Every member card on the page draws its picture, inline. */
async function expectPicturesShown(page: Page, cards: number) {
  await expect
    .poll(async () => {
      const all = await pictures(page);
      return all.length === cards && all.every((p) => p.ok) ? 'ok' : JSON.stringify(all);
    }, { timeout: 15_000 })
    .toBe('ok');
}

/** How many member cards a lookup shows (a senator appears under each district of a split ZIP). */
function cardsFor(zip: string, district?: string): number {
  return membersFor(zip, district)!.districts.reduce((n, d) => n + d.reps.length, 0);
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/district', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'NY', district: 12 }) })
  );
  await mockScriptApi(page);
});

for (const [prefix, m] of [
  ['', en],
  ['/es', es],
] as const) {
  const label = prefix || '/en';

  test.describe(`${label}: the members' pictures come inside the lookup's answer`, () => {
    test('a ZIP typed on the home page', async ({ page }) => {
      const requests = recordRequests(page);
      await page.goto(`${prefix}/`);
      await page.getByLabel(m.home.zipLabel).fill(ZIP);
      await page.getByRole('button', { name: m.home.zipCta }).click();
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps$`));
      await expectPicturesShown(page, cardsFor(ZIP));
      await page.waitForLoadState('networkidle');
      await expectNothingNamed(requests, tokensFor(ZIP));
    });

    test('a ZIP typed on /reps', async ({ page }) => {
      const requests = recordRequests(page);
      await page.goto(`${prefix}/reps`);
      await page.getByLabel(m.home.zipLabel).fill(ZIP);
      await page.getByRole('button', { name: m.home.zipCta }).click();
      await expectPicturesShown(page, cardsFor(ZIP));
      await page.waitForLoadState('networkidle');
      await expectNothingNamed(requests, tokensFor(ZIP));
    });

    test('a saved ZIP: /reps opens on the members', async ({ page }) => {
      await page.goto(`${prefix}/privacy`);
      await seedZip(page, ZIP);
      const requests = recordRequests(page);
      await page.goto(`${prefix}/reps`);
      await expectPicturesShown(page, cardsFor(ZIP));
      await page.waitForLoadState('networkidle');
      await expectNothingNamed(requests, tokensFor(ZIP));
    });

    test('a split ZIP refined by street address, then Reload, Back and Forward', async ({ page }) => {
      const t = (k: keyof typeof m.reps) => m.reps[k] as string;
      const requests = recordRequests(page);
      await page.goto(`${prefix}/reps`);
      await page.getByLabel(m.home.zipLabel).fill(SPLIT_ZIP);
      await page.getByRole('button', { name: m.home.zipCta }).click();
      await expectPicturesShown(page, cardsFor(SPLIT_ZIP));

      await page.getByLabel(t('addressLabel')).fill('421 8th Ave');
      await page.getByRole('button', { name: t('refineCta') }).click();
      await expect(page.getByText('Daniel S. Goldman')).toHaveCount(0);
      await expectPicturesShown(page, cardsFor(SPLIT_ZIP, 'NY-12'));

      await page.reload();
      await expect(page.getByText('Jerrold Nadler').first()).toBeVisible();
      await expectPicturesShown(page, cardsFor(SPLIT_ZIP, 'NY-12'));

      await page.goBack();
      await expect(page.getByText('Daniel S. Goldman').first()).toBeVisible();
      await expectPicturesShown(page, cardsFor(SPLIT_ZIP));

      await page.goForward();
      await expect(page.getByText('Daniel S. Goldman')).toHaveCount(0);
      await expectPicturesShown(page, cardsFor(SPLIT_ZIP, 'NY-12'));

      await page.waitForLoadState('networkidle');
      await expectNothingNamed(requests, tokensFor(SPLIT_ZIP));
      // No picture is kept anywhere but the page on screen.
      const kept = await page.evaluate(
        () => JSON.stringify(window.history.state) + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })
      );
      expect(kept).not.toContain('data:image');
      expect(kept).not.toContain('UklGR'); // the start of every WebP file, in base64
    });

    test('Back to the members from a bill they lead to', async ({ page }) => {
      const requests = recordRequests(page);
      await page.goto(`${prefix}/reps`);
      await page.getByLabel(m.home.zipLabel).fill(ZIP);
      await page.getByRole('button', { name: m.home.zipCta }).click();
      await expectPicturesShown(page, cardsFor(ZIP));
      await page.locator('main a[href*="/bills/"]').first().click();
      await expect(page).toHaveURL(/\/bills\//);
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps$`));
      await expectPicturesShown(page, cardsFor(ZIP));
      await page.waitForLoadState('networkidle');
      await expectNothingNamed(requests, tokensFor(ZIP));
    });

    test('an old /reps?zip= link', async ({ page }) => {
      const requests = recordRequests(page);
      await page.goto(`${prefix}/reps?zip=${ZIP}`);
      await expectPicturesShown(page, cardsFor(ZIP));
      await page.waitForLoadState('networkidle');
      await expectNothingNamed(requests, tokensFor(ZIP));
    });

    test('surfaces that show names without pictures do not ask for them', async ({ page }) => {
      await page.goto(`${prefix}/privacy`);
      await seedZip(page, ZIP);
      const requests = recordRequests(page);
      await page.goto(`${prefix}/`);
      await expect(page.locator('[data-saved-zip] a[href*="/reps/"]').first()).toBeVisible();
      await page.goto(`${prefix}${BILL}`);
      await page.getByRole('radio', { name: m.bill.stance.support }).click();
      await expect(page.locator('[data-rep-votes-link]').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      // The members lookup (the one answer that carries pictures) never ran.
      const lookups = [];
      for (const r of requests) if ((await r.allHeaders())['next-action']) lookups.push(r.url());
      expect(lookups).toEqual([]);
    });
  });

  test.describe(`${label}: with JavaScript off the pictures are in the page itself`, () => {
    test.use({ javaScriptEnabled: false });

    test('the form POSTs to /reps and the answer draws every picture', async ({ page }) => {
      const requests = recordRequests(page);
      await page.goto(`${prefix}/reps`);
      await page.getByLabel(m.home.zipLabel).fill(ZIP);
      await page.getByRole('button', { name: m.home.zipCta }).click();
      await page.waitForLoadState('load');
      await expectPicturesShown(page, cardsFor(ZIP));
      await expectNothingNamed(requests, tokensFor(ZIP));
    });
  });
}
