import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { EMBEDS_PAGES_PUBLIC } from '../lib/site';

// Hidden until embeds come back (lib/site.ts EMBEDS_PAGES_PUBLIC). Every test
// below needs the page, so the whole file skips while it 404s, and runs again
// unchanged the moment the constant flips.
test.skip(!EMBEDS_PAGES_PUBLIC, 'The /embeds pages are hidden until embeds come back (owner, 2026-09-28; PR #353). tests/embeds-hidden.spec.ts asserts their 404; set lib/site.ts EMBEDS_PAGES_PUBLIC to true to run this again.');

/*
 * S21 — the embeds Terms of Service page (/embeds/terms, both locales).
 * Basic rendering, bilingual parity, the governing-language clause present
 * in BOTH languages (English controls; Spanish is a courtesy translation —
 * both statements must render, in both locales), the required-coverage
 * sections all present, and the two outbound links (back to /embeds, and to
 * the separate citizen /terms). No horizontal-overflow check, mirroring
 * about.spec.ts's convention for a plain prose page.
 */

for (const [locale, prefix, messages] of [
  ['en', '', en],
  ['es', '/es', es],
] as const) {
  test(`${locale}: renders a single h1, the governing-language notice, and the last-updated line`, async ({
    page,
  }) => {
    await page.goto(`${prefix}/embeds/terms`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(messages.embedsTerms.title);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByText(messages.embedsTerms.governingLanguageNotice)).toBeVisible();
    await expect(page.getByText(messages.embedsTerms.lastUpdated)).toBeVisible();
  });

  test(`${locale}: every required-coverage section renders`, async ({ page }) => {
    await page.goto(`${prefix}/embeds/terms`);
    const t = messages.embedsTerms;
    const headings = [
      t.scopeHeading,
      t.nonpartisanHeading,
      t.attributionHeading,
      t.prohibitedHeading,
      t.tokenHeading,
      t.licensingHeading,
      t.billingHeading,
      t.warrantyHeading,
      t.lawHeading,
      t.contactHeading,
      t.changesHeading,
    ];
    for (const heading of headings) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
    // The AllSides/lean/coverage-data exclusion and the nonpartisan clause
    // are the two provisions most load-bearing for the house hard rules —
    // pinned by content, not just by heading presence.
    await expect(page.getByText(t.licensingBody)).toBeVisible();
    await expect(page.getByText(t.nonpartisanBody)).toBeVisible();
  });

  test(`${locale}: links back to /embeds and out to the separate citizen Terms`, async ({ page }) => {
    await page.goto(`${prefix}/embeds/terms`);
    const backLink = page.getByRole('link', { name: messages.embedsTerms.backLinkText });
    await expect(backLink).toHaveAttribute('href', `${prefix || ''}/embeds`);
    const citizenLink = page.getByRole('link', { name: messages.embedsTerms.citizenTermsLinkText });
    await expect(citizenLink).toHaveAttribute('href', `${prefix || ''}/terms`);
  });
}
