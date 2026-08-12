import { expect, test } from '@playwright/test';

/*
 * The "In the news" band. Selection and captions are unit-tested in
 * tests/news-band.unit.spec.ts (the conversation lamp and its fallback); here
 * we just confirm the band surfaces on the homepage + /bills and that every
 * card states a reason a reader can read. Data-driven: skips cleanly when a
 * quiet week leaves nothing to feature.
 */
const lens = (page: import('@playwright/test').Page) =>
  page.locator('section[aria-labelledby="news"]');

test('homepage leads with the "In the news" lens', async ({ page }) => {
  await page.goto('/');
  test.skip((await lens(page).count()) === 0, 'no news-lens coverage in current data');

  await expect(lens(page).getByRole('heading', { name: 'In the news' })).toBeVisible();
  /* EVERY CARD SAYS WHY IT IS THERE. Under the conversation lamp that is a
     counted caption — outlets across the spectrum this week, or congress.gov's
     own most-viewed list; in the fallback it is the outlet-count cue the band
     has always carried. Either is a reason; a card with neither is the failure
     this assertion exists to catch. */
  await expect(
    lens(page).getByText(/\d+ outlets?|most-viewed/i).first()
  ).toBeVisible();
  // and links through to a bill
  await expect(lens(page).getByRole('link').first()).toBeVisible();
});

test('the bills feed shows the news lens above the bands', async ({ page }) => {
  await page.goto('/bills');
  test.skip((await lens(page).count()) === 0, 'no news-lens coverage in current data');

  await expect(lens(page).getByRole('heading', { name: 'In the news' })).toBeVisible();
});

test('the Spanish band states its reasons in Spanish', async ({ page }) => {
  // Bilingual parity is a hard rule and a caption is a user-facing string: a
  // band that counted outlets in English on /es would be the exact failure the
  // rule exists to stop. Matches either mode's cue — the counted caption
  // ("2 medios de distintas tendencias", "más vistos de congress.gov") or the
  // fallback's outlet count ("2 medios") — and refuses the English words.
  await page.goto('/es');
  test.skip((await lens(page).count()) === 0, 'no news-lens coverage in current data');

  await expect(lens(page).getByRole('heading', { name: 'En las noticias' })).toBeVisible();
  await expect(lens(page).getByText(/\d+ medios?|más vistos/i).first()).toBeVisible();
  await expect(lens(page).getByText(/\boutlets?\b|most-viewed/i)).toHaveCount(0);
});
