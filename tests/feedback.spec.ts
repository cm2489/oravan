import { expect, test, type Page } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * Beta feedback dialog. /api/feedback is intercepted at the browser edge
 * (same pattern as mockDistrictApi): the route's own behavior is pinned
 * separately in feedback.unit.spec.ts, so no test depends on a GitHub
 * token or the network.
 *
 * Note on pacing: the dialog holds submission until it has been open ~3s
 * (bot friction), so the success/error expectations use a generous timeout
 * instead of asserting immediacy.
 *
 * Copy is read BY KEY (feedback.*), formatted the way the dialog formats it,
 * so rewording a label or a notice in messages/*.json never fails this file.
 * What stays pinned is behaviour and privacy: the page context is editable
 * text the visitor can delete, the note travels in a POST body and never in a
 * URL, the honeypot stays empty, and a failed send keeps the draft.
 */
const t = createTranslator({ locale: 'en', messages: en, namespace: 'feedback' });
const tEs = createTranslator({ locale: 'es', messages: es, namespace: 'feedback' });
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The prefill the dialog writes for `path`: the key's prefix, then the path. */
const prefill = (prefix: string, path: string) => new RegExp(escapeRegExp(`${prefix}${path}`));

function mockFeedbackApi(page: Page, response: { status: number; body: Record<string, unknown> }) {
  const requests: { method: string; postData: string | null }[] = [];
  page.route('**/api/feedback', (route) => {
    requests.push({ method: route.request().method(), postData: route.request().postData() });
    return route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: JSON.stringify(response.body),
    });
  });
  return requests;
}

async function openDialog(page: Page) {
  const trigger = page.getByRole('button', { name: t('trigger') });
  await expect(trigger).toBeVisible({ timeout: 15_000 }); // renders post-hydration
  await trigger.click();
}

test('feedback flow: prefilled page context is editable, POST body only, success state', async ({
  page,
}) => {
  const requests = mockFeedbackApi(page, { status: 200, body: { ok: true } });
  await page.goto('/why-call');
  await openDialog(page);

  // Context by consent: the current path sits INSIDE the textarea as
  // ordinary deletable text, not attached invisibly.
  const textarea = page.getByLabel(t('messageLabel'));
  await expect(textarea).toHaveValue(prefill(t('pagePrefix'), '/why-call'));
  await expect(page.getByText(t('notice'))).toBeVisible();

  await page.getByRole('radio', { name: t('categoryBug') }).check();
  // Replacing the prefill wholesale = withholding the page context.
  await textarea.fill('The staffer counter reads NaN sometimes.');
  await page.getByRole('button', { name: t('send') }).click();

  await expect(page.getByRole('status').filter({ hasText: t('success') })).toBeVisible({
    timeout: 10_000,
  });

  // Log hygiene, pinned: the message went in a POST body, never in a URL.
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST');
  const body = JSON.parse(requests[0].postData ?? '{}');
  expect(body.category).toBe('bug');
  expect(body.message).toBe('The staffer counter reads NaN sometimes.');
  expect(body.website).toBe(''); // honeypot untouched by a real user
  expect(body.message).not.toContain(t('pagePrefix').trim()); // the deleted prefill stayed deleted
  expect(page.url()).not.toContain('NaN');

  await page.getByRole('button', { name: t('close') }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('dialog is escapable and validates before sending', async ({ page }) => {
  mockFeedbackApi(page, { status: 200, body: { ok: true } });
  await page.goto('/');
  await openDialog(page);
  await expect(page.getByRole('dialog')).toBeVisible();

  // No category yet: submitting explains instead of sending.
  await page.getByRole('button', { name: t('send') }).click();
  await expect(page.getByRole('alert').filter({ hasText: t('errorIncomplete') })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('server error: calm inline message, the draft is not lost', async ({ page }) => {
  mockFeedbackApi(page, { status: 503, body: { error: 'unavailable' } });
  await page.goto('/');
  await openDialog(page);
  await page.getByRole('radio', { name: t('categoryOther') }).check();
  await page.getByLabel(t('messageLabel')).fill('A note that must survive the failure.');
  await page.getByRole('button', { name: t('send') }).click();

  await expect(page.getByRole('alert').filter({ hasText: t('errorGeneric') })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByLabel(t('messageLabel'))).toHaveValue(
    'A note that must survive the failure.'
  );
});

test('rate limited: a gentle try-again-later message', async ({ page }) => {
  mockFeedbackApi(page, { status: 429, body: { error: 'rate_limited' } });
  await page.goto('/');
  await openDialog(page);
  await page.getByRole('radio', { name: t('categoryFeature') }).check();
  await page.getByLabel(t('messageLabel')).fill('hello');
  await page.getByRole('button', { name: t('send') }).click();
  await expect(page.getByRole('alert').filter({ hasText: t('errorRateLimited') })).toBeVisible({
    timeout: 10_000,
  });
});

test('bilingual parity in the flesh: the ES dialog is fully Spanish', async ({ page }) => {
  await page.goto('/es');
  const trigger = page.getByRole('button', { name: tEs('trigger') });
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.click();
  await expect(page.getByText(tEs('notice'))).toBeVisible();
  await expect(page.getByLabel(tEs('messageLabel'))).toHaveValue(
    prefill(tEs('pagePrefix'), '/')
  );
  await expect(page.getByRole('button', { name: tEs('send') })).toBeVisible();
});
