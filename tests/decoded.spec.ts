import { expect, test } from '@playwright/test';

// A-plus decoded structure: TL;DR + sections + computed journey.

test('decoded card renders sections and journey with current position', async ({ page }) => {
  await page.goto('/bills/hr-5582-119'); // House bill, in committee
  await expect(page.getByRole('heading', { name: 'What it does' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Who it affects' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Why it matters' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /path to law/ })).toBeVisible();
  await expect(page.getByText('You are here')).toBeVisible();
  // House-origin bill: committee step is the current one
  await expect(page.getByText('House committee review')).toBeVisible();
});

test('signed bill shows a completed journey', async ({ page }) => {
  await page.goto('/bills/hr-1-119');
  await expect(page.getByText('Now law')).toBeVisible();
  await expect(page.getByText('You are here')).toHaveCount(0);
});

test('senate bill journeys start in the Senate', async ({ page }) => {
  await page.goto('/bills/s-2280-119'); // Senate bill, passed chamber
  await expect(page.getByText('Introduced in the Senate')).toBeVisible();
  await expect(page.getByText(/House committee and vote/)).toBeVisible();
});

test('spanish bill page renders translated sections and journey', async ({ page }) => {
  await page.goto('/es/bills/hr-5582-119');
  await expect(page.getByRole('heading', { name: 'Qué hace' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'A quién afecta' })).toBeVisible();
  await expect(page.getByText('Estás aquí')).toBeVisible();
});
