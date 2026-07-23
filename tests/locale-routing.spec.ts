import { expect, test } from '@playwright/test';

/*
 * S6 persona gate (founder decision, 2026-07-07): URLs are authoritative.
 * i18n/routing.ts sets `localeDetection: false`, so a stored NEXT_LOCALE=es
 * cookie must NEVER 307-redirect a bare English URL to its /es twin. Before
 * this, once anyone visited an /es page the cookie silently served Spanish on
 * every later bare-URL English link — the shared-library-terminal trap the
 * persona panel caught, and the same next-intl default that corrupted the S6
 * capture run. This guards the decision from a silent regression if the
 * next-intl default ever flips back.
 *
 * The switcher case proves the flip side: turning OFF passive detection does
 * NOT break an EXPLICIT language choice — LocaleSwitcher still navigates to
 * the other locale (and next-intl still writes the cookie on that click).
 */

test.describe('locale routing — URLs authoritative (localeDetection off)', () => {
  test('a stale NEXT_LOCALE=es cookie does not redirect a bare English URL', async ({ request }) => {
    const res = await request.get('/bills', {
      headers: { cookie: 'NEXT_LOCALE=es' },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(200); // NOT 307 -> /es/bills
    const html = await res.text();
    expect(html).toContain('<html lang="en"');
    expect(html).not.toContain('Proyectos de ley activos'); // the ES bills heading
  });

  test('a prefixed /es URL stays Spanish regardless of an en cookie', async ({ request }) => {
    const res = await request.get('/es/bills', {
      headers: { cookie: 'NEXT_LOCALE=en' },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('<html lang="es"');
  });

  test('the language switcher still performs an explicit locale change', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // exact: the homepage hero gained its own thumb-reachable "Ver en
    // español" link (2026-07 critique round 2), whose accessible name
    // contains this one as a substring.
    await page.getByRole('link', { name: 'En español', exact: true }).click();
    await expect(page).toHaveURL(/\/es$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  });

  test('the hero language link is a second, thumb-reachable switch into Spanish (and back)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Ver en español' }).click();
    await expect(page).toHaveURL(/\/es$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await page.getByRole('link', { name: 'View in English' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});
