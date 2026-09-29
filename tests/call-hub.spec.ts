import { expect, test, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { getBill } from '../lib/core/bills';
import { getNomination } from '../lib/core/nominations';
import { settledDecision } from '../lib/journey';
import { getMoments, vehicleKind } from '../lib/moments';
import { billCtaKey, nominationCtaKey, vehicleCtaHref, vehicleStatuses } from '../lib/moments-ui';
import { anyTopAt, stableAcross, topActionSlugsAt } from './corpus';
import { settledBill } from './corpus-fixtures';
import { callableBillSlug, memberBioguide } from './corpus-samples';
import { mockScriptApi, seedZip } from './helpers';

/*
 * NAV 1 AND THE CALL HUB, IN A BROWSER (owner, 2026-09-29: "nav 1";
 * wireframes v2, index.html "Where the Call tab goes" and call-hub.html).
 *
 * What is pinned here, in the order a reader meets it:
 *   - the bar: five tabs on a phone, four links and the switch on a desktop,
 *     in the ruled order, with Today and the record off both;
 *   - where the Call tab goes: the hub from general, settled-bill and member
 *     pages; the page's own panel on an open bill; a Big Question's one open
 *     bill, or its list when it has several;
 *   - the hub: this week's callable bills in the act-now pool's own order,
 *     each with "Read + call" onto its panel; the quiet-week words when the
 *     pool is empty; and who you'll reach only once a ZIP is saved;
 *   - the path: Call tab → Read + call → a stance is a completed script, three
 *     interactions, the ZIP-first budget of tests/funnel.spec.ts.
 * The source-level half (the declared conditions, the one call style) is in
 * tests/call-tab.unit.spec.ts.
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

const callTab = (page: Page, messages: typeof en | typeof es) =>
  primaryNav(page, messages).locator('[data-call-tab]');

/** A Big Question's callable vehicles, read with the cards' own keys — the
 *  same derivation app/[locale]/questions/[id]/page.tsx runs. */
function callableHrefs(momentId: string): string[] {
  const m = getMoments().find((x) => x.id === momentId)!;
  const isSettled = m.state === 'settled';
  return vehicleStatuses(m.vehicles).flatMap(({ vehicle: v, line }) => {
    if (vehicleKind(v) === 'nomination') {
      const n = getNomination(v.slug);
      if (!n) return [];
      const key = nominationCtaKey(n, isSettled || line.terminal);
      return key === 'moments.readCall' ? [vehicleCtaHref(`/nominations/${v.slug}`, key)] : [];
    }
    const raw = getBill(v.slug);
    if (!raw) return [];
    const key = billCtaKey(isSettled || line.terminal || settledDecision(raw) !== null);
    return key === 'moments.readCall' ? [vehicleCtaHref(`/bills/${v.slug}`, key)] : [];
  });
}

const RENDERED_QUESTIONS = getMoments().filter((m) => m.state !== 'retired');
const ONE_OPEN = RENDERED_QUESTIONS.find((m) => callableHrefs(m.id).length === 1) ?? null;
const SEVERAL_OPEN = RENDERED_QUESTIONS.find((m) => callableHrefs(m.id).length > 1) ?? null;
const NONE_OPEN = RENDERED_QUESTIONS.find((m) => callableHrefs(m.id).length === 0) ?? null;
const SETTLED = settledBill('law') ?? settledBill('rejected');

for (const { locale, prefix, messages } of LOCALES) {
  test.describe(`${locale}: the bar`, () => {
    test('phone: Home · Bills · Call · Questions · Reps; desktop: Bills · Call · Big Questions · My reps', async ({
      page,
      isMobile,
    }) => {
      await page.goto(`${prefix}/`);
      const nav = primaryNav(page, messages);
      const texts = (await nav.getByRole('link').allInnerTexts()).map((s) => s.trim());
      const expected = isMobile
        ? [
            messages.common.navShort.home,
            messages.common.navShort.bills,
            messages.common.navShort.call,
            messages.common.navShort.moments,
            messages.common.navShort.reps,
          ]
        : [messages.common.nav.bills, messages.common.nav.call, messages.common.nav.moments, messages.common.nav.reps];
      expect(texts).toEqual(expected);
      // Today and the record are off the bar (owner, "nav 1").
      await expect(nav.locator('a[href$="/today"], a[href$="/record"], a[href$="/why-call"]')).toHaveCount(0);
    });

    test('the Call tab clears the 44px floor @reflow', async ({ page }) => {
      await page.goto(`${prefix}/`);
      const box = await callTab(page, messages).boundingBox();
      expect(box, 'the Call tab must render').not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    });
  });

  test.describe(`${locale}: where the Call tab goes`, () => {
    test('from Home to the hub, where it is the current page', async ({ page }) => {
      await page.goto(`${prefix}/`);
      const tab = callTab(page, messages);
      await expect(tab).toHaveAttribute('href', `${prefix}/call`);
      await tab.click();
      await expect(page).toHaveURL(new RegExp(`${prefix}/call$`));
      await expect(page.getByRole('heading', { level: 1, name: messages.call.title })).toBeVisible();
      await expect(callTab(page, messages)).toHaveAttribute('aria-current', 'page');
    });

    test('on an open bill page, to its own call panel', async ({ page }) => {
      await page.goto(`${prefix}/bills/${callableBillSlug()}`);
      const tab = callTab(page, messages);
      // The page declares it after hydration; the server render says /call.
      await expect(tab).toHaveAttribute('href', '#act');
      await tab.click();
      await expect(page.locator('#act')).toBeInViewport();
    });

    test('on a settled bill page and on a member page, to the hub', async ({ page }) => {
      test.skip(!SETTLED, 'no settled bill in the corpus');
      await page.goto(`${prefix}/bills/${SETTLED!.slug}`);
      await expect(page.locator('[data-settled-panel]')).toBeVisible();
      await callTab(page, messages).click();
      await expect(page).toHaveURL(new RegExp(`${prefix}/call$`));

      await page.goto(`${prefix}/reps/${memberBioguide()}`);
      await callTab(page, messages).click();
      await expect(page).toHaveURL(new RegExp(`${prefix}/call$`));
    });

    test('on a Big Question with one open bill, to that bill’s panel', async ({ page }) => {
      test.skip(!ONE_OPEN, 'no Big Question with exactly one open vehicle in the corpus');
      await page.goto(`${prefix}/questions/${ONE_OPEN!.id}`);
      await expect(callTab(page, messages)).toHaveAttribute('href', `${prefix}${callableHrefs(ONE_OPEN!.id)[0]}`);
    });

    test('on a Big Question with several open bills, to its list', async ({ page }) => {
      test.skip(!SEVERAL_OPEN, 'no Big Question with several open vehicles in the corpus');
      await page.goto(`${prefix}/questions/${SEVERAL_OPEN!.id}`);
      const tab = callTab(page, messages);
      await expect(tab).toHaveAttribute('href', '#vehicles-h');
      await tab.click();
      await expect(page.locator('#vehicles-h')).toBeInViewport();
    });

    test('on a Big Question with nothing open, to the hub', async ({ page }) => {
      test.skip(!NONE_OPEN, 'every Big Question in the corpus has an open vehicle');
      await page.goto(`${prefix}/questions/${NONE_OPEN!.id}`);
      await callTab(page, messages).click();
      await expect(page).toHaveURL(new RegExp(`${prefix}/call$`));
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

    test('Call tab → Read + call → a stance is a completed script: three interactions', async ({ page }) => {
      test.skip(!anyTop, 'quiet week: no bill on the hub to call about');
      test.skip(!CORPUS_STABLE, 'corpus sits at a scoring boundary');
      await mockScriptApi(page);
      await page.goto(`${prefix}/`);
      let used = 0;
      used += 1;
      await callTab(page, messages).click();
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
