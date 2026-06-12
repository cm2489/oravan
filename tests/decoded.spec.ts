import { expect, test } from '@playwright/test';

// A-plus decoded structure: TL;DR + sections + computed journey.

test('decoded card renders sections and journey with current position', async ({ page }) => {
  await page.goto('/bills/hr-5582-119'); // House bill, in committee
  await expect(page.getByRole('heading', { name: 'What does this do?' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Who does it affect?' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Why does it matter?' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Where does it stand?' })).toBeVisible();
  // TL;DR strip with computed meta
  await expect(page.getByText(/-second read · 5 questions answered below/)).toBeVisible();
  // House-origin bill in committee: stepper note names the chamber
  await expect(page.getByText('Right now:')).toBeVisible();
  await expect(page.getByText(/a House committee is reviewing it/)).toBeVisible();
  // cost chips render for this bill
  await expect(page.getByRole('heading', { name: /What does it cost/ })).toBeVisible();
});

test('signed bill shows a completed journey', async ({ page }) => {
  await page.goto('/bills/hr-1-119');
  await expect(page.getByText('Now law')).toBeVisible();
  await expect(page.getByText(/the President signed it/)).toBeVisible();
});

test('senate bill journeys start in the Senate', async ({ page }) => {
  await page.goto('/bills/s-2280-119'); // Senate bill, passed chamber
  await expect(page.getByText('Senate committee')).toBeVisible();
  await expect(page.getByText(/it passed the Senate and now goes to the House/)).toBeVisible();
});

test('spanish bill page renders translated sections and journey', async ({ page }) => {
  await page.goto('/es/bills/hr-5582-119');
  await expect(page.getByRole('heading', { name: '¿Qué hace esto?' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '¿A quién afecta?' })).toBeVisible();
  await expect(page.getByText('Ahora mismo:')).toBeVisible();
});
