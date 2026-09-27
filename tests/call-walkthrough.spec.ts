import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import { referenceBill } from './corpus-fixtures';
import { messagePattern } from './message-pattern';

/**
 * CallWalkthrough under reduced motion: it starts PAUSED and never advances
 * on its own. That is the accessibility promise ("reduced motion honoured",
 * hard rule 7) and the only thing this spec pins.
 *
 * Trimmed 2026-09-27 (audit card a3): the step-dot navigation, the auto-advance
 * timing, the hover pause and the collapsed-by-default disclosure were all
 * pinned here too. They describe how the demo is built, not a promise, and
 * any redesign of it would have reddened them for reasons unrelated to intent.
 *
 * The walkthrough ships in a collapsed disclosure on every bill page, so any
 * bill will do (tests/corpus-fixtures.ts). The presence guard below detects
 * presence, not behavior, so it can never mask a real failure — only an
 * unmount, which is a product decision rather than a regression.
 */

// Longer than the longest per-scene hold (6.8s), to prove "no auto-advance".
const LONGEST_SCENE_MS = 7500;

test('reduced motion: starts paused and never auto-advances', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/bills/${referenceBill().slug}`);
  const disclosure = page.locator('[data-walkthrough-disclosure]');
  test.skip((await disclosure.count()) === 0, 'CallWalkthrough is not mounted on the bill page');
  // Collapsed costs nothing: the chunk is code-split and the scene timers do
  // not run until this click, so the demo always starts at scene 1.
  await disclosure.locator('summary').click();
  const root = page.locator('[data-walkthrough]');
  await expect(root).toBeVisible();

  // Paused state = the toggle offers Play, and we sit on step 1.
  const stepOne = messagePattern(en.walkthrough.stepOf, { step: 1 });
  await expect(root.getByRole('button', { name: en.walkthrough.play })).toBeVisible();
  await expect(root.getByText(stepOne)).toBeVisible();

  await page.waitForTimeout(LONGEST_SCENE_MS);
  await expect(root.getByText(stepOne)).toBeVisible();
  await expect(root.getByRole('button', { name: en.walkthrough.play })).toBeVisible();
});
