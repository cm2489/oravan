import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { getMoments } from '../lib/moments';
import { questionVehicles } from '../lib/moments-ui';

/*
 * PICTURES OF THE UI AUDIT FIXES (2026-11-22), for the owner's before and
 * after. Each test opens the page a fix lives on, checks the one property the
 * fix changed where that can be measured without guessing, and writes a
 * viewport picture to ui-fixes-shots/ (uploaded by the e2e shards as
 * `ui-fixes-shots-<shard>`). The pictures are for review; the checks are the
 * part that guards the fix.
 *
 * Projects: webkit-mobile (390), webkit-desktop (1280) and, for the tests
 * tagged @reflow (the home page: the ZIP button and the phone bar), webkit-320.
 */

const SHOTS = path.join(process.cwd(), 'ui-fixes-shots');

async function shot(page: Page, info: TestInfo, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(SHOTS, `${info.project.name}-${name}.png`) });
}

/** Scroll so the element sits a little below the top of the screen, with context above it. */
async function bring(page: Page, selector: string) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 120));
  }, selector);
}

const LOCALES = [
  { prefix: '', lang: 'en', m: en },
  { prefix: '/es', lang: 'es', m: es },
] as const;

for (const { prefix, lang, m } of LOCALES) {
  test(`${lang} home: the ZIP button reads as a button on one line; the phone bar says ${m.common.nav.tabQuestions} @reflow`, async ({
    page,
  }, info) => {
    await page.goto(`${prefix}/`);
    const submit = page.locator('[data-hero]').getByRole('button', { name: m.home.zipCtaShort, exact: true });
    await expect(submit).toBeVisible();
    // One 48px line: a wrapped label made it 70px or more.
    const box = await submit.boundingBox();
    expect(box!.height, 'the hero ZIP button is one line tall').toBeLessThanOrEqual(50);
    // A filled button, not the field's paper box.
    const bg = await submit.evaluate((el) => getComputedStyle(el).backgroundColor);
    const field = await page.locator('[data-hero] [data-zip-field]').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg, 'the button is not filled like the field').not.toBe(field);
    await shot(page, info, `home-top-${lang}`);
  });
}

test('en /bills: the AI note reads in normal case; Show all prints its separator', async ({ page }, info) => {
  await page.goto('/bills');
  const note = page.getByText(en.bills.aiNote, { exact: true });
  await expect(note).toBeVisible();
  expect(await note.evaluate((el) => getComputedStyle(el).textTransform)).toBe('none');
  await shot(page, info, 'bills-top-en');

  const showAll = page.getByRole('button', { name: /^Show all \d/ }).first();
  if ((await showAll.count()) > 0) {
    const text = (await showAll.innerText()).trim();
    const n = Number(text.replace(/\D/g, ''));
    if (n > 999) expect(text, 'a count over 999 prints a thousands separator').toMatch(/\d,\d{3}/);
    await showAll.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 200));
    await shot(page, info, 'bills-show-all-en');
  }

  // A bill card's meta line, and the footer's colophon.
  await bring(page, 'main article, main li a');
  await shot(page, info, 'bills-cards-en');
  await page.locator('footer').last().scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await shot(page, info, 'footer-en');
});

test('es /bills: the search placeholder fits; Show all and the AI note in Spanish', async ({ page }, info) => {
  await page.goto('/es/bills');
  await expect(page.locator('#bill-search')).toHaveAttribute('placeholder', es.bills.searchPlaceholder);
  await shot(page, info, 'bills-top-es');
  const showAll = page.getByRole('button', { name: /^Ver los \d/ }).first();
  if ((await showAll.count()) > 0) {
    await showAll.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 200));
    await shot(page, info, 'bills-show-all-es');
  }
});

test('en /questions: the AI note reads in normal case', async ({ page }, info) => {
  await page.goto('/questions');
  const note = page.getByText(en.moments.aiNote, { exact: true });
  await expect(note).toBeVisible();
  expect(await note.evaluate((el) => getComputedStyle(el).textTransform)).toBe('none');
  await shot(page, info, 'questions-top-en');
});

test('en question page: the note above the bill cards reads in normal case', async ({ page }, info) => {
  const q = getMoments().find((mo) => questionVehicles(mo).some((v) => v.open || v.kind === 'nomination'));
  test.skip(!q, 'no question with an open bill card in the corpus today');
  await page.goto(`/questions/${q!.id}`);
  const note = page.getByText(en.moments.vehiclesAiNote, { exact: true });
  await expect(note).toBeVisible();
  expect(await note.evaluate((el) => getComputedStyle(el).textTransform)).toBe('none');
  await note.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 160));
  await shot(page, info, 'question-cards-note-en');
});

test('en 404: the heading is a page heading, smaller than the home headline', async ({ page }, info) => {
  await page.goto('/');
  const home = await page.locator('h1').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  await page.goto('/bills/no-such-bill-ui-fixes');
  const h1 = page.getByRole('heading', { level: 1, name: en.notFound.title });
  await expect(h1).toBeVisible();
  const size = await h1.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(size, 'the 404 heading is smaller than the home headline').toBeLessThan(home);
  await shot(page, info, 'not-found-en');
});

test('en home: the floor panel date stays on one line', async ({ page }, info) => {
  await page.goto('/');
  const chip = page.locator('.on-stone .bg-urgent').first();
  test.skip((await chip.count()) === 0, 'a quiet week: no floor panel on the home page today');
  const date = chip.locator('span').last();
  const lines = await date.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
  });
  expect(lines, 'the printed date is one line').toBe(1);
  await bring(page, '.on-stone');
  await shot(page, info, 'home-floor-panel-en');
});
