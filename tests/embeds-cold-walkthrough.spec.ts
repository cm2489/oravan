import { expect, test, type Page } from '@playwright/test';
import en from '../messages/en.json';
import { startCrossOriginHost } from './helpers';

/*
 * S16's own Done criterion (docs/ideation/2026-07-05-build-gtm-strategy.md
 * §1.3 S16: "a cold walkthrough (no prior context) succeeds using only
 * public docs"). This is that walkthrough, automated: read the ACTUAL
 * snippet the public configurator (/embeds) renders — not a hand-typed
 * approximation of it — and paste it into a genuine cross-origin host page
 * (tests/helpers.ts's startCrossOriginHost, the same real-HTTP-origin
 * fixture tests/embed-loader.spec.ts and tests/frame-posture.spec.ts use),
 * then prove the widget actually loads and functions there. Both widget
 * types, per the sprint's own scope.
 *
 * One necessary substitution: the configurator's snippet embeds the real
 * production origin (lib/site.ts's SITE_ORIGIN constant - the same literal
 * tests/hreflang.spec.ts and tests/sitemap.spec.ts already assert against
 * as plain text, for the same reason). That's correct for a real recipient,
 * but this suite runs against the build under test on its own local port
 * (playwright.config.ts's PW_PORT), not the public internet - pointing a
 * test browser at the real production deployment would exercise a different,
 * possibly stale build and require network egress this suite doesn't
 * otherwise need. So: assert the snippet's real shape (the production
 * origin + exact data-attributes) verbatim first, then swap ONLY the
 * origin substring for this run's own baseURL before handing the snippet to
 * a cross-origin host page - the contract under test is unchanged, only the
 * network endpoint is redirected to the code actually being verified.
 */

const SITE_ORIGIN = 'https://cabina-nine.vercel.app'; // lib/site.ts's SITE_ORIGIN - see file header comment above

const DECODED_SLUG = 'hr-5582-119';

test.describe.configure({ timeout: 60_000 });

async function readSnippet(page: Page): Promise<string> {
  const text = await page.locator('pre code').textContent();
  if (!text) throw new Error('configurator did not render a snippet');
  return text;
}

test('cold walkthrough (rep-lookup): the configurator default snippet loads and looks up reps on a genuine cross-origin host', async ({
  page,
  baseURL,
}) => {
  await page.goto('/embeds');
  // rep-lookup is the default selected widget - a genuinely cold visitor
  // gets a working snippet with zero picks required.
  const snippet = await readSnippet(page);
  expect(snippet).toContain(`${SITE_ORIGIN}/embed.js`);
  expect(snippet).toContain('data-rostra-widget="rep-lookup"');
  expect(snippet).toContain('data-locale="en"');

  const hostSnippet = snippet.replaceAll(SITE_ORIGIN, baseURL!);
  const host = await startCrossOriginHost(`<!doctype html><html><body>${hostSnippet}</body></html>`);
  try {
    await page.goto(host.url);
    const frame = page.frameLocator('iframe[data-rostra-embed="rep-lookup"]');
    await expect(frame.getByText(en.embed.frameTitle)).toBeVisible();

    await frame.getByLabel(en.home.zipLabel).fill('78501');
    await frame.getByRole('button', { name: en.home.zipCta }).click();
    await expect(frame.getByText('Monica De La Cruz')).toBeVisible();
  } finally {
    await host.close();
  }
});

test('cold walkthrough (bill-card): a configured snippet (chosen bill + theme) loads and renders the decode on a genuine cross-origin host', async ({
  page,
  baseURL,
}) => {
  await page.goto('/embeds');
  await page.locator('input[type="radio"][value="bill-card"]').check();
  await page.getByRole('searchbox', { name: en.embeds.billSearchLabel }).fill('5582');
  await page.getByRole('button', { name: /Hospitals and insurers/ }).click();
  await page.getByLabel(en.embeds.radiusLabel).selectOption('round');
  await page.getByLabel(en.embeds.fontLabel).selectOption('serif');

  const snippet = await readSnippet(page);
  expect(snippet).toContain(`${SITE_ORIGIN}/embed.js`);
  expect(snippet).toContain('data-rostra-widget="bill-card"');
  expect(snippet).toContain(`data-slug="${DECODED_SLUG}"`);
  expect(snippet).toContain('data-radius="round"');
  expect(snippet).toContain('data-font="serif"');

  const hostSnippet = snippet.replaceAll(SITE_ORIGIN, baseURL!);
  const host = await startCrossOriginHost(`<!doctype html><html><body>${hostSnippet}</body></html>`);
  try {
    await page.goto(host.url);
    const frame = page.frameLocator('iframe[data-rostra-embed="bill-card"]');
    await expect(
      frame.getByText('Hospitals and insurers must publish real prices under HR 5582')
    ).toBeVisible();
    await expect(frame.getByText(en.og.aiDecoded, { exact: true })).toBeVisible();
    // The chosen theme actually reached the rendered widget, not just the
    // snippet text - same computed-style assertion tests/embed-bill-card.spec.ts
    // uses for the widget page directly.
    const root = frame.locator('.bc-root');
    await expect
      .poll(() => root.evaluate((el) => getComputedStyle(el).getPropertyValue('--rostra-radius').trim()))
      .toBe('20px'); // RADIUS_VALUES.round, lib/embed-theme.ts
  } finally {
    await host.close();
  }
});
