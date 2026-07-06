import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * S16 — the embeds configurator + public docs page
 * (docs/ideation/2026-07-05-build-gtm-strategy.md §1.3 S16). This suite
 * covers the page's own UI behavior (widget switching, bill search, theme
 * controls, snippet/copy, a11y, discoverability). The sprint's own
 * cold-walkthrough Done criterion — the generated snippet actually working
 * on a genuine cross-origin host page — lives in
 * tests/embeds-cold-walkthrough.spec.ts instead, since that's a materially
 * different (slower, real-iframe-round-trip) kind of test.
 */

for (const [locale, prefix, messages] of [
  ['en', '', en],
  ['es', '/es', es],
] as const) {
  test(`${locale}: the embeds page renders a single h1 and the docs sections`, async ({ page }) => {
    await page.goto(`${prefix}/embeds`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(messages.embeds.title);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(
      page.getByRole('heading', { name: messages.embeds.configuratorHeading })
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: messages.embeds.docsHeading })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: messages.embeds.docsIsolationTitle })
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: messages.embeds.docsPrivacyTitle })
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: messages.embeds.docsThemingTitle })
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: messages.embeds.docsAttributionTitle })
    ).toBeVisible();
  });

  test(`${locale}: the privacy docs state the CI-tested claims`, async ({ page }) => {
    await page.goto(`${prefix}/embeds`);
    await expect(page.getByText(messages.embeds.docsPrivacyCookies)).toBeVisible();
    await expect(page.getByText(messages.embeds.docsPrivacyThirdParty)).toBeVisible();
    await expect(page.getByText(messages.embeds.docsPrivacyZip)).toBeVisible();
    await expect(page.getByText(messages.embeds.docsPrivacyTested)).toBeVisible();
  });

  test(`${locale}: no horizontal overflow on the embeds page`, async ({ page }) => {
    await page.goto(`${prefix}/embeds`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `${prefix}/embeds must not scroll horizontally`).toBeLessThanOrEqual(0);
  });
}

test.describe('configurator behavior (rep-lookup is the default, no picks required)', () => {
  test('rep-lookup is selected by default and a working snippet renders immediately', async ({
    page,
  }) => {
    await page.goto('/embeds');
    const snippet = page.locator('pre code');
    await expect(snippet).toBeVisible();
    await expect(snippet).toContainText('data-rostra-widget="rep-lookup"');
    await expect(snippet).toContainText('/embed.js');
    // No bill picker or theme controls for a widget that doesn't use them.
    await expect(page.getByRole('searchbox', { name: en.embeds.billSearchLabel })).toHaveCount(0);
    await expect(page.getByText(en.embeds.themeNote)).toBeVisible();
  });

  test('switching to bill-card reveals the bill picker and theme controls, and hides the snippet until a bill is chosen', async ({
    page,
  }) => {
    await page.goto('/embeds');
    await page.locator('input[type="radio"][value="bill-card"]').check();

    await expect(page.getByRole('searchbox', { name: en.embeds.billSearchLabel })).toBeVisible();
    await expect(page.getByLabel(en.embeds.accentLabel)).toBeVisible();
    await expect(page.getByLabel(en.embeds.radiusLabel)).toBeVisible();
    await expect(page.getByLabel(en.embeds.fontLabel)).toBeVisible();
    await expect(page.getByText(en.embeds.snippetPending)).toBeVisible();
    await expect(page.locator('pre code')).toHaveCount(0);
  });

  test('bill search filters the corpus and picking a result generates a snippet with the chosen slug + theme', async ({
    page,
  }) => {
    await page.goto('/embeds');
    await page.locator('input[type="radio"][value="bill-card"]').check();

    const search = page.getByRole('searchbox', { name: en.embeds.billSearchLabel });
    await search.fill('5582');
    const result = page.getByRole('button', { name: /Hospitals and insurers/ });
    await expect(result).toBeVisible();
    await result.click();

    await page.getByLabel(en.embeds.radiusLabel).selectOption('round');
    await page.getByLabel(en.embeds.fontLabel).selectOption('serif');

    const snippet = page.locator('pre code');
    await expect(snippet).toContainText('data-rostra-widget="bill-card"');
    await expect(snippet).toContainText('data-slug="hr-5582-119"');
    await expect(snippet).toContainText('data-radius="round"');
    await expect(snippet).toContainText('data-font="serif"');

    // The live preview reflects the exact same pick, not a stale iframe.
    const preview = page.frameLocator('iframe[title]').first();
    await expect(
      preview.getByText('Hospitals and insurers must publish real prices under HR 5582')
    ).toBeVisible();
  });

  test('the locale toggle sets data-locale in the snippet without needing a bill for rep-lookup', async ({
    page,
  }) => {
    await page.goto('/embeds');
    await page.getByRole('button', { name: en.embeds.localeEs }).click();
    await expect(page.locator('pre code')).toContainText('data-locale="es"');
  });

  test('copy snippet writes the exact snippet text to the clipboard and confirms', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __copied: string | null };
      w.__copied = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (t: string) => ((w.__copied = t), Promise.resolve()) },
      });
    });
    await page.goto('/embeds');
    const snippetText = await page.locator('pre code').textContent();
    await page.getByRole('button', { name: en.embeds.copySnippet }).click();
    await expect(page.getByRole('button', { name: en.embeds.copied })).toBeVisible();
    const copied = await page.evaluate(
      () => (window as unknown as { __copied: string | null }).__copied
    );
    expect(copied).toBe(snippetText);
  });

  test('a11y basics: radio group labeled, 44px touch targets, visible focus', async ({ page }) => {
    await page.goto('/embeds');
    const repLookupRadio = page.locator('input[type="radio"][value="rep-lookup"]');
    await expect(repLookupRadio).toBeChecked();

    const localeBtn = page.getByRole('button', { name: en.embeds.localeEn });
    const box = await localeBtn.boundingBox();
    expect(box?.height, 'locale toggle must meet the 44px touch target').toBeGreaterThanOrEqual(44);

    await localeBtn.focus();
    await expect(localeBtn).toBeFocused();
  });
});

test('footer Embeds link is reachable from a bill page, not just the homepage', async ({ page }) => {
  await page.goto('/bills/hr-1787-119');
  const link = page.locator('footer').getByRole('link', { name: en.common.footer.embeds });
  await expect(link).toHaveAttribute('href', '/embeds');
  await link.scrollIntoViewIfNeeded();
  await link.click();
  await expect(page).toHaveURL(/\/embeds$/);
});

test('footer Embeds link is reachable and clickable on mobile', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'regression guard for the mobile tab-bar overlap (mirrors the About/Citations checks)');
  await page.goto('/');
  const link = page.locator('footer').getByRole('link', { name: en.common.footer.embeds });
  await link.scrollIntoViewIfNeeded();
  await link.click();
  await expect(page).toHaveURL(/\/embeds$/);
});
