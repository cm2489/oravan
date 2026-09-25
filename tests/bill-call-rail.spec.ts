import { expect, test, type Page } from '@playwright/test';
import { billSlug, getAllBills } from '../lib/core';

/*
 * B2 — THE MOBILE CALL RAIL (2026-09-24), with its B1-2 hold zones
 * (2026-09-25).
 *
 * On a phone the bill page is one column, so the floating "Make the call"
 * button is the rail. It used to stand down the instant the call panel's top
 * edge slid in UNDER the fixed bottom nav and under the button itself — so
 * for a stretch of scroll, while the reader was still in the decode, no call
 * surface was visible at all. FloatingCallButton now yields only once a call
 * surface has risen above the button's own top edge.
 *
 * B1-2 added three HOLD ZONES the button is never drawn over: the title block
 * (it used to cover "55-second read · 5 questions answered below" at scroll
 * 0), the green panel (which carries its own call, and on which the old green
 * edge was 1.52:1), and the footer (at the page foot it used to park over the
 * footer's last lines for good). Inside a hold zone the button is down, and
 * the zone is the reason — so "never neither" is asserted everywhere OUTSIDE
 * them, and the zones themselves are pinned by their own tests below.
 *
 * Measured on webkit-mobile at the iPhone 13 viewport:
 *
 *   1. At 11 evenly spaced scroll positions, top to foot: never two call
 *      surfaces at once (the one-surface contract tests/call-action.spec.ts
 *      pins), and outside the hold zones never none. Across the decoded read
 *      itself, once past the title block, the button must be the one showing.
 *   2. While the button shows, it never sits over a control inside the call
 *      panel — swept every 24px through the panel's whole approach.
 *   3. It covers no text at scroll 0 or at the page foot.
 *   4. It is never painted while the green panel reaches its strip.
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
  held: boolean;
  panelHeld: boolean;
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
    // A hold zone counts from the top of the screen down to the button's own
    // bottom edge — the component's hold root, in the same arithmetic.
    const holdBottom = window.innerHeight - offset;
    const reaches = (el: Element | null) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.top < holdBottom && r.bottom > 0;
    };
    const panelHeld = reaches(document.querySelector('.on-go'));
    const held =
      panelHeld ||
      reaches(document.querySelector('[data-call-hold]')) ||
      reaches(document.querySelector('main ~ footer'));
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
    return { scrollY: Math.round(window.scrollY), fabShown, ctaAbove, inRead, overlap, held, panelHeld };
  });
}

/** Text nodes the button is painted over right now (0 while it is not painted). */
async function coveredText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const fab = document.querySelector('[data-floating-call]') as HTMLElement;
    const cs = getComputedStyle(fab);
    if (cs.display === 'none' || cs.opacity === '0') return [];
    const fb = fab.getBoundingClientRect();
    const hits: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      if (!n.textContent?.trim() || fab.contains(n)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const rc of range.getClientRects()) {
        if (rc.width > 0 && rc.right > fb.left && rc.left < fb.right && rc.bottom > fb.top && rc.top < fb.bottom) {
          hits.push(n.textContent.trim().slice(0, 60));
          break;
        }
      }
    }
    return hits;
  });
}

/** The button's settled resting state: hidden AND faded out (not mid-fade). */
async function expectDown(page: Page, message: string) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const fab = document.querySelector('[data-floating-call]') as HTMLElement;
          return fab.getAttribute('aria-hidden') === 'true' && getComputedStyle(fab).opacity === '0';
        }),
      { message }
    )
    .toBe(true);
}

test.describe('bill page mobile call rail', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'webkit-mobile', 'the floating rail is the phone layout');
    test.skip(!SLUG, 'no decoded bill in the corpus');
  });

  test('one call surface at 11 evenly spaced scroll positions, and the button carries the read', async ({
    page,
  }) => {
    await page.goto(`/bills/${SLUG}`);
    await page.waitForLoadState('networkidle');
    // The title block is on screen at scroll 0 on every bill page, so the
    // button's first settled state is DOWN — it waits for the reader to pass
    // the title (B1-2). Settled, not resting: the observers have answered.
    await expectDown(page, 'the button holds while the title block is on screen');
    const max = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight
    );
    const rows: Sample[] = [];
    for (let i = 0; i <= 10; i++) {
      await scrollToY(page, Math.round((max * i) / 10));
      // Polled: the observer answers a frame after the scroll lands. The
      // settled state is what is asserted — never two surfaces, and never
      // none outside a hold zone.
      await expect
        .poll(async () => {
          const s = await sample(page);
          const two = s.fabShown && (s.ctaAbove || s.panelHeld);
          const none = !s.fabShown && !s.ctaAbove && !s.held;
          const shownInHold = s.fabShown && s.held;
          return !two && !none && !shownInHold;
        }, { message: `one call surface at position ${i}` })
        .toBe(true);
      rows.push(await sample(page));
    }
    // Guard against a vacuous pass: the walk really reached the page foot.
    expect(rows.at(-1)!.scrollY).toBeGreaterThanOrEqual(max - 2);
    for (const r of rows) {
      if (r.inRead && !r.ctaAbove && !r.held) {
        expect(r.fabShown, `button hidden mid-read at y=${r.scrollY}`).toBe(true);
      }
    }
    // The read was actually sampled past the title, and the button carried
    // it — the B2 regression was precisely a read with no call surface beside
    // it, and a hold zone that swallowed the whole read would be the same bug.
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

  test('the button covers no text at the top of the page or at its foot', async ({ page }) => {
    await page.goto(`/bills/${SLUG}`);
    await page.waitForLoadState('networkidle');
    await expectDown(page, 'down at scroll 0: the title block holds it');
    expect(await coveredText(page), 'text under the button at scroll 0').toEqual([]);

    const max = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    await scrollToY(page, max);
    // Nothing scrolls past the foot, so anything under the button here would
    // be covered for good — the footer holds it down instead.
    await expectDown(page, 'down at the page foot: the footer holds it');
    expect(await coveredText(page), 'text under the button at max scroll').toEqual([]);
  });

  test('the button is never painted over the green panel', async ({ page }) => {
    // Whatever the homepage crowns carries the green panel on its own page
    // (tests/freshness.spec.ts, THE SEAM) — derived, never pinned.
    await page.goto('/');
    const crown = page.locator('section[aria-labelledby="top-actions"] section.bg-go-deep a[data-call-cta]');
    test.skip((await crown.count()) === 0, 'quiet week: no green panel anywhere to sweep');
    const href = await crown.first().getAttribute('href');
    await page.goto(href!);
    await page.waitForLoadState('networkidle');
    const panel = await page.evaluate(() => {
      const p = document.querySelector('.on-go');
      if (!p) return null;
      const r = p.getBoundingClientRect();
      return { top: Math.round(r.top + window.scrollY), bottom: Math.round(r.bottom + window.scrollY) };
    });
    test.skip(!panel, 'the chamber is out: the recess note stands in the band slot');
    let sampled = 0;
    for (let y = 0; y <= panel!.bottom + 48; y += 48) {
      await scrollToY(page, y);
      const s = await sample(page);
      if (!s.panelHeld) continue;
      sampled++;
      await expectDown(page, `button painted over the green panel at y=${y}`);
    }
    expect(sampled, 'the sweep actually crossed the panel').toBeGreaterThan(0);
  });
});

test.describe('bill page desk: the rail is the call', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'webkit-desktop', 'the two-column desk layout');
    test.skip(!SLUG, 'no decoded bill in the corpus');
  });

  /*
   * DESIGN.md structural constraint 1: at 62rem and up the page is two
   * columns and the "Make your call" rail is sticky beside the read. The
   * floating button only ever doubled a call already on screen there (B1-2,
   * measured at 1440x900: over the green panel beside the panel's own CTA),
   * so it does not render at all — and the rail it defers to must still be
   * the sticky one.
   */
  test('the floating button never shows at 62rem and up, and the rail is sticky', async ({ page }) => {
    await page.goto(`/bills/${SLUG}`);
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => window.matchMedia('(min-width: 62rem)').matches)).toBe(true);
    const sticky = await page.evaluate(() => {
      let el: HTMLElement | null = document.querySelector('section[aria-labelledby="act"]');
      while (el && getComputedStyle(el).position !== 'sticky') el = el.parentElement;
      return !!el;
    });
    expect(sticky, 'the call rail holds a sticky ancestor on the desk').toBe(true);

    const max = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    for (const y of [0, Math.round(max / 3), Math.round((2 * max) / 3), max]) {
      await scrollToY(page, y);
      await expectDown(page, `floating button shown on the desk at y=${y}`);
      expect(
        await page.locator('[data-floating-call]').evaluate((el) => getComputedStyle(el).display),
        `floating button rendered on the desk at y=${y}`
      ).toBe('none');
    }
  });
});
