import { expect, test } from '@playwright/test';

/*
 * The "Read" section: real third-party articles + outlet lean. Coverage is
 * baked into data/coverage.json; hr-1-119 is a seeded sample with a Left/
 * Center/Right spread, s-2280-119 is a seeded-free bill (no section).
 */

test('seeded bill shows the Read section with articles and outlet lean', async ({ page }) => {
  await page.goto('/bills/hr-1-119');

  await expect(page.getByRole('heading', { name: "How it's being covered" })).toBeVisible();
  // A real article link (its accessible name is the localized "Open this article at {source}").
  await expect(page.getByRole('link', { name: /Open this article at npr\.org/ })).toBeVisible();
  // Lean is shown by text label, never color alone.
  await expect(page.getByText('Leans left').first()).toBeVisible();
  // The "outlet, not party" disclaimer is present.
  await expect(page.getByText(/labels describe the news outlet/)).toBeVisible();
});

test('snippet preview reveals (hover on desktop, tap on mobile)', async ({ page }, testInfo) => {
  await page.goto('/bills/hr-1-119');

  const row = page.getByRole('listitem').filter({ hasText: 'millions losing health insurance' });
  const snippet = page.getByText(/nearly 11 million more people could be uninsured/);

  await expect(snippet).toBeHidden(); // collapsed by default

  if (testInfo.project.name.includes('mobile')) {
    // Touch: the disclosure button toggles it open (needs hydration → retry-guarded,
    // tapping only while still collapsed so we never toggle it back shut).
    const button = row.getByRole('button', { name: 'Preview' });
    await expect(async () => {
      if (!(await snippet.isVisible())) await button.tap();
      await expect(snippet).toBeVisible({ timeout: 400 });
    }).toPass({ timeout: 10_000 });
  } else {
    // Desktop: revealed by CSS group-hover (works without JS, so no hydration gate).
    await row.hover();
    await expect(snippet).toBeVisible();
  }
});

test('a bill with no coverage renders no Read section', async ({ page }) => {
  await page.goto('/bills/s-2280-119');
  await expect(page.getByRole('heading', { name: 'Where does it stand?' })).toBeVisible(); // page rendered
  await expect(page.getByRole('heading', { name: "How it's being covered" })).toHaveCount(0);
});
