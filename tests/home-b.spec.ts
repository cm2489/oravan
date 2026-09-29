import { expect, test, type Locator, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { districtsForZip, repsForDistrict } from '../lib/core';
import { homeQuestionRows } from '../lib/home';

/*
 * HOME OPTION B — the structure the owner picked (2026-09-29, typed: "Home
 * Page - Option B, This week first, then Big Questions."), as the v2
 * wireframe draws it. Read through hooks, hrefs and message keys only; the
 * pure halves (the order, the short status lines, the saved-ZIP shaping) are
 * tests/home.unit.spec.ts.
 *
 * Corpus-coupled like the rest of the homepage specs: a band that is absent
 * by design this run (no live Big Question, no news, no crown) is skipped
 * with the reason, never faked.
 */

const LOCALES = [
  { prefix: '', messages: en },
  { prefix: '/es', messages: es },
] as const;

/** Every band, by hook, in option B's order. */
const BANDS = [
  { name: 'hero', selector: '[data-hero]', always: true },
  { name: 'week', selector: 'section[aria-labelledby="top-actions"]', always: true },
  { name: 'questions', selector: 'section[aria-labelledby="moments-strip-title"]', always: false },
  { name: 'news', selector: '[data-news-band]', always: false },
  { name: 'specimen', selector: 'section[aria-labelledby="specimen-title"]', always: false },
  { name: 'how a call works', selector: 'section[aria-labelledby="act-zone"]', always: true },
  { name: 'why calling works', selector: 'section[aria-labelledby="why-title"]', always: true },
  { name: 'privacy', selector: 'section[aria-labelledby="privacy-title"]', always: true },
] as const;

/** A ZIP with one district, a seated House member and two senators. */
const ZIP = '78501';
const ZIP_REPS = districtsForZip(ZIP).flatMap(repsForDistrict);

async function seedZip(page: Page, zip: string) {
  await page.addInitScript((z) => {
    try {
      window.localStorage.setItem('oravan.prefs', JSON.stringify({ zip: z }));
    } catch {
      /* blocked storage: the test then fails on the missing block, loudly */
    }
  }, zip);
}

/** Click a row away from its link text, near its bottom-right corner. */
async function clickRowCorner(row: Locator) {
  const box = await row.boundingBox();
  expect(box, 'the row has a box').not.toBeNull();
  await row.click({ position: { x: box!.width - 6, y: box!.height - 6 } });
}

for (const { prefix, messages } of LOCALES) {
  test.describe(`${prefix || '/'}: option B`, () => {
    test('the bands run hero, this week, Big Questions, news, specimen, how a call works, why · privacy', async ({
      page,
    }) => {
      await page.goto(`${prefix}/`);
      const present: string[] = [];
      for (const band of BANDS) {
        const count = await page.locator(band.selector).count();
        if (band.always) expect(count, `${band.name} is always on the page`).toBe(1);
        if (count > 0) present.push(band.selector);
      }
      const order = await page.evaluate((selectors) => {
        const els = selectors.map((s) => document.querySelector(s)!);
        return els.every(
          (el, i) => i === 0 || Boolean(els[i - 1].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
        );
      }, present);
      expect(order, `bands out of order: ${present.join(' → ')}`).toBe(true);
    });

    test('this week leads with the floor item when the record has one', async ({ page }) => {
      await page.goto(`${prefix}/`);
      const week = page.locator('section[aria-labelledby="top-actions"]');
      const crown = week.locator('[data-crown]');
      test.skip((await crown.count()) === 0, 'no live floor fact in the committed record this run');
      // The crown's bill is the week's first bill link, so the floor item leads.
      const firstBill = await week.locator('a[href*="/bills/"]').first().getAttribute('href');
      const crownBill = await crown.locator('a[href*="/bills/"]').first().getAttribute('href');
      expect(firstBill).toBe(crownBill);
      // The week's one AI line points to how this is made.
      await expect(week.locator('a[href$="/citations#ai-policy"]')).toHaveCount(1);
    });

    test('every Big Question row is one whole-row link, newest record action first', async ({ page }) => {
      const rows = homeQuestionRows();
      test.skip(rows.length === 0, 'no live Big Question in the corpus - the band is absent by design');
      await page.goto(`${prefix}/`);
      const band = page.locator('[data-front-door="questions"]');
      const hrefs = await band
        .locator('li a[href*="/questions/"]')
        .evaluateAll((els) => els.map((e) => new URL((e as HTMLAnchorElement).href).pathname));
      expect(hrefs).toEqual(rows.map((r) => `${prefix}/questions/${r.moment.id}`));

      const items = band.locator('li');
      for (const box of await items.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) {
        expect(box, 'a row is a target far taller than 44px').toBeGreaterThanOrEqual(44);
      }
      await clickRowCorner(items.first());
      await expect(page).toHaveURL(new RegExp(`${prefix}/questions/${rows[0].moment.id}$`));
    });

    test('every row in the rest of the week is one whole-row link', async ({ page }) => {
      await page.goto(`${prefix}/`);
      const rows = page.locator('section[aria-labelledby="top-actions"] ul > li');
      test.skip((await rows.count()) === 0, 'no listed bills beside the floor item this run');
      const href = await rows.first().locator('a[href*="/bills/"]').getAttribute('href');
      await clickRowCorner(rows.first());
      await expect(page).toHaveURL(new RegExp(`${href!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    });

    test('each block below the hero carries one quiet AI line to how this is made', async ({ page }) => {
      await page.goto(`${prefix}/`);
      for (const selector of [
        'section[aria-labelledby="top-actions"]',
        'section[aria-labelledby="moments-strip-title"]',
        '[data-news-band]',
        'section[aria-labelledby="specimen-title"]',
      ]) {
        const block = page.locator(selector);
        if ((await block.count()) === 0) continue;
        await expect(block.locator('a[href$="/citations#ai-policy"]'), selector).toHaveCount(1);
        await expect(block.getByText(messages.home.aiHowMade, { exact: true }), selector).toBeVisible();
      }
      // Not in the hero: there, a link would be the first action (rule 8).
      await expect(page.locator('[data-hero] a[href$="/citations#ai-policy"]')).toHaveCount(0);
      await expect(page.locator('[data-hero]').getByText(messages.home.aiHero)).toBeVisible();
    });

    test('the week closes with every active bill and today\'s brief', async ({ page }) => {
      await page.goto(`${prefix}/`);
      const week = page.locator('section[aria-labelledby="top-actions"]');
      await expect(week.getByRole('link', { name: messages.home.todayBrief })).toHaveAttribute(
        'href',
        `${prefix}/today`
      );
      await expect(week.locator(`a[href="${prefix}/bills"]`)).toHaveCount(1);
    });

    test('with a saved ZIP, the hero names your members and nothing else changes', async ({ page }) => {
      expect(ZIP_REPS.length, `the fixture ZIP ${ZIP} must resolve to members in data/`).toBeGreaterThan(0);
      await page.goto(`${prefix}/`);
      const weekHeading = await page.locator('#top-actions').textContent();

      await seedZip(page, ZIP);
      await page.goto(`${prefix}/`);
      const block = page.locator('[data-hero] [data-saved-zip]');
      await expect(block).toHaveAttribute('data-saved-zip', ZIP);
      await expect(block).toContainText(messages.homeZip.members);
      for (const rep of ZIP_REPS) {
        const link = block.locator(`a[href="${prefix}/reps/${rep.bioguide}"]`);
        await expect(link, rep.name).toContainText(rep.name);
      }
      // The ZIP field gives way; Change ZIP code is the way back to it.
      await expect(page.locator('[data-hero] [data-zip-field]')).toHaveCount(0);
      await expect(block.getByRole('link', { name: messages.reps.changeZip })).toHaveAttribute(
        'href',
        `${prefix}/reps?change=1`
      );
      // Everything below the hero is the same page.
      await expect(page.locator('#top-actions')).toHaveText(weekHeading ?? '');
      await expect(page.locator('[data-hero] a[href="#top-actions"]')).toBeVisible();
    });
  });
}
