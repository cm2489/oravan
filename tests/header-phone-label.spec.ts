import { expect, test, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { billSlug, getAllBills } from '../lib/core';
import { settledDecision } from '../lib/journey';

/*
 * THE ISLAND BAR ON A PHONE (owner, 2026-09-27: the floating island tab bar;
 * built 2026-11-22). components/Header.tsx draws it, `.island-bar` in
 * app/globals.css paints it, tests/island-bar.unit.spec.ts computes its
 * contrast. This file measures what only a browser can, in both languages:
 *
 *   - four tabs, Home · Bills · Big Questions · Reps (owner, 2026-11-24, his
 *     pick on the mock-up card: "Four tabs: Home · Bills · Big Questions ·
 *     Reps"), and the Big Questions tab reads the full `nav.moments` on one
 *     line ("Big Questions" / "Grandes preguntas") and reaches /questions;
 *   - on every page the bar lives on (so each tab takes its turn as the bold
 *     current tab), no label is clipped or wrapped and the bar adds no
 *     sideways scroll — at 320px in webkit-320, the tightest case;
 *   - the bar floats: inset from both sides and 4px off the bottom, 52px tall
 *     (56px of screen in all; tests/home-fold.spec.ts holds the hero to it);
 *   - every tab is at least 44px each way, and no label spills past its own
 *     cell or touches its neighbour;
 *   - the page never scrolls sideways;
 *   - at the very end of a page the footer's last line has scrolled clear of
 *     the bar, and there is no blank band above the footer;
 *   - on a bill page the floating call button parks above the bar, never on
 *     it.
 * The webkit-320 project runs the @reflow tests at 320px, webkit-mobile at
 * 390px.
 */

const decoded = getAllBills().find((b) => b.ai_sections && settledDecision(b) === null);
const SLUG = decoded ? billSlug(decoded) : null;

async function island(page: Page) {
  const bar = page.locator('nav[data-thumb-bar]');
  await expect(bar).toBeVisible();
  return bar;
}

for (const [prefix, messages] of [
  ['', en],
  ['/es', es],
] as const) {
  const where = prefix || '/en';

  test(`${where}: the island floats, its tabs clear 44px and its labels fit @reflow`, async ({ page, isMobile }) => {
    test.skip(!isMobile, 'the island bar is a phone surface');
    await page.goto(`${prefix}/`);
    const bar = await island(page);

    const link = bar.getByRole('link', { name: messages.common.nav.moments, exact: true });
    await expect(link).toHaveAttribute('href', `${prefix}/questions`);

    const m = await bar.evaluate((nav) => {
      const r = nav.getBoundingClientRect();
      const cells = [...nav.querySelectorAll('li')].map((li) => {
        const a = li.querySelector('a') as HTMLElement;
        const label = li.querySelector('[data-tab-label]') as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(label);
        const glyphs = range.getBoundingClientRect();
        const cell = li.getBoundingClientRect();
        const target = a.getBoundingClientRect();
        return {
          text: label.textContent,
          cellLeft: cell.left,
          cellRight: cell.right,
          targetW: target.width,
          targetH: target.height,
          glyphLeft: glyphs.left,
          glyphRight: glyphs.right,
          lines: range.getClientRects().length,
        };
      });
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        height: r.height,
        vw: document.documentElement.clientWidth,
        vh: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        cells,
      };
    });

    expect(m.cells.map((c) => c.text)).toEqual([
      messages.common.navShort.home,
      messages.common.navShort.bills,
      messages.common.nav.moments,
      messages.common.navShort.reps,
    ]);
    expect(m.left, 'inset from the left edge').toBeGreaterThanOrEqual(5.5);
    expect(m.vw - m.right, 'inset from the right edge').toBeGreaterThanOrEqual(5.5);
    expect(m.vh - m.bottom, 'lifted off the bottom edge').toBeGreaterThanOrEqual(3.5);
    expect(m.height, 'the island is 52px tall').toBeLessThanOrEqual(52.5);
    expect(m.vh - m.top, 'the island takes at most 56px of the screen').toBeLessThanOrEqual(56.5);
    expect(m.scrollWidth, 'no sideways scroll').toBeLessThanOrEqual(m.vw);
    for (const c of m.cells) {
      expect(c.targetW, `${c.text}: tap width`).toBeGreaterThanOrEqual(44);
      expect(c.targetH, `${c.text}: tap height`).toBeGreaterThanOrEqual(44);
      expect(c.lines, `${c.text}: one line`).toBe(1);
      expect(c.glyphLeft, `${c.text}: inside its cell`).toBeGreaterThanOrEqual(c.cellLeft - 0.5);
      expect(c.glyphRight, `${c.text}: inside its cell`).toBeLessThanOrEqual(c.cellRight + 0.5);
    }
    for (let i = 1; i < m.cells.length; i++) {
      expect(m.cells[i].glyphLeft - m.cells[i - 1].glyphRight, 'neighbouring labels keep a gap').toBeGreaterThan(0);
    }
  });

  for (const route of ['/', '/bills', '/questions', '/reps']) {
    test(`${where}${route}: no tab label is clipped or wrapped, and the bar adds no sideways scroll @reflow`, async ({
      page,
      isMobile,
    }) => {
      test.skip(!isMobile, 'the island bar is a phone surface');
      await page.goto(`${prefix}${route}`);
      const bar = await island(page);
      // The current tab is bold, the widest its label gets (Spanish "Grandes
      // preguntas" on /questions is the widest of all).
      await expect(bar.locator('a[aria-current="page"]')).toHaveCount(1);
      const m = await bar.evaluate((nav) => {
        const row = nav.querySelector('ul') as HTMLElement;
        const tabs = [...nav.querySelectorAll('a')].map((a) => {
          const label = a.querySelector('[data-tab-label]') as HTMLElement;
          const range = document.createRange();
          range.selectNodeContents(label);
          const glyphs = range.getBoundingClientRect();
          const box = a.getBoundingClientRect();
          return {
            text: label.textContent,
            labelScroll: label.scrollWidth,
            labelClient: label.clientWidth,
            tabScroll: a.scrollWidth,
            tabClient: a.clientWidth,
            lines: range.getClientRects().length,
            glyphLeft: glyphs.left,
            glyphRight: glyphs.right,
            tabLeft: box.left,
            tabRight: box.right,
          };
        });
        const r = nav.getBoundingClientRect();
        return {
          tabs,
          rowScroll: row.scrollWidth,
          rowClient: row.clientWidth,
          barLeft: r.left,
          barRight: r.right,
          vw: document.documentElement.clientWidth,
          pageScroll: document.documentElement.scrollWidth,
        };
      });
      expect(m.tabs).toHaveLength(4);
      for (const c of m.tabs) {
        expect(c.lines, `${c.text}: one line`).toBe(1);
        expect(c.labelScroll, `${c.text}: the label is not clipped`).toBeLessThanOrEqual(c.labelClient);
        expect(c.tabScroll, `${c.text}: nothing spills out of the tab`).toBeLessThanOrEqual(c.tabClient);
        expect(c.glyphLeft, `${c.text}: inside its tab`).toBeGreaterThanOrEqual(c.tabLeft - 0.5);
        expect(c.glyphRight, `${c.text}: inside its tab`).toBeLessThanOrEqual(c.tabRight + 0.5);
      }
      expect(m.rowScroll, 'the row of tabs fits inside the bar').toBeLessThanOrEqual(m.rowClient);
      expect(m.barLeft, 'the bar starts on screen').toBeGreaterThanOrEqual(0);
      expect(m.barRight, 'the bar ends on screen').toBeLessThanOrEqual(m.vw);
      expect(m.pageScroll, 'no sideways scroll').toBeLessThanOrEqual(m.vw);
    });
  }

  test(`${where}: at the end of the page the footer clears the island, with no blank band above it @reflow`, async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, 'the island bar is a phone surface');
    await page.goto(`${prefix}/`);
    const bar = await island(page);
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
    await expect
      .poll(() =>
        page.evaluate(
          () => Math.abs(window.scrollY - (document.documentElement.scrollHeight - window.innerHeight)) <= 1
        )
      )
      .toBe(true);
    const barTop = (await bar.boundingBox())!.y;
    const m = await page.evaluate(() => {
      const footer = document.querySelector('footer') as HTMLElement;
      // The footer's last line of content: the deepest bottom of any text
      // or control inside it.
      const bottoms = [...footer.querySelectorAll('a, p, li, button, span')]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => r.bottom);
      const main = document.getElementById('main') as HTMLElement;
      return {
        lastLine: Math.max(...bottoms),
        mainPadding: parseFloat(getComputedStyle(main).paddingBottom) || 0,
      };
    });
    expect(m.lastLine, "the footer's last line sits above the island").toBeLessThanOrEqual(barTop);
    expect(m.mainPadding, '<main> adds no blank band above the footer').toBe(0);
  });
}

test('a bill page: the floating call button parks above the island, never on it', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the island bar is a phone surface');
  test.skip(!SLUG, 'no decoded bill with an open decision in the corpus');
  await page.goto(`/bills/${SLUG}`);
  const bar = await island(page);
  const barTop = (await bar.boundingBox())!.y;
  // From layout, not the painted box: while hidden the button is translated
  // 12px down, so read the offset the way FloatingCallButton does.
  const fabBottom = await page.evaluate(() => {
    const fab = document.querySelector('[data-floating-call]') as HTMLElement;
    return window.innerHeight - (parseFloat(getComputedStyle(fab).bottom) || 0);
  });
  expect(barTop - fabBottom, 'gap between the button and the island').toBeGreaterThanOrEqual(8);
});
