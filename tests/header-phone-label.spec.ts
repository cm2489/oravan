import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * THE THUMB BAR'S BIG QUESTIONS CELL. It read "Big Questions" (owner,
 * 2026-09-29, typed: "I'd like the phone to say Big Questions instead of just
 * questions if possible"), which wrapped onto two lines; since 2026-11-22 it
 * reads `common.nav.tabQuestions` ("Questions" / "Preguntas",
 * components/Header.tsx `tabLabel`), on ONE line. What is pinned:
 *   - the label is one line, in either language;
 *   - the label never spills past its own cell, in either language;
 *   - the bar stays 48px tall plus the safe area, so the floating call button
 *     parked above it (components/FloatingCallButton.tsx) and the layout's
 *     bottom padding still clear it;
 *   - neighbouring labels never touch;
 *   - the label is read out as the words, whatever the line break.
 * The webkit-320 project runs it at 320px (@reflow), webkit-mobile at 390px.
 */

for (const [prefix, messages] of [
  ['', en],
  ['/es', es],
] as const) {
  test(`${prefix || '/en'}: the Big Questions cell reads on one line, fits, and the bar stays 48px @reflow`, async ({ page, isMobile }) => {
    test.skip(!isMobile, 'the thumb bar is a phone surface');
    await page.goto(`${prefix}/`);
    const bar = page.locator('nav[data-thumb-bar]');
    await expect(bar).toBeVisible();

    const link = bar.getByRole('link', { name: messages.common.nav.tabQuestions, exact: true });
    await expect(link).toHaveAttribute('href', `${prefix}/questions`);

    const m = await bar.evaluate((nav) => {
      const cells = [...nav.querySelectorAll('li')];
      // The bar's own 48px row: its box less the safe-area padding and its
      // 1px top rule.
      const style = getComputedStyle(nav);
      const safe = (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.borderTopWidth) || 0);
      const labels = cells.map((li) => {
        const label = li.querySelector('[data-tab-label]') as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(label);
        const glyphs = range.getBoundingClientRect();
        // Distinct line boxes the label's glyphs sit on.
        const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
        return {
          text: label.textContent,
          lines,
          cellLeft: li.getBoundingClientRect().left,
          cellRight: li.getBoundingClientRect().right,
          cellWidth: li.getBoundingClientRect().width,
          scrollWidth: label.scrollWidth,
          clientWidth: label.clientWidth,
          glyphLeft: glyphs.left,
          glyphRight: glyphs.right,
        };
      });
      return { height: nav.getBoundingClientRect().height - safe, labels };
    });

    const questions = m.labels.find((l) => l.text === messages.common.nav.tabQuestions);
    expect(questions, 'the Big Questions cell carries its one-word label').toBeTruthy();
    expect(questions!.lines, `${questions!.text}: one line`).toBe(1);
    expect(m.height, 'bar row height without the safe area and the top rule').toBeLessThanOrEqual(48.5);
    for (const l of m.labels) {
      expect(l.scrollWidth, `${l.text}: scrollWidth vs its box`).toBeLessThanOrEqual(l.clientWidth);
      expect(l.glyphLeft, `${l.text}: inside its cell`).toBeGreaterThanOrEqual(l.cellLeft - 0.5);
      expect(l.glyphRight, `${l.text}: inside its cell`).toBeLessThanOrEqual(l.cellRight + 0.5);
    }
    for (let i = 1; i < m.labels.length; i++) {
      expect(m.labels[i].glyphLeft - m.labels[i - 1].glyphRight, 'neighbouring labels keep a gap').toBeGreaterThan(0);
    }
  });
}
