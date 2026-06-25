import { expect, type Page } from '@playwright/test';

/**
 * Wait for the bills feed to hydrate before driving its controlled inputs.
 * Filling the search box (or clicking a chip) before React attaches wedges the
 * page: the interaction lands in the DOM but its handler never fires, and the
 * controlled input never recovers within that page load. The "/" accelerator
 * is installed by the same effect that makes the feed interactive, so a focus
 * from it proves we're hydrated - and unlike fill(), pressing "/" can't wedge.
 */
export async function waitForFeedHydrated(page: Page) {
  const search = page.getByRole('searchbox');
  await expect(async () => {
    await page.keyboard.press('/');
    await expect(search).toBeFocused({ timeout: 250 });
  }).toPass({ timeout: 15_000 });
}

/** Seed a saved ZIP the way the app stores it (must run after first navigation). */
export async function seedZip(page: Page, zip: string) {
  await page.evaluate((z) => localStorage.setItem('rostra.prefs', JSON.stringify({ zip: z })), zip);
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
