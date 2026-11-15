import { expect, test, type Page } from '@playwright/test';
import { getAllBills } from '../lib/core';
import { sharedNamePages, sharedNamePath } from '../lib/shared-names';

/*
 * THE SHARED-NAME PAGE'S ACCESSIBILITY FLOOR (CLAUDE.md rule 7), in the style
 * of tests/bill-a11y.spec.ts: a semantic list, every control at least 44x44,
 * a visible focus ring on the keyboard walk, and no sideways scroll at 320px.
 * The page uses the site's existing tokens and components only (BillCard,
 * Chip), whose contrast pairs tests/contrast.unit.spec.ts already computes.
 * Skips, with the reason, while the data holds no shared name (before the
 * nightly first fills data/short-titles.json).
 */

const first = sharedNamePages(getAllBills())[0];
const PATH = first ? sharedNamePath(first.congress, first.name) : null;
const NONE = 'no shared name in the data yet (data/short-titles.json not filled)';

async function smallTargets(page: Page) {
  return page.evaluate(() => {
    const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"]';
    const main = document.querySelector('main')!;
    const out: string[] = [];
    for (const el of main.querySelectorAll(sel)) {
      if (el.closest('[aria-hidden="true"], [inert]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width >= 44 && r.height >= 44) continue;
      out.push(`${el.tagName} "${(el.textContent || '').trim().slice(0, 40)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
}

test.describe('shared-name page accessibility floor', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(!PATH, NONE);
    test.skip(testInfo.project.name === 'webkit-desktop', 'phone widths are where targets shrink and lines overflow');
  });

  test('a semantic list of the bills, one item and one link each, with a 44px hit box', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'webkit-mobile', 'run once, at 390px');
    for (const path of [PATH!, `/es${PATH}`]) {
      await page.goto(path);
      const list = page.locator('main ul[aria-label]');
      await expect(list).toHaveCount(1);
      await expect(list.locator(':scope > li')).toHaveCount(first!.bills.length);
      await expect(list.locator(':scope > li a[href]')).toHaveCount(first!.bills.length);
      await expect(page.locator('main h1')).toHaveCount(1);
      // The record's title is English on /es too, and says so.
      await expect(page.locator('main h1 [lang="en"]').first()).toBeVisible();
      expect(await smallTargets(page), `${path}: controls under 44px`).toEqual([]);
    }
  });

  test('the keyboard walk reaches every bill link with a visible focus ring', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'webkit-mobile', 'run once');
    await page.goto(PATH!);
    await page.locator('main').evaluate((m) => {
      m.setAttribute('tabindex', '-1');
      (m as HTMLElement).focus();
    });
    for (let i = 0; i < first!.bills.length; i++) {
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => {
        const a = document.activeElement as HTMLElement;
        const cs = getComputedStyle(a);
        return { tag: a.tagName, inList: !!a.closest('main ul'), focusVisible: a.matches(':focus-visible'), outline: cs.outlineStyle !== 'none' ? parseFloat(cs.outlineWidth) : 0 };
      });
      expect(ring.inList, `step ${i + 1} is a bill link`).toBe(true);
      expect(ring.focusVisible).toBe(true);
      expect(ring.outline).toBeGreaterThanOrEqual(3);
    }
  });

  test('no sideways scroll at 320px, in both languages @reflow', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'webkit-320', 'the 320px project');
    for (const path of [PATH!, `/es${PATH}`]) {
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });
});
