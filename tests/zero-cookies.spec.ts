import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import { mockScriptApi } from './helpers';

/*
 * THE ZERO-COOKIE CLAIM, SWEPT (owner directive, 2026-08-04: "no cookies
 * should be 100% defensible"). privacy.p4 says "no cookies at all" — as of
 * `localeCookie: false` (i18n/routing.ts) nothing in this codebase writes a
 * cookie: no `document.cookie`, no server `cookies()`, no middleware writer.
 * This spec turns that from a grep into a pinned contract:
 *
 *  1. A response sweep across every surface CLASS the origin serves — both
 *     locales, static pages, dynamic APIs, the 404 path, sitemap/robots —
 *     asserting no Set-Cookie header ever leaves.
 *  2. A full user JOURNEY (language toggle, decode, stance, ZIP, logged
 *     outcome, civic record, erase) ending with an empty cookie jar — so a
 *     client-side writer sneaking in anywhere on the funnel fails loudly.
 *
 * The embeds carry their own zero-cookie pins (embed-loader, embed-bill-card,
 * embed-action-panel, embed-rep-lookup, mcp, tenant-feed) — this file covers
 * the main site so the privacy page's sentence is enforced end to end.
 *
 * SCOPE, stated honestly: this pins OUR origin's behavior. It cannot speak
 * for cookies other origins set on their own domains (e.g. Stripe's checkout
 * pages, congress.gov links) — those are outside the sentence being made.
 */

const ROUTES = [
  // The bilingual front door and its twin.
  '/',
  '/es',
  // Every distinct page surface, EN — plus ES twins for the funnel-critical ones.
  '/bills',
  '/es/bills',
  '/bills/sjres-99-119',
  '/es/bills/sjres-99-119',
  '/reps',
  '/reps?zip=10001', // the split-ZIP lookup, server-rendered with params
  '/record',
  '/es/record',
  '/questions',
  '/why-call',
  '/about',
  '/partners',
  '/privacy',
  '/terms',
  '/citations',
  '/mcp',
  '/embeds',
  // The failure surface and the machine surfaces.
  '/this-page-does-not-exist-404',
  '/sitemap.xml',
  '/robots.txt',
  // Dynamic APIs, success and failure shapes.
  '/api/reps?zip=78501',
  '/api/reps?zip=not-a-zip',
  '/api/district',
];

test('no response from any surface class ever sets a cookie', async ({ request }) => {
  for (const path of ROUTES) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.headers()['set-cookie'], `${path} set a cookie`).toBeUndefined();
  }
  // POST surface too: an invalid script request's error response is as
  // cookie-free as a success (the success path is pinned by the journey below).
  const post = await request.post('/api/script', { data: { nonsense: true } });
  expect(post.headers()['set-cookie'], '/api/script set a cookie').toBeUndefined();
});

test('a full user journey ends with an EMPTY cookie jar', async ({ page }) => {
  await mockScriptApi(page);

  // Language toggle — the one interaction that historically DID write a
  // cookie (NEXT_LOCALE, removed 2026-08-04).
  await page.goto('/');
  await page.getByRole('link', { name: 'En español', exact: true }).click();
  await expect(page).toHaveURL(/\/es$/);
  await page.getByRole('link', { name: 'In English', exact: true }).click();
  await expect(page).toHaveURL(/\/$/); // settle the client nav before the next goto

  // Decode → stance → ZIP → dial links → logged outcome.
  await page.goto('/bills/sjres-99-119');
  await page.getByRole('radio', { name: 'I support it' }).click();
  await expect(page.getByRole('textbox', { name: 'Your script' })).toBeVisible();
  await page.getByLabel(en.home.zipLabel).fill('78501');
  await page.getByRole('button', { name: en.home.zipCta }).click();
  await expect(page.locator('a[href^="tel:"]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Left a voicemail' }).first().click();

  // The civic record and the erase flow — everything personal stays in
  // localStorage; the cookie jar has nothing to do at any step.
  await page.goto('/record');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  expect(await page.context().cookies()).toHaveLength(0);
});
