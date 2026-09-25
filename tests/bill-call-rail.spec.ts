import { expect, test, type Page } from '@playwright/test';
import { billSlug, getAllBills } from '../lib/core';

/*
 * B2 — THE MOBILE CALL RAIL (2026-09-24).
 *
 * On a phone the bill page is one column, so the floating "Make the call"
 * button is the rail. It used to stand down the instant the call panel's top
 * edge slid in UNDER the fixed bottom nav and under the button itself — so
 * for a stretch of scroll, while the reader was still in the decode, no call
 * surface was visible at all. FloatingCallButton now yields only once a call
 * surface has risen above the button's own top edge.
 *
 * Two properties, measured on webkit-mobile at the iPhone 13 viewport:
 *
 *   1. At 11 evenly spaced scroll positions, top to foot, the reader can see
 *      a way to call: EITHER the button is showing, OR a call surface is on
 *      screen above it and the button has yielded to it — never neither, and
 *      never both (the one-surface contract tests/call-action.spec.ts pins).
 *      Across the decoded read itself the button must be the one showing.
 *   2. While the button shows, it never sits over a control inside the call
 *      panel — swept every 24px through the panel's whole approach.
 *
 * Any decoded bill works; the first one in the corpus is used so the test
 * never pins a slug the nightly sync can drop.
 */
const decoded = getAllBills().find((b) => b.ai_sections);
const SLUG = decoded ? billSlug(decoded) : null;

type Sample = {
  scrollY: number;
  fabShown: boolean;
  ctaAbove: boolean;
  inRead: boolean;
  overlap: boolean;
};

/*
 * globals.css sets `scroll-behavior: smooth`, so a bare scrollTo ANIMATES and
 * a sample taken straight after it reads a page still at the old depth —
 * which lets every assertion here pass vacuously at y=0. Jump instantly, then
 * wait for the page to actually be there.
 */
async function scrollToY(page: Page, y: number) {
  await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), y);
  const target = await page.evaluate(
    (y) => Math.min(y, document.documentElement.scrollHeight - window.innerHeight),
    y
  );
  await expect
    .poll(() => page.evaluate((t) => Math.abs(window.scrollY - t) <= 1, target))
    .toBe(true);
}

async function sample(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const fab = document.querySelector('[data-floating-call]') as HTMLElement;
    const fr = fab.getBoundingClientRect();
    const fabShown = fab.getAttribute('aria-hidden') !== 'true';
    // The top of the strip the button stands in. `fr` moves 12px while the
    // button is hidden (translate-y-3), so derive the strip from layout,
    // exactly the way the component does.
    const stripTop =
      window.innerHeight - (parseFloat(getComputedStyle(fab).bottom) || 0) - fab.offsetHeight - 8;
    const ctaAbove = [...document.querySelectorAll('[data-call-cta]')].some((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.top < stripTop && r.bottom > 0;
    });
    const read = document.querySelector('section[aria-labelledby="decoded"]')!.getBoundingClientRect();
    const inRead = read.top < stripTop && read.bottom > stripTop;
    const controls = document.querySelectorAll(
      '[data-call-cta] button, [data-call-cta] a[href], [data-call-cta] input, [data-call-cta] textarea, [data-call-cta] summary'
    );
    const overlap =
      fabShown &&
      [...controls].some((c) => {
        const r = c.getBoundingClientRect();
        return r.width > 0 && r.left < fr.right && r.right > fr.left && r.top < fr.bottom && r.bottom > fr.top;
      });
    return { scrollY: Math.round(window.scrollY), fabShown, ctaAbove, inRead, overlap };
  });
}

test.describe('bill page mobile call rail', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'webkit-mobile', 'the floating rail is the phone layout');
    test.skip(!SLUG, 'no decoded bill in the corpus');
  });

  test('a way to call is visible at 11 evenly spaced scroll positions, and the button carries the read', async ({
    page,
  }) => {
    await page.goto(`/bills/${SLUG}`);
    await expect(page.locator('[data-floating-call]')).toHaveAttribute('aria-hidden', 'false');
    await page.waitForLoadState('networkidle');
    const max = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight
    );
    const rows: Sample[] = [];
    for (let i = 0; i <= 10; i++) {
      await scrollToY(page, Math.round((max * i) / 10));
      // Polled: the observer answers a frame after the scroll lands. The
      // settled state is what is asserted — exactly one surface.
      await expect
        .poll(async () => {
          const s = await sample(page);
          return s.fabShown !== s.ctaAbove;
        }, { message: `one call surface at position ${i}` })
        .toBe(true);
      rows.push(await sample(page));
    }
    // Guard against a vacuous pass: the walk really reached the page foot.
    expect(rows.at(-1)!.scrollY).toBeGreaterThanOrEqual(max - 2);
    for (const r of rows) {
      if (r.inRead && !r.ctaAbove) expect(r.fabShown, `button hidden mid-read at y=${r.scrollY}`).toBe(true);
    }
    // The read was actually sampled, and the button carried it — the B2
    // regression was precisely a read with no call surface beside it.
    expect(rows.some((r) => r.inRead && r.fabShown), JSON.stringify(rows)).toBe(true);
    test.info().annotations.push({ type: 'positions', description: JSON.stringify(rows) });
  });

  test('the button never covers a control in the call panel', async ({ page }) => {
    await page.goto(`/bills/${SLUG}`);
    const { from, to } = await page.evaluate(() => {
      const p = document.querySelector('[data-call-cta]')!.getBoundingClientRect();
      const top = p.top + window.scrollY;
      return {
        from: Math.max(0, Math.round(top - window.innerHeight)),
        to: Math.round(p.bottom + window.scrollY),
      };
    });
    for (let y = from; y <= to; y += 24) {
      await scrollToY(page, y);
      await expect
        .poll(async () => (await sample(page)).overlap, { message: `button over a panel control at y=${y}` })
        .toBe(false);
    }
  });
});
