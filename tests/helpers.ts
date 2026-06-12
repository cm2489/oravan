import type { Page } from '@playwright/test';

/** Seed a saved ZIP the way the app stores it (must run after first navigation). */
export async function seedZip(page: Page, zip: string) {
  await page.evaluate((z) => localStorage.setItem('cabina.prefs', JSON.stringify({ zip: z })), zip);
}

/** Mock the AI script endpoint so tests are free, fast, and deterministic. */
export async function mockScriptApi(page: Page) {
  await page.route('**/api/script', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        script:
          "Hi, my name is [YOUR NAME], and I'm a constituent from [YOUR TOWN OR ZIP]. I'm calling about S.J.Res. 99. MOCKED SCRIPT BODY. Thank you for your time.",
        cached: false,
      }),
    })
  );
}
