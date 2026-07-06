import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

test('normal district shows one rep and two senators with local offices', async ({ page }) => {
  await page.goto('/reps?zip=78501');
  await expect(page.getByText('Monica De La Cruz')).toBeVisible();
  await expect(page.getByText('John Cornyn')).toBeVisible();
  await expect(page.getByText('Ted Cruz')).toBeVisible();
  await expect(page.getByText(/^Local offices/).first()).toBeVisible();
});

test('DC explains the delegate situation instead of promising senators', async ({ page }) => {
  await page.goto('/reps?zip=20002');
  await expect(page.getByText(/elects a delegate/)).toBeVisible();
  await expect(page.getByText('Eleanor Holmes Norton')).toBeVisible();
  await expect(page.getByText(/Delegate ·/)).toBeVisible();
});

test('unknown ZIP gets a recoverable error', async ({ page }) => {
  await page.goto('/reps?zip=00000');
  await expect(page.getByRole('alert').filter({ hasText: /couldn't match/i })).toBeVisible();
});

/*
 * S24 groundwork (docs/ideation/2026-07-05-build-gtm-strategy.md §9.1(f)):
 * FL-20 is a real, currently-vacant House seat already baked into
 * data/legislators.json (Cherfilus-McCormick resigned Apr 21, 2026, and
 * Florida's new map eliminates the district outright - no special election
 * is on record). ZIP 33313 maps to FL-20 alone, so this is the sharpest
 * regression fixture available: the reps page must show an explicit vacant
 * notice, never a stale departed-member card, and never invent an
 * election-pending claim.
 */
test.describe('vacant seat (FL-20)', () => {
  test('English: explicit vacant notice, senators still shown, no invented election claim', async ({
    page,
  }) => {
    await page.goto('/reps?zip=33313');
    await expect(page.getByText(en.reps.vacantSeat, { exact: true })).toBeVisible();
    await expect(page.getByText(en.reps.vacantSeatBody)).toBeVisible();
    await expect(page.getByRole('link', { name: en.reps.vacantSeatLink })).toHaveAttribute(
      'href',
      'https://www.house.gov/representatives/find-your-representative'
    );
    // Senators for the state are unaffected by a House vacancy.
    await expect(page.getByText('Rick Scott')).toBeVisible();
    await expect(page.getByText('Ashley Moody')).toBeVisible();
    // Never show the departed member, never speculate about a special election.
    await expect(page.getByText('Cherfilus-McCormick')).toHaveCount(0);
    await expect(page.getByText(/special election/i)).toHaveCount(0);
    await expect(page.getByText(/election pending/i)).toHaveCount(0);
  });

  test('Spanish: same vacant fact, fully localized', async ({ page }) => {
    await page.goto('/es/reps?zip=33313');
    await expect(page.getByText(es.reps.vacantSeat, { exact: true })).toBeVisible();
    await expect(page.getByText(es.reps.vacantSeatBody)).toBeVisible();
    await expect(page.getByRole('link', { name: es.reps.vacantSeatLink })).toHaveAttribute(
      'href',
      'https://www.house.gov/representatives/find-your-representative'
    );
    await expect(page.getByText('Rick Scott')).toBeVisible();
    await expect(page.getByText('Ashley Moody')).toBeVisible();
    // No English leakage on the vacant-seat surface.
    await expect(page.getByText(en.reps.vacantSeat, { exact: true })).toHaveCount(0);
    await expect(page.getByText('Cherfilus-McCormick')).toHaveCount(0);
  });

  test('/api/reps names the vacant seat explicitly (fact only, no since-date exposed)', async ({
    request,
  }) => {
    const res = await request.get('/api/reps?zip=33313');
    const body = await res.json();
    expect(body.vacancies).toEqual([{ state: 'FL', district: 20 }]);
    const names = (body.reps as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['Rick Scott', 'Ashley Moody']));
  });

  test('/api/reps returns an empty vacancies array for a fully occupied district', async ({
    request,
  }) => {
    const res = await request.get('/api/reps?zip=78501');
    const body = await res.json();
    expect(body.vacancies).toEqual([]);
  });
});
