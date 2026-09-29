import { expect, test, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * THE HOMEPAGE'S FIRST SCREEN (fold pass 2026-09-24; un-pinned 2026-09-27).
 *
 * Measured on real WebKit at 390×844 on 2026-09-10: on /es the hero's ZIP
 * button sat 8px UNDER the fixed thumb bar — a control the visitor could see
 * the top of and not tap. What is pinned here is the promise behind that
 * finding, not the layout that fixed it, in both locales:
 *
 *   1. No control inside the hero (`[data-hero]`) is hidden under a fixed
 *      bar at scroll 0. A control that starts on the first screen is wholly
 *      clear of every position:fixed element; one that starts below the
 *      first screen is simply below the fold. Checked at 390×844 AND at the
 *      iPhone 13 project's own 390×664, the shorter screen where it is
 *      tightest.
 *   2. The hero's first action leads to understanding ("Truth-first,
 *      call-next", Constitution v2 rule 8), whatever its fill: it links to a
 *      decoded surface — a /bills or /questions page, or an in-page anchor
 *      that lands inside a `[data-front-door]` surface. The ZIP path stays in
 *      the hero, demoted, never buried.
 *   3. (Dated — fold pass 2026-09-24; delete if the hero drops the line.) The
 *      trust line is visible on the first screen.
 *
 * Spanish is the long language and is the one that failed; it is never
 * optional here.
 *
 * WITH A ZIP SAVED (2026-09-29, Home option B). The hero's ZIP form gives way
 * to a block naming the reader's members (components/HeroSavedZip.tsx), and
 * promise 1 holds for it too. Until this date the suite ran with no ZIP only;
 * an independent check then found 8 of 16 saved-ZIP cases failing in WebKit
 * at 390 wide ("Ver en español", "Change ZIP code" / "Cambiar código postal"
 * and "View in English", partly or wholly under the bar). The block's height
 * depends on the names, the language and the split-district line, so the
 * four ZIPs below cover those shapes: 98103 and 78501 (one district, three
 * members), 20001 (DC, one delegate) and 10001 (a split district: senators
 * only, plus a link to find the representative).
 */

const LOCALES = [
  { prefix: '', messages: en },
  { prefix: '/es', messages: es },
] as const;

const HEIGHTS = [844, 664] as const;

/** The saved-ZIP shapes; see the header. */
const SAVED_ZIPS = ['98103', '78501', '20001', '10001'] as const;

type Rect = { top: number; bottom: number; left: number; right: number };

/** Every visible element pinned to the screen (position fixed or sticky) that
 *  is neither inside the hero nor wrapping it — the thumb bar today, whatever
 *  else a redesign pins to the screen tomorrow. */
async function fixedRects(page: Page): Promise<Rect[]> {
  return page.evaluate(() => {
    const hero = document.querySelector('[data-hero]');
    return [...document.querySelectorAll('body *')]
      .filter((el) => ['fixed', 'sticky'].includes(getComputedStyle(el).position))
      .filter((el) => !hero || !(hero.contains(el) || el.contains(hero)))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 1 && r.height > 1)
      .map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }));
  });
}

const overlaps = (a: Rect, b: Rect) =>
  a.top < b.bottom && a.bottom > b.top && a.left < b.right && a.right > b.left;

/** Promise 1, measured: the names of the hero controls that start on the
 *  first screen and sit partly or wholly under a fixed bar. Call it at
 *  scroll 0, once the hero has rendered in the state under test. */
async function heroControlsUnderBars(page: Page, viewportHeight: number): Promise<string[]> {
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  const bars = await fixedRects(page);
  // Precondition, not a design pin: with nothing pinned to the screen
  // this test has no subject. If the thumb bar is ever retired, delete
  // the test; if it moves somewhere fixedRects cannot see, fix the helper.
  expect(bars.length, 'no fixed or sticky bar found on a phone page').toBeGreaterThan(0);

  const controls = await page.evaluate(() => {
    const hero = document.querySelector('[data-hero]');
    if (!hero) throw new Error('no [data-hero] on the homepage');
    return [
      ...hero.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    ]
      .filter((el) => getComputedStyle(el).visibility !== 'hidden')
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0)
      .map(({ el, r }) => ({
        name:
          el.getAttribute('aria-label') ||
          el.textContent?.trim() ||
          (el as HTMLInputElement).name ||
          el.tagName,
        rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      }));
  });
  expect(controls.length, 'the hero carries at least one control').toBeGreaterThan(0);

  return controls
    .filter((c) => c.rect.top < viewportHeight)
    .filter((c) => bars.some((bar) => overlaps(c.rect, bar)))
    .map((c) => `${c.name} (${Math.round(c.rect.top)}–${Math.round(c.rect.bottom)})`);
}

test.describe('home fold (phone)', () => {
  // The thumb bar exists below md only, so this is a phone-project suite.
  test.skip(({ isMobile }) => !isMobile, 'the thumb bar exists below md only');

  for (const { prefix, messages } of LOCALES) {
    for (const height of HEIGHTS) {
      test(`${prefix || '/'} @390×${height}: no hero control is hidden under a fixed bar at scroll 0`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 390, height });
        await page.goto(`${prefix}/`);
        // The ZIP submit is the control that failed on 2026-09-10; waiting on
        // it (by key) also means the hero has rendered before we measure.
        await expect(page.getByRole('button', { name: messages.home.zipCta })).toBeVisible();
        expect(
          await heroControlsUnderBars(page, height),
          'hero controls partly or wholly under a fixed bar at scroll 0'
        ).toEqual([]);
      });

      for (const zip of SAVED_ZIPS) {
        test(`${prefix || '/'} @390×${height}, ZIP ${zip} saved: no hero control is hidden under a fixed bar at scroll 0`, async ({
          page,
        }) => {
          await page.addInitScript((z) => {
            try {
              window.localStorage.setItem('oravan.prefs', JSON.stringify({ zip: z }));
            } catch {
              /* blocked storage: the test then fails on the missing block, loudly */
            }
          }, zip);
          await page.setViewportSize({ width: 390, height });
          await page.goto(`${prefix}/`);
          // The members block replaces the form once the lookup answers;
          // measuring before that would measure the no-ZIP hero again.
          await expect(page.locator(`[data-hero] [data-saved-zip="${zip}"]`)).toBeVisible();
          await expect(page.locator('[data-hero] [data-zip-field]')).toHaveCount(0);
          expect(
            await heroControlsUnderBars(page, height),
            `ZIP ${zip}: hero controls partly or wholly under a fixed bar at scroll 0`
          ).toEqual([]);
        });
      }
    }

    test(`${prefix || '/'} (dated 2026-09-24): the trust line is visible on the first screen`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${prefix}/`);
      // Scoped to <main>: the Spanish header also carries the same sentence
      // in its lg+ sub-bar, which is display:none on a phone.
      const trust = page.locator('main').getByText(
        `${messages.common.trustLine1} ${messages.common.trustLine2}`,
        { exact: true }
      );
      await expect(trust).toBeVisible();
      const box = await trust.boundingBox();
      expect(box).not.toBeNull();
      const rect = { top: box!.y, bottom: box!.y + box!.height, left: box!.x, right: box!.x + box!.width };
      expect(rect.bottom).toBeLessThanOrEqual(844);
      for (const bar of await fixedRects(page)) expect(overlaps(rect, bar)).toBe(false);
    });
  }
});

/** A same-page anchor lands on a truth surface; a path lands on a decoded page. */
test.describe('home hero: the first action leads to understanding', () => {
  for (const { prefix, messages } of LOCALES) {
    test(`${prefix || '/'}: the hero's first action links to a decoded surface, whatever its fill`, async ({
      page,
    }) => {
      await page.goto(`${prefix}/`);
      const first = await page.evaluate(() => {
        const hero = document.querySelector('[data-hero]');
        if (!hero) throw new Error('no [data-hero] on the homepage');
        const action = [...hero.querySelectorAll('a[href], button')].find((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
        });
        if (!action) return null;
        const href = action.getAttribute('href');
        if (href === null) return { href: null, path: null, landsOnFrontDoor: false };
        const url = new URL(href, location.href);
        const samePage = url.pathname === location.pathname && url.hash.length > 1;
        const target = samePage ? document.getElementById(decodeURIComponent(url.hash.slice(1))) : null;
        return {
          href,
          path: url.pathname,
          landsOnFrontDoor: Boolean(target?.closest('[data-front-door]')),
        };
      });
      expect(first, 'the hero has an action').not.toBeNull();
      const decodedPath = /^(\/es)?\/(bills|questions)(\/|$)/.test(first!.path ?? '');
      expect(
        first!.landsOnFrontDoor || decodedPath,
        `the hero's first action (${first!.href}) must lead to a decoded surface, not to the call`
      ).toBe(true);

      // The ZIP path is still in the hero — demoted, never buried.
      await expect(
        page.locator('[data-hero]').getByRole('button', { name: messages.home.zipCta })
      ).toBeVisible();
    });
  }
});
