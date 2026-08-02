import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { mockScriptApi } from './helpers';

/*
 * "The panel scrolls · the call stays" — and so does a ZIP submit (2026-08,
 * panel-navigation fix). The ZipForm instances INSIDE the bill page's call
 * panel (the rail's no-ZIP block and the call dialog's never-a-dead-end
 * block) resolve in place: submit saves the ZIP, the reps load into the
 * panel, and the freshly generated script — which lives only in component
 * state — survives. Navigation to /reps remains the home hero's and the
 * /reps page's own behavior (funnel I2 pins it), never this panel's.
 *
 * Fixtures proven by tests/reps.spec.ts: 78501 = a normal single-district
 * TX ZIP (Monica De La Cruz), 00000 = valid shape but unmatched, 33313 =
 * FL-20, a genuinely vacant House seat.
 *
 * LOCATOR SCOPING: while the dialog is open, the rail and the dialog each
 * mount a ZipForm and (in the new states) duplicate loading/not-found copy —
 * the exact e2e trap ActionPanel's own dialog comment documents. Every
 * locator here is scoped to the dialog or left rail-only (dialog closed).
 */

const BILL = '/bills/sjres-99-119'; // same stable slug flow/es-parity/call-action pin

for (const locale of ['en', 'es'] as const) {
  test(`${locale}: rail ZIP submit stays on the bill page — script intact, reps load in-panel`, async ({
    page,
  }) => {
    const messages = locale === 'en' ? en : es;
    await mockScriptApi(page);
    await page.goto(locale === 'es' ? '/es' + BILL : BILL); // deliberately NO seedZip

    await page.getByRole('radio', { name: messages.bill.stance.support }).click();
    const textarea = page.getByRole('textbox', { name: messages.bill.scriptTitle });
    await expect(textarea).toHaveValue(/MOCKED SCRIPT BODY/);

    // Submit a ZIP in the rail's own form (dialog closed: single instance).
    await page.getByLabel(messages.home.zipLabel).fill('78501');
    await page.getByRole('button', { name: messages.home.zipCta }).click();

    // The promise: reps arrive IN the panel, the URL never changes, and the
    // script draft is not destroyed by a navigation.
    await expect(page.getByText('Monica De La Cruz')).toBeVisible();
    await expect(page.locator('a[href^="tel:"]').first()).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${BILL.replace(/\//g, '\\/')}`));
    await expect(textarea).toHaveValue(/MOCKED SCRIPT BODY/);
  });
}

test('dialog ZIP submit (the P0): the mode stays open, script visible, dial links appear in-dialog', async ({
  page,
}) => {
  await mockScriptApi(page);
  await page.goto(BILL); // NO seedZip
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toBeVisible();
  await page.getByRole('button', { name: en.bill.startCall }).click();

  const dialog = page.getByRole('dialog', { name: en.bill.callTitle });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(en.home.zipLabel)).toBeVisible();

  // Fix the missing ZIP without leaving the mode.
  await dialog.getByLabel(en.home.zipLabel).fill('78501');
  await dialog.getByRole('button', { name: en.home.zipCta }).click();

  // The mode survives its own ZIP submit: still open, still on the bill
  // page, script still there, and the dial links land inside the dialog.
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('a[href^="tel:"]').first()).toBeVisible();
  await expect(dialog.getByText(/MOCKED SCRIPT BODY/)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(BILL.replace(/\//g, '\\/')));
});

test('unmatched ZIP in the rail: the /reps failure register in-panel, recoverable in place', async ({
  page,
}) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toBeVisible();

  await page.getByLabel(en.home.zipLabel).fill('00000');
  await page.getByRole('button', { name: en.home.zipCta }).click();

  // The honest not-found block (this used to be a silently empty rail):
  // role=alert with the /reps copy, still on the bill page, form re-shown.
  await expect(page.getByRole('alert').filter({ hasText: en.reps.zipNotFound })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(BILL.replace(/\//g, '\\/')));

  // Recovery proven: correct the ZIP right there.
  await page.getByLabel(en.home.zipLabel).fill('78501');
  await page.getByRole('button', { name: en.home.zipCta }).click();
  await expect(page.getByText('Monica De La Cruz')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(BILL.replace(/\//g, '\\/')));
});

test('reps lookup failure in the rail: Failure + retry recovers without leaving the page', async ({
  page,
}) => {
  await mockScriptApi(page);
  let repCalls = 0;
  await page.route('**/api/reps*', (route) => {
    repCalls += 1;
    if (repCalls === 1) {
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
    }
    return route.continue();
  });
  await page.goto(BILL);
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toBeVisible();

  await page.getByLabel(en.home.zipLabel).fill('78501');
  await page.getByRole('button', { name: en.home.zipCta }).click();

  await expect(page.getByRole('alert').filter({ hasText: en.bill.repsError })).toBeVisible();
  await page.getByRole('button', { name: en.bill.retry }).click();
  await expect(page.getByText('Monica De La Cruz')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(BILL.replace(/\//g, '\\/')));
});

test('vacant seat (FL-20) via the rail: vacancy named, senators still dialable, no departed member', async ({
  page,
}) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toBeVisible();

  await page.getByLabel(en.home.zipLabel).fill('33313');
  await page.getByRole('button', { name: en.home.zipCta }).click();

  await expect(page.getByText(en.reps.vacantSeat, { exact: true })).toBeVisible();
  await expect(page.getByText('Rick Scott')).toBeVisible();
  await expect(page.getByText('Ashley Moody')).toBeVisible();
  await expect(page.locator('a[href^="tel:"]').first()).toBeVisible();
  await expect(page.getByText('Cherfilus-McCormick')).toHaveCount(0);
});
