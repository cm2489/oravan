import { expect, test, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * THE HOMEPAGE'S FIRST SCREEN ON A PHONE (fold pass, 2026-09-24).
 *
 * Measured on real WebKit at 390×844 on 2026-09-10: on /es the hero's primary
 * ZIP button sat 8px UNDER the fixed thumb bar, the hero carried two co-equal
 * filled buttons pointing at two funnels, and the "No accounts, no ads, no
 * trackers" line was hidden on phones. Three facts pinned here, both locales:
 *
 *   1. The lowest hero control (the ZIP submit) clears the thumb bar: its bottom edge
 *      is above the bar's top edge with the page at scroll 0. Checked at the
 *      measured 390×844 AND at the iPhone 13 project's own 390×664, the
 *      shorter screen where it is tightest.
 *   2. Exactly ONE filled primary control in the hero, and it is the jump to
 *      what is moving ("Truth-first, call-next"); the ZIP submit is secondary.
 *   3. The trust line is visible on the first screen.
 *
 * Spanish is the long language and is the one that failed; it is never
 * optional here.
 */

const LOCALES = [
  { prefix: '', messages: en },
  { prefix: '/es', messages: es },
] as const;

const HEIGHTS = [844, 664] as const;

/** The fixed thumb bar — the one `nav` that is position:fixed. */
async function thumbBarTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const nav = [...document.querySelectorAll('nav')].find(
      (n) => getComputedStyle(n).position === 'fixed'
    );
    if (!nav) throw new Error('no fixed thumb bar on the page');
    return nav.getBoundingClientRect().top;
  });
}

test.describe('home fold (phone)', () => {
  // The thumb bar exists below md only, so this is a phone-project spec.
  test.skip(({ isMobile }) => !isMobile, 'the thumb bar exists below md only');

  for (const { prefix, messages } of LOCALES) {
    for (const height of HEIGHTS) {
      test(`${prefix || '/'} @390×${height}: the ZIP submit (lowest hero control) clears the thumb bar at scroll 0`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 390, height });
        await page.goto(`${prefix}/`);
        const cta = page.getByRole('button', { name: messages.home.zipCta });
        await expect(cta).toBeVisible();
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
        const box = await cta.boundingBox();
        expect(box).not.toBeNull();
        const barTop = await thumbBarTop(page);
        expect(box!.y + box!.height).toBeLessThan(barTop);
      });
    }

    test(`${prefix || '/'}: exactly one filled primary control in the hero, and it is the jump to what is moving`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${prefix}/`);
      const jump = page.getByRole('link', { name: messages.home.heroJump });
      await expect(jump).toBeVisible();
      // "Truth-first, call-next": the filled control leads to READING. The ZIP
      // form is still in the hero (demoted, never buried) with an ink-outline
      // submit, so the ZIP-first funnel path is unchanged.
      const filled = await page.evaluate((jumpName) => {
        const hero = document.querySelector('main h1')?.parentElement;
        if (!hero) throw new Error('no hero');
        const primary = [...hero.querySelectorAll('a')].find(
          (a) => a.textContent?.trim() === jumpName
        );
        if (!primary) throw new Error('no jump link in the hero');
        const go = getComputedStyle(primary).backgroundColor;
        return [...hero.querySelectorAll('a, button')]
          .filter((el) => el.getBoundingClientRect().height > 0)
          .filter((el) => getComputedStyle(el).backgroundColor === go)
          .map((el) => el.textContent?.trim());
      }, messages.home.heroJump);
      expect(filled).toEqual([messages.home.heroJump]);

      // The ZIP path is still one tap away — demoted, not removed.
      await expect(page.getByRole('button', { name: messages.home.zipCta })).toBeVisible();
    });

    test(`${prefix || '/'}: the trust line is visible on the first screen`, async ({ page }) => {
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
      expect(box!.y + box!.height).toBeLessThan(await thumbBarTop(page));
    });
  }
});
