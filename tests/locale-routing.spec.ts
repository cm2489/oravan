import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

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
 * the other locale.
 *
 * 2026-08-04: `localeCookie: false` joined `localeDetection: false`. The
 * cookie was written but never read (pure vestige) and written WRONG — an
 * explicit Español toggle measurably left it at 'en'. The explicit choice
 * is remembered on-device instead (lib/locale-pref.ts,
 * tests/locale-preference.spec.ts), and the main site now sets the same
 * number of cookies as the embeds: zero — pinned below.
 *
 * Copy is read by message key only, never as an English (or Spanish) literal.
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
    // The page's own title, in each language: English present, Spanish absent.
    expect(html).toContain(en.bills.title);
    expect(html).not.toContain(es.bills.title);
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
    // exact: the homepage hero carries its own thumb-reachable language link
    // (home.heroLocaleLink), whose accessible name contains this one as a
    // substring.
    await page.getByRole('link', { name: en.common.switchLocale, exact: true }).click();
    await expect(page).toHaveURL(/\/es$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  });

  // Dated (2026-07 critique round 2): the hero carries a second,
  // thumb-reachable language link. Delete this test if the hero drops it.
  test('the hero language link is a second, thumb-reachable switch into Spanish (and back)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('link', { name: en.home.heroLocaleLink }).click();
    await expect(page).toHaveURL(/\/es$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await page.getByRole('link', { name: es.home.heroLocaleLink }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('zero cookies on the main site — no NEXT_LOCALE, not even on an explicit toggle', async ({
    page,
    request,
  }) => {
    for (const path of ['/', '/es', '/es/bills']) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.headers()['set-cookie'], `${path} set a cookie`).toBeUndefined();
    }
    await page.goto('/');
    await page.getByRole('link', { name: en.common.switchLocale, exact: true }).click();
    await expect(page).toHaveURL(/\/es$/);
    await page.goto('/es/bills');
    expect(await page.context().cookies()).toHaveLength(0);
  });
});
