import { expect, test } from '@playwright/test';
import { mockScriptApi, seedZip } from './helpers';

const BILL = '/bills/sjres-99-119';

test('full flow: stance, script, outcome, impact, delete', async ({ page }) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await seedZip(page, '78501');
  await page.reload();

  // Stance -> mocked script appears, editable
  await page.getByRole('button', { name: 'I support it' }).click();
  const textarea = page.getByRole('textbox', { name: 'Your script' });
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveValue(/MOCKED SCRIPT BODY/);
  await textarea.fill('My edited script.');

  // Switching stance does not destroy the edit
  await page.getByRole('button', { name: 'I oppose it' }).click();
  await expect(textarea).toHaveValue(/MOCKED SCRIPT BODY/);
  await page.getByRole('button', { name: 'I support it' }).click();
  await expect(textarea).toHaveValue('My edited script.');

  // Call section: reps render with tel links
  await expect(page.getByText('Monica De La Cruz')).toBeVisible();
  expect(await page.locator('a[href^="tel:"]').count()).toBeGreaterThan(0);

  // Outcome: selected state + upsert (change, not duplicate)
  await page.getByRole('button', { name: 'Left a voicemail' }).first().click();
  await expect(
    page.getByRole('button', { name: 'Left a voicemail' }).first()
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Spoke to someone' }).first().click();
  const calls = await page.evaluate(() => JSON.parse(localStorage.getItem('rostra.calls') ?? '[]'));
  expect(calls).toHaveLength(1);
  expect(calls[0].outcome).toBe('contact');

  // Impact shows the record; per-record delete empties it
  await page.goto('/impact');
  await expect(page.getByText('S.J.Res. 99', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Delete this record' }).click();
  await expect(page.getByText('No calls logged yet')).toBeVisible();
});

test('big-type mode shows script and dial buttons, Escape closes', async ({ page }) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await seedZip(page, '78501');
  await page.reload();
  await page.getByRole('button', { name: 'I support it' }).click();
  await page.getByRole('button', { name: 'Read big' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/MOCKED SCRIPT BODY/)).toBeVisible();
  expect(await dialog.locator('a[href^="tel:"]').count()).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('script failure shows a retry that recovers', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/script', (route) => {
    calls++;
    if (calls === 1) return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"generation_failed"}' });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ script: 'RECOVERED SCRIPT', cached: false }) });
  });
  await page.goto(BILL);
  await page.getByRole('button', { name: 'I have questions' }).click();
  // Next.js's route announcer is also role=alert - filter to ours
  await expect(page.getByRole('alert').filter({ hasText: /try again/i })).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('textbox', { name: 'Your script' })).toHaveValue('RECOVERED SCRIPT');
});

test('spanish bill page serves translated decoded content', async ({ page }) => {
  await page.goto('/es' + BILL);
  await expect(page.getByRole('heading', { name: 'En claro' })).toBeVisible();
  await expect(page.locator('main')).toContainText(/El Congreso|El Senado|La Cámara|regla/i);
});
