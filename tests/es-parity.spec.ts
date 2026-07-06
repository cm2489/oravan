import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { seedZip } from './helpers';

/*
 * S6 — Spanish paired-script last mile. The call-script flow must be
 * structurally identical in both locales: same three stance lanes, the same
 * AI-label + review-before-call disclosure, and no English leaking into the
 * ES path. The generation API is mocked (per-stance, echoing the request) so
 * these tests never spend a token and can assert exactly what the client
 * sends: /api/script must receive locale "es" for every stance on an ES page.
 */

const BILL = '/bills/sjres-99-119'; // same stable slug flow.spec.ts drives

const STANCES = ['support', 'oppose', 'undecided'] as const;

/** Mock /api/script per stance and record every request body the panel sends. */
async function mockScriptApiCapturing(page: Page, sent: Array<Record<string, unknown>>) {
  await page.route('**/api/script', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        script: `GUION SIMULADO (${body.stance}): Buenos días, me llamo [TU NOMBRE] y soy constituyente de [TU CIUDAD O CÓDIGO POSTAL]. Llamo sobre la S.J.Res. 99. Gracias por su tiempo.`,
        cached: false,
      }),
    });
  });
}

test('ES bill page: script UI is fully localized across all three stances', async ({ page }) => {
  const sent: Array<Record<string, unknown>> = [];
  await mockScriptApiCapturing(page, sent);
  await page.goto('/es' + BILL);
  await seedZip(page, '78501');
  await page.reload();

  const stanceLabels = {
    support: es.bill.stance.support, // "Lo apoyo"
    oppose: es.bill.stance.oppose, // "Me opongo"
    undecided: es.bill.stance.undecided, // "Me preocupa"
  };
  const textarea = page.getByRole('textbox', { name: es.bill.scriptTitle });

  for (const stance of STANCES) {
    await page.getByRole('button', { name: stanceLabels[stance] }).click();
    // The mocked draft for THIS stance renders in the ES-labeled textarea.
    await expect(textarea).toHaveValue(new RegExp(`GUION SIMULADO \\(${stance}\\)`));
    // The AI-label + review-before-call disclosure sits beside every script.
    await expect(page.getByText(es.bill.scriptDisclaimer)).toBeVisible();
  }

  // The concern lane carries its honest-expectations note, in Spanish.
  await expect(page.getByText(es.bill.concernNote)).toBeVisible();

  // Every request the ES page made declared locale "es" — one per stance lane.
  expect(sent).toHaveLength(3);
  expect(sent.map((b) => b.stance).sort()).toEqual([...STANCES].sort());
  for (const body of sent) expect(body.locale).toBe('es');

  // No EN leakage on the script surfaces of the ES page.
  for (const englishString of [
    en.bill.scriptDisclaimer,
    en.bill.scriptTitle,
    en.bill.stance.support,
    en.bill.stance.oppose,
    en.bill.stance.undecided,
  ]) {
    await expect(page.getByText(englishString, { exact: true })).toHaveCount(0);
  }
});

test('ES call moment: dial mode and outcome logging speak Spanish end to end', async ({ page }) => {
  const sent: Array<Record<string, unknown>> = [];
  await mockScriptApiCapturing(page, sent);
  await page.goto('/es' + BILL);
  await seedZip(page, '78501');
  await page.reload();

  await page.getByRole('button', { name: es.bill.stance.support }).click();
  await expect(page.getByRole('textbox', { name: es.bill.scriptTitle })).toBeVisible();

  // Call mode opens as an ES-labeled dialog with the script and tel: links.
  await page.getByRole('button', { name: es.bill.startCall }).click();
  const dialog = page.getByRole('dialog', { name: es.bill.callTitle });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/GUION SIMULADO/)).toBeVisible();
  // Fresh profile: the first-call voicemail nudge shows, localized.
  await expect(dialog.getByText(es.bill.firstCallTitle)).toBeVisible();
  // Auto-waiting assertion: the dial buttons appear once /api/reps resolves.
  await expect(dialog.locator('a[href^="tel:"]').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // The voicemail-legitimizing beats render in Spanish.
  await expect(page.getByText(es.bill.afterHoursTitle)).toBeVisible();
  await expect(page.getByText(es.bill.staffNote)).toBeVisible();

  // Outcome chips log in Spanish and the milestone lands localized.
  await page.getByRole('button', { name: es.bill.outcome.voicemail }).first().click();
  await expect(
    page.getByRole('button', { name: es.bill.outcome.voicemail }).first()
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(es.bill.loggedFirst)).toBeVisible();
});

/*
 * The 3-stance × 2-locale matrix, pinned at the source of truth. UI parity
 * above proves rendering; this proves no locale can drift structurally —
 * every stance lane, outcome, and script-flow string exists in both files
 * and the ES side is actually Spanish (a copied-over English value would
 * pass a pure key-parity check).
 */
test.describe('3-stance × 2-locale matrix', () => {
  test('both locales expose exactly the three stance lanes', () => {
    for (const messages of [en, es]) {
      expect(Object.keys(messages.bill.stance).sort()).toEqual([...STANCES].sort());
      expect(Object.keys(messages.bill.outcome).sort()).toEqual(
        ['contact', 'voicemail', 'unavailable'].sort()
      );
    }
  });

  test('script-flow strings exist in both locales and are not English copies', () => {
    const scriptFlowKeys = [
      'actTitle',
      'actSub',
      'stanceQ',
      'concernNote',
      'scriptTitle',
      'scriptHint',
      'scriptDisclaimer',
      'scriptError',
      'rateLimited',
      'callTitle',
      'startCall',
      'editScript',
      'copyScript',
      'scriptCopied',
      'afterHoursTitle',
      'afterHoursBody',
      'staffNote',
      'firstCallTitle',
      'firstCallBody',
      'preDialTitle',
      'preDialBody',
      'officeHoursTitle',
      'officeHoursOpenBody',
      'officeHoursClosedBody',
    ] as const;
    for (const key of scriptFlowKeys) {
      const enValue = en.bill[key];
      const esValue = es.bill[key];
      expect(typeof enValue, `en.bill.${key}`).toBe('string');
      expect(typeof esValue, `es.bill.${key}`).toBe('string');
      expect(esValue, `es.bill.${key} must not be the English string`).not.toBe(enValue);
    }
    for (const stance of STANCES) {
      expect(es.bill.stance[stance], `es.bill.stance.${stance}`).not.toBe(en.bill.stance[stance]);
    }
  });

  test('the walkthrough demo script matches the live placeholder conventions', () => {
    // The phone-mock snippet is the first script a visitor ever reads; it must
    // model the same placeholders /api/script actually emits per locale.
    expect(en.walkthrough.phone.scriptSnippet).toContain('[YOUR NAME]');
    expect(en.walkthrough.phone.scriptSnippet).toContain('[YOUR TOWN OR ZIP]');
    expect(es.walkthrough.phone.scriptSnippet).toContain('[TU NOMBRE]');
    expect(es.walkthrough.phone.scriptSnippet).toContain('[TU CIUDAD O CÓDIGO POSTAL]');
    // No anglicized placeholder sneaks back into the ES demo.
    expect(es.walkthrough.phone.scriptSnippet).not.toContain('ZIP]');
  });
});
