import { expect, test } from '@playwright/test';

/*
 * The beta feedback option is OFF (owner, 2026-09-28: "remove the feedback
 * option for now"), rendered: no page offers the form, and the old endpoint
 * accepts nothing. The copy side is pinned in tests/feedback.unit.spec.ts,
 * and /citations' correction link in tests/citations.spec.ts.
 */

for (const prefix of ['', '/es']) {
  test(`${prefix || '/en'}: the footer offers no feedback form`, async ({ page }) => {
    await page.goto(`${prefix}/why-call`);
    // The old trigger rendered only after hydration, so wait for the page's
    // scripts to settle before asserting it is absent.
    await page.waitForLoadState('networkidle');
    const footer = page.locator('footer');
    await expect(footer).toBeVisible();
    await expect(footer.getByRole('button', { name: /feedback|comentarios/i })).toHaveCount(0);
    await expect(page.locator('#feedback, dialog[aria-labelledby="feedback-title"]')).toHaveCount(0);
  });
}

test('POST /api/feedback finds no route: 404, nothing accepted', async ({ request }) => {
  const res = await request.post('/api/feedback', {
    data: { category: 'bug', message: 'Is anything still listening here?' },
    headers: { 'x-forwarded-for': '203.0.113.201' },
  });
  expect(res.status()).toBe(404);
});
