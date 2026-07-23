import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import {
  E2E_TENANT_TOKEN,
  E2E_TENANT_TOKEN_DOMAIN_GATED,
  E2E_TENANT_TOKEN_INACTIVE,
  E2E_TENANT_TOKEN_NO_TOS,
} from './fixtures/e2e-tenant';

/*
 * S19 — action-panel embed widget (paid tier only). Drives the widget's own
 * page directly against the live server, which tests/e2e-server.mjs has
 * pointed at a tiny fake tenancy backend seeding four fixture tenants (see
 * that file + tests/fixtures/e2e-tenant.ts) — this is what makes a
 * genuinely LIVE "valid token -> the action panel actually renders" test
 * possible without real Upstash credentials, which this sandbox never has.
 *
 * A stable, always-covered bill (the same SJ.Res.99 fixture
 * tests/call-action.spec.ts already relies on) is used throughout; /api/script
 * is mocked via page.route for every test that needs a script (this widget's
 * own generate() call is otherwise indistinguishable from the citizen
 * site's — there is no live ANTHROPIC_API_KEY in this sandbox either).
 */

const SLUG = 'sjres-99-119';

async function mockScript(page: import('@playwright/test').Page) {
  await page.route('**/api/script', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        script: "Hi, I'm a constituent calling about S.J.Res. 99. MOCKED ACTION-PANEL SCRIPT. Thank you.",
        cached: false,
      }),
    })
  );
}

function panelUrl(params: Record<string, string>) {
  const q = new URLSearchParams(params).toString();
  return `/embed/action-panel?${q}`;
}

// --- refusal states ----------------------------------------------------------

test('no token: refuses with the generic unauthorized message, link to /embeds', async ({ page }) => {
  await page.goto(panelUrl({ locale: 'en', slug: SLUG }));
  await expect(page.getByText(en.embed.actionPanelUnauthorizedTitle)).toBeVisible();
  const link = page.getByRole('link', { name: new RegExp(en.embed.actionPanelUnauthorizedLink) });
  await expect(link).toHaveAttribute('href', '/embeds');
  await expect(link).toHaveAttribute('target', '_blank');
  // Never a blank/broken page, never a crash, never the citizen flow.
  await expect(page.getByRole('radio', { name: en.bill.stance.support })).toHaveCount(0);
});

test('bad/unresolvable token: SAME generic unauthorized message as no token (deliberately not distinguished)', async ({
  page,
}) => {
  await page.goto(panelUrl({ locale: 'en', slug: SLUG, token: 'totally-made-up-token-that-cannot-resolve' }));
  await expect(page.getByText(en.embed.actionPanelUnauthorizedTitle)).toBeVisible();
});

test('revoked/inactive tenant: same unauthorized message, not distinguished from a bad token', async ({ page }) => {
  await page.goto(panelUrl({ locale: 'en', slug: SLUG, token: E2E_TENANT_TOKEN_INACTIVE }));
  await expect(page.getByText(en.embed.actionPanelUnauthorizedTitle)).toBeVisible();
});

test('active tenant, no ToS on file: DISTINCT message naming hello@oravan.org', async ({ page }) => {
  await page.goto(panelUrl({ locale: 'en', slug: SLUG, token: E2E_TENANT_TOKEN_NO_TOS }));
  await expect(page.getByText(en.embed.actionPanelTosRequired)).toBeVisible();
  await expect(page.getByText(/hello@oravan\.org/)).toBeVisible();
  // Distinct from the generic unauthorized copy - not the same string.
  await expect(page.getByText(en.embed.actionPanelUnauthorizedTitle)).toHaveCount(0);
});

test('unknown bill slug with a fully-authorized token: billNotFound, not a crash', async ({ page }) => {
  await page.goto(panelUrl({ locale: 'en', slug: 'not-a-real-bill-999', token: E2E_TENANT_TOKEN }));
  await expect(page.getByText(en.embed.billNotFound)).toBeVisible();
});

test('domain-gated tenant, direct navigation (no Referer sent): Referer absent -> allow, renders Live', async ({
  page,
}) => {
  await page.goto(panelUrl({ locale: 'en', slug: SLUG, token: E2E_TENANT_TOKEN_DOMAIN_GATED }));
  await expect(page.getByRole('radio', { name: en.bill.stance.support })).toBeVisible();
});

// The genuine-cross-origin-iframe variant of this same domain-gated tenant
// (Referer present -> "domain not authorized") lives in
// tests/embed-loader.spec.ts alongside this file's other loader-injected
// iframe case - a statically-authored `<iframe>` in the host HTML makes
// page.goto() block on the NESTED iframe's own document load (real,
// spec-compliant browser behavior), which is measurably slow against a
// cold `next start` process hitting this route for the first time and
// intermittently exceeded this suite's 30s test timeout. Every other
// cross-origin test in this codebase instead injects its iframe via
// public/embed.js AFTER the host page's own load event has already fired
// (embed-loader.spec.ts's established pattern) - this test now follows
// that same convention rather than being the one exception.

// --- ES parity for the refusal states ----------------------------------------

test('ES: refusal states render in Spanish, no English leakage', async ({ page }) => {
  await page.goto(panelUrl({ locale: 'es', slug: SLUG }));
  await expect(page.getByText(es.embed.actionPanelUnauthorizedTitle)).toBeVisible();
  await expect(page.getByText(en.embed.actionPanelUnauthorizedTitle, { exact: true })).toHaveCount(0);

  await page.goto(panelUrl({ locale: 'es', slug: SLUG, token: E2E_TENANT_TOKEN_NO_TOS }));
  await expect(page.getByText(es.embed.actionPanelTosRequired)).toBeVisible();
});

// --- the live widget flow -----------------------------------------------------

test('Live: stance -> ZIP -> generate -> review (AI chip, editable) -> call, in that print order, never simultaneous', async ({
  page,
}) => {
  await mockScript(page);
  await page.goto(panelUrl({ locale: 'en', slug: SLUG, token: E2E_TENANT_TOKEN }));

  // Step 1 - stance. No script, no call affordance yet.
  const supportBtn = page.getByRole('radio', { name: en.bill.stance.support });
  await expect(supportBtn).toBeVisible();
  await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
  await supportBtn.click();
  await expect(supportBtn).toHaveAttribute('aria-checked', 'true');

  // Step 2 - ZIP (F2: never an address field in any iframe).
  await expect(page.locator('input[name="street-address"]')).toHaveCount(0);
  await page.getByLabel(en.home.zipLabel).fill('78501');
  await page.getByRole('button', { name: en.home.zipCta }).click();

  // Step 3/4 - the script arrives, editable, with the AI chip immediately
  // adjacent - never gated behind any theme param.
  const textarea = page.getByRole('textbox', { name: en.bill.scriptTitle });
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveValue(/MOCKED ACTION-PANEL SCRIPT/);
  await expect(page.getByText(en.bill.scriptDisclaimer)).toBeVisible();

  // Step 5 - call: tel: links now present, print-ORDERED after the script,
  // never simultaneously with it (no modal - this IS the review gate).
  const telLink = page.locator('a[href^="tel:"]').first();
  await expect(telLink).toBeVisible();
  const textareaBox = await textarea.boundingBox();
  const telBox = await telLink.boundingBox();
  expect(telBox!.y, 'the call affordance must render BELOW the editable script, never above/beside it').toBeGreaterThan(
    textareaBox!.y
  );

  // The pre-dial reassurance note is inline, always visible - no <dialog>.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(en.bill.preDialTitle)).toBeVisible();

  // The bill citation context is shown so a caller knows which bill this
  // is, even standing alone in an iframe - scoped to the citation eyebrow
  // specifically, since the mocked script text also happens to mention the
  // bill by name inside the (separately-asserted) textarea.
  await expect(page.locator('p.bc-citation', { hasText: 'S.J.Res. 99' })).toBeVisible();
});

test('Live: the editable textarea can actually be edited (a real review step, not a static label)', async ({
  page,
}) => {
  await mockScript(page);
  await page.goto(panelUrl({ locale: 'en', slug: SLUG, token: E2E_TENANT_TOKEN }));
  await page.getByRole('radio', { name: en.bill.stance.oppose }).click();
  await page.getByLabel(en.home.zipLabel).fill('78501');
  await page.getByRole('button', { name: en.home.zipCta }).click();
  const textarea = page.getByRole('textbox', { name: en.bill.scriptTitle });
  await expect(textarea).toBeVisible();
  await textarea.fill('A fully edited, user-written version of the script.');
  await expect(textarea).toHaveValue('A fully edited, user-written version of the script.');
});

test('Live: rate-limited generate() shows the inline rateLimited message (widget-level degraded state)', async ({
  page,
}) => {
  await page.route('**/api/script', (route) =>
    route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'rate_limited' }) })
  );
  await page.goto(panelUrl({ locale: 'en', slug: SLUG, token: E2E_TENANT_TOKEN }));
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await page.getByLabel(en.home.zipLabel).fill('78501');
  await page.getByRole('button', { name: en.home.zipCta }).click();
  await expect(page.getByText(en.bill.rateLimited)).toBeVisible();
  await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toHaveCount(0);
});

test('Live: brandless never hides the AI-disclosure chip (S14 precedent, no tier exception)', async ({ page }) => {
  await mockScript(page);
  await page.goto(panelUrl({ locale: 'en', slug: SLUG, token: E2E_TENANT_TOKEN, brandless: '1' }));
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await page.getByLabel(en.home.zipLabel).fill('78501');
  await page.getByRole('button', { name: en.home.zipCta }).click();
  await expect(page.getByText(en.bill.scriptDisclaimer)).toBeVisible();
});

test('Live: link-out to the canonical Oravan bill page for the full logged-impact experience', async ({ page }) => {
  await page.goto(panelUrl({ locale: 'en', slug: SLUG, token: E2E_TENANT_TOKEN }));
  // en.embed.actionPanelSeeImpact contains a literal "?" - build the
  // pattern from a fixed substring rather than new RegExp(fullString),
  // which would otherwise treat that "?" as a regex quantifier.
  const link = page.getByRole('link', { name: /Continue on Oravan/ });
  await expect(link).toHaveAttribute('href', new RegExp(`/bills/${SLUG}$`));
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
});

test('zero cookies on the action-panel embed response', async ({ page }) => {
  const res = await page.goto(panelUrl({ locale: 'en', slug: SLUG, token: E2E_TENANT_TOKEN }));
  expect(res?.headers()['set-cookie']).toBeUndefined();
  expect(await page.context().cookies()).toHaveLength(0);
});

test('a11y basics: labeled ZIP input, 44px stance buttons, visible focus', async ({ page }) => {
  await page.goto(panelUrl({ locale: 'en', slug: SLUG, token: E2E_TENANT_TOKEN }));
  const supportBtn = page.getByRole('radio', { name: en.bill.stance.support });
  const box = await supportBtn.boundingBox();
  expect(box?.height, 'stance button must meet the 44px touch target').toBeGreaterThanOrEqual(44);
  const zipInput = page.getByLabel(en.home.zipLabel);
  await expect(zipInput).toBeVisible();
  await zipInput.focus();
  await expect(zipInput).toBeFocused();
});

/*
 * 2026-07 critique round 2: the embed's stance picker is the same WAI-ARIA
 * radio group the citizen ActionPanel became in round 1 (#97) — a paying
 * customer's visitors get the identical screen-reader contract, never the
 * old three-independent-toggles misdescription.
 */
test('a11y: stance picker is a real radio group — roving tabindex, arrow keys select as they move', async ({
  page,
}) => {
  await mockScript(page);
  await page.goto(panelUrl({ locale: 'en', slug: SLUG, token: E2E_TENANT_TOKEN }));

  const group = page.getByRole('radiogroup', { name: en.bill.stanceQ });
  await expect(group).toBeVisible();
  await expect(group.getByRole('radio')).toHaveCount(3);

  // Roving tabindex: exactly one stop in the group before any selection.
  await expect(group.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);

  const support = page.getByRole('radio', { name: en.bill.stance.support });
  const oppose = page.getByRole('radio', { name: en.bill.stance.oppose });
  await support.click();
  await expect(support).toHaveAttribute('aria-checked', 'true');

  // Arrow keys move focus AND select, same as clicking (WAI-ARIA radio pattern).
  await support.focus();
  await page.keyboard.press('ArrowRight');
  await expect(oppose).toBeFocused();
  await expect(oppose).toHaveAttribute('aria-checked', 'true');
  await expect(support).toHaveAttribute('aria-checked', 'false');
});

/*
 * S20 (F6): the action panel's own impression count (after(() =>
 * noteImpression(access.tenant.tenantId)) on the fully-authorized branch)
 * must never affect this page's own rendering, whether the counters
 * database is configured or not - the whole point of scheduling it via
 * after(). tests/e2e-server.mjs deliberately keeps the counters database
 * UNCONFIGURED for this whole suite (its own header comment), so this
 * live-render test already exercises exactly that condition; the
 * genuinely-erroring-vs-unconfigured distinction in the WRITE ITSELF is
 * pinned separately at the unit level (tests/impressions.unit.spec.ts's
 * MockUpstash.failWithNetworkError case) - see
 * tests/embed-rep-lookup.spec.ts's matching S20 block for the full
 * disclosure of why this e2e bootstrap isn't extended to fake an
 * erroring counters backend too.
 */
test('S20: a fully-authorized live render is unaffected by the (unconfigured) counters database — same status, same content as every other live-render test above', async ({
  page,
}) => {
  await mockScript(page);
  const res = await page.goto(panelUrl({ locale: 'en', slug: SLUG, token: E2E_TENANT_TOKEN }));
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('radio', { name: en.bill.stance.support })).toBeVisible();
  await expect(page.locator('a[href^="tel:"]')).toHaveCount(0); // pre-stance, same as the very first live test above
});
