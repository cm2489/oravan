import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
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
 *
 * THE FIRST SCREEN (review of 2026-11-22): on a 390×844 phone, for EVERY
 * Big Question that is not retired and has a box, in both languages, the
 * box's call button — or, on a settled box, the record's outcome line — ends
 * above y = 780, the top edge of the bottom bar (taken at 780 because a
 * taller bar is coming in another pull request). Measured at scroll 0 in the
 * mobile project only; each measurement is also written to glance-shots/ so a
 * reviewer can read the numbers. A question that cannot meet it goes in
 * FIRST_SCREEN_EXCEPTIONS with its reason, never a looser number.
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

const BAR_TOP = 780;
/** `<question id>:<lang>` → why it cannot meet the first-screen budget. */
const FIRST_SCREEN_EXCEPTIONS: Record<string, string> = {};

for (const { prefix, lang } of LOCALES) {
  for (const { m: moment, g } of RENDERED) {
    test(`${lang} ${moment.id}: the box's ${g.settled ? 'outcome' : 'call'} is on a 390×844 phone's first screen`, async ({
      page,
    }, info) => {
      test.skip(info.project.name !== 'webkit-mobile', 'measured once, in the 390px phone project');
      const why = FIRST_SCREEN_EXCEPTIONS[`${moment.id}:${lang}`];
      test.skip(!!why, why);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${prefix}/questions/${moment.id}`);
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => window.scrollTo(0, 0));

      const box = page.locator('[data-question-glance]');
      await expect(box).toBeVisible();
      const target = g.settled ? box.locator('[data-glance-row="status"]') : box.locator('[data-glance-call]');
      await expect(target).toHaveCount(1);
      const b = (await target.boundingBox())!;
      const bottom = Math.round(b.y + b.height);
      mkdirSync(SHOTS, { recursive: true });
      writeFileSync(
        path.join(SHOTS, `first-screen-${lang}-${moment.id}.json`),
        JSON.stringify({ question: moment.id, lang, measured: g.settled ? 'outcome' : 'call', bottom, barTop: BAR_TOP }, null, 2)
      );
      info.annotations.push({ type: 'first-screen', description: `${moment.id} ${lang}: bottom ${bottom}px of ${BAR_TOP}` });
      expect(bottom, `${moment.id} (${lang}): the ${g.settled ? 'outcome line' : 'call button'} ends above the bar`).toBeLessThanOrEqual(BAR_TOP);
    });
  }
}

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
