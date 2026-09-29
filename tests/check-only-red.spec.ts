import { expect, test } from '@playwright/test';

// Check-only branch: a deliberately red browser test, to prove the aggregate
// `test` check fails when one E2E shard does. Never merged.
test('deliberately red: the aggregate check must fail on this', async ({ page }) => {
  await page.goto('/');
  expect(await page.title()).toBe('check-only: a title no page has');
});
