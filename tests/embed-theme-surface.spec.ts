import { expect, test } from '@playwright/test';
import { FONT_VALUES, MODE_DEFAULTS } from '../lib/embed-theme';

/*
 * Brand-preview build — the widened theming surface, driven against the
 * real server the way tests/embed-rep-lookup-theme.spec.ts drives the
 * original three knobs. Theme vars now land at :root via one validated
 * <style> tag (components/embed/EmbedThemeStyle.tsx), so assertions read
 * them from documentElement/body computed style; custom properties inherit,
 * so the original .re-root readings elsewhere keep working untouched.
 */

const DECODED_SLUG = 'hr-5582-119';

function readVar(name: string) {
  return (el: Element, n: string) => getComputedStyle(el).getPropertyValue(n).trim();
}

test('a valid surface/ink pair re-keys the whole document, band below content included', async ({
  page,
}) => {
  await page.goto('/embed/rep-lookup?locale=en&surface=%230f1a2b&ink=%23f5f7fa');
  const html = page.locator('html');
  await expect.poll(() => html.evaluate(readVar('--oravan-surface'), '--oravan-surface')).toBe('#0f1a2b');
  await expect.poll(() => html.evaluate(readVar('--oravan-ink'), '--oravan-ink')).toBe('#f5f7fa');
  // The BODY background is the pair's surface — that's the band a fixed-height
  // iframe shows below short content, the thing inline vars on <main> could
  // never recolor.
  const bodyBg = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bodyBg).toBe('rgb(15, 26, 43)');
  const bodyColor = await page.locator('body').evaluate((el) => getComputedStyle(el).color);
  expect(bodyColor).toBe('rgb(245, 247, 250)');
});

test('a pair below AA contrast is discarded as a pair (default background survives)', async ({
  page,
}) => {
  await page.goto('/embed/rep-lookup?locale=en&surface=%23888888&ink=%23999999');
  const html = page.locator('html');
  await expect.poll(() => html.evaluate(readVar('--oravan-surface'), '--oravan-surface')).toBe('');
  await expect.poll(() => html.evaluate(readVar('--oravan-ink'), '--oravan-ink')).toBe('');
});

test('a lone ink (no surface) is discarded — pair-or-nothing', async ({ page }) => {
  await page.goto('/embed/rep-lookup?locale=en&ink=%23000000');
  const html = page.locator('html');
  await expect.poll(() => html.evaluate(readVar('--oravan-ink'), '--oravan-ink')).toBe('');
});

test('mode=dark forces the dark default palette on a light-preference visitor', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/embed/bill-card?locale=en&slug=' + DECODED_SLUG + '&mode=dark');
  const html = page.locator('html');
  await expect
    .poll(() => html.evaluate(readVar('--oravan-surface'), '--oravan-surface'))
    .toBe(MODE_DEFAULTS.dark.surface);
  const scheme = await html.evaluate((el) => getComputedStyle(el).colorScheme);
  expect(scheme).toBe('dark');
  const bodyBg = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bodyBg).toBe('rgb(27, 22, 17)'); // #1b1611
});

test('mode=light forces the light palette on a dark-preference visitor', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/embed/rep-lookup?locale=en&mode=light');
  const bodyBg = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bodyBg).toBe('rgb(243, 236, 221)'); // #f3ecdd
});

test('junk mode falls back to auto (visitor preference rules)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/embed/rep-lookup?locale=en&mode=midnight');
  const bodyBg = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bodyBg).toBe('rgb(27, 22, 17)'); // dark default via media query
});

test('the two new font stacks land as computed --oravan-font', async ({ page }) => {
  for (const key of ['humanist', 'geometric'] as const) {
    await page.goto(`/embed/rep-lookup?locale=en&font=${key}`);
    const html = page.locator('html');
    await expect.poll(() => html.evaluate(readVar('--oravan-font'), '--oravan-font')).toBe(
      FONT_VALUES[key]
    );
  }
});

test('a themed widget shows no Oravan-palette leak: note box re-tints, toggle text is the tenant color', async ({
  page,
}) => {
  // The NYT-shaped case Colby flagged: black accent, white surface, near-black
  // ink. The note box must NOT be Oravan amber, and the pressed toggle text
  // must be the tenant's white, not Oravan's #fbf8f0.
  await page.goto(
    '/embed/rep-lookup?locale=en&accent=%23000000&surface=%23ffffff&ink=%23121212&mode=light'
  );
  const note = page.locator('.re-note');
  await expect(note).toBeVisible();
  const noteBorder = await note.evaluate((el) => getComputedStyle(el).borderTopColor);
  // Oravan amber is rgb(232, 163, 23); a themed box must not be that hue.
  expect(noteBorder).not.toContain('232, 163, 23');

  const toggleText = await page
    .locator('.re-toggle[aria-pressed="true"]')
    .evaluate((el) => getComputedStyle(el).color);
  // #fbf8f0 (Oravan paper) is rgb(251, 248, 240); tenant white is rgb(255,255,255).
  expect(toggleText).toBe('rgb(255, 255, 255)');
});

test('accent-only theme keeps a visible focus ring (falls back to ink, not the raw accent)', async ({
  page,
}) => {
  // A dark-navy accent on the light default surface: the focus ring must not
  // become the near-invisible accent. --oravan-focus is only emitted when the
  // accent is confirmed to contrast, so accent-only must fall back to ink.
  await page.goto('/embed/rep-lookup?locale=en&accent=%2318203a');
  const html = page.locator('html');
  const focus = await html.evaluate((el) => getComputedStyle(el).getPropertyValue('--_focus').trim());
  const ink = await html.evaluate((el) => getComputedStyle(el).getPropertyValue('--_ink').trim());
  const accent = await html.evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--_accent').trim()
  );
  // Focus resolves to ink (visible on the surface), not the supplied accent.
  expect(focus).toBe(ink);
  expect(focus).not.toBe(accent);
});

test('the UN-themed default widget keeps its amber note box (Oravan default look preserved)', async ({
  page,
}) => {
  await page.goto('/embed/rep-lookup?locale=en');
  const noteBorder = await page
    .locator('.re-note')
    .evaluate((el) => getComputedStyle(el).borderTopColor);
  // No theme applied → the amber fallback stands: rgb(232, 163, 23) at 0.55 alpha.
  expect(noteBorder).toContain('232, 163, 23');
});

test('accent alone also derives --oravan-accent-ink and the chip renders with it', async ({
  page,
}) => {
  // A pale accent whose readable text color is the dark ink, not the default
  // near-white — proves the derivation is computed, not hardcoded.
  await page.goto('/embed/bill-card?locale=en&slug=' + DECODED_SLUG + '&accent=%23ffe680');
  const html = page.locator('html');
  await expect
    .poll(() => html.evaluate(readVar('--oravan-accent-ink'), '--oravan-accent-ink'))
    .toBe('#1b1611');
  const chipColor = await page
    .locator('.bc-chip-ai')
    .evaluate((el) => getComputedStyle(el).color);
  expect(chipColor).toBe('rgb(27, 22, 17)');
});

test('injection through the new knobs never reaches the document', async ({ page }) => {
  const hostile = encodeURIComponent('#fff"}body{display:none}</style><script>window.__pwned9=1</script>');
  await page.goto(
    `/embed/rep-lookup?locale=en&surface=${hostile}&ink=${hostile}&mode=${hostile}`
  );
  await expect(page.locator('.re-root')).toBeVisible();
  const pwned = await page.evaluate(() => (window as { __pwned9?: number }).__pwned9);
  expect(pwned).toBeUndefined();
  // The payload must never reach a STYLE surface. (page.content() would also
  // match Next's RSC flight payload, which legitimately echoes searchParams
  // as inert, escaped string data — that's not a style/script surface.)
  const styleText = await page.evaluate(() =>
    Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n')
  );
  expect(styleText).not.toContain('display:none');
  expect(styleText).not.toContain('pwned');
  expect(await page.content()).not.toContain('<script>window.__pwned9');
  const html = page.locator('html');
  await expect.poll(() => html.evaluate(readVar('--oravan-surface'), '--oravan-surface')).toBe('');
});

/*
 * The action-panel refusal state is the path where the :root style tag is
 * load-bearing: no client widget ever mounts there (the iframe never
 * resizes), so the server-rendered tag is the only thing theming the frame.
 */
test('action-panel refusal state (garbage token) is fully themed', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(
    '/embed/action-panel?locale=en&token=not-a-real-token&mode=dark&surface=%230f1a2b&ink=%23f5f7fa'
  );
  // The refusal copy renders (not a crash, not the live widget)…
  await expect(page.locator('.re-note[role="alert"]')).toBeVisible();
  // …and the tenant palette carried through to the whole document.
  const bodyBg = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bodyBg).toBe('rgb(15, 26, 43)');
  const scheme = await page.locator('html').evaluate((el) => getComputedStyle(el).colorScheme);
  expect(scheme).toBe('dark');
});
