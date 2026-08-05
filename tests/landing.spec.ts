import { expect, test } from '@playwright/test';

test('landing renders and ZIP search reaches reps', async ({ page }) => {
  await page.goto('/');
  // The hero is a two-beat promise: the truth clause, then the phrase the 6px
  // green go-stroke is drawn under. Assert the stroked beat, because it is
  // the one the owner pinned (truth-first flip, decided 2026-07-31 — this
  // assertion previously read "It counts.").
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Then make it count.');
  await page.getByLabel('Your ZIP code').fill('78501');
  await page.getByRole('button', { name: /find my representatives/i }).click();
  await expect(page).toHaveURL(/\/reps\?zip=78501/);
  await expect(page.getByText('Monica De La Cruz')).toBeVisible();
});

test('no horizontal overflow on either landing locale @reflow', async ({ page }) => {
  for (const path of ['/', '/es']) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `${path} must not scroll horizontally`).toBeLessThanOrEqual(0);
  }
});

/*
 * WCAG 1.4.10 reflow is specified AT 320px, and neither Playwright project
 * runs there — so the widest thing on the page, the hero h1, was never
 * measured at the width the criterion names. Caught for real by the
 * truth-first flip (2026-07-31): the stroked beat cannot wrap (the go-mark
 * has to be one continuous bar), and "Luego haz que cuente." set 330px at the
 * 32px --text-h1 floor, 42px past a 320px screen's 288px content box. The
 * page.tsx step-down below 360px is what this guards.
 */
test('no horizontal overflow at the 320px reflow width, either locale', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  for (const path of ['/', '/es']) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `${path} must reflow at 320px without a horizontal scrollbar`).toBeLessThanOrEqual(0);
  }
});

test('spanish landing is fully localized', async ({ page }) => {
  await page.goto('/es');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Luego haz que cuente.');
  await expect(page.getByLabel('Tu código postal')).toBeVisible();
});

test('footer privacy link is reachable and clickable on mobile', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'regression guard for the mobile tab-bar overlap');
  await page.goto('/');
  const link = page.locator('footer').getByRole('link', { name: 'Privacy' });
  await link.scrollIntoViewIfNeeded();
  await link.click();
  await expect(page).toHaveURL(/\/privacy/);
});

test('Enter in the hero ZIP field submits (GovTrack anti-lesson gate, 2026-08 benchmark)', async ({
  page,
}) => {
  // The incumbent's address field silently swallowed Enter on one of two
  // runs — at the moment of highest intent. Ours must submit either way:
  // hydrated (onSubmit) or not (the form's own action="/reps" method=get).
  await page.goto('/');
  await page.getByLabel('Your ZIP code').fill('78501');
  await page.getByLabel('Your ZIP code').press('Enter');
  await expect(page).toHaveURL(/\/reps\?zip=78501/);
});
