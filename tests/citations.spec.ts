import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { callTool } from './helpers';

/*
 * S23 — the citability/correction page (the project records §1.3 S23). Covers the sprint's own done-criteria: the page
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

/*
 * 2026-08-06 — the claim-truth pass. citations.aiBody is the page's fullest
 * statement of HOW a decode comes to be published, and until now nothing
 * pinned a word of it. It shipped a false gate ("no advocacy language" /
 * "sin lenguaje de campaña" — that lint runs on Big Questions, never on the
 * decode path) for as long as anyone had been reading it.
 *
 * These pin the corrected copy in both languages, in the JSON *and* on the
 * rendered page — a JSON-only assertion would still pass if the paragraph
 * stopped rendering — and they guard the carve-out next door from being
 * collaterally deleted by the next person cleaning up review language.
 */
test.describe('AI-provenance copy on /citations says what actually runs', () => {
  test('aiBody names the real gates and no longer names an advocacy gate, both locales', () => {
    for (const [lang, body] of [
      ['en', en.citations.aiBody],
      ['es', es.citations.aiBody],
    ] as const) {
      // The retired review claim, in either language, must be gone.
      expect(body, `${lang}: no human-review claim on the decode path`).not.toMatch(
        /human[\s-]?review|revisad[oa] por una persona|revisión humana/i
      );
      // The lint that never ran on decodes must not be listed as a gate.
      expect(body, `${lang}: advocacy is not one of the decode gates`).not.toMatch(
        /no advocacy language|sin lenguaje de campaña/i
      );
      // 2026-08-06, second pass. The copy used to name the schema gate as
      // one "that fails the whole sync rather than ship a partial record".
      // The promise was true — the bill is simply not added — but the
      // mechanism was not: scripts/bill-decode.mjs throws 'bad decode
      // shape' per bill, scripts/sync-bills.mjs catches it and drops that
      // bill, and only a mostly-failed run exits 1. The one check that
      // fails the whole sync is scripts/verify-sync.mjs, and it runs on the
      // corpus before the commit, not on a single decode.
      expect(body, `${lang}: the schema check does not fail the whole sync on one bad decode`).not.toMatch(
        /fails the whole sync|hace fallar toda la sincronización/i
      );
    }

    // The three gates that ARE real, named in both languages.
    expect(en.citations.aiBody).toContain('both languages present');
    expect(en.citations.aiBody).toContain('the official record attached');
    expect(en.citations.aiBody).toContain('automated gates pass');
    expect(es.citations.aiBody).toContain('los dos idiomas presentes');
    expect(es.citations.aiBody).toContain('el registro oficial adjunto');
    expect(es.citations.aiBody).toContain('controles automáticos');

    // And the replacement sentence: where the nonpartisan constraint really
    // lives — a drafting instruction on decodes, an enforced check on Big
    // Questions. Dropping the false claim without saying this would leave
    // the page quieter but no more honest.
    expect(en.citations.aiBody).toMatch(/drafting instruction to the model/i);
    expect(en.citations.aiBody).toMatch(/Big Questions/);
    expect(es.citations.aiBody).toMatch(/instrucción de redacción al modelo/i);
    expect(es.citations.aiBody).toMatch(/Grandes preguntas/);
  });

  test('the call-script carve-out survived the cleanup — it is TRUE and must not be collaterally deleted', () => {
    // A caller really does read and can edit the script before dialing, and
    // the MCP server really does refuse to generate one so an agent cannot
    // skip that. This is the one review claim the product is entitled to.
    expect(en.citations.aiCallScript).toMatch(/read and can edit the script before placing a call/i);
    expect(en.citations.aiCallScript).toMatch(/never generates one/i);
    expect(es.citations.aiCallScript).toMatch(/leer y puede editar el guion antes de marcar/i);
    expect(es.citations.aiCallScript).toMatch(/nunca genera uno/i);
  });

  for (const [locale, prefix, messages] of [
    ['en', '', en],
    ['es', '/es', es],
  ] as const) {
    test(`${locale}: the corrected aiBody and the call-script carve-out both RENDER on the page`, async ({
      page,
    }) => {
      await page.goto(`${prefix}/citations`);
      // Whole-paragraph exact text: pinning the JSON alone would still pass
      // if the <p> were dropped from the page, which is the failure mode a
      // trust page can least afford.
      await expect(page.getByText(messages.citations.aiBody)).toBeVisible();
      await expect(page.getByText(messages.citations.aiCallScript)).toBeVisible();
    });
  }
});
