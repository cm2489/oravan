import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { getMoments, type MomentWithState } from '../lib/moments';
import { questionVehicles } from '../lib/moments-ui';
import { questionStatus } from '../lib/moment-status.mjs';
import { questionGlance, type Glance } from '../lib/question-glance';

/*
 * "AT A GLANCE" IN A BROWSER, AND ITS PICTURES FOR THE OWNER (2026-11-22).
 * Each test opens a Big Question, checks what the box promises where it can
 * be measured (it is there, its call reaches the lead bill's panel and is a
 * 44px target, a settled box has no call, nothing scrolls sideways), and
 * writes a viewport picture to glance-shots/ (uploaded by the e2e shards as
 * `glance-shots-<shard>`). Tagged @reflow, so it runs at 390 (webkit-mobile),
 * 1280 (webkit-desktop) and 320 (webkit-320).
 *
 * Which questions: read from the corpus through the box's own reader, never
 * named by hand — one whose box leads a single open bill and has no other
 * bills, one with several bills, and one whose every bill is finished. A
 * shape the corpus lacks today skips, and says so.
 */

const SHOTS = path.join(process.cwd(), 'glance-shots');

async function shot(page: Page, info: TestInfo, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(SHOTS, `${info.project.name}-${name}.png`) });
}

const glanceOf = (m: MomentWithState): Glance | null => {
  const vs = questionVehicles(m);
  return questionGlance(vs, questionStatus(vs.map((v) => v.line)).lead);
};
const RENDERED = getMoments()
  .filter((m) => m.state !== 'retired')
  .map((m) => ({ m, g: glanceOf(m) }))
  .filter((x): x is { m: MomentWithState; g: Glance } => x.g !== null);

const SHAPES = [
  { shape: 'one-bill', pick: RENDERED.find((x) => !x.g.settled && x.g.otherBills === 0) },
  {
    shape: 'several-bills',
    pick: [...RENDERED].filter((x) => !x.g.settled).sort((a, b) => b.g.otherBills - a.g.otherBills)[0],
  },
  { shape: 'settled', pick: RENDERED.find((x) => x.g.settled) },
] as const;

const LOCALES = [
  { prefix: '', lang: 'en', m: en },
  { prefix: '/es', lang: 'es', m: es },
] as const;

for (const { prefix, lang, m } of LOCALES) {
  for (const { shape, pick } of SHAPES) {
    test(`${lang} ${shape} question: the "At a glance" box @reflow`, async ({ page }, info) => {
      test.skip(!pick || (shape === 'several-bills' && pick.g.otherBills === 0), `no ${shape} Big Question in the corpus today`);
      const { m: moment, g } = pick!;
      await page.goto(`${prefix}/questions/${moment.id}`);

      const box = page.locator('[data-question-glance]');
      await expect(box).toBeVisible();
      await expect(box).toHaveAttribute('data-glance-lead', g.slug);
      await expect(box.getByRole('heading', { name: m.moments.glance.heading })).toBeAttached();
      await expect(box).toContainText(m.moments.status.label);
      await expect(box.locator('[data-glance-row="bill"] a')).toHaveAttribute('href', `${prefix}/bills/${g.slug}`);

      const call = box.locator('[data-glance-call]');
      if (g.settled) {
        // Rule 6: a settled decision shows no call apparatus.
        await expect(call).toHaveCount(0);
        await expect(box.locator('a[href*="tel:"]')).toHaveCount(0);
      } else {
        await expect(call).toHaveCount(1);
        expect(await call.getAttribute('href')).toMatch(new RegExp(`(^#act$|/bills/${g.slug}#act$)`));
        const b = (await call.boundingBox())!;
        expect(b.height, 'the call is a 44px target').toBeGreaterThanOrEqual(44);
      }
      await expect(box.locator('[data-glance-row="next"]')).toHaveCount(g.next ? 1 : 0);
      await expect(box.locator('[data-glance-row="votes"]')).toHaveCount(g.votes ? 1 : 0);
      await expect(box.locator('[data-glance-row="passage"]')).toHaveCount(g.passage ? 1 : 0);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, 'nothing scrolls sideways').toBeLessThanOrEqual(0);

      await shot(page, info, `${lang}-${shape}-${moment.id}`);
    });
  }
}
