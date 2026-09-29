import { expect, test, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { questionHasPanel } from '../lib/call-tab';
import { getBill } from '../lib/core/bills';
import { getMoments, type MomentWithState } from '../lib/moments';
import { questionVehicles } from '../lib/moments-ui';
import { statusWord } from '../lib/status-word';
import { mockScriptApi, seedZip } from './helpers';

/*
 * BIG QUESTION PAGES AS DECIDED (wireframes v2, 2026-09-29:
 * question-single.html, question-multi.html and the index's Decided list).
 *
 *   ONE OPEN BILL (Q6 b): the bill page's own call panel sits on the
 *   question page — the same component, with the same props, so its text is
 *   the bill page's panel word for word — right after the question's answer
 *   and its bill on a phone, and in the sticky rail on the desk. The card's
 *   "Read + call" lands on it, and a stance there is a completed script
 *   within funnel invariant I2's two interactions, without leaving the page.
 *
 *   SEVERAL OPEN: the open vehicles are cards under a "Still open" heading
 *   with a stable id, each landing on its own bill's panel; the desk adds a
 *   short list of the same in its rail. No panel on the page.
 *
 *   SETTLED VEHICLES (rule 6, Q9 a): record rows with one status word from
 *   the closed set, the record's outcome sentence and "Read the bill" —
 *   nothing that dials.
 *
 * Corpus-derived throughout (tests/corpus.ts discipline): which question is
 * which shape is read from data/moments.json through the helper the page
 * builds its lists from, and a shape the corpus lacks today skips honestly.
 */

const LOCALES = [
  { locale: 'en', prefix: '', messages: en },
  { locale: 'es', prefix: '/es', messages: es },
] as const;

const ZIP = '78501'; // TX-15: one House member and two senators, a single district

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const startsWith = (label: string) => new RegExp(`^${escapeRegex(label)}\\b`);

const RENDERED = getMoments().filter((m) => m.state !== 'retired');
const openOf = (m: MomentWithState) => questionVehicles(m).filter((v) => v.open);
const ONE_BILL = RENDERED.find((m) => questionHasPanel(openOf(m).map((v) => v.kind))) ?? null;
const SEVERAL = RENDERED.find((m) => openOf(m).length > 1) ?? null;
const WITH_SETTLED =
  RENDERED.find((m) => questionVehicles(m).some((v) => !v.open && v.kind === 'bill')) ?? null;

/** The page has hydrated: a page with a call panel claims the header's Call
 *  tab for it in an effect (components/CallTabTarget.tsx), so the tab's href
 *  turns from the server's "/call" to "#act" only once React is running. */
async function hydrated(page: Page) {
  await expect(page.locator('[data-call-tab][href="#act"]').first()).toBeAttached();
}

/** Click a stance until the (mocked) script request goes out — the funnel's
 *  guard against a click landing before React hydrates the panel. */
async function declareStance(page: Page, label: string) {
  const button = page.getByRole('radio', { name: label });
  await expect(async () => {
    const request = page.waitForRequest('**/api/script', { timeout: 3000 });
    await button.click();
    await request;
  }).toPass({ timeout: 30_000 });
}

for (const { locale, prefix, messages } of LOCALES) {
  test.describe(`${locale}: a Big Question with one open bill carries that bill's call panel`, () => {
    test('the panel is the bill page’s panel, word for word', async ({ page }) => {
      test.skip(!ONE_BILL, 'no Big Question with exactly one open bill in the corpus');
      const slug = openOf(ONE_BILL!)[0].vehicle.slug;

      await page.goto(`${prefix}/bills/${slug}`);
      await hydrated(page);
      const onBill = page.locator('[data-call-cta]');
      await expect(onBill).toHaveCount(1);
      const billText = await onBill.innerText();

      await page.goto(`${prefix}/questions/${ONE_BILL!.id}`);
      await hydrated(page);
      const onQuestion = page.locator('[data-call-cta]');
      await expect(onQuestion).toHaveCount(1);
      await expect(page.locator('#act')).toHaveText(messages.bill.actTitle);
      expect(await onQuestion.innerText()).toBe(billText);
    });

    test('with a saved ZIP and a stance, the members, their order and the routing line match the bill page too', async ({
      page,
    }) => {
      test.skip(!ONE_BILL, 'no Big Question with exactly one open bill in the corpus');
      // At rest the panel prints no member list, so the props that route it
      // (liveTarget) only show once a ZIP and a stance are in: compare there.
      const slug = openOf(ONE_BILL!)[0].vehicle.slug;
      await mockScriptApi(page);
      const panelAfterStance = async (path: string) => {
        await page.goto(path);
        await hydrated(page);
        await declareStance(page, messages.bill.stance.support);
        await expect(page.getByRole('textbox', { name: messages.bill.scriptTitle })).toBeVisible();
        await expect(page.locator('[data-call-cta] a[href^="tel:"]').first()).toBeVisible();
        return page.locator('[data-call-cta]').innerText();
      };
      await page.goto(`${prefix}/bills/${slug}`);
      await seedZip(page, ZIP);
      const billText = await panelAfterStance(`${prefix}/bills/${slug}`);
      const questionText = await panelAfterStance(`${prefix}/questions/${ONE_BILL!.id}`);
      expect(questionText).toBe(billText);
    });

    test('on a phone it follows the answer and the bill; on the desk it rides in the rail', async ({ page, isMobile }) => {
      test.skip(!ONE_BILL, 'no Big Question with exactly one open bill in the corpus');
      await page.goto(`${prefix}/questions/${ONE_BILL!.id}`);
      const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
      const deciding = await box('#deciding');
      const bills = await box('#vehicles-h');
      const panel = await box('#act');
      const moved = await box('#whats-moved');
      if (isMobile) {
        // Source order is reading order: answer → bill → panel → the record.
        expect(deciding.y).toBeLessThan(bills.y);
        expect(bills.y).toBeLessThan(panel.y);
        expect(panel.y).toBeLessThan(moved.y);
      } else {
        // The rail: to the right of the reading column, beside its top.
        expect(panel.x).toBeGreaterThan(deciding.x + deciding.width);
        expect(panel.y).toBeLessThan(moved.y);
      }
    });

    test('its card’s "Read + call" stays on the page, and a stance is a completed script within two interactions (I2)', async ({
      page,
    }) => {
      test.skip(!ONE_BILL, 'no Big Question with exactly one open bill in the corpus');
      await mockScriptApi(page);
      await page.goto(`${prefix}/questions/${ONE_BILL!.id}`);
      let used = 0;

      const cta = page.locator('[data-still-open]').getByRole('link', { name: startsWith(messages.moments.readCall) });
      await expect(cta).toHaveCount(1);
      await expect(cta).toHaveAttribute('href', '#act');
      used += 1;
      await cta.click();
      await expect(page).toHaveURL(new RegExp(`${prefix}/questions/${ONE_BILL!.id}#act$`));
      await expect(page.locator('#act')).toBeInViewport();

      used += 1;
      await declareStance(page, messages.bill.stance.support);
      await expect(page.getByRole('textbox', { name: messages.bill.scriptTitle })).toBeVisible();
      expect(used).toBeLessThanOrEqual(2);
      // Never left the question.
      expect(new URL(page.url()).pathname).toBe(`${prefix}/questions/${ONE_BILL!.id}`);
    });
  });

  test.describe(`${locale}: a Big Question with several open vehicles lists them under "Still open"`, () => {
    test('each open vehicle is a card whose "Read + call" lands on its own bill’s panel, in authoring order', async ({ page }) => {
      test.skip(!SEVERAL, 'no Big Question with several open vehicles in the corpus');
      const open = openOf(SEVERAL!);
      await page.goto(`${prefix}/questions/${SEVERAL!.id}`);

      const heading = page.locator('#still-open');
      await expect(heading).toHaveText(messages.moments.stillOpenHeading.replace('{count}', String(open.length)));

      const list = page.locator('[data-still-open]');
      const calls = list.getByRole('link', { name: startsWith(messages.moments.readCall) });
      const expected = open.map((v) =>
        v.kind === 'nomination' ? `${prefix}/nominations/${v.vehicle.slug}#act` : `${prefix}/bills/${v.vehicle.slug}#act`
      );
      expect(await calls.evaluateAll((els) => els.map((e) => e.getAttribute('href')))).toEqual(expected);
      // Each button names its bill for a screen reader.
      for (const [i, v] of open.entries()) {
        const b = getBill(v.vehicle.slug);
        if (!b) continue;
        await expect(calls.nth(i)).toHaveAccessibleName(new RegExp(`${escapeRegex(messages.moments.readCall)} .+`));
      }
      // The chamber each started in, where the list used to group by chamber.
      for (const group of new Set(open.map((v) => v.group))) {
        await expect(list).toContainText(messages.moments.status.group[group as 'house' | 'senate' | 'enacted']);
      }
      // No panel on this page: the call is on each bill's own page.
      await expect(page.locator('[data-call-cta]')).toHaveCount(0);
    });

    test('the desk repeats the list in its rail; a phone does not', async ({ page, isMobile }) => {
      test.skip(!SEVERAL, 'no Big Question with several open vehicles in the corpus');
      await page.goto(`${prefix}/questions/${SEVERAL!.id}`);
      const rail = page.locator('[data-still-open-rail]');
      if (isMobile) {
        await expect(rail).toBeHidden();
        return;
      }
      await expect(rail).toBeVisible();
      await expect(rail.getByRole('heading', { level: 2 })).toHaveText(messages.moments.stillOpenRailHeading);
      const railHrefs = await rail
        .getByRole('link', { name: startsWith(messages.moments.readCall) })
        .evaluateAll((els) => els.map((e) => e.getAttribute('href')));
      const listHrefs = await page
        .locator('[data-still-open]')
        .getByRole('link', { name: startsWith(messages.moments.readCall) })
        .evaluateAll((els) => els.map((e) => e.getAttribute('href')));
      expect(railHrefs).toEqual(listHrefs);
      const deciding = (await page.locator('#deciding').boundingBox())!;
      const railBox = (await rail.boundingBox())!;
      expect(railBox.x).toBeGreaterThan(deciding.x + deciding.width);
      for (const link of await rail.getByRole('link').all()) {
        expect((await link.boundingBox())!.height, 'rule 7: 44px').toBeGreaterThanOrEqual(44);
      }
    });
  });

  test.describe(`${locale}: settled vehicles are kept as the record`, () => {
    test('one status word, the record’s outcome, "Read the bill", and nothing that dials', async ({ page }) => {
      test.skip(!WITH_SETTLED, 'no Big Question holds a settled bill today');
      const settled = questionVehicles(WITH_SETTLED!).filter((v) => !v.open && v.kind === 'bill');
      await page.goto(`${prefix}/questions/${WITH_SETTLED!.id}`);

      const list = page.locator('[data-record-list]');
      await expect(list.getByRole('heading', { level: 3 })).toHaveText(
        messages.moments.settledGroupHeading.replace('{count}', String(questionVehicles(WITH_SETTLED!).filter((v) => !v.open).length))
      );
      await expect(list.locator('[data-record-row]')).toHaveCount(settled.length);
      for (const v of settled) {
        const b = getBill(v.vehicle.slug)!;
        const word = statusWord(b);
        const row = list.locator(`[data-record-row="${v.vehicle.slug}"]`);
        await expect(row).toBeVisible();
        await expect(row.locator(`[data-status-word="${word}"]`)).toHaveText(messages.bills.statusWord[word]);
        // A way to read it: the bill page's top, never its panel.
        const read = row.getByRole('link', { name: startsWith(messages.moments.readBill) });
        await expect(read).toHaveAttribute('href', `${prefix}/bills/${v.vehicle.slug}`);
        expect((await read.boundingBox())!.height, 'rule 7: 44px').toBeGreaterThanOrEqual(44);
        // Nothing that dials (rule 6).
        await expect(row.locator('a[href*="#act"], a[href^="tel:"], [data-call-cta]')).toHaveCount(0);
      }
    });
  });

  test(`${locale}: both shapes reflow at 320px with no sideways scroll @reflow`, async ({ page }) => {
    for (const m of [ONE_BILL, SEVERAL].filter((x): x is MomentWithState => x !== null)) {
      await page.goto(`${prefix}/questions/${m.id}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${m.id} scrolls sideways`).toBeLessThanOrEqual(0);
    }
  });
}
