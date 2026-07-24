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

/**
 * A computed color as channels, tolerant of BOTH serializations WebKit uses:
 * `rgb()/rgba()` for a plain literal, and `color(srgb r g b / a)` for a value
 * that came out of color-mix(). Asserting the parsed channels keeps these
 * tests pinned to the color the design system actually specifies instead of to
 * one engine's spelling of it.
 */
function parseColor(value: string): { r: number; g: number; b: number; a: number } {
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(value);
  if (srgb) {
    return {
      r: Math.round(Number(srgb[1]) * 255),
      g: Math.round(Number(srgb[2]) * 255),
      b: Math.round(Number(srgb[3]) * 255),
      a: srgb[4] === undefined ? 1 : Number(srgb[4]),
    };
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(value);
  if (!rgb) throw new Error(`unrecognized computed color: ${value}`);
  const parts = rgb[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
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
  expect(bodyBg).toBe('rgb(22, 25, 27)'); // #16191b — variant B's one dark
});

test('mode=light forces the light palette on a dark-preference visitor', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/embed/rep-lookup?locale=en&mode=light');
  const bodyBg = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bodyBg).toBe('rgb(255, 255, 255)'); // #ffffff — `paper`
});

test('junk mode falls back to auto (visitor preference rules)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/embed/rep-lookup?locale=en&mode=midnight');
  const bodyBg = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bodyBg).toBe('rgb(22, 25, 27)'); // dark default via media query
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

test('the UN-themed default widget keeps Oravan\'s own note treatment — a neutral ink wash, never amber', async ({
  page,
}) => {
  await page.goto('/embed/rep-lookup?locale=en');
  const noteBorder = await page
    .locator('.re-note')
    .evaluate((el) => getComputedStyle(el).borderTopColor);
  // Same property as before — an un-themed widget gets Oravan's OWN default
  // note treatment rather than nothing — re-keyed to the treatment the colour
  // law now assigns it. Amber is spent site-wide on exactly one fact (a bill
  // standing on the floor calendar, with its date printed) and no widget can
  // render that fact, so the amber fallback was retired for --_line-strong,
  // half the default ink. The old amber is asserted ABSENT so the retirement
  // itself is pinned, not just the replacement.
  const border = parseColor(noteBorder);
  expect([border.r, border.g, border.b]).not.toEqual([232, 163, 23]); // no amber
  expect([border.r, border.g, border.b]).toEqual([22, 25, 27]); // #16191b, the default ink
  expect(border.a).toBeCloseTo(0.5, 2); // --_line-strong: half ink, an edge at 3.37:1
});

test('accent alone still derives --oravan-accent-ink; the AI chip stays an ink mark', async ({
  page,
}) => {
  // A pale accent whose readable text color is the dark ink, not the default
  // near-white — proves the derivation is computed, not hardcoded.
  await page.goto('/embed/bill-card?locale=en&slug=' + DECODED_SLUG + '&accent=%23ffe680');
  const html = page.locator('html');
  await expect
    .poll(() => html.evaluate(readVar('--oravan-accent-ink'), '--oravan-accent-ink'))
    .toBe('#16191b');
  // The chip half of this test changed MEANING, not just its hex: .bc-chip-ai
  // no longer fills with the accent (embed.css — "the AI label is an INTEGRITY
  // MARK, not brand chrome"), so it renders in --_ink on a transparent ground.
  // Asserting the transparent ground is what keeps this a real check: with the
  // ink and the derived accent-ink both #16191b today, a color assertion alone
  // would pass either way and would no longer notice the accent coming back.
  const chip = page.locator('.bc-chip-ai');
  expect(await chip.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(22, 25, 27)');
  expect(await chip.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
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
