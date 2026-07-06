import { expect, test, type Page } from '@playwright/test';
import bills from '../data/bills.json';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { TERMINAL_STATUSES, effectiveUrgency } from '../lib/urgency.mjs';
import { bandFloors } from '../lib/taxonomy';
import { mockScriptApi } from './helpers';

/*
 * S4-S5 — the homepage funnel's own success test: a first-time visitor
 * reaches a completed, editable call script in <=3 clicks, in either
 * language, from either of the two legitimate entry points:
 *   - bill-first: "Worth a call this week" on the homepage
 *   - ZIP-first: find your reps, then the /reps continuation this sprint
 *     adds (previously a dead end - see reps.spec.ts for the rep-lookup
 *     behavior itself, unchanged here)
 *
 * Mirrors freshness.spec.ts's corpus math rather than hardcoding a slug:
 * whether "Act now" has any decoded bills depends on the live, nightly-
 * synced data/bills.json, so the click-path assertions skip (not fail)
 * on a genuinely quiet week - same idiom the freshness suite already uses.
 */
type CorpusBill = { status: string; last_action_date: string | null; ai_headline: string | null };
const active = (bills as CorpusBill[]).filter((b) => !TERMINAL_STATUSES.has(b.status));
const effs = active.map((b) => effectiveUrgency(b.status, b.last_action_date)).sort((a, b) => b - a);
const floors = bandFloors(effs);
/** Same condition as lib/core's getTopActions: a decoded bill clearing the "now" floor. */
const anyTop = active.some(
  (b) => b.ai_headline && effectiveUrgency(b.status, b.last_action_date) >= floors.nowFloor
);

const ZIP = '78501'; // single district + two senators, no address-refinement detour (see reps.spec.ts)

async function clickFirstBillCardIn(page: Page, sectionSelector: string) {
  await page.locator(`${sectionSelector} a[href*="/bills/"]`).first().click();
}

async function expectCompletedScript(page: Page, scriptTitleLabel: string) {
  await expect(page.getByRole('textbox', { name: scriptTitleLabel })).toBeVisible();
}

/** Turn a "...{count}..." message template into a regex matching any count. */
function messageRegex(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{count\\\}/, '\\d+');
  return new RegExp(escaped);
}

const LOCALES = [
  { locale: 'en', prefix: '', messages: en },
  { locale: 'es', prefix: '/es', messages: es },
] as const;

for (const { locale, prefix, messages } of LOCALES) {
  test.describe(`${locale} locale: <=3-click funnel`, () => {
    test('bill-first: homepage "worth a call" card -> stance = completed script in 2 clicks', async ({
      page,
    }) => {
      test.skip(!anyTop, 'corpus is quiet this week - no Top Actions card to drive this path');
      await mockScriptApi(page);
      await page.goto(`${prefix}/`);

      // Click 1 of <=3: a callable bill from "Worth a call this week".
      await clickFirstBillCardIn(page, 'section[aria-labelledby="top-actions"]');
      await expect(page).toHaveURL(/\/bills\//);

      // Click 2 of <=3: declare a stance - the script appears immediately,
      // no further navigation required.
      await page.getByRole('button', { name: messages.bill.stance.support }).click();
      await expectCompletedScript(page, messages.bill.scriptTitle);
    });

    test('ZIP-first: find reps -> reps-page continuation -> stance = completed script in 3 clicks', async ({
      page,
    }) => {
      test.skip(!anyTop, 'corpus is quiet this week - the reps continuation has no bill card to drive this path');
      await mockScriptApi(page);
      await page.goto(`${prefix}/`);

      // Click 1 of <=3: submit a ZIP code from the hero.
      await page.getByLabel(messages.home.zipLabel).fill(ZIP);
      await page.getByRole('button', { name: messages.home.zipCta }).click();
      await expect(page).toHaveURL(new RegExp(`/reps\\?zip=${ZIP}`));

      // The rep-lookup result is not a dead end: a "Ready to act?" section
      // (this sprint's /reps continuation) surfaces the same callable bills.
      await expect(page.getByRole('heading', { name: messages.reps.nextTitle })).toBeVisible();

      // Click 2 of <=3: a callable bill from that continuation section.
      await clickFirstBillCardIn(page, 'section[aria-labelledby="reps-next"]');
      await expect(page).toHaveURL(/\/bills\//);

      // Click 3 of <=3: declare a stance - script appears.
      await page.getByRole('button', { name: messages.bill.stance.support }).click();
      await expectCompletedScript(page, messages.bill.scriptTitle);
    });

    // The corpus this session is genuinely quiet (no bill clears the "now"
    // floor - see freshness.spec.ts), so the two tests above skip rather
    // than run against a fabricated hot week. This test instead pins that
    // neither entry point dead-ends even then: both surfaces show the
    // honest empty state (never a false "quiet" claim - AE3) with a
    // working "browse all bills" escape hatch that still reaches a
    // completed script, just not inside the 3-click budget a hot week gets.
    test('quiet-week fallback: neither entry point dead-ends when Top Actions is empty', async ({
      page,
    }) => {
      test.skip(anyTop, 'corpus has Top Actions cards this run - covered by the tests above instead');
      await mockScriptApi(page);

      await page.goto(`${prefix}/`);
      await expect(
        page.locator('section[aria-labelledby="top-actions"]').getByRole('status')
      ).toBeVisible();
      await page.getByRole('link', { name: messageRegex(messages.home.seeAll) }).click();
      await expect(page).toHaveURL(/\/bills$/);
      await page.locator('a[href*="/bills/"]').first().click();
      await expect(page).toHaveURL(/\/bills\//);
      await page.getByRole('button', { name: messages.bill.stance.support }).click();
      await expectCompletedScript(page, messages.bill.scriptTitle);

      await page.goto(`${prefix}/`);
      await page.getByLabel(messages.home.zipLabel).fill(ZIP);
      await page.getByRole('button', { name: messages.home.zipCta }).click();
      await expect(page.getByRole('heading', { name: messages.reps.nextTitle })).toBeVisible();
      await expect(
        page.locator('section[aria-labelledby="reps-next"]').getByRole('status')
      ).toBeVisible();
    });
  });
}
