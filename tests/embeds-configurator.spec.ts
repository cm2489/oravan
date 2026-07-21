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
    await expect(snippet).toContainText('data-oravan-widget="rep-lookup"');
    await expect(snippet).toContainText('/embed.js');
    // No bill picker for a widget that doesn't use one — but theme controls
    // now apply to both widgets (S5a closed the rep-lookup theming gap),
    // and the white-label toggle is always offered.
    await expect(page.getByRole('searchbox', { name: en.embeds.billSearchLabel })).toHaveCount(0);
    await expect(page.getByLabel(en.embeds.accentLabel)).toBeVisible();
    await expect(page.getByText(en.embeds.whiteLabelLegend)).toBeVisible();
    await expect(snippet).toContainText('data-accent=');
  });

  test('brandless toggle adds data-brandless to the snippet and keeps attribution language honest', async ({
    page,
  }) => {
    await page.goto('/embeds');
    await page.getByLabel(en.embeds.whiteLabelBrandless).check();
    const snippet = page.locator('pre code');
    await expect(snippet).toContainText('data-brandless="1"');
    // The configurator never offers attribution removal - license-only,
    // documented in the docs section below the fold.
    await expect(snippet).not.toContainText('data-attribution');
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
    await expect(snippet).toContainText('data-oravan-widget="bill-card"');
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

/*
 * Brand-preview build — the widened theme controls: color mode, the two new
 * font stacks, and the custom surface/ink pair gated by the same lib/contrast
 * math the server enforces (warn + omit on a failing pair, so the snippet can
 * never carry values the server would discard).
 */
test.describe('widened theme controls (mode, new fonts, custom surface/ink pair)', () => {
  // React controlled color inputs need the native value setter + a bubbling
  // input event; locator.fill() doesn't support type="color".
  async function setColor(page: import('@playwright/test').Page, id: string, value: string) {
    await page.locator(`#${id}`).evaluate((el, v) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  }

  test('mode select emits data-mode only when forced', async ({ page }) => {
    await page.goto('/embeds');
    const snippet = page.locator('pre code');
    await expect(snippet).not.toContainText('data-mode');
    await page.getByLabel(en.embeds.modeLabel).selectOption('dark');
    await expect(snippet).toContainText('data-mode="dark"');
    await page.getByLabel(en.embeds.modeLabel).selectOption('auto');
    await expect(snippet).not.toContainText('data-mode');
  });

  test('the two new font stacks are selectable and land in the snippet', async ({ page }) => {
    await page.goto('/embeds');
    const fontSelect = page.getByLabel(en.embeds.fontLabel);
    await expect(fontSelect.locator('option')).toHaveCount(4);
    await fontSelect.selectOption('humanist');
    await expect(page.locator('pre code')).toContainText('data-font="humanist"');
    await fontSelect.selectOption('geometric');
    await expect(page.locator('pre code')).toContainText('data-font="geometric"');
  });

  test('custom colors: hidden by default, defaults pass contrast, snippet carries the pair', async ({
    page,
  }) => {
    await page.goto('/embeds');
    await expect(page.locator('#oravan-surface')).toHaveCount(0);
    await expect(page.locator('pre code')).not.toContainText('data-surface');

    await page.getByLabel(en.embeds.customColorsToggle).check();
    await expect(page.getByLabel(en.embeds.surfaceLabel, { exact: true })).toBeVisible();
    await expect(page.getByLabel(en.embeds.inkLabel, { exact: true })).toBeVisible();
    // The prefilled defaults are the brand pair — they pass AA, no warning.
    await expect(page.getByText(en.embeds.contrastWarning)).toHaveCount(0);
    await expect(page.locator('pre code')).toContainText('data-surface="#f3ecdd"');
    await expect(page.locator('pre code')).toContainText('data-ink="#2a2318"');
  });

  test('a failing pair warns AND is omitted from snippet + preview', async ({ page }) => {
    await page.goto('/embeds');
    await page.getByLabel(en.embeds.customColorsToggle).check();
    await setColor(page, 'oravan-ink', '#dddddd'); // ~1.2:1 against the default cream
    await expect(page.getByText(en.embeds.contrastWarning)).toBeVisible();
    await expect(page.locator('pre code')).not.toContainText('data-surface');
    await expect(page.locator('pre code')).not.toContainText('data-ink');
    const previewSrc = await page.locator('iframe[title]').first().getAttribute('src');
    expect(previewSrc).not.toContain('surface=');
    expect(previewSrc).not.toContain('ink=');
    // Repairing the pair clears the warning and restores the knobs.
    await setColor(page, 'oravan-ink', '#111111');
    await expect(page.getByText(en.embeds.contrastWarning)).toHaveCount(0);
    await expect(page.locator('pre code')).toContainText('data-ink="#111111"');
  });

  test('a valid custom pair + forced mode reach the live preview iframe', async ({ page }) => {
    await page.goto('/embeds');
    await page.getByLabel(en.embeds.customColorsToggle).check();
    await setColor(page, 'oravan-surface', '#0f1a2b');
    await setColor(page, 'oravan-ink', '#f5f7fa');
    await page.getByLabel(en.embeds.modeLabel).selectOption('dark');
    const previewSrc = await page.locator('iframe[title]').first().getAttribute('src');
    expect(previewSrc).toContain('surface=%230f1a2b');
    expect(previewSrc).toContain('ink=%23f5f7fa');
    expect(previewSrc).toContain('mode=dark');
  });

  test('ES locale renders the new control labels', async ({ page }) => {
    await page.goto('/es/embeds');
    await expect(page.getByLabel(es.embeds.modeLabel)).toBeVisible();
    await expect(page.getByLabel(es.embeds.fontLabel)).toBeVisible();
    await expect(page.getByText(es.embeds.customColorsToggle)).toBeVisible();
  });

  test('new controls meet the 44px touch-target bar', async ({ page }) => {
    await page.goto('/embeds');
    // Native <select> ignores min-height in WebKit (the pre-existing radius/
    // font selects render identically) — the mode select matches that shipped
    // pattern, so the bounding-box assertion covers the controls that DO
    // honor sizing: the checkbox row and the color inputs.
    const toggleBox = await page
      .locator('label', { hasText: en.embeds.customColorsToggle })
      .boundingBox();
    expect(toggleBox!.height).toBeGreaterThanOrEqual(44);
    await page.getByLabel(en.embeds.customColorsToggle).check();
    const surfaceBox = await page.locator('#oravan-surface').boundingBox();
    expect(surfaceBox!.height).toBeGreaterThanOrEqual(43); // h-11 = 44px, allow subpixel
  });
});

/*
 * "Match your site" (brand-preview build) — the client flow with /api/brand
 * mocked via page.route(): autofill, the adjusted-colors honesty note, the
 * mock site strip, and the error-string taxonomy. The route's own behavior
 * (guard, limits, taxonomy) is pinned server-side in embed-brand-route.spec.
 */
test.describe('match your site (mocked /api/brand)', () => {
  const THEME_RESPONSE = {
    theme: {
      surface: '#0f1a2b',
      ink: '#f5f7fa',
      accent: '#2ea043',
      radius: 'sharp',
      font: 'geometric',
      mode: 'dark',
    },
    site: { name: 'Nightowl Analytics', logoUrl: 'https://nightowl.example/logo.png' },
    adjusted: true,
  };

  // Submit the match URL, robust against the click-before-hydration race:
  // a click that lands on the server-rendered button before React attaches
  // its handler fires no fetch and leaves no replayable DOM effect, so we
  // retry fill+click until the /api/brand request actually goes out. Takes
  // the locale's messages so the ES flow reuses the same guard.
  async function submitUrl(
    page: import('@playwright/test').Page,
    messages: typeof en | typeof es = en
  ) {
    const button = page.getByRole('button', { name: messages.embeds.matchSiteCta });
    await expect(async () => {
      await page.getByLabel(messages.embeds.matchSiteUrlLabel).fill('https://nightowl.example');
      const request = page.waitForRequest('**/api/brand', { timeout: 1500 });
      await button.click();
      await request; // rejects if the click was lost → expect.toPass re-issues it
    }).toPass({ timeout: 10000 });
  }

  test('a successful match autofills every theme control and the snippet', async ({ page }) => {
    await page.route('**/api/brand', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(THEME_RESPONSE) })
    );
    await page.goto('/embeds');
    await submitUrl(page);

    const snippet = page.locator('pre code');
    await expect(snippet).toContainText('data-accent="#2ea043"');
    await expect(snippet).toContainText('data-surface="#0f1a2b"');
    await expect(snippet).toContainText('data-ink="#f5f7fa"');
    await expect(snippet).toContainText('data-mode="dark"');
    await expect(snippet).toContainText('data-radius="sharp"');
    await expect(snippet).toContainText('data-font="geometric"');
    await expect(page.getByLabel(en.embeds.modeLabel)).toHaveValue('dark');
    await expect(page.getByLabel(en.embeds.customColorsToggle)).toBeChecked();
    // The adjusted-colors honesty note.
    await expect(page.getByText(en.embeds.matchSiteAdjustedNote)).toBeVisible();
    // The host-page mockup masthead carries the matched site name + the
    // "simulated preview" label.
    await expect(page.getByText('Nightowl Analytics')).toBeVisible();
    await expect(page.getByText(en.embeds.mockupSimulated)).toBeVisible();
  });

  test('manual edits after autofill still work (plain state, no locking)', async ({ page }) => {
    await page.route('**/api/brand', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(THEME_RESPONSE) })
    );
    await page.goto('/embeds');
    await submitUrl(page);
    await page.getByLabel(en.embeds.radiusLabel).selectOption('round');
    await expect(page.locator('pre code')).toContainText('data-radius="round"');
    await expect(page.locator('pre code')).toContainText('data-surface="#0f1a2b"'); // rest intact
  });

  test('the error taxonomy maps to the four bilingual strings', async ({ page }) => {
    const cases: Array<[number, string, string]> = [
      [400, 'bad_request', en.embeds.matchSiteErrorInvalid],
      [429, 'rate_limited', en.embeds.matchSiteErrorRateLimited],
      [502, 'unavailable', en.embeds.matchSiteErrorUnavailable],
      [502, 'generation_failed', en.embeds.matchSiteErrorFailed],
    ];
    for (const [status, error, message] of cases) {
      await page.route('**/api/brand', (route) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error }) })
      );
      await page.goto('/embeds');
      await submitUrl(page);
      await expect(page.getByText(message)).toBeVisible();
      await page.unroute('**/api/brand');
    }
  });

  test('ES locale: heading, privacy line, and an error string render in Spanish', async ({
    page,
  }) => {
    await page.route('**/api/brand', (route) =>
      route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) })
    );
    await page.goto('/es/embeds');
    await expect(page.getByText(es.embeds.matchSiteHeading)).toBeVisible();
    await expect(page.getByText(es.embeds.matchSitePrivacy)).toBeVisible();
    await submitUrl(page, es);
    await expect(page.getByText(es.embeds.matchSiteErrorUnavailable)).toBeVisible();
  });

  test('match controls meet the 44px bar and the URL input is labeled', async ({ page }) => {
    await page.goto('/embeds');
    const input = page.getByLabel(en.embeds.matchSiteUrlLabel);
    await expect(input).toBeVisible();
    const inputBox = await input.boundingBox();
    expect(inputBox!.height).toBeGreaterThanOrEqual(44);
    const buttonBox = await page.getByRole('button', { name: en.embeds.matchSiteCta }).boundingBox();
    expect(buttonBox!.height).toBeGreaterThanOrEqual(44);
  });
});

/*
 * The host-page mockup preview (brand-preview build): the live preview is
 * always a themed fake host page (newsroom / library / advocacy / generic)
 * with the widget embedded, switchable via a radiogroup. Painted in the
 * current effective colors; after a match, in the tenant's exact palette.
 */
test.describe('host-page mockup preview', () => {
  test('the archetype switcher renders all four contexts and swaps content', async ({ page }) => {
    await page.goto('/embeds');
    const group = page.getByRole('radiogroup', { name: en.embeds.mockupLegend });
    await expect(group).toBeVisible();
    for (const label of [
      en.embeds.mockupGeneric,
      en.embeds.mockupNewsroom,
      en.embeds.mockupLibrary,
      en.embeds.mockupAdvocacy,
    ]) {
      await expect(group.getByRole('radio', { name: label })).toBeVisible();
    }
    // Default is newsroom → its headline shows; switching to advocacy swaps it.
    await expect(page.getByText(en.embeds.mockupNewsHeadline)).toBeVisible();
    await group.getByRole('radio', { name: en.embeds.mockupAdvocacy }).click();
    await expect(page.getByRole('heading', { name: en.embeds.mockupAdvocacyHeading })).toBeVisible();
    await expect(page.getByText(en.embeds.mockupNewsHeadline)).toHaveCount(0);
  });

  test('the widget iframe renders inside the mockup, still themed by the controls', async ({
    page,
  }) => {
    await page.goto('/embeds');
    // The preview iframe lives inside the mockup region and shows the real widget.
    const frame = page.frameLocator('iframe[title]').first();
    await expect(frame.getByText(en.embed.frameTitle)).toBeVisible();
  });

  test('ES: the mockup switcher and newsroom content render in Spanish', async ({ page }) => {
    await page.goto('/es/embeds');
    await expect(
      page.getByRole('radiogroup', { name: es.embeds.mockupLegend })
    ).toBeVisible();
    await expect(page.getByText(es.embeds.mockupNewsHeadline)).toBeVisible();
  });
});
