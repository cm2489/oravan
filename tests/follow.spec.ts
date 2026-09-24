import { expect, test, type Locator, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { mcpRpc } from './helpers';

/*
 * Plan item B8 — "a citizen can find the feed in one click from any page."
 *
 * Two surfaces: the footer's Follow column (on every page, so it is checked
 * on the homepage, the bills index, a bill page and the Spanish homepage),
 * and /follow, the one page that lists every way to follow Oravan that exists
 * today. Every link either surface prints must resolve — a Follow link that
 * 404s is worse than none — and every one is a 44px touch target.
 *
 * The MCP facts on /follow are asserted against the LIVE server's
 * tools/list, not against a literal here, so the page, the server and this
 * spec can only ever agree on one number.
 */

const BILL = '/bills/hr-5582-119';
const MCP_ENDPOINT_URL = 'https://oravan.org/api/mcp/mcp';

const LOCALES = [
  { locale: 'en', prefix: '', m: en, feed: '/feed' },
  { locale: 'es', prefix: '/es', m: es, feed: '/es/feed' },
] as const;

async function hrefs(links: Locator): Promise<string[]> {
  const count = await links.count();
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push((await links.nth(i).getAttribute('href'))!);
  return out;
}

async function expectTouchTargets(links: Locator) {
  const count = await links.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const box = await links.nth(i).boundingBox();
    expect(box, `link ${i} has no box`).not.toBeNull();
    expect(box!.height, `link ${i} is under the 44px touch target`).toBeGreaterThanOrEqual(44);
  }
}

function followColumn(page: Page, heading: string): Locator {
  return page
    .locator('footer nav')
    .locator('div')
    .filter({ has: page.getByRole('heading', { level: 2, name: heading, exact: true }) });
}

for (const { locale, prefix, m, feed } of LOCALES) {
  test(`${locale}: /follow renders every way to follow, and nothing that doesn't exist`, async ({
    page,
    request,
  }) => {
    await page.goto(`${prefix}/follow`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(m.follow.title);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    for (const key of ['feedsTitle', 'mcpTitle', 'embedsTitle', 'broadcastTitle'] as const) {
      await expect(page.getByRole('heading', { level: 2, name: m.follow[key] })).toBeVisible();
    }

    // The feeds are this locale's own, printed as full addresses.
    const main = page.locator('main article');
    await expect(main.locator(`a[href="${feed}/whats-moving.xml"]`)).toHaveText(
      `https://oravan.org${feed}/whats-moving.xml`,
    );
    await expect(main.locator(`a[href="${feed}/whats-moving.json"]`)).toHaveText(
      `https://oravan.org${feed}/whats-moving.json`,
    );

    // MCP: the exact connection URL, and the tool names/count the live
    // server actually registers.
    await expect(page.getByTestId('follow-mcp-url')).toHaveText(MCP_ENDPOINT_URL);
    const rpc = await mcpRpc(request, 'tools/list', {}, 7);
    const live = (rpc.result?.tools as Array<{ name: string }>).map((t) => t.name);
    await expect(page.getByTestId('follow-mcp-tools').locator('li')).toHaveText(live);
    const countLabel = locale === 'en' ? `${live.length} tools` : `${live.length} herramientas`;
    await expect(main.getByText(countLabel, { exact: false })).toBeVisible();

    // Broadcast channels are empty by design: the section says so, and it
    // links to no account, because none exists yet.
    const broadcast = page.getByTestId('follow-broadcast');
    await expect(broadcast).toContainText(m.follow.broadcastBody);
    await expect(broadcast.locator('a')).toHaveCount(0);
  });

  test(`${locale}: every link on /follow resolves, and each is a 44px target`, async ({ page, request }) => {
    await page.goto(`${prefix}/follow`);
    const links = page.locator('main article a');
    const targets = await hrefs(links);
    expect(targets.length).toBe(4); // RSS, JSON, the MCP docs, the embeds page
    for (const href of targets) {
      const res = await request.get(href);
      expect(res.status(), `${href} must resolve`).toBe(200);
    }
    await expectTouchTargets(links);
  });
}

for (const path of ['/', '/bills', BILL, '/es']) {
  test(`footer Follow column on ${path}: feeds, MCP and /follow, all resolving, all 44px`, async ({
    page,
    request,
  }) => {
    const isEs = path === '/es' || path.startsWith('/es/');
    const m = isEs ? es : en;
    const feed = isEs ? '/es/feed' : '/feed';
    const localePrefix = isEs ? '/es' : '';

    await page.goto(path);
    const column = followColumn(page, m.common.footer.colFollow);
    await expect(column).toHaveCount(1);
    const links = column.locator('a');
    await expect(links).toHaveText([
      m.common.footer.followRss,
      m.common.footer.followJson,
      m.common.footer.followMcp,
      m.common.footer.followAll,
    ]);
    expect(await hrefs(links)).toEqual([
      `${feed}/whats-moving.xml`,
      `${feed}/whats-moving.json`,
      `${localePrefix}/mcp`,
      `${localePrefix}/follow`,
    ]);
    for (const href of await hrefs(links)) {
      const res = await request.get(href);
      expect(res.status(), `${href} must resolve`).toBe(200);
    }
    await column.scrollIntoViewIfNeeded();
    await expectTouchTargets(links);
  });
}

/*
 * Every footer link — Site, Trust and Follow alike — is a 44px target in BOTH
 * dimensions on a phone. Height alone was pinned before; an accessibility
 * sweep (2026-09-24) measured "About" and "Terms" at 41-42px WIDE on
 * webkit-mobile. Checked on a bill page, where the sweep found it, and on the
 * Spanish homepage, whose labels differ.
 */
for (const path of [BILL, '/es']) {
  test(`every footer link on ${path} is at least 44×44 on mobile`, async ({ page, isMobile }, testInfo) => {
    test.skip(!isMobile, 'the 44px floor is measured at the phone viewport');
    await page.goto(path);
    const links = page.locator('footer a');
    const count = await links.count();
    expect(count).toBeGreaterThan(10);
    const sizes: string[] = [];
    for (let i = 0; i < count; i++) {
      const link = links.nth(i);
      await link.scrollIntoViewIfNeeded();
      const box = await link.boundingBox();
      const label = (await link.innerText()).trim();
      expect(box, `footer link "${label}" has no box`).not.toBeNull();
      sizes.push(`${label}: ${box!.width.toFixed(1)}×${box!.height.toFixed(1)}`);
      expect(box!.width, `footer link "${label}" is under 44px wide`).toBeGreaterThanOrEqual(44);
      expect(box!.height, `footer link "${label}" is under 44px tall`).toBeGreaterThanOrEqual(44);
    }
    await testInfo.attach('footer-link-sizes', { body: sizes.join('\n'), contentType: 'text/plain' });
    console.log(`footer link sizes on ${path}:\n${sizes.join('\n')}`);
  });
}

test('the feeds the Follow links point at are the real feeds, with feed content types', async ({ request }) => {
  for (const feed of ['/feed', '/es/feed']) {
    const rss = await request.get(`${feed}/whats-moving.xml`);
    expect(rss.status()).toBe(200);
    expect(rss.headers()['content-type']).toContain('application/rss+xml');
    const json = await request.get(`${feed}/whats-moving.json`);
    expect(json.status()).toBe(200);
    expect(json.headers()['content-type']).toContain('application/json');
  }
});
