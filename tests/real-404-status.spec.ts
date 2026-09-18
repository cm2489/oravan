import { expect, test } from '@playwright/test';
import { billSlug, getAllBills } from '../lib/core/bills';

/*
 * Regression guard for the soft-404 bug (fix/real-404-status). Unknown paths
 * rendered app/[locale]/not-found.tsx's copy correctly but the response
 * carried HTTP 200 — a known Next.js interaction between generateMetadata()
 * resolving without calling notFound() and a route-level loading.tsx forcing
 * an early streamed flush of the 200 status before the page body's own
 * notFound() throw could change it (vercel/next.js#75543). The fix removed
 * app/[locale]/loading.tsx and made the bills/nominations generateMetadata()
 * functions call notFound() themselves instead of returning `{}` on a miss.
 *
 * A real bill slug (not a hardcoded fixture) proves the fix didn't flip a
 * real page to 404 alongside the unknown ones.
 */
function realBillPath(): string {
  const first = getAllBills()[0];
  if (!first) throw new Error('corpus is empty — scripts/check-bills should have failed the build first');
  return `/bills/${billSlug(first)}`;
}

const UNKNOWN_PATHS = ['/zzzz', '/bills/not-a-bill', '/reps/X999999'];

for (const p of UNKNOWN_PATHS) {
  test(`${p} is a real 404 (en)`, async ({ page }) => {
    const response = await page.goto(p);
    expect(response?.status()).toBe(404);
  });

  test(`${p} is a real 404 (es)`, async ({ page }) => {
    const response = await page.goto(`/es${p}`);
    expect(response?.status()).toBe(404);
  });
}

test('bare /nominations 404s honestly rather than building an index', async ({ page }) => {
  const response = await page.goto('/nominations');
  expect(response?.status()).toBe(404);
});

test('a real bill page still answers 200 after the fix', async ({ page }) => {
  const response = await page.goto(realBillPath());
  expect(response?.status()).toBe(200);
});
