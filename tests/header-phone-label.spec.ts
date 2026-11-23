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
 *   - the Questions cell reads `nav.tabQuestions` on one line ("Questions" /
 *     "Preguntas"; owner, 2026-11-22) and reaches /questions;
 *   - the bar floats: inset from both sides and from the bottom, 56px tall;
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

    const link = bar.getByRole('link', { name: messages.common.nav.tabQuestions, exact: true });
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
        bottom: r.bottom,
        height: r.height,
        vw: document.documentElement.clientWidth,
        vh: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        cells,
      };
    });

    expect(m.cells).toHaveLength(5);
    expect(m.left, 'inset from the left edge').toBeGreaterThanOrEqual(5.5);
    expect(m.vw - m.right, 'inset from the right edge').toBeGreaterThanOrEqual(5.5);
    expect(m.vh - m.bottom, 'lifted off the bottom edge').toBeGreaterThanOrEqual(7.5);
    expect(m.height, 'the island is 56px tall').toBeLessThanOrEqual(56.5);
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
