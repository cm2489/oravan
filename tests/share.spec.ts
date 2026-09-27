import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { referenceBill } from './corpus-fixtures';

/*
 * SharePanel: the canonical, slug-only share URL (no query params, no stance,
 * no locale-tracking params) and the no-native-share fallback. The origin is
 * pinned to lib/site.ts on purpose — when the rename lands, that constant and
 * these expectations change together, and nothing else. The bill is any
 * decoded one (tests/corpus-fixtures.ts); controls are found by message key.
 */

const REF = referenceBill();
const PATH = `/bills/${REF.slug}`;
const CANONICAL = `https://oravan.org${PATH}`;

// Deterministic native-share stub: capture the payload instead of opening a sheet.
const stubNativeShare = () => {
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: (data: unknown) => {
      (window as unknown as { __shared: unknown }).__shared = data;
      return Promise.resolve();
    },
  });
};

// Deterministic fallback: remove navigator.share regardless of engine defaults.
const removeNativeShare = () => {
  Object.defineProperty(Navigator.prototype, 'share', { configurable: true, value: undefined });
};

test.describe('native share', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(stubNativeShare);
  });

  test('shares the canonical slug-only URL — no query params, no stance', async ({ page }) => {
    await page.goto(PATH);
    await page.getByRole('button', { name: en.bill.share.share, exact: true }).click();
    const shared = await page.evaluate(
      () => (window as unknown as { __shared: { title: string; text: string; url: string } }).__shared
    );
    expect(shared.url).toBe(CANONICAL);
    expect(shared.url).not.toContain('?');
    // Neutral text: citation + headline (the citation may live inside the headline)
    expect(shared.text).toContain(String(REF.bill.bill_number));
    // Native mode replaces the fallback affordances entirely
    await expect(page.getByRole('link', { name: en.bill.share.whatsapp })).toHaveCount(0);
  });

  test('spanish page shares its own canonical (/es path, still no params)', async ({ page }) => {
    await page.goto('/es' + PATH);
    await page.getByRole('button', { name: es.bill.share.share, exact: true }).click();
    const shared = await page.evaluate(
      () => (window as unknown as { __shared: { url: string } }).__shared
    );
    expect(shared.url).toBe(`https://oravan.org/es${PATH}`);
  });
});

test.describe('fallback (no navigator.share)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(removeNativeShare);
  });

  test('copy link copies the canonical URL and announces the confirmation', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __copied: string | null };
      w.__copied = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (t: string) => {
            w.__copied = t;
            return Promise.resolve();
          },
        },
      });
    });
    await page.goto(PATH);
    // The copy button appears only after hydration, so this click can't wedge.
    await page.getByRole('button', { name: en.bill.share.copyLink }).click();
    await expect(page.getByRole('button', { name: en.bill.share.copied })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: en.bill.share.copied })).toHaveCount(1);
    expect(await page.evaluate(() => (window as unknown as { __copied: string | null }).__copied)).toBe(
      CANONICAL
    );
  });

  test('WhatsApp share is a plain anchor embedding the slug-only URL', async ({ page }) => {
    await page.goto(PATH);
    const wa = page.getByRole('link', { name: en.bill.share.whatsapp });
    await expect(wa).toBeVisible();
    await expect(wa).toHaveAttribute('target', '_blank');
    await expect(wa).toHaveAttribute('rel', 'noopener noreferrer');
    const href = (await wa.getAttribute('href'))!;
    expect(href).toMatch(/^https:\/\/wa\.me\/\?text=/);
    const message = decodeURIComponent(href.replace('https://wa.me/?text=', ''));
    expect(message).toContain(CANONICAL);
    expect(message).not.toContain(`${CANONICAL}?`);
  });

  test('spanish fallback renders localized labels', async ({ page }) => {
    await page.goto('/es' + PATH);
    await expect(page.getByRole('button', { name: es.bill.share.copyLink })).toBeVisible();
    await expect(page.getByRole('link', { name: es.bill.share.whatsapp })).toBeVisible();
  });
});
