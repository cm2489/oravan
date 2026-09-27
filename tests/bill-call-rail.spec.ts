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
 * AMENDED 2026-09-27 (audit SY-07, interim until the rebuild's Call tab). B2
 * made the button carry the decoded read, and the audit measured the cost:
 * a 173x62px button over about three lines of the decode on every phone
 * screen, three personas out of three. The text is the product, so the button
 * now also stands down while any of the decoded answer ([data-read-zone]) is
 * on screen. What the reader keeps: the call panel follows the read directly
 * in flow, and past the panel the button carries the rest of the page back to
 * it. Funnel invariant I2 (stance → completed script) counts interactions and
 * never read this button.
 *
 * Three properties, measured on webkit-mobile at the iPhone 13 viewport:
 *
 *   1. At 11 evenly spaced scroll positions, top to foot: never two call
 *      surfaces at once (the one-surface contract tests/call-action.spec.ts
 *      pins), the button is showing EXACTLY when neither a call surface nor
 *      the read is on screen, it never sits over the read, and the panel is
 *      the next thing after the read.
 *   2. While the button shows, it never sits over a control inside the call
 *      panel — swept every 24px through the panel's whole approach.
 *   3. It never sits over the read — swept every 96px through the read's
 *      whole extent.
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
  /** Any of the decoded answer is on screen above the fixed nav. */
  readOnScreen: boolean;
  /** The SHOWING button's box intersects the read's box (SY-07). */
  coversRead: boolean;
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
    const offset = parseFloat(getComputedStyle(fab).bottom) || 0;
    const stripTop = window.innerHeight - offset - fab.offsetHeight - 8;
    const ctaAbove = [...document.querySelectorAll('[data-call-cta]')].some((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.top < stripTop && r.bottom > 0;
    });
    const reads = [...document.querySelectorAll('[data-read-zone]')].map((el) =>
      el.getBoundingClientRect()
    );
    // Same arithmetic as FloatingCallButton's read observer: anywhere above
    // the fixed nav, including the strip the button stands in.
    const readOnScreen = reads.some(
      (r) => r.height > 0 && r.top < window.innerHeight - offset && r.bottom > 0
    );
    const coversRead =
      fabShown &&
      reads.some((r) => r.left < fr.right && r.right > fr.left && r.top < fr.bottom && r.bottom > fr.top);
    const controls = document.querySelectorAll(
      '[data-call-cta] button, [data-call-cta] a[href], [data-call-cta] input, [data-call-cta] textarea, [data-call-cta] summary'
    );
    const overlap =
      fabShown &&
      [...controls].some((c) => {
        const r = c.getBoundingClientRect();
        return r.width > 0 && r.left < fr.right && r.right > fr.left && r.top < fr.bottom && r.bottom > fr.top;
      });
    return { scrollY: Math.round(window.scrollY), fabShown, ctaAbove, readOnScreen, coversRead, overlap };
  });
}

test.describe('bill page mobile call rail', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'webkit-mobile', 'the floating rail is the phone layout');
    test.skip(!SLUG, 'no decoded bill in the corpus');
  });

  test('at 11 evenly spaced scroll positions the button stands down over the read and carries the rest of the page', async ({
    page,
  }) => {
    await page.goto(`/bills/${SLUG}`);
    await page.waitForLoadState('networkidle');
    const max = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight
    );
    const rows: Sample[] = [];
    for (let i = 0; i <= 10; i++) {
      await scrollToY(page, Math.round((max * i) / 10));
      // Polled: the observers answer a frame after the scroll lands. The
      // settled state is what is asserted — the button shows exactly when
      // neither a call surface nor the read is on screen.
      await expect
        .poll(async () => {
          const s = await sample(page);
          return s.fabShown === !(s.ctaAbove || s.readOnScreen);
        }, { message: `button state at position ${i}` })
        .toBe(true);
      rows.push(await sample(page));
    }
    // Guard against a vacuous pass: the walk really reached the page foot.
    expect(rows.at(-1)!.scrollY).toBeGreaterThanOrEqual(max - 2);
    for (const r of rows) {
      expect(r.fabShown && r.ctaAbove, `two call surfaces at y=${r.scrollY}`).toBe(false);
      expect(r.coversRead, `button over the decoded read at y=${r.scrollY}`).toBe(false);
    }
    // NON-VACUITY, both ways: the read was sampled with the button down (the
    // SY-07 fix fired), and the button still showed somewhere (it was not
    // simply switched off — past the panel it carries the call).
    expect(rows.some((r) => r.readOnScreen && !r.fabShown), JSON.stringify(rows)).toBe(true);
    expect(rows.some((r) => r.fabShown), JSON.stringify(rows)).toBe(true);

    // DEMOTE, NEVER BURY, on the one layout where the button now steps aside
    // for the read: the call panel is the very next thing after it. The gap
    // is the grid's own row gap; 64px is a generous ceiling on it.
    const gap = await page.evaluate(() => {
      const read = document.querySelector('[data-read-zone]')!.getBoundingClientRect();
      const panel = document.querySelector('section[aria-labelledby="act"]')!.getBoundingClientRect();
      return panel.top - read.bottom;
    });
    expect(gap, 'the call panel must follow the decoded read directly').toBeGreaterThanOrEqual(0);
    expect(gap, 'the call panel must follow the decoded read directly').toBeLessThanOrEqual(64);
    test.info().annotations.push({ type: 'positions', description: JSON.stringify(rows) });
  });

  test('the button never sits over the decoded read', async ({ page }) => {
    await page.goto(`/bills/${SLUG}`);
    await page.waitForLoadState('networkidle');
    const { from, to } = await page.evaluate(() => {
      const r = document.querySelector('[data-read-zone]')!.getBoundingClientRect();
      const top = r.top + window.scrollY;
      return {
        from: Math.max(0, Math.round(top - window.innerHeight)),
        to: Math.round(r.bottom + window.scrollY),
      };
    });
    let sampled = 0;
    for (let y = from; y <= to; y += 96) {
      await scrollToY(page, y);
      await expect
        .poll(async () => (await sample(page)).coversRead, { message: `button over the read at y=${y}` })
        .toBe(false);
      sampled += 1;
    }
    expect(sampled, 'the sweep never entered the read').toBeGreaterThan(1);
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
