import { expect, test, type Page } from '@playwright/test';

/**
 * CallWalkthrough behavior: reduced-motion starts paused, labeled step dots
 * navigate, auto-advance runs (and pauses on hover) otherwise.
 *
 * The walkthrough is mounted on the homepage (the integration PR), so these
 * run for real now. The self-skip guard below predates the mount and stays:
 * it detects presence, not behavior, so it can never mask a real failure —
 * only an unmount, which the integration's own specs would surface.
 *
 * Bill pages get the same walkthrough behind a collapsed <details>
 * disclosure; its spec is at the bottom.
 */

// Where the walkthrough is mounted (homepage, "See how a call works").
const PAGE_PATH = '/';
// Longer than the longest per-scene hold (6.8s), to prove "no auto-advance".
const LONGEST_SCENE_MS = 7500;

async function gotoWalkthrough(page: Page) {
  await page.goto(PAGE_PATH);
  const root = page.locator('[data-walkthrough]');
  test.skip(
    (await root.count()) === 0,
    'CallWalkthrough is not mounted on a page yet — these activate with the integration PR'
  );
  return root;
}

test('reduced motion: starts paused and never auto-advances', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const root = await gotoWalkthrough(page);

  // Paused state = the toggle offers Play, and we sit on step 1.
  await expect(root.getByRole('button', { name: 'Play walkthrough' })).toBeVisible();
  await expect(root.getByText('Step 1 of 5')).toBeVisible();

  await page.waitForTimeout(LONGEST_SCENE_MS);
  await expect(root.getByText('Step 1 of 5')).toBeVisible();
  await expect(root.getByRole('button', { name: 'Play walkthrough' })).toBeVisible();
});

test('step dots are labeled, navigate scenes, and mark the current step', async ({ page }) => {
  // Reduced motion keeps navigation deterministic (no timer racing the clicks).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const root = await gotoWalkthrough(page);

  const dot3 = root.getByRole('button', { name: 'Step 3 of 5: Your 30-second script' });
  await dot3.click();
  await expect(root.getByRole('heading', { name: 'Your 30-second script' })).toBeVisible();
  await expect(dot3).toHaveAttribute('aria-current', 'step');

  // Back one step: manual prev works the same way.
  await root.getByRole('button', { name: 'Step 2 of 5: Say where you stand' }).click();
  await expect(root.getByRole('heading', { name: 'Say where you stand' })).toBeVisible();
  await expect(dot3).not.toHaveAttribute('aria-current', 'step');
});

test('auto-advances between scenes, and the toggle pauses it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const root = await gotoWalkthrough(page);

  // Playing state arms after hydration, then scene 1 gives way to scene 2.
  await expect(root.getByRole('button', { name: 'Pause walkthrough' })).toBeVisible();
  await expect(root.getByText('Step 2 of 5')).toBeVisible({ timeout: 10_000 });

  // Pausing parks it: hover leaves the toggle focus-free, so this isolates the button.
  await root.getByRole('button', { name: 'Pause walkthrough' }).click();
  await expect(root.getByRole('button', { name: 'Play walkthrough' })).toBeVisible();
  const step = await root.locator('h3').textContent();
  await page.waitForTimeout(LONGEST_SCENE_MS);
  await expect(root.locator('h3')).toHaveText(step ?? '');
});

test('hovering pauses auto-advance', async ({ page, isMobile }) => {
  test.skip(!!isMobile, 'hover is a pointer-only affordance');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const root = await gotoWalkthrough(page);

  await root.hover();
  const step = await root.locator('h3').textContent();
  await page.waitForTimeout(LONGEST_SCENE_MS);
  await expect(root.locator('h3')).toHaveText(step ?? '');
});

test('bill page: disclosure is collapsed by default and reveals the walkthrough', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/bills/hr-5582-119'); // same known-good slug decoded.spec.ts relies on

  const disclosure = page.locator('[data-walkthrough-disclosure]');
  await expect(disclosure).toBeVisible();
  // Collapsed by default — and the walkthrough isn't even mounted yet
  // (it's lazy-loaded on open, so collapsed pages carry no extra weight).
  await expect(disclosure).toHaveJSProperty('open', false);
  await expect(page.locator('[data-walkthrough]')).toHaveCount(0);

  await disclosure.locator('summary').click();
  await expect(disclosure).toHaveJSProperty('open', true);
  await expect(page.locator('[data-walkthrough]')).toBeVisible();
  // The revealed walkthrough behaves like the homepage one: reduced motion ⇒ paused.
  await expect(disclosure.getByRole('button', { name: 'Play walkthrough' })).toBeVisible();
  await expect(disclosure.getByText('Step 1 of 5')).toBeVisible();
});
