import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { PRIVACY_BOLD, PRIVACY_PARAGRAPHS, withoutTags } from './privacy-bold';

/*
 * /privacy bolds each paragraph's promise (owner's pick, 2026-09-29: Version
 * 2, "bold key phrases, no new words, no headers"). This is the rendered side:
 * each paragraph, found by its `data-privacy-paragraph` hook, holds exactly
 * its pinned phrases as role=strong, in both languages; the words read the
 * same as the catalog with no tag printed as text; the bold really is bolder;
 * and nothing scrolls sideways. The catalog side is
 * tests/privacy-emphasis.unit.spec.ts.
 */

for (const [locale, prefix, messages] of [
  ['en', '', en],
  ['es', '/es', es],
] as const) {
  test(`${locale}: every paragraph bolds its pinned phrases, as <strong>, and reads the catalog's words`, async ({
    page,
  }) => {
    await page.goto(`${prefix}/privacy`);
    const article = page.locator('article');
    await expect(article.locator('[data-privacy-paragraph]')).toHaveCount(PRIVACY_PARAGRAPHS.length);
    for (const key of PRIVACY_PARAGRAPHS) {
      const paragraph = article.locator(`[data-privacy-paragraph="${key}"]`);
      await expect(paragraph.getByRole('strong'), `${locale} ${key}`).toHaveText([...PRIVACY_BOLD[locale][key]]);
      await expect(paragraph, `${locale} ${key}`).toHaveText(withoutTags(messages.privacy[key]));
    }
    // No tag leaked into the page as literal text.
    await expect(article).not.toContainText('<strong>');
  });

  test(`${locale}: the bold is heavier than the paragraph, and the closing line stays semibold`, async ({ page }) => {
    await page.goto(`${prefix}/privacy`);
    const weight = (selector: string) =>
      page.locator(selector).first().evaluate((el) => Number(getComputedStyle(el).fontWeight));
    const body = await weight('[data-privacy-paragraph="p1"]');
    const bold = await weight('[data-privacy-paragraph="p1"] strong');
    expect(bold).toBeGreaterThanOrEqual(700);
    expect(bold).toBeGreaterThan(body);
    expect(await weight('[data-privacy-paragraph="p5"]')).toBe(600);
  });

  test(`${locale}: /privacy does not scroll sideways with the bold in place @reflow`, async ({ page }) => {
    await page.goto(`${prefix}/privacy`);
    await expect(page.locator('[data-privacy-paragraph="p1"]').getByRole('strong').first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `${prefix}/privacy must not scroll horizontally`).toBeLessThanOrEqual(0);
  });
}
