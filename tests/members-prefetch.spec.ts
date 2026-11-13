import { expect, test, type Page, type Request } from '@playwright/test';
import zipDistricts from '../data/zip-districts.json';
import vacancies from '../data/vacancies.json';
import { districtsForZip, repsForDistrict, vacancySlug } from '../lib/core';
import { mockScriptApi, seedZip } from './helpers';
import { referenceBill } from './corpus-fixtures';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * NO ADDRESS NAMES THE VISITOR'S OWN MEMBERS (owner, 2026-11-12; CLAUDE.md
 * rule 1; the independent review of PR #470 the same day).
 *
 * Next.js prefetches the page behind a link as soon as the link is on screen,
 * and again when it is hovered or touched. A prefetch is a request the
 * visitor never made, and its address is `/reps/C001056?_rsc=…` (a member) or
 * `/reps/tx-23?_rsc=…` (a vacant seat's district). A card that links to the
 * members a ZIP lookup found therefore tied a network address to a
 * congressional district in the host's request log, with no click. Each such
 * link now sets `prefetch={false}`, which stops both the viewport prefetch and
 * the hover and touch prefetch (node_modules/next/dist/client/app-dir/link.js
 * and components/links.js, 16.2.12: `mountLinkInstance` observes nothing, and
 * `onMouseEnter` and `onTouchStart` return before `onNavigationIntent`).
 *
 * Each case below does a lookup, brings every link to a member's page into
 * view, hovers it, lets the network settle, and fails if any request the page
 * made on its own has an address that holds one of the visitor's member ids or
 * a vacant seat's slug. Nothing is clicked.
 *
 * THE PORTRAITS TOO (owner, 2026-11-12). `/_next/image?url=…/C001056.jpg`
 * named the member in its query; the members page now draws its pictures
 * from `data:` addresses inside the lookup's answer (lib/member-portraits.ts),
 * so there is no exception any more: no request, `/_next/image` included,
 * may name a visitor's member, in its address or its Referer.
 * tests/members-portraits.spec.ts checks the pictures are really drawn.
 *
 * Prefetching is off in `next dev`, so this file only has teeth against a
 * production build (`next build && next start`, which is what the suite runs).
 */

const ZIP = '78501';
const BILL = `/bills/${referenceBill().slug}`;

/** A ZIP whose every district is a vacant House seat, found in the committed data (the vacancy changes; the test follows it). */
function vacantZip(): { zip: string; slug: string } | null {
  for (const v of vacancies as { state: string; district: number }[]) {
    for (const [zip, districts] of Object.entries(zipDistricts as Record<string, { state: string; district: number }[]>)) {
      if (districts.length === 1 && districts[0].state === v.state && districts[0].district === v.district) {
        return { zip, slug: vacancySlug(v) };
      }
    }
  }
  return null;
}

/** The ids and slugs that would name this visitor's seats: every member of the ZIP's districts, and any vacant seat's slug. */
function namesFor(zip: string): string[] {
  const out = new Set<string>();
  for (const d of districtsForZip(zip)) {
    for (const r of repsForDistrict(d)) out.add(r.bioguide);
    const vacant = (vacancies as { state: string; district: number }[]).find(
      (v) => v.state === d.state && v.district === d.district
    );
    if (vacant) out.add(vacancySlug(vacant));
  }
  return [...out];
}

/** The page's own requests from now on. */
function recordRequests(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (r) => seen.push(r));
  return seen;
}

/**
 * Bring every link to a member's page into view and hover it (the two moments
 * Next.js prefetches on), then wait for the network to go quiet. Returns how
 * many such links the page had, so a case cannot pass by finding none.
 */
async function reachMemberLinks(page: Page): Promise<number> {
  const links = page.locator('a[href*="/reps/"]');
  const count = await links.count();
  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    await link.scrollIntoViewIfNeeded();
    await link.hover({ force: true }).catch(() => {
      /* a link covered for a moment (a sticky bar) is still scrolled into view */
    });
  }
  await page.waitForLoadState('networkidle');
  // The viewport observer reports on a later frame; give it that, then settle again.
  await page.waitForTimeout(500);
  await page.waitForLoadState('networkidle');
  return count;
}

async function expectNoMemberInAnyAddress(requests: Request[], names: string[], also: RegExp[] = []) {
  expect(names.length, 'the case has members or a seat to look for').toBeGreaterThan(0);
  for (const r of requests) {
    const url = new URL(r.url());
    const referer = (await r.allHeaders().catch(() => ({}) as Record<string, string>))['referer'] ?? '';
    for (const name of names) {
      expect(r.url(), `${r.method()} ${r.url()} names ${name}`).not.toContain(name);
      expect(referer, `${r.method()} ${r.url()}: its Referer names ${name}`).not.toContain(name);
    }
    for (const pattern of also) expect(url.pathname, `${r.method()} ${r.url()}`).not.toMatch(pattern);
  }
}

/** The bioguide id of the bill's sponsor, whose link every reader gets (null when the page has none). */
async function sponsorOf(page: Page): Promise<string | null> {
  const sponsor = page.locator('[data-sponsor]');
  return (await sponsor.count()) > 0 ? sponsor.first().getAttribute('data-sponsor') : null;
}

/** Any member's page: `/reps/<id or slug>`, in either language. (Not usable where a page links a member that is not the visitor's.) */
const ANY_MEMBER_PAGE = /\/reps\/[^/]+/;

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

  test.describe(`${label}: links to the visitor's members are not prefetched`, () => {
    test('after a ZIP typed on the home page, on /reps', async ({ page }) => {
      const requests = recordRequests(page);
      await page.goto(`${prefix}/`);
      await page.getByLabel(m.home.zipLabel).fill(ZIP);
      await page.getByRole('button', { name: m.home.zipCta }).click();
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps$`));
      await expect(page.locator('[data-rep-name-link]').first()).toBeVisible();
      expect(await reachMemberLinks(page), 'member links on the page').toBeGreaterThan(0);
      await expectNoMemberInAnyAddress(requests, namesFor(ZIP), [ANY_MEMBER_PAGE]);
    });

    test('after a ZIP typed on /reps itself', async ({ page }) => {
      await page.goto(`${prefix}/reps`);
      const requests = recordRequests(page);
      await page.getByLabel(m.home.zipLabel).fill(ZIP);
      await page.getByRole('button', { name: m.home.zipCta }).click();
      await expect(page.locator('[data-rep-name-link]').first()).toBeVisible();
      expect(await reachMemberLinks(page), 'member links on the page').toBeGreaterThan(0);
      await expectNoMemberInAnyAddress(requests, namesFor(ZIP), [ANY_MEMBER_PAGE]);
    });

    test('on the home page with a saved ZIP, the three names under the hero', async ({ page }) => {
      await page.goto(`${prefix}/privacy`);
      await seedZip(page, ZIP);
      const requests = recordRequests(page);
      await page.goto(`${prefix}/`);
      await expect(page.locator('[data-saved-zip] a[href*="/reps/"]').first()).toBeVisible();
      expect(await reachMemberLinks(page), 'member links on the page').toBeGreaterThan(0);
      await expectNoMemberInAnyAddress(requests, namesFor(ZIP), [ANY_MEMBER_PAGE]);
    });

    test('in the bill page call panel, with a saved ZIP', async ({ page }) => {
      await page.goto(`${prefix}/privacy`);
      await seedZip(page, ZIP);
      const requests = recordRequests(page);
      await page.goto(`${prefix}${BILL}`);
      await page.getByRole('radio', { name: m.bill.stance.support }).click();
      await expect(page.locator('[data-rep-votes-link]').first()).toBeVisible();
      // A bill's own sponsor is linked for every reader, whoever they are, and
      // is out of scope: if the sponsor is one of this visitor's members, that
      // one link is left out of the names.
      const sponsor = await sponsorOf(page);
      expect(await reachMemberLinks(page), 'member links on the page').toBeGreaterThan(0);
      await expectNoMemberInAnyAddress(
        requests,
        namesFor(ZIP).filter((n) => n !== sponsor)
      );
    });

    test('in the bill page call panel, after a ZIP typed in the panel', async ({ page }) => {
      const requests = recordRequests(page);
      await page.goto(`${prefix}${BILL}`);
      await page.getByRole('radio', { name: m.bill.stance.support }).click();
      await page.getByLabel(m.home.zipLabel).fill(ZIP);
      await page.getByRole('button', { name: m.home.zipCta }).click();
      await expect(page.locator('[data-rep-votes-link]').first()).toBeVisible();
      const sponsor = await sponsorOf(page);
      expect(await reachMemberLinks(page), 'member links on the page').toBeGreaterThan(0);
      await expectNoMemberInAnyAddress(
        requests,
        namesFor(ZIP).filter((n) => n !== sponsor)
      );
    });

    test('a ZIP whose House seat is vacant: the seat link is not prefetched either', async ({ page }) => {
      const vacant = vacantZip();
      test.skip(!vacant, 'no ZIP in the committed data maps only to a vacant seat today');
      const { zip, slug } = vacant!;
      const requests = recordRequests(page);
      await page.goto(`${prefix}/reps`);
      await page.getByLabel(m.home.zipLabel).fill(zip);
      await page.getByRole('button', { name: m.home.zipCta }).click();
      const seat = page.locator('[data-seat-name-link]');
      await expect(seat).toBeVisible();
      await expect(seat).toHaveAttribute('href', new RegExp(`/reps/${slug}$`));
      expect(await reachMemberLinks(page), 'member links on the page').toBeGreaterThan(0);
      await expectNoMemberInAnyAddress(requests, namesFor(zip), [ANY_MEMBER_PAGE]);
    });
  });
}
