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

/*
 * A CONCURRENT RESOLUTION NEVER VISITS THE PRESIDENT.
 *
 * hconres/sconres are not presented under Article I §7 — both chambers adopt
 * the text and that is the end of it. The stepper printed "President's desk"
 * on all six of them until 2026-08-09, in both languages, under a header that
 * promises it cannot hallucinate procedure. sconres-38-119 is a budget
 * resolution on the Senate floor calendar; the predicate itself is pinned
 * corpus-wide in tests/bill-journey.unit.spec.ts.
 */
test('a concurrent resolution ends at adoption, not the President', async ({ page }) => {
  await page.goto('/bills/sconres-38-119');
  await expect(page.getByText('Adopted by both chambers')).toBeVisible();
  await expect(page.getByText("President's desk")).toHaveCount(0);
  await expect(page.getByText(/never goes to the President and does not become law/)).toBeVisible();
});

test('a concurrent resolution ends at adoption in Spanish too', async ({ page }) => {
  await page.goto('/es/bills/hconres-113-119');
  await expect(page.getByText('Aprobación en ambas cámaras')).toBeVisible();
  await expect(page.getByText('Escritorio del Presidente')).toHaveCount(0);
  await expect(page.getByText(/nunca llega al Presidente y no se convierte en ley/)).toBeVisible();
});

/*
 * NEITHER DOES A PROPOSED CONSTITUTIONAL AMENDMENT.
 *
 * Article V: two thirds of both chambers propose, three quarters of the
 * states ratify, the President never signs and cannot veto. The stepper
 * promised a President's desk on all 16 of the corpus's amendment proposals
 * until 2026-08-12 — the class the concurrent-resolution fix above named as
 * its known limit and declined to guess at. hjres-1-119 is on the House
 * Calendar, so it renders the trailer as well as the fifth step; the
 * predicate and the corpus sweep are pinned in tests/bill-journey.unit.spec.ts.
 */
test('an Article V amendment proposal ends at the states, not the President', async ({ page }) => {
  await page.goto('/bills/hjres-1-119');
  await expect(page.getByText('Sent to the states')).toBeVisible();
  await expect(page.getByText("President's desk")).toHaveCount(0);
  await expect(page.getByText(/three quarters of them have to ratify it/)).toBeVisible();
});

test('an Article V amendment proposal ends at the states in Spanish too', async ({ page }) => {
  await page.goto('/es/bills/hjres-1-119');
  await expect(page.getByText('Enviada a los estados')).toBeVisible();
  await expect(page.getByText('Escritorio del Presidente')).toHaveCount(0);
  await expect(page.getByText(/tres cuartas partes de ellos tienen que ratificarla/)).toBeVisible();
});

/* An ORDINARY joint resolution — a CRA disapproval — genuinely is presented,
 * so the title heuristic above must leave its own vehicle type alone. */
test('an ordinary joint resolution still ends at the President', async ({ page }) => {
  await page.goto('/bills/sjres-99-119');
  await expect(page.getByText("President's desk")).toBeVisible();
  await expect(page.getByText('Sent to the states')).toHaveCount(0);
});

test('an ordinary bill still ends at the President', async ({ page }) => {
  await page.goto('/bills/hr-5582-119');
  await expect(page.getByText("President's desk")).toBeVisible();
  await expect(page.getByText(/before reaching the President/)).toBeVisible();
});

test('spanish bill page renders translated sections and journey', async ({ page }) => {
  await page.goto('/es/bills/hr-5582-119');
  await expect(page.getByRole('heading', { name: '¿Qué hace esto?' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '¿A quién afecta?' })).toBeVisible();
  await expect(page.getByText('Ahora mismo:')).toBeVisible();
});
