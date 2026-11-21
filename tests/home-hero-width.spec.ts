import { expect, test } from '@playwright/test';

/*
 * THE HOME HERO NEVER WIDENS THE PAGE ON A PHONE (2026-11-20).
 *
 * The hero's second beat ("Then call your members." / "Luego, haz la
 * llamada.") carries the go-mark stroke and cannot wrap. text-h1 holds its
 * 32px floor from 360 to 457px, and the one-step-smaller size began only
 * below 360px, so on main the English line ran 19px past a 360px screen and
 * 4px past a 375px one, and the page scrolled sideways there.
 *
 * WHY THE 320 TESTS DID NOT CATCH IT: the webkit-320 project runs at 320px
 * only, where the smaller step already applied. This test sets its own
 * viewports between 344 and 412px, the band no reflow test measured. It runs
 * in the webkit-mobile and webkit-desktop projects (not tagged @reflow: that
 * project is pinned to 320). In webkit-mobile it also attaches pictures of
 * the hero at 360 and 390px in both languages to the report, so a reviewer
 * can see the line without running anything.
 */

const WIDTHS = [344, 360, 375, 390, 412];
const PICTURES = new Set([360, 390]);

for (const lang of ['en', 'es'] as const) {
  for (const width of WIDTHS) {
    test(`home (${lang}): the page is no wider than a ${width}px screen`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(lang === 'es' ? '/es' : '/');
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const hero = page.locator('[data-hero]');
      await expect(hero).toBeVisible();

      const o = await page.evaluate(() => {
        const doc = document.documentElement;
        const h1 = document.querySelector('[data-hero] h1');
        let worst = 0;
        for (const el of h1 ? [h1, ...Array.from(h1.querySelectorAll('span'))] : []) {
          const r = el.getBoundingClientRect();
          if (r.width > 0) worst = Math.max(worst, r.right - doc.clientWidth);
        }
        return { page: doc.scrollWidth - doc.clientWidth, heading: Math.ceil(worst) };
      });

      if (testInfo.project.name === 'webkit-mobile' && PICTURES.has(width)) {
        await testInfo.attach(`home-hero-${lang}-${width}px`, {
          body: await hero.screenshot(),
          contentType: 'image/png',
        });
      }

      expect(o.page, `the page scrolls sideways by ${o.page}px`).toBeLessThanOrEqual(0);
      expect(o.heading, `the hero heading ends ${o.heading}px past the screen`).toBeLessThanOrEqual(0);
    });
  }
}
