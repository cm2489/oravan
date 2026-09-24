import { expect, test, type Page } from '@playwright/test';
import en from '../messages/en.json';
import { billSlug, getAllBills } from '../lib/core';
import { mockScriptApi, seedZip } from './helpers';

/*
 * BILL PAGE TOUCH TARGETS + VISIBLE FOCUS (2026-09-24 a11y sweep).
 *
 * "Accessibility is not optional" (CLAUDE.md) — and on this page it had
 * slipped: "Read the official bill on Congress.gov" trailed the AI
 * disclaimer inline, wrapped at 390px and measured 39px tall.
 *
 * THE RULE, as DESIGN.md states it: every control is at least 44x44, except
 * a link sitting inline inside a sentence (WCAG 2.5.8's inline exception —
 * inflating it would break the line). The sweep enforces exactly that and no
 * more: a hit box counts its padding (the bounding box), and an inline link
 * is exempt only when the block it sits in carries other words too. It runs
 * on the page at rest AND with the call panel opened (ZIP seeded, a stance
 * picked), because most of the panel's controls only exist in that state.
 *
 * Scoped to <main>: the site header and footer are shared chrome with their
 * own owners and specs.
 */
const decoded = getAllBills().find((b) => b.ai_sections && b.congress_gov_url);
const SLUG = decoded ? billSlug(decoded) : null;

async function smallTargets(page: Page) {
  return page.evaluate(() => {
    const sel =
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="radio"], [role="button"]';
    const main = document.querySelector('main')!;
    const blockOf = (el: Element) => {
      let n: Element | null = el.parentElement;
      while (n && getComputedStyle(n).display.startsWith('inline')) n = n.parentElement;
      return n;
    };
    const out: string[] = [];
    for (const el of main.querySelectorAll(sel)) {
      if (el.closest('[aria-hidden="true"], [inert]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
      if (r.width >= 44 && r.height >= 44) continue;
      if (cs.display === 'inline') {
        const text = (el.textContent ?? '').trim();
        const block = blockOf(el);
        const around = (block?.textContent ?? '').replace(text, '').trim();
        if (around.length > 0) continue; // inline inside a sentence: exempt
      }
      out.push(
        `${el.tagName} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40)}" ${Math.round(r.width)}x${Math.round(r.height)}`
      );
    }
    return out;
  });
}

test.describe('bill page accessibility floor', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'webkit-mobile', 'the 390px phone layout is where targets shrink');
    test.skip(!SLUG, 'no decoded bill in the corpus');
  });

  test('every interactive element on a bill page has a 44px hit box', async ({ page }) => {
    await mockScriptApi(page);
    await page.goto(`/bills/${SLUG}`);
    // The official-text disclosure hides a link; open it so it is swept too.
    await page.locator('main header details summary').click();
    expect(await smallTargets(page), 'controls under 44px at rest').toEqual([]);

    await seedZip(page, '10001');
    await page.reload();
    await page.getByRole('radio', { name: en.bill.stance.support }).click();
    await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toBeVisible();
    expect(await smallTargets(page), 'controls under 44px with the call panel open').toEqual([]);
  });

  test('the first three controls show a visible focus indicator', async ({ page }) => {
    await page.goto(`/bills/${SLUG}`);
    await page.locator('main').evaluate((m) => {
      // Start the keyboard walk at the top of <main>, past the site chrome.
      m.setAttribute('tabindex', '-1');
      (m as HTMLElement).focus();
    });
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => {
        const a = document.activeElement as HTMLElement;
        const cs = getComputedStyle(a);
        return {
          name: (a.textContent ?? '').trim().slice(0, 40),
          inMain: !!a.closest('main'),
          outline: cs.outlineStyle !== 'none' ? parseFloat(cs.outlineWidth) : 0,
          focusVisible: a.matches(':focus-visible'),
        };
      });
      expect(ring.inMain, `focus left <main> at step ${i + 1}`).toBe(true);
      expect(ring.focusVisible, `"${ring.name}" is not :focus-visible`).toBe(true);
      // globals.css draws a 3px `--focus` ring; anything thinner is a regression.
      expect(ring.outline, `"${ring.name}" focus ring`).toBeGreaterThanOrEqual(3);
      seen.push(ring.name);
    }
    expect(new Set(seen).size).toBe(3);
  });
});
