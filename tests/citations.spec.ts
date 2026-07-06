import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { callTool } from './helpers';

/*
 * S23 — the citability/correction page (docs/ideation/2026-07-05-build-gtm-
 * strategy.md §1.3 S23). Covers the sprint's own done-criteria: the page
 * renders in both locales, the footer link is present on bill pages (not
 * just the homepage), and the correction path resolves to the existing
 * feedback intake rather than a parallel one.
 */

for (const [locale, prefix, messages] of [
  ['en', '', en],
  ['es', '/es', es],
] as const) {
  test(`${locale}: Citations page renders a single h1 and every section`, async ({ page }) => {
    await page.goto(`${prefix}/citations`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(messages.citations.title);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: messages.citations.urlTitle })).toBeVisible();
    await expect(page.getByRole('heading', { name: messages.citations.asOfTitle })).toBeVisible();
    await expect(page.getByRole('heading', { name: messages.citations.sourceTitle })).toBeVisible();
    await expect(page.getByRole('heading', { name: messages.citations.aiTitle })).toBeVisible();
    await expect(page.getByRole('heading', { name: messages.citations.licenseTitle })).toBeVisible();
    await expect(page.getByRole('heading', { name: messages.citations.correctionTitle })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: messages.citations.whenConfirmedTitle })
    ).toBeVisible();
  });

  test(`${locale}: canonical example URL uses the live example bill`, async ({ page }) => {
    await page.goto(`${prefix}/citations`);
    await expect(page.getByText(`/bills/hr-1787-119`)).toBeVisible();
  });

  test(`${locale}: no horizontal overflow on the Citations page`, async ({ page }) => {
    await page.goto(`${prefix}/citations`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `${prefix}/citations must not scroll horizontally`).toBeLessThanOrEqual(0);
  });
}

test('footer Citations link is reachable from a bill page, not just the homepage', async ({ page }) => {
  await page.goto('/bills/hr-1787-119');
  const link = page.locator('footer').getByRole('link', { name: en.common.footer.citations });
  await expect(link).toHaveAttribute('href', '/citations');
  await link.scrollIntoViewIfNeeded();
  await link.click();
  await expect(page).toHaveURL(/\/citations$/);
});

test('footer Citations link is reachable and clickable on mobile', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'regression guard for the mobile tab-bar overlap (mirrors the About/Privacy checks)');
  await page.goto('/');
  const link = page.locator('footer').getByRole('link', { name: en.common.footer.citations });
  await link.scrollIntoViewIfNeeded();
  await link.click();
  await expect(page).toHaveURL(/\/citations$/);
});

test('the correction-path link resolves to the existing feedback intake, not a parallel form', async ({
  page,
}) => {
  await page.goto('/citations');
  const reportLink = page.getByRole('link', { name: en.citations.correctionLinkText });
  await expect(reportLink).toHaveAttribute('href', '#feedback');
  await reportLink.click();
  // #feedback lands on the Footer's own FeedbackDialog trigger - one
  // beta-feedback intake for the whole site, reused here rather than
  // duplicated (components/Footer.tsx).
  await expect(page).toHaveURL(/#feedback$/);
  const feedbackButton = page.locator('footer #feedback').getByRole('button', { name: en.feedback.trigger });
  await expect(feedbackButton).toBeInViewport();
});

test("the page quotes the live MCP envelope's localized source/ai_label text verbatim, per locale, on both locale routes", async ({
  page,
  request,
}) => {
  // Fetched from the live route rather than imported from lib/core/mcp.ts
  // directly (that module pulls in lib/freshness.ts's 'server-only' guard,
  // which only resolves inside Next's own bundler - not in Playwright's
  // plain Node test runner). This is also the more honest check: it proves
  // the /citations copy matches what an agent actually receives right now,
  // not a compile-time copy of the same constant.
  const resultEn = await callTool(request, 'get_bill', { slug: 'hr-1787-119', locale: 'en' });
  const resultEs = await callTool(request, 'get_bill', { slug: 'hr-1787-119', locale: 'es' });
  const metaEn = resultEn.structuredContent!.meta as { source: string; ai_label: string };
  const metaEs = resultEs.structuredContent!.meta as { source: string; ai_label: string };
  expect(metaEn.source).toBeTruthy();
  expect(metaEn.ai_label).toBeTruthy();
  expect(metaEs.source).toBeTruthy();
  expect(metaEs.ai_label).toBeTruthy();
  // The gap PR #46 pinned, now closed: an ES-locale query gets ES prose, not
  // the same English text an EN-locale query gets.
  expect(metaEs.source).not.toBe(metaEn.source);
  expect(metaEs.ai_label).not.toBe(metaEn.ai_label);

  for (const prefix of ['', '/es']) {
    await page.goto(`${prefix}/citations`);
    // Bilingual trust page: both the EN-locale and ES-locale envelope text
    // are shown on either locale route, so a reporter reading in either
    // language can verify what BOTH locales' MCP queries actually receive.
    await expect(page.getByText(metaEn.source)).toBeVisible();
    await expect(page.getByText(metaEs.source)).toBeVisible();
    await expect(page.getByText(metaEn.ai_label)).toBeVisible();
    await expect(page.getByText(metaEs.ai_label)).toBeVisible();
  }
});
