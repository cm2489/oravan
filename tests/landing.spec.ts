import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { districtsForZip, repsForDistrict } from '../lib/core';

/** A ZIP with one district, a seated House member and two senators — the
 *  names the lookup must print come from the same data the page reads. */
const ZIP = '78501';
const ZIP_REPS = districtsForZip(ZIP).flatMap(repsForDistrict).map((l) => l.name);

test('landing renders and ZIP search reaches reps', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(en.home.heroTitle);
  await page.getByLabel(en.home.zipLabel).fill(ZIP);
  await page.getByRole('button', { name: en.home.zipCta }).click();
  await expect(page).toHaveURL(new RegExp(`/reps\\?zip=${ZIP}`));
  expect(ZIP_REPS.length, `the fixture ZIP ${ZIP} must resolve to members in data/`).toBeGreaterThan(0);
  for (const name of ZIP_REPS) {
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  }
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
  await expect(page.getByRole('heading', { level: 1 })).toContainText(es.home.heroTitle);
  await expect(page.getByLabel(es.home.zipLabel)).toBeVisible();
  await expect(page.getByRole('button', { name: es.home.zipCta })).toBeVisible();
});

test('footer privacy link is reachable and clickable on mobile', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'regression guard for the mobile tab-bar overlap');
  await page.goto('/');
  const link = page.locator('footer').getByRole('link', { name: en.common.footer.privacy });
  await link.scrollIntoViewIfNeeded();
  await link.click();
  await expect(page).toHaveURL(/\/privacy/);
});

test('Enter in the hero ZIP field always submits (2026-08 gate)', async ({
  page,
}) => {
  // The incumbent's address field silently swallowed Enter on one of two
  // runs — at the moment of highest intent. Ours must submit either way:
  // hydrated (onSubmit) or not (the form's own action="/reps" method=get).
  await page.goto('/');
  await page.getByLabel(en.home.zipLabel).fill(ZIP);
  await page.getByLabel(en.home.zipLabel).press('Enter');
  await expect(page).toHaveURL(new RegExp(`/reps\\?zip=${ZIP}`));
});

test('the Spanish language switcher keeps full-size cells beside the header trust line', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'the header sub-bar that crowded the switcher is a wide-screen layout');
  await page.goto('/es');
  // The regression that found this: an inline trust line crushed the
  // language switcher to 25px cells and swallowed its clicks. Both cells
  // must hold their full tap width.
  const cells = page
    .locator('header')
    .getByRole('group', { name: es.common.localeGroupLabel })
    .getByRole('link');
  await expect(cells).toHaveCount(2);
  for (const width of await cells.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width))) {
    expect(width).toBeGreaterThan(60);
  }
});

/*
 * THE LOCALE TRAP (2026-08-09 crown rewiring). The homepage filters the
 * crowned bill out of the plain ruled listing beneath it, and that filter used
 * to be REFERENCE equality (`top.filter((b) => b !== feature)`).
 * `localizeBill()` returns a FRESH object for /es, and since the crown's
 * candidate pool is now built independently of the 4-card shortlist, the two
 * are never the same object — so on Spanish, and only on Spanish, the crowned
 * bill wore the crown AND appeared again in the list 200px below it. An
 * English-only smoke test cannot see that, which is the entire reason this
 * drives both locales; the fix is slug equality, and this is its pin.
 *
 * Read through hooks and hrefs only: `[data-crown]` is the panel, and the
 * crowned bill is whatever page its links point at.
 */
test('the crowned bill appears exactly once in the week, in both locales', async ({ page }) => {
  for (const path of ['/', '/es']) {
    await page.goto(path);
    const crown = page.locator('[data-crown]');
    // Absent on a quiet week, which is a valid state and not this test's subject.
    if ((await crown.count()) === 0) {
      test.skip(true, `quiet week: no crown rendered on ${path}`);
      return;
    }
    // One crown per page, and it wears the week.
    await expect(crown, `${path}: exactly one crown`).toHaveCount(1);
    const week = page.locator('[data-front-door="week"]');
    await expect(week.locator('[data-crown]'), `${path}: the crown sits in the week`).toHaveCount(1);

    const crowned = await crown.evaluate((el) => {
      const a = el.querySelector<HTMLAnchorElement>('a[href*="/bills/"]');
      return a ? new URL(a.href).pathname : null;
    });
    expect(crowned, `${path}: the crown links to its bill`).toBeTruthy();
    const listedAgain = await week.evaluate(
      (el, target) =>
        [...el.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(
          (a) => new URL(a.href).pathname === target && !a.closest('[data-crown]')
        ).length,
      crowned
    );
    expect(listedAgain, `${path}: ${crowned} is crowned, so it must not also be listed below`).toBe(0);
  }
});
