import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import billsJson from '../data/bills.json';
import { shareAddress, shareTablesFor } from '../lib/share-address';
import type { ShortAddressBill } from '../lib/short-address';
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
const TABLES = shareTablesFor(billsJson as unknown as ShortAddressBill[]);
const CANONICAL = shareAddress(REF.bill as unknown as ShortAddressBill, 'en', TABLES);
const CANONICAL_ES = shareAddress(REF.bill as unknown as ShortAddressBill, 'es', TABLES);

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

  test('shares the short address — no query params, no stance', async ({ page }) => {
    await page.goto(PATH);
    await page.getByRole('button', { name: en.bill.share.share, exact: true }).click();
    const shared = await page.evaluate(
      () => (window as unknown as { __shared: { title: string; text: string; url: string } }).__shared
    );
    expect(shared.url).toBe(CANONICAL);
    expect(shared.url).toMatch(/^https:\/\/oravan\.org\/(?:[a-z0-9]+(?:-[a-z0-9]+)*|bills\/[a-z]+-\d+-\d+)$/);
    expect(shared.url).not.toContain('?');
    // Neutral text: citation + headline (the citation may live inside the headline)
    expect(shared.text).toContain(String(REF.bill.bill_number));
    // Native mode replaces the fallback affordances entirely
    await expect(page.getByRole('link', { name: en.bill.share.whatsapp })).toHaveCount(0);
  });

  test('spanish page shares its own short address (/es path, still no params)', async ({ page }) => {
    await page.goto('/es' + PATH);
    await page.getByRole('button', { name: es.bill.share.share, exact: true }).click();
    const shared = await page.evaluate(
      () => (window as unknown as { __shared: { url: string } }).__shared
    );
    expect(shared.url).toBe(CANONICAL_ES);
    expect(CANONICAL_ES).toBe(CANONICAL.replace('https://oravan.org/', 'https://oravan.org/es/'));
  });
});

test.describe('fallback (no navigator.share)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(removeNativeShare);
  });

  test('copy link copies the short address and announces the confirmation', async ({ page }) => {
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

  test('the address Copy hands out opens this very bill on this site, in both languages', async ({ page, request }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __copied: string | null };
      w.__copied = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (t: string) => ((w.__copied = t), Promise.resolve()) },
      });
    });
    for (const [prefix, labels, expected] of [
      ['', en.bill.share, CANONICAL],
      ['/es', es.bill.share, CANONICAL_ES],
    ] as const) {
      await page.goto(prefix + PATH);
      await page.getByRole('button', { name: labels.copyLink }).click();
      await expect(page.getByRole('button', { name: labels.copied })).toBeVisible();
      const copied = await page.evaluate(() => (window as unknown as { __copied: string | null }).__copied);
      expect(copied).toBe(expected);
      // The copied address, asked of this server: a 307 to this bill's page (a bill with no name of its own, or
      // while names are off), or to the page listing the bills that share its name, which lists this one.
      const from = new URL(copied!).pathname;
      const res = await request.get(from, { maxRedirects: 0, headers: { accept: 'text/html' } });
      expect(res.status(), from).toBe(307);
      const to = new URL(res.headers()['location'] ?? '', 'http://x').pathname;
      if (to.startsWith(`${prefix}/names/`)) {
        expect(await (await request.get(to)).text(), to).toContain(`/bills/${REF.slug}`);
      } else {
        expect(to, from).toBe(prefix + PATH);
      }
    }
  });

  test('spanish fallback renders localized labels', async ({ page }) => {
    await page.goto('/es' + PATH);
    await expect(page.getByRole('button', { name: es.bill.share.copyLink })).toBeVisible();
    await expect(page.getByRole('link', { name: es.bill.share.whatsapp })).toBeVisible();
  });
});
