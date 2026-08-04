import { expect, test } from '@playwright/test';
import en from '../messages/en.json';

/*
 * The remembered language choice (2026-08-04 walkthrough P1: "Spanish is a
 * mode you must re-enter" — choosing Español was forgotten the moment a bare
 * URL was opened). An explicit choice made on any language control is stored
 * on-device (lib/locale-pref.ts) and turns into the SAME dismissible
 * suggestion note a Spanish-configured browser already gets.
 *
 * NEVER a redirect: URLs stay authoritative (founder decision, S6 persona
 * gate 2026-07-07 — i18n/routing.ts, tests/locale-routing.spec.ts). The
 * final test here pins that the stored choice does not weaken that ruling.
 *
 * The note's own strings are Spanish in BOTH catalogs by design, so the EN
 * catalog literals below are the Spanish sentences the note shows.
 */

const NOTE_CTA = en.langNote.cta;
const CHOICE_KEY = 'oravan.locale.chosen';

const storedChoice = (page: import('@playwright/test').Page) =>
  page.evaluate((k) => localStorage.getItem(k), CHOICE_KEY);

test.describe('Spanish-configured browser (es-MX)', () => {
  test.use({ locale: 'es-MX' });

  test('the EN homepage suggests Spanish; dismissal persists across entries', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(NOTE_CTA)).toBeVisible();
    await page.getByRole('button', { name: en.langNote.dismiss }).click();
    await expect(page.getByText(NOTE_CTA)).toHaveCount(0);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(en.home.heroTitle);
    await expect(page.getByText(NOTE_CTA)).toHaveCount(0);
  });

  test('an explicit ENGLISH choice outranks the browser language — no re-suggestion', async ({
    page,
  }) => {
    await page.goto('/es');
    await page.locator('header').getByRole('link', { name: /english/i }).first().click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(en.home.heroTitle);
    await expect.poll(() => storedChoice(page)).toBe('en');
    await page.goto('/');
    await expect(page.getByText(NOTE_CTA)).toHaveCount(0);
  });
});

test('an explicit Español choice is remembered: the one-tap way back returns on the next bare-URL entry', async ({
  page,
}) => {
  // An English-configured browser — the note has no reason to appear yet.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(en.home.heroTitle);
  await expect(page.getByText(NOTE_CTA)).toHaveCount(0);

  // Choose Español in the header switcher.
  await page.locator('header').getByRole('link', { name: /español/i }).first().click();
  await expect(page).toHaveURL(/\/es(\/|$)/);
  await expect.poll(() => storedChoice(page)).toBe('es');

  // THE RULING HOLDS: a bare URL still renders English — no redirect —
  // but the way back to Spanish is now one tap, without needing a
  // Spanish-configured browser.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(en.home.heroTitle);
  await expect(page.getByText(NOTE_CTA)).toBeVisible();
  expect(page.url()).not.toContain('/es');
});
