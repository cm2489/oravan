import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { billSlug, getAllBills } from '../lib/core';
import { settledDecision } from '../lib/journey';

/*
 * PICTURES OF THE ISLAND BAR, FOR THE OWNER'S REVIEW (2026-11-22). Not a
 * gate: each test asserts only that its subject is on screen, then writes a
 * picture to island-bar-shots/, which ci.yml uploads from every e2e shard and
 * the e2e-report job gathers into one artifact, `island-bar-shots`. Built for
 * the review of the island bar's pull request; delete this file (and its two
 * ci.yml steps) once the owner has seen them.
 *
 * webkit-mobile (390 wide) and webkit-320 (@reflow, 320 wide) take the phone
 * pictures; webkit-desktop takes the one 1280px picture of the unchanged
 * desktop header.
 *
 * "Reduced transparency": WebKit and Playwright cannot emulate
 * `prefers-reduced-transparency`, so that picture copies the stylesheet's own
 * `@media (prefers-reduced-transparency: reduce)` rules out of the page's
 * CSSOM and applies them unconditionally. "More contrast" is emulated for
 * real (`emulateMedia({ contrast: 'more' })`).
 */

const SHOTS = path.join(process.cwd(), 'island-bar-shots');
mkdirSync(SHOTS, { recursive: true });

const decoded = getAllBills().find((b) => b.ai_sections && settledDecision(b) === null);
const SLUG = decoded ? billSlug(decoded) : null;

function width(page: Page) {
  return page.viewportSize()?.width ?? 0;
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${name}-${width(page)}.png`) });
}

async function scrollTo(page: Page, y: number) {
  await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
  await page.waitForTimeout(150);
}

/** Scroll so `selector`'s top sits a little above the island's top edge, so
 *  that ground is what the bar floats over. */
async function parkOver(page: Page, selector: string) {
  const y = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const bar = document.querySelector('[data-thumb-bar]');
    if (!el || !bar) return null;
    const r = el.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    return Math.max(0, window.scrollY + r.top - b.top + 24);
  }, selector);
  expect(y, `${selector} is on the page`).not.toBeNull();
  await scrollTo(page, y!);
}

async function phone(page: Page, isMobile: boolean) {
  test.skip(!isMobile, 'the island bar is a phone surface');
  await expect(page.locator('nav[data-thumb-bar]')).toBeVisible();
}

test.describe('island bar pictures @reflow', () => {
  test('over light content (a bill page, mid-read)', async ({ page, isMobile }) => {
    test.skip(!SLUG, 'no decoded bill');
    await page.goto(`/bills/${SLUG}`);
    await phone(page, isMobile);
    await scrollTo(page, 600);
    await shot(page, 'light');
  });

  test('over the dark Big Questions band (home)', async ({ page, isMobile }) => {
    await page.goto('/');
    await phone(page, isMobile);
    await parkOver(page, 'section.on-dark, .on-dark.bg-ink-deep');
    await shot(page, 'dark-band');
  });

  test('over the footer at the very end of a page', async ({ page, isMobile }) => {
    await page.goto('/');
    await phone(page, isMobile);
    await scrollTo(page, 1e6);
    await shot(page, 'footer-end');
  });

  test('a bill page beside the floating call button', async ({ page, isMobile }) => {
    test.skip(!SLUG, 'no decoded bill');
    await page.goto(`/bills/${SLUG}`);
    await phone(page, isMobile);
    await page.waitForLoadState('networkidle');
    // Past the call panel: the stretch where the floating button carries the
    // page back to #act.
    await scrollTo(page, 1e6);
    await page.evaluate(() => window.scrollBy({ top: -900, behavior: 'instant' }));
    await page.waitForTimeout(500);
    await shot(page, 'bill-fab');
  });

  test('reduced transparency (the stylesheet rule applied)', async ({ page, isMobile }) => {
    await page.goto('/');
    await phone(page, isMobile);
    const applied = await page.evaluate(() => {
      const css: string[] = [];
      for (const sheet of [...document.styleSheets]) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const r of [...rules]) {
          if (r instanceof CSSMediaRule && r.conditionText.includes('prefers-reduced-transparency')) {
            for (const inner of [...r.cssRules]) css.push(inner.cssText);
          }
        }
      }
      const style = document.createElement('style');
      style.textContent = css.join('\n');
      document.head.appendChild(style);
      return css.length;
    });
    expect(applied, 'the reduced-transparency rule is in the stylesheet').toBeGreaterThan(0);
    await parkOver(page, 'section.on-dark, .on-dark.bg-ink-deep');
    await shot(page, 'reduced-transparency');
  });

  test('more contrast (emulated)', async ({ page, isMobile }) => {
    await page.emulateMedia({ contrast: 'more' });
    await page.goto('/');
    await phone(page, isMobile);
    await parkOver(page, 'section.on-dark, .on-dark.bg-ink-deep');
    await shot(page, 'more-contrast');
  });

  test('keyboard focus on a tab', async ({ page, isMobile }) => {
    await page.goto('/bills');
    await phone(page, isMobile);
    const tab = page.locator('nav[data-thumb-bar] a[href$="/questions"]');
    await tab.focus();
    // Focus from the keyboard, so :focus-visible matches.
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(tab).toBeFocused();
    await shot(page, 'focus-tab');
    await page.locator('nav[data-thumb-bar] [data-call-tab]').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await shot(page, 'focus-call');
  });

  test('Spanish, home and the end of a page', async ({ page, isMobile }) => {
    await page.goto('/es');
    await phone(page, isMobile);
    await shot(page, 'es-home');
    await page.goto('/es/questions');
    await scrollTo(page, 1e6);
    await shot(page, 'es-questions-end');
  });

  test('desktop at 1280: the header is unchanged and the bar is absent', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the desktop picture');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.locator('nav[data-thumb-bar]')).toBeHidden();
    await shot(page, 'desktop');
  });
});
