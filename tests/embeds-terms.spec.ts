import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

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

test('the governing-law section carries the literal founder placeholder, not an invented jurisdiction', async ({
  page,
}) => {
  // Flags loudly (in a test, not just a code comment) that this document is
  // AI-drafted and awaits a real founder/lawyer decision before any tenant
  // may be permitted to accept it — see this file's PR body for the same
  // flag. If this test ever fails because the placeholder is gone, the
  // right response is "a human filled in a real jurisdiction," not "delete
  // this test."
  await page.goto('/embeds/terms');
  await expect(page.getByText('[FOUNDER: fill]')).toBeVisible();
  // Same literal survives in the Spanish courtesy translation too — the
  // marker itself is deliberately left in English (see the governing-
  // language clause), not translated into a false sense of localized legal
  // completeness.
  await page.goto('/es/embeds/terms');
  await expect(page.getByText('[FOUNDER: fill]')).toBeVisible();
});
