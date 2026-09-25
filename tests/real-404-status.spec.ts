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

/*
 * The 404's TAB TITLE (UI audit F11). It used to inherit the layout default —
 * the site name and tagline — so a dead link looked like the homepage in the
 * tab strip and in history. app/[locale]/not-found.tsx now exports
 * generateMetadata with the already-reviewed `notFound.title`, run through the
 * layout's "%s — Oravan" template. Asserted beside the status so the metadata
 * export can never quietly trade the real 404 away (see the header above:
 * metadata resolution is exactly the kind of thing that once flipped it).
 */
test('the 404 names itself in the tab, in both languages, and still answers 404', async ({ page }) => {
  const en = await page.goto('/zzzz');
  expect(en?.status()).toBe(404);
  await expect(page).toHaveTitle(/^Page not found — Oravan$/);
  const es = await page.goto('/es/zzzz');
  expect(es?.status()).toBe(404);
  await expect(page).toHaveTitle(/^Página no encontrada — Oravan$/);
});

test('bare /nominations 404s honestly rather than building an index', async ({ page }) => {
  const response = await page.goto('/nominations');
  expect(response?.status()).toBe(404);
});

test('a real bill page still answers 200 after the fix', async ({ page }) => {
  const response = await page.goto(realBillPath());
  expect(response?.status()).toBe(200);
});
