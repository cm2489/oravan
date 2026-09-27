import { expect, test } from '@playwright/test';
import { hexToRgb } from '../lib/contrast';
import { FONT_VALUES, MODE_DEFAULTS, resolveEmbedTheme } from '../lib/embed-theme';
import { decodedCommitteeBill } from './corpus-fixtures';
import { colorToken, rgbOf } from './palette';

/*
 * Brand-preview build — the widened theming surface, driven against the
 * real server the way tests/embed-rep-lookup-theme.spec.ts drives the
 * original three knobs. Theme vars now land at :root via one validated
 * <style> tag (components/embed/EmbedThemeStyle.tsx), so assertions read
 * them from documentElement/body computed style; custom properties inherit,
 * so the original .re-root readings elsewhere keep working untouched.
 */

/*
 * Every expected colour below is READ — the defaults from lib/embed-theme.ts's
 * MODE_DEFAULTS (the pair embed.css's fallbacks must mirror), a tenant colour
 * from the tenant input the test sent — never an rgb() literal. A default
 * that drifts from embed.css fails here; a palette change does not.
 */
const DECODED_SLUG = decodedCommitteeBill().slug;

/** A tenant's dark palette — any valid pair that is not the default. */
const TENANT_DARK = { surface: '#0f1a2b', ink: '#f5f7fa' };

function readVar() {
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
  await page.goto(
    `/embed/rep-lookup?locale=en&surface=${encodeURIComponent(TENANT_DARK.surface)}&ink=${encodeURIComponent(TENANT_DARK.ink)}`
  );
  const html = page.locator('html');
  await expect.poll(() => html.evaluate(readVar(), '--oravan-surface')).toBe(TENANT_DARK.surface);
  await expect.poll(() => html.evaluate(readVar(), '--oravan-ink')).toBe(TENANT_DARK.ink);
  // The BODY background is the pair's surface — that's the band a fixed-height
  // iframe shows below short content, the thing inline vars on <main> could
  // never recolor.
  const bodyBg = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bodyBg).toBe(rgbOf(TENANT_DARK.surface));
  const bodyColor = await page.locator('body').evaluate((el) => getComputedStyle(el).color);
  expect(bodyColor).toBe(rgbOf(TENANT_DARK.ink));
});

test('a pair below AA contrast is discarded as a pair (default background survives)', async ({
  page,
}) => {
  await page.goto('/embed/rep-lookup?locale=en&surface=%23888888&ink=%23999999');
  const html = page.locator('html');
  await expect.poll(() => html.evaluate(readVar(), '--oravan-surface')).toBe('');
  await expect.poll(() => html.evaluate(readVar(), '--oravan-ink')).toBe('');
});

test('a lone ink (no surface) is discarded — pair-or-nothing', async ({ page }) => {
  await page.goto('/embed/rep-lookup?locale=en&ink=%23000000');
  const html = page.locator('html');
  await expect.poll(() => html.evaluate(readVar(), '--oravan-ink')).toBe('');
});

test('mode=dark forces the dark default palette on a light-preference visitor', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/embed/bill-card?locale=en&slug=' + DECODED_SLUG + '&mode=dark');
  const html = page.locator('html');
  await expect
    .poll(() => html.evaluate(readVar(), '--oravan-surface'))
    .toBe(MODE_DEFAULTS.dark.surface);
  const scheme = await html.evaluate((el) => getComputedStyle(el).colorScheme);
  expect(scheme).toBe('dark');
  const bodyBg = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bodyBg).toBe(rgbOf(MODE_DEFAULTS.dark.surface));
});

test('mode=light forces the light palette on a dark-preference visitor', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/embed/rep-lookup?locale=en&mode=light');
  const bodyBg = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bodyBg).toBe(rgbOf(MODE_DEFAULTS.light.surface));
});

test('junk mode falls back to auto (visitor preference rules)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/embed/rep-lookup?locale=en&mode=midnight');
  const bodyBg = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
  // Nothing forced, so this is embed.css's own dark fallback via its media
  // query — which must be the dark default the server pins for mode=dark.
  expect(bodyBg).toBe(rgbOf(MODE_DEFAULTS.dark.surface));
});

test('the two new font stacks land as computed --oravan-font', async ({ page }) => {
  for (const key of ['humanist', 'geometric'] as const) {
    await page.goto(`/embed/rep-lookup?locale=en&font=${key}`);
    const html = page.locator('html');
    await expect.poll(() => html.evaluate(readVar(), '--oravan-font')).toBe(
      FONT_VALUES[key]
    );
  }
});

test('a themed widget shows no Oravan-palette leak: note box re-tints, toggle text is the tenant color', async ({
  page,
}) => {
  // The case the owner flagged: a publisher's black accent, light surface and
  // near-black ink. The surface is an off-white on purpose — it differs from
  // every Oravan default, so a fallback to Oravan's own colours cannot pass
  // for the tenant's. The note box must wear the tint derived from THEIR
  // colours, and the pressed toggle text must be THEIR light colour.
  const tenant = { accent: '#000000', surface: '#fdfcfa', ink: '#121212', mode: 'light' };
  expect([MODE_DEFAULTS.light.surface, MODE_DEFAULTS.dark.surface]).not.toContain(tenant.surface);
  const expected = resolveEmbedTheme(tenant);
  await page.goto(
    `/embed/rep-lookup?locale=en&accent=${encodeURIComponent(tenant.accent)}&surface=${encodeURIComponent(tenant.surface)}&ink=${encodeURIComponent(tenant.ink)}&mode=${tenant.mode}`
  );
  const note = page.locator('.re-note');
  await expect(note).toBeVisible();
  const noteBorder = parseColor(await note.evaluate((el) => getComputedStyle(el).borderTopColor));
  const tint = hexToRgb(expected.noteBorder!)!;
  expect([noteBorder.r, noteBorder.g, noteBorder.b]).toEqual([tint.r, tint.g, tint.b]);

  const toggleText = await page
    .locator('.re-toggle[aria-pressed="true"]')
    .evaluate((el) => getComputedStyle(el).color);
  expect(expected.accentInk).toBe(tenant.surface);
  expect(toggleText).toBe(rgbOf(tenant.surface));
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

test('the UN-themed default widget keeps Oravan\'s own note treatment — a neutral ink wash, never the live-floor colour', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/embed/rep-lookup?locale=en');
  const noteBorder = await page
    .locator('.re-note')
    .evaluate((el) => getComputedStyle(el).borderTopColor);
  // An un-themed widget gets Oravan's OWN default note treatment rather than
  // nothing: --_line-strong, half the default ink. What this protects: the
  // site's live-floor colour (--color-urgent) marks one fact — a bill
  // standing on the floor calendar, with its date printed — and no widget
  // can render that fact, so a widget must never wear that colour.
  const border = parseColor(noteBorder);
  const urgent = hexToRgb(colorToken('urgent'))!;
  expect([border.r, border.g, border.b]).not.toEqual([urgent.r, urgent.g, urgent.b]);
  const ink = hexToRgb(MODE_DEFAULTS.light.ink)!;
  expect([border.r, border.g, border.b]).toEqual([ink.r, ink.g, ink.b]); // the default ink
  expect(border.a).toBeCloseTo(0.5, 2); // --_line-strong: half ink
});

test('accent alone still derives --oravan-accent-ink; the AI chip stays an ink mark', async ({
  page,
}) => {
  // A pale accent whose readable text color is the dark ink, not the default
  // near-white — proves the derivation is computed, not hardcoded.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/embed/bill-card?locale=en&slug=' + DECODED_SLUG + '&accent=%23ffe680');
  const html = page.locator('html');
  await expect
    .poll(() => html.evaluate(readVar(), '--oravan-accent-ink'))
    .toBe(MODE_DEFAULTS.light.ink);
  // The chip half of this test changed MEANING, not just its hex: .bc-chip-ai
  // no longer fills with the accent (embed.css — "the AI label is an INTEGRITY
  // MARK, not brand chrome"), so it renders in --_ink on a transparent ground.
  // Asserting the transparent ground is what keeps this a real check: with the
  // ink and the derived accent-ink the same colour today, a color assertion
  // alone would pass either way and would no longer notice the accent coming
  // back.
  const chip = page.locator('.bc-chip-ai');
  expect(await chip.evaluate((el) => getComputedStyle(el).color)).toBe(rgbOf(MODE_DEFAULTS.light.ink));
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
  await expect.poll(() => html.evaluate(readVar(), '--oravan-surface')).toBe('');
});

/*
 * The action-panel refusal state is the path where the :root style tag is
 * load-bearing: no client widget ever mounts there (the iframe never
 * resizes), so the server-rendered tag is the only thing theming the frame.
 */
test('action-panel refusal state (garbage token) is fully themed', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(
    `/embed/action-panel?locale=en&token=not-a-real-token&mode=dark&surface=${encodeURIComponent(TENANT_DARK.surface)}&ink=${encodeURIComponent(TENANT_DARK.ink)}`
  );
  // The refusal copy renders (not a crash, not the live widget)…
  await expect(page.locator('.re-note[role="alert"]')).toBeVisible();
  // …and the tenant palette carried through to the whole document.
  const bodyBg = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bodyBg).toBe(rgbOf(TENANT_DARK.surface));
  const scheme = await page.locator('html').evaluate((el) => getComputedStyle(el).colorScheme);
  expect(scheme).toBe('dark');
});
