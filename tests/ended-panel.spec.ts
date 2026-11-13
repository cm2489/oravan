import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { E2E_TENANT_TOKEN } from './fixtures/e2e-tenant';
import { callTool } from './helpers';

/*
 * THE ENDED STATE ON THE RENDERED SITE (stage 3 of the new-Congress work,
 * 2026-11-13; the owner's decision of Nov 12, 2026 to keep the 119th
 * Congress's bills as an archive marked "ended").
 *
 * The ended list (lib/congress.mjs) is empty until the January 2027 switch, so
 * an ordinary build shows nothing ended and this spec SKIPS. It runs against a
 * local REVIEW build, the only build that shows the state before January:
 *
 *   ORAVAN_REVIEW_ENDED_CONGRESS=119 E2E_SERVER_MODE=build node tests/e2e-server.mjs
 *   E2E_SERVER_MODE=start PW_PORT=3300 node tests/e2e-server.mjs &
 *   PW_REVIEW_ENDED=119 PW_NO_WEBSERVER=1 npx playwright test tests/ended-panel.spec.ts --project=webkit-desktop
 *
 * (The review setting is refused in CI by lib/ended-state.mjs, so CI never
 * runs this spec; the unit-level proof is tests/ended-state.unit.spec.ts.)
 *
 * The bills: S.J.Res. 99 (a joint resolution on the Senate calendar, open
 * today), H.R. 1 (Public Law 119-21) and H.R. 4930 (passed both chambers, no
 * signature on the record on 2026-11-13).
 */

test.skip(process.env.PW_REVIEW_ENDED !== '119', 'needs a review build with the 119th shown as ended');

const OPEN = 'sjres-99-119';
const LAW = 'hr-1-119';
const PRESENTED = 'hr-4930-119';

async function noCallApparatus(page: import('@playwright/test').Page, m: typeof en) {
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: m.bill.scriptTitle })).toHaveCount(0);
  await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
  await expect(page.locator('[data-call-cta]')).toHaveCount(0);
  await expect(page.locator('[data-floating-call]')).toHaveCount(0);
  await expect(page.locator('[data-walkthrough-disclosure]')).toHaveCount(0);
}

for (const { locale, prefix, m } of [
  { locale: 'en', prefix: '', m: en },
  { locale: 'es', prefix: '/es', m: es },
] as const) {
  test(`${locale}: an open bill of the ended Congress shows the note where the call panel stood, and keeps the decode`, async ({
    page,
  }) => {
    await page.goto(`${prefix}/bills/${OPEN}`);
    const panel = page.locator('[data-ended-panel]');
    await expect(panel).toHaveAttribute('data-ended-panel', 'ended');
    await expect(panel.getByRole('heading', { name: m.bill.settled.title })).toBeVisible();
    await expect(panel.locator('[data-ended-note]')).toHaveText(m.bill.ended.note);
    await noCallApparatus(page, m);
    // The long label in the header chip, the decode and its AI label stay.
    await expect(page.locator('main header p').first()).toContainText(m.bill.ended.statusLong);
    await expect(page.getByText(m.bill.aiLabel).first()).toBeVisible();
    await expect(page.locator('#decoded')).toBeVisible();
    // No floor band (its call-to-action is the band's own link).
    await expect(page.getByRole('link', { name: m.bill.floor.cta })).toHaveCount(0);
    // The stepper says it ended, not a stage it can no longer move from.
    await expect(page.locator('[data-journey-ended]')).toHaveText(m.bill.ended.statusLong);
  });

  test(`${locale}: a law of the ended Congress keeps "This is law" with the small line`, async ({ page }) => {
    await page.goto(`${prefix}/bills/${LAW}`);
    const panel = page.locator('[data-settled-panel]');
    await expect(panel).toHaveAttribute('data-settled-panel', 'law');
    await expect(panel.locator('[data-settled-outcome]')).toHaveText(m.bill.settled.law);
    await expect(panel.locator('[data-ended-law-line]')).toHaveText(m.bill.ended.lawLine);
    await noCallApparatus(page, m);
  });

  test(`${locale}: a bill both chambers passed shows the President line and no call`, async ({ page }) => {
    await page.goto(`${prefix}/bills/${PRESENTED}`);
    const panel = page.locator('[data-ended-panel]');
    await expect(panel).toHaveAttribute('data-ended-panel', 'presented');
    await expect(panel.locator('[data-ended-note]')).toHaveText(m.bill.ended.presented);
    await noCallApparatus(page, m);
  });

  test(`${locale}: the bills list has no "Deciding now" or "Moving" band, and labels the cards "${m.bills.status.ended}"`, async ({
    page,
  }) => {
    await page.goto(`${prefix}/bills`);
    await expect(page.locator('#band-now')).toHaveCount(0);
    await expect(page.locator('#band-moving')).toHaveCount(0);
    await expect(page.getByText(m.bills.status.ended, { exact: true }).first()).toBeVisible();
  });
}

test('the action-panel embed shows the note and mounts no panel', async ({ page }) => {
  await page.goto(`/embed/action-panel?locale=en&slug=${OPEN}&token=${E2E_TENANT_TOKEN}`);
  await expect(page.locator('[data-ended-panel]')).toHaveAttribute('data-ended-panel', 'ended');
  await expect(page.locator('[data-ended-note]')).toHaveText(en.bill.ended.note);
  await expect(page.getByRole('radio')).toHaveCount(0);
});

test('the bill-card embed prints the long label', async ({ page }) => {
  await page.goto(`/embed/bill-card?locale=es&slug=${OPEN}`);
  await expect(page.locator('.bc-status')).toHaveText(es.bill.ended.statusLong);
});

test('the script route refuses an ended bill', async ({ request }) => {
  const res = await request.post('/api/script', {
    data: { slug: OPEN, stance: 'support', locale: 'en' },
    headers: { 'x-forwarded-for': '203.0.113.77' },
  });
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({ error: 'ended' });
});

test('MCP get_bill reads decision_state "ended" with no act_url', async ({ request }) => {
  const result = await callTool(request, 'get_bill', { slug: OPEN, locale: 'en' });
  const bill = (result.structuredContent as { bill: { decision_state: string; act_url: string | null } }).bill;
  expect(bill.decision_state).toBe('ended');
  expect(bill.act_url).toBeNull();
});
