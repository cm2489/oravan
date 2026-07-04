import { expect, test } from '@playwright/test';

/*
 * Per-bill Open Graph / Twitter cards: the metadata a chat app's crawler
 * reads when a bill link is pasted into WhatsApp/iMessage/Slack. og:url is
 * the canonical slug-only URL (no query params — same rule as SharePanel,
 * same lib/site.ts origin), and og:image must actually serve a PNG in both
 * locales or every forwarded link falls back to the generic site card.
 *
 * og:image itself MAY carry Next's cache-busting version query — the
 * no-query-params rule protects the shared page URL, not asset URLs.
 */

const ORIGIN = 'https://cabina-nine.vercel.app';
const CANONICAL = `${ORIGIN}/bills/hr-5582-119`;
const CANONICAL_ES = `${ORIGIN}/es/bills/hr-5582-119`;

test.describe('bill page social metadata', () => {
  test('og:url is absolute, canonical, and query-free; card is summary_large_image', async ({ page }) => {
    await page.goto('/bills/hr-5582-119');

    const ogUrl = page.locator('meta[property="og:url"]');
    await expect(ogUrl).toHaveAttribute('content', CANONICAL);
    expect((await ogUrl.getAttribute('content'))!).not.toContain('?');

    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
      'content',
      'summary_large_image'
    );
    await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute('content', 'en_US');
    // Neutral title: citation + headline, no advocacy framing to assert against
    expect(await page.locator('meta[property="og:title"]').getAttribute('content')).toContain('5582');
  });

  test('spanish page carries its own canonical og:url and locale', async ({ page }) => {
    await page.goto('/es/bills/hr-5582-119');
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', CANONICAL_ES);
    await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute('content', 'es_ES');
  });

  test('hreflang alternates point at both locales, slug-only', async ({ page }) => {
    await page.goto('/bills/hr-5582-119');
    await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute(
      'href',
      CANONICAL
    );
    await expect(page.locator('link[rel="alternate"][hreflang="es"]')).toHaveAttribute(
      'href',
      CANONICAL_ES
    );
  });
});

test.describe('bill og:image', () => {
  // Read the og:image URL off the page, then fetch its path against the app
  // under test (the meta content pins the production origin from lib/site.ts).
  const fetchOgImage = async (
    page: import('@playwright/test').Page,
    request: import('@playwright/test').APIRequestContext,
    path: string
  ) => {
    await page.goto(path);
    const content = await page.locator('meta[property="og:image"]').first().getAttribute('content');
    expect(content, 'bill page must declare an og:image').toBeTruthy();
    const url = new URL(content!);
    expect(url.origin).toBe(ORIGIN);
    return request.get(url.pathname + url.search);
  };

  test('resolves 200 as a PNG under the size budget (en)', async ({ page, request }) => {
    const res = await fetchOgImage(page, request, '/bills/hr-5582-119');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
    // Chat apps skip heavyweight previews; keep every card well under 300KB.
    expect((await res.body()).byteLength).toBeLessThan(300_000);
  });

  test('resolves 200 as a PNG under the size budget (es)', async ({ page, request }) => {
    const res = await fetchOgImage(page, request, '/es/bills/hr-5582-119');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
    expect((await res.body()).byteLength).toBeLessThan(300_000);
  });
});
