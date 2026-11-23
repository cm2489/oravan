import { expect, test, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import rq from '../data/reader-questions.json';
import type { ReaderQuestionsEntry } from '../lib/reader-questions';

/*
 * READER QUESTIONS on the funding question's page: native <details> rows that
 * open without JavaScript, 44px rows with visible keyboard focus, the AI label
 * at the block's top, the "We couldn't check this" state, the written-on line,
 * no sideways scroll at 320px, in English and Spanish. The last test takes the
 * reviewer's pictures (CI uploads reader-questions-shots/ as the artifact
 * reader-questions-shots-<shard>).
 */

const ID = 'government-funding-deadline';
const ENTRY = (rq as unknown as { questions: Record<string, ReaderQuestionsEntry> }).questions[ID];
const SHOTS = path.join(process.cwd(), 'reader-questions-shots');
const LOCALES = [
  { lang: 'en', prefix: '' },
  { lang: 'es', prefix: '/es' },
] as const;
const ABSENCE_PICK: string = ENTRY.picks.find((p) =>
  p.claims.some((c) => c.kind === 'absence' && c.absence_kind === 'not_checked'),
)!.bank_id;
const NOT_FOUND_PICK: string = ENTRY.picks.find((p) =>
  p.claims.some((c) => c.kind === 'absence' && c.absence_kind === 'not_found'),
)!.bank_id;
const FIRST_PICK: string = ENTRY.picks[0].bank_id;

/** Keyboard focus, the way tests/colour-states.spec.ts gets it in WebKit:
 *  a key press first, so the engine counts the focus as :focus-visible. */
async function keyboardFocus(page: Page, loc: Locator) {
  await page.keyboard.press('Shift');
  await loc.focus();
  await expect(loc).toBeFocused();
}

const block = (page: Page) => page.locator('[data-reader-questions]');
const row = (page: Page, id: string) => page.locator(`[data-rq-item="${id}"]`);

for (const { lang, prefix } of LOCALES) {
  test.describe(`reader questions (${lang})`, () => {
    test('sits after the summary and before the bills, with the AI label, every question and the written-on line', async ({ page }) => {
      await page.goto(`${prefix}/questions/${ID}`);
      const b = block(page);
      await expect(b).toBeVisible();
      const order = await page.evaluate(() => {
        const s = document.getElementById('deciding');
        const r = document.querySelector('[data-reader-questions]');
        const v = document.getElementById('vehicles-h');
        const after = (a: Node, z: Node) => !!(a.compareDocumentPosition(z) & Node.DOCUMENT_POSITION_FOLLOWING);
        return { summaryFirst: !!s && !!r && after(s, r), billsAfter: !!r && !!v && after(r, v) };
      });
      expect(order).toEqual({ summaryFirst: true, billsAfter: true });
      await expect(b.locator('[data-rq-ai-label] a')).toHaveAttribute('href', new RegExp(`${prefix}/citations#reader-questions$`));
      await expect(b.locator('details')).toHaveCount(ENTRY.picks.length);
      for (const p of ENTRY.picks) await expect(row(page, p.bank_id).locator('summary')).toContainText(p.q[lang]);
      await expect(b.locator('[data-rq-written]')).toBeVisible();
    });

    test('rows are at least 44px tall, open and close, and show the sources and the couldn’t-check state', async ({ page }) => {
      await page.goto(`${prefix}/questions/${ID}`);
      for (const p of ENTRY.picks) {
        const box = await row(page, p.bank_id).locator('summary').boundingBox();
        expect(box!.height, p.bank_id).toBeGreaterThanOrEqual(44);
      }
      const r = row(page, ABSENCE_PICK);
      await expect(r.locator('[data-rq-answer]')).toBeHidden();
      await r.locator('summary').click();
      await expect(r.locator('[data-rq-silent]').first()).toBeVisible();
      await expect(r.locator('[data-rq-answer] a[href^="https://"]').first()).toBeVisible();
      await r.locator('summary').click();
      await expect(r.locator('[data-rq-answer]')).toBeHidden();
      // A searched-and-not-found line is a checked finding: a plain sentence, never "We couldn't check this."
      const nf = row(page, NOT_FOUND_PICK);
      await nf.locator('summary').click();
      await expect(nf.locator('[data-rq-not-found]').first()).toBeVisible();
      await expect(nf.locator('[data-rq-not-found] strong')).toHaveCount(0);
    });

    test('a row takes visible keyboard focus @reflow', async ({ page }) => {
      await page.goto(`${prefix}/questions/${ID}`);
      const summary = row(page, FIRST_PICK).locator('summary');
      await keyboardFocus(page, summary);
      const ring = await summary.evaluate((el) => ({
        focusVisible: el.matches(':focus-visible'),
        style: getComputedStyle(el).outlineStyle,
        width: parseFloat(getComputedStyle(el).outlineWidth),
      }));
      expect(ring.focusVisible).toBe(true);
      expect(ring.style).not.toBe('none');
      expect(ring.width).toBeGreaterThanOrEqual(3);
    });

    test('no sideways scroll with every answer open @reflow', async ({ page }) => {
      await page.goto(`${prefix}/questions/${ID}`);
      await page.evaluate(() => document.querySelectorAll('[data-rq-item]').forEach((d) => d.setAttribute('open', '')));
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over).toBeLessThanOrEqual(0);
    });
  });
}

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test('a row still opens', async ({ page }) => {
    await page.goto(`/questions/${ID}`);
    const r = row(page, FIRST_PICK);
    await r.locator('summary').click();
    await expect(r.locator('[data-rq-answer]')).toBeVisible();
  });
});

test('pictures for the reviewer: closed, one answer open, couldn’t check, keyboard focus; 390, 320 and 1280px; English and Spanish (taken by CI)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'webkit-desktop', 'run once; sets its own widths');
  test.setTimeout(180_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  const shoot = async (name: string) => {
    const file = path.join(SHOTS, `${name}.png`);
    await block(page).screenshot({ path: file });
    await testInfo.attach(name, { path: file, contentType: 'image/png' });
  };
  for (const width of [390, 320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const { lang, prefix } of LOCALES) {
      const tag = `${lang}-${width}`;
      await page.goto(`${prefix}/questions/${ID}`);
      await shoot(`${tag}-1-closed`);
      await row(page, FIRST_PICK).locator('summary').click();
      await shoot(`${tag}-2-open-${FIRST_PICK}`);
      await row(page, FIRST_PICK).locator('summary').click();
      await row(page, ABSENCE_PICK).locator('summary').click();
      await shoot(`${tag}-3-couldnt-check-${ABSENCE_PICK}`);
      await page.goto(`${prefix}/questions/${ID}`);
      await keyboardFocus(page, row(page, FIRST_PICK).locator('summary'));
      await shoot(`${tag}-4-keyboard-focus`);
    }
  }
});
