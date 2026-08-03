import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * The About/Support page (S4-S5, §6). Basic rendering, bilingual parity,
 * and the same a11y conventions the rest of the site already holds itself
 * to (semantic heading, no horizontal overflow, mobile tap-target
 * reachability - mirrors landing.spec.ts's equivalent checks for the
 * footer's existing links).
 */

for (const [locale, prefix, messages] of [
  ['en', '', en],
  ['es', '/es', es],
] as const) {
  test(`${locale}: About page renders a single h1 and the always-on funding section`, async ({ page }) => {
    await page.goto(`${prefix}/about`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(messages.about.title);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: messages.about.fundingTitle })).toBeVisible();
    await expect(page.getByText(messages.about.intro)).toBeVisible();
    // The operator paragraph (2026-08-02) — and the raw-key guard. A key
    // requested from the wrong namespace renders as its literal path
    // ("about.builtBy"): that exact defect shipped to main when these two
    // keys landed under `privacy` while the page reads `about`. Assert the
    // real strings render AND no namespace.key literal survives anywhere on
    // the page.
    await expect(page.getByText(messages.about.builtBy)).toBeVisible();
    await expect(
      page.getByRole('link', { name: messages.about.repoLinkLabel })
    ).toHaveAttribute('href', 'https://github.com/cm2489/oravan');
    expect(await page.locator('main').innerText()).not.toMatch(/\babout\.[a-zA-Z]+\b/);
  });

  test(`${locale}: no horizontal overflow on the About page @reflow`, async ({ page }) => {
    await page.goto(`${prefix}/about`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `${prefix}/about must not scroll horizontally`).toBeLessThanOrEqual(0);
  });
}

test('footer About link is reachable and clickable on mobile', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'regression guard for the mobile tab-bar overlap (mirrors the Privacy link check)');
  await page.goto('/');
  const link = page.locator('footer').getByRole('link', { name: 'About' });
  await link.scrollIntoViewIfNeeded();
  await link.click();
  await expect(page).toHaveURL(/\/about/);
});
