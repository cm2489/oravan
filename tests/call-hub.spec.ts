import { expect, test, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { anyTopAt, stableAcross, topActionSlugsAt } from './corpus';
import { mockScriptApi, seedZip } from './helpers';

/*
 * THE BARS AND THE CALL HUB, IN A BROWSER (owner, 2026-09-29: "nav 1";
 * wireframes v2, call-hub.html).
 *
 * What is pinned here, in the order a reader meets it:
 *   - the bar: four tabs on a phone, four links and the switch on a desktop,
 *     in the ruled order. The desktop row is Today in Congress · Bills · Big
 *     Questions · My reps with no Call item (owner, 2026-09-29, typed: "The
 *     'Call' button in the header needs to be removed and 'Today in Congress'
 *     needs to come first on the header"; scope "Desktop only"). The phone
 *     bar is Home · Bills · Big Questions · Reps with no Call tab (owner,
 *     2026-11-24, his pick on the mock-up card: "Four tabs: Home · Bills · Big
 *     Questions · Reps"; 2026-11-23: "every page has a "call" button close
 *     by"). So neither bar links the hub, and every screen reaches it from the
 *     footer's "Make a call";
 *   - the hub: this week's callable bills in the act-now pool's own order,
 *     each with "Read + call" onto its panel; the quiet-week words when the
 *     pool is empty; and who you'll reach only once a ZIP is saved;
 *   - the path: footer "Make a call" → Read + call → a stance is a completed
 *     script, three interactions, the ZIP-first budget of tests/funnel.spec.ts.
 * The bar's phone measurements (44px tabs, one-line labels, no overflow at
 * 320px) are in tests/header-phone-label.spec.ts.
 */

const LOCALES = [
  { locale: 'en', prefix: '', messages: en },
  { locale: 'es', prefix: '/es', messages: es },
] as const;

const anyTop = anyTopAt(Date.now());
const CORPUS_STABLE = stableAcross((at) => anyTopAt(at));
const TOP_STABLE = stableAcross((at) => topActionSlugsAt(at).slice(0, 5));
const ZIP = '78501'; // TX-15: one House member and two senators, a single district

/** The visible "Primary" navigation — both navs are in the DOM and exactly
 *  one is displayed (components/Header.tsx), so a role query finds it. */
const primaryNav = (page: Page, messages: typeof en | typeof es) =>
  page.getByRole('navigation', { name: messages.common.nav.primaryLabel });

/** The footer's standing door to the Call hub, on every screen. */
const footerCallHub = (page: Page, messages: typeof en | typeof es) =>
  page.locator('footer').getByRole('link', { name: messages.common.footer.callHub, exact: true });

for (const { locale, prefix, messages } of LOCALES) {
  test.describe(`${locale}: the bar`, () => {
    test('phone: Home · Bills · Big Questions · Reps; desktop: Today in Congress · Bills · Big Questions · My reps', async ({
      page,
      isMobile,
    }) => {
      await page.goto(`${prefix}/`);
      const nav = primaryNav(page, messages);
      const texts = (await nav.getByRole('link').allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim());
      const expected = isMobile
        ? [
            messages.common.navShort.home,
            messages.common.navShort.bills,
            messages.common.nav.moments,
            messages.common.navShort.reps,
          ]
        : [messages.common.nav.today, messages.common.nav.bills, messages.common.nav.moments, messages.common.nav.reps];
      expect(texts).toEqual(expected);
      // The record and "Why call?" are off both bars (owner, "nav 1"); Today
      // is on the desktop row only (owner, 2026-09-29, "Desktop only"); the
      // Call hub is on neither (2026-09-29 desktop, 2026-11-24 phone).
      await expect(nav.locator('a[href$="/record"], a[href$="/why-call"]')).toHaveCount(0);
      await expect(nav.locator('a[href$="/today"]')).toHaveCount(isMobile ? 0 : 1);
      await expect(nav.locator(`a[href="${prefix}/call"]`)).toHaveCount(0);
      await expect(page.locator('[data-call-tab]')).toHaveCount(0);
    });

    test('the footer\'s "Make a call" reaches the hub on every screen', async ({ page }) => {
      await page.goto(`${prefix}/`);
      const link = footerCallHub(page, messages);
      await expect(link).toHaveAttribute('href', `${prefix}/call`);
      await link.click();
      await expect(page).toHaveURL(new RegExp(`${prefix}/call$`));
      await expect(page.getByRole('heading', { level: 1, name: messages.call.title })).toBeVisible();
    });
  });

  test.describe(`${locale}: the Call hub`, () => {
    test("this week's callable bills, in the pool's own order, each with Read + call onto its panel", async ({
      page,
    }) => {
      test.skip(!anyTop, 'quiet week: the pool is empty (the quiet case below runs instead)');
      test.skip(!TOP_STABLE, 'the pool sits at a scoring boundary - the baked page could flip before the assert');
      await page.goto(`${prefix}/call`);
      const expected = topActionSlugsAt(Date.now()).slice(0, 5);
      const rows = page.locator('[data-call-hub-row]');
      await expect(rows).toHaveCount(expected.length);
      expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-call-hub-row')))).toEqual(expected);
      for (const [i, slug] of expected.entries()) {
        const row = rows.nth(i);
        await expect(row.getByRole('link', { name: messages.moments.readCall })).toHaveAttribute(
          'href',
          `${prefix}/bills/${slug}#act`
        );
        // The headline opens the decoded answer at the top (truth first).
        const headline = row.getByRole('heading', { level: 3 }).getByRole('link');
        await expect(headline).toHaveAttribute('href', `${prefix}/bills/${slug}`);
        // Rule 7's 44px floor holds on a headline that fits on one line too.
        expect((await headline.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        // A floor claim's source opens the official record in a new tab.
        const source = row.getByRole('link', { name: messages.home.evidenceLink });
        if (await source.count()) {
          await expect(source).toHaveAttribute('target', '_blank');
          await expect(source).toHaveAttribute('rel', /noopener/);
        }
      }
      // One AI label for the list, in the wireframe's words, linking to how it is made.
      await expect(page.getByText(messages.call.aiNote, { exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: messages.call.aiHowMade })).toHaveAttribute(
        'href',
        `${prefix}/citations#ai-policy`
      );
      await expect(page.locator(`main a[href="${prefix}/bills"]`).first()).toBeVisible();
    });

    test('a quiet week says so and still offers every bill', async ({ page }) => {
      test.skip(anyTop, 'the pool has bills this run - covered by the case above');
      await page.goto(`${prefix}/call`);
      await expect(page.locator('main [role="status"]').first()).toBeVisible();
      await expect(page.locator('[data-call-hub-row]')).toHaveCount(0);
      await expect(page.locator(`main a[href="${prefix}/bills"]`).first()).toBeVisible();
    });

    test("who you'll reach: nothing without a ZIP, the members once one is saved", async ({ page }) => {
      await page.goto(`${prefix}/call`);
      await expect(page.getByRole('heading', { level: 1, name: messages.call.title })).toBeVisible();
      await expect(page.locator('[data-call-reach]')).toHaveCount(0);

      await seedZip(page, ZIP);
      await page.reload();
      const reach = page.locator('[data-call-reach="ready"]');
      await expect(reach.getByRole('heading', { level: 2, name: messages.call.reachTitle })).toBeVisible();
      await expect(reach.locator('a[href*="/reps/"]')).toHaveCount(3);
      await expect(reach.locator('[data-zip-line]')).toContainText(ZIP);
      // A one-district ZIP names its district (wireframe: "ZIP 78501 · Texas, district 15").
      await expect(reach.locator('[data-zip-line]')).toContainText(
        messages.reps.districtHeading.replace('{state}', 'TX').replace('{district}', '15')
      );
      await expect(reach.getByRole('link', { name: messages.reps.changeZip })).toHaveAttribute(
        'href',
        `${prefix}/reps?change=1`
      );
      // No numbers on the hub: a number list with no script is what it avoids.
      await expect(page.locator('main a[href^="tel:"]')).toHaveCount(0);
      // Any routing line names members the section itself lists.
      const listed = await reach.locator('a[href*="/reps/"]').allInnerTexts();
      for (const line of await page.locator('[data-call-routing]').allInnerTexts()) {
        expect(listed.some((name) => line.includes(name.trim())), line).toBe(true);
      }
    });

    test('no sideways scroll (the webkit-320 project runs it at 320px) @reflow', async ({ page }) => {
      await page.goto(`${prefix}/call`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });

    test('footer "Make a call" → Read + call → a stance is a completed script: three interactions', async ({
      page,
    }) => {
      test.skip(!anyTop, 'quiet week: no bill on the hub to call about');
      test.skip(!CORPUS_STABLE, 'corpus sits at a scoring boundary');
      await mockScriptApi(page);
      await page.goto(`${prefix}/`);
      let used = 0;
      used += 1;
      // Neither bar links the hub (the desktop row since 2026-09-29, the
      // phone bar since 2026-11-24); the footer's first Site link is its
      // standing door on every screen.
      await footerCallHub(page, messages).click();
      await expect(page).toHaveURL(new RegExp(`${prefix}/call$`));
      used += 1;
      await page.locator('[data-call-hub-cta]').first().click();
      await expect(page).toHaveURL(/\/bills\/[^#]+#act$/);
      used += 1;
      // The stance can land before hydration; retry until the script request
      // goes out (tests/funnel.spec.ts declareStance) — a lost click is not an
      // interaction the reader spent.
      const stance = page.getByRole('radio', { name: messages.bill.stance.support });
      await expect(async () => {
        const request = page.waitForRequest('**/api/script', { timeout: 3000 });
        await stance.click();
        await request;
      }).toPass({ timeout: 30_000 });
      await expect(page.getByRole('textbox', { name: messages.bill.scriptTitle })).toBeVisible();
      expect(used).toBeLessThanOrEqual(3);
    });
  });
}

test('es: the row nav fits at 768px with the switch, no wrap and no overflow', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the row nav is a desktop surface');
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto('/es/');
  const nav = primaryNav(page, es);
  await expect(nav).toBeVisible();
  const links = nav.getByRole('link');
  await expect(links).toHaveCount(4);
  // One row: every link shares the first link's top edge.
  const tops = await links.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // The language switch keeps its own width: flex used to squeeze it until
  // "English" and "Español" printed over each other (measured 2026-09-29).
  const squeezed = await page
    .locator('header a[hreflang]')
    .evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
  expect(squeezed).toEqual([]);
});

/*
 * THE ROW AT 1024px (owner, 2026-09-29: "'Today in Congress' needs to come
 * first on the header"). 64rem is where the full labels start, and the
 * English bar also carries the trust line there, so it is the tightest the
 * row gets. Both languages: one row, no page overflow, no link squeezed.
 */
for (const { locale, prefix, messages } of LOCALES) {
  test(`${locale}: the row nav fits at 1024px in one row, Today first`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'the row nav is a desktop surface');
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(`${prefix}/`);
    const nav = primaryNav(page, messages);
    await expect(nav).toBeVisible();
    const links = nav.getByRole('link');
    await expect(links).toHaveCount(4);
    await expect(links.first()).toHaveAttribute('href', `${prefix}/today`);
    const tops = await links.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const squeezed = await page
      .locator('header a')
      .evaluateAll((els) =>
        els.filter((e) => e.getClientRects().length > 0 && e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent)
      );
    expect(squeezed).toEqual([]);
  });
}
