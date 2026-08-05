import { expect, test, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { getLiveMoments } from '../lib/moments';
import { anyTopAt, stableAcross } from './corpus';
import { mockScriptApi } from './helpers';

/*
 * THE FUNNEL INVARIANTS — three, named, in both locales.
 *
 * This file used to enforce a single governing invariant: "<=3 clicks to a
 * completed call script." The truth-first repositioning (decided 2026-07-26,
 * spec the project records §3) demoted the
 * call to the natural next step after engagement, which means that invariant
 * had to be REWRITTEN DELIBERATELY rather than quietly broken. It is not
 * dropped and it is not weakened - it is renamed I2 and joined by a new
 * primary one. What the three of them say together is the product's whole
 * thesis, mechanically: understanding is one click away, the call is still
 * two, and a quiet week is admitted rather than faked.
 *
 *   I1 - TRUTH (new, primary). Every truth surface on the homepage is <=1
 *        CLICK from a decoded, AI-labeled answer. Boundaries: bill links in
 *        section[aria-labelledby="top-actions"], and Big Questions links in
 *        the promoted band, section[aria-labelledby="moments-strip-title"].
 *        Proof AT THE DESTINATION, never at the link: the decode's own
 *        `bill.sec.what` heading plus the AI chip beside it, visible.
 *        (The spec drafted this as "`bill.sec.what` + `bill.aiChip`". The
 *        bill page's AI chip is actually `bill.aiLabel` - "Decoded by AI ·
 *        checked against the record", gated on `hasDecode`; `bill.aiChip` is
 *        the string the MOMENT page reuses. Both are asserted below, each on
 *        the page that renders it.)
 *
 *   I2 - CALL PATH (preserved). From any decoded answer, a completed,
 *        editable script is <=2 INTERACTIONS away (stance radio -> a visible
 *        `bill.scriptTitle` textbox), and the ZIP-first route stays <=3
 *        CLICKS end to end through section[aria-labelledby="reps-next"].
 *        Assertions unchanged from the pre-repositioning suite; only the
 *        narration moved. The bill page's sticky two-column rail (DESIGN.md
 *        structural constraint 1) is what makes this true: DEMOTE, NEVER
 *        BURY, enforced structurally.
 *
 *   I3 - QUIET-WEEK HONESTY (unchanged). When the truth surfaces are empty
 *        they say so in a role=status empty state (never a false "quiet"
 *        claim - AE3), and neither entry point dead-ends.
 *
 * FROZEN IDENTIFIERS, read by this file and by freshness.spec.ts:
 * `top-actions`, `reps-next`, `moments-strip-title`. Heading copy may change
 * freely - it did, twice, in this train - but the ids may not. DESIGN.md
 * structural constraint 2 states the same budgets in prose; the numbers there
 * and the numbers here must always agree.
 *
 * CORPUS COUPLING (unchanged idiom): these suites branch on the live,
 * nightly-synced data/bills.json and data/moments.json rather than hardcoding
 * a slug, sharing freshness.spec.ts's corpus math (tests/corpus.ts). A
 * genuinely quiet week SKIPS the hot-week paths (and runs I3 instead);
 * CORPUS_STABLE additionally skips when the corpus sits at a scoring boundary
 * and the baked pages could disagree with this assert-time recomputation.
 */
/** Same condition as lib/core's getTopActions: a decoded bill clearing the "now" floor. */
const anyTop = anyTopAt(Date.now());
const CORPUS_STABLE = stableAcross((at) => anyTopAt(at));
/** The Big Questions band renders only when something reads as live, and then
 *  the truth claim survives in the hero instead - so I1's second surface is
 *  corpus-gated the same way its first one is. */
const anyLiveMoment = getLiveMoments().length > 0;

const ZIP = '78501'; // single district + two senators, no address-refinement detour (see reps.spec.ts)

async function clickFirstBillCardIn(page: Page, sectionSelector: string) {
  await page.locator(`${sectionSelector} a[href*="/bills/"]`).first().click();
}

// Declare a stance robust against the click-before-hydration race (same
// guard as embeds-configurator.spec.ts's submitUrl): a click that lands on
// the server-rendered stance button before React attaches fires no script
// fetch and leaves nothing to wait on, so retry until the (mocked)
// /api/script request actually goes out. A retry can only fire after a
// lost click, so it never double-toggles a stance that already registered.
//
// BUDGETS RAISED 2026-08-02: 15s of 2s windows lost twice in one day on
// webkit-mobile under full-suite load (PR #142 and #145 CI runs, both green
// on rerun and everywhere else) — on a saturated 2-vCPU runner hydration
// alone can outlast the old budget, and every burned rerun costs a full CI
// build. 30s outer / 3s window holds the same semantics with headroom;
// a real regression still fails, just 15 seconds later.
async function declareStance(page: Page, stanceLabel: string) {
  const button = page.getByRole('radio', { name: stanceLabel });
  await expect(async () => {
    const request = page.waitForRequest('**/api/script', { timeout: 3000 });
    await button.click();
    await request;
  }).toPass({ timeout: 30_000 });
}

async function expectCompletedScript(page: Page, scriptTitleLabel: string) {
  await expect(page.getByRole('textbox', { name: scriptTitleLabel })).toBeVisible();
}

/** I1's proof at the destination: the decode is actually rendered AND it is
 *  labeled as machine-written. One without the other fails the invariant -
 *  an unlabeled decode breaks the AI rule, and a chip with no decode under it
 *  is a promise rather than an answer. */
async function expectDecodedAnswer(
  page: Page,
  messages: typeof en | typeof es
) {
  await expect(page.getByRole('heading', { name: messages.bill.sec.what })).toBeVisible();
  await expect(page.getByText(messages.bill.aiLabel, { exact: true }).first()).toBeVisible();
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
  test.describe(`${locale} locale: I1 - Truth (<=1 click to a decoded, AI-labeled answer)`, () => {
    test('I1: a bill link in the week reaches a decoded answer in 1 click', async ({ page }) => {
      test.skip(!CORPUS_STABLE, 'corpus sits at a scoring boundary - the baked homepage could flip before the assert');
      test.skip(!anyTop, 'corpus is quiet this week - no bill card in the week to drive this path');
      await page.goto(`${prefix}/`);

      // The ONLY click. The front door promises understanding, so the very
      // next thing on screen has to be the understanding - not a form, not a
      // stance, not an ask.
      await clickFirstBillCardIn(page, 'section[aria-labelledby="top-actions"]');
      await expect(page).toHaveURL(/\/bills\//);
      await expectDecodedAnswer(page, messages);
    });

    test('I1: a Big Questions band link reaches its decoded answer in 1 click', async ({ page }) => {
      test.skip(!anyLiveMoment, 'no live Big Question in the corpus - the band is absent by design');
      await page.goto(`${prefix}/`);

      const band = page.locator('section[aria-labelledby="moments-strip-title"]');
      await expect(band).toBeVisible();

      // The ONLY click. `/questions` (the band's see-all CTA) has no trailing
      // slash, so this selector can only pick an entry link.
      await band.locator('a[href*="/questions/"]').first().click();
      await expect(page).toHaveURL(/\/questions\/[^/]+$/);

      // Proof at the destination: the hand-authored answer to the question,
      // under its own heading, with the page's AI label visible. Note the
      // band is live-only, so the heading is the LIVE framing - a settled
      // entry never appears on the front door.
      await expect(
        page.getByRole('heading', { name: messages.moments.decidingLive })
      ).toBeVisible();
      await expect(page.getByText(messages.bill.aiChip, { exact: true }).first()).toBeVisible();
    });
  });

  test.describe(`${locale} locale: I2 - Call path (<=2 interactions, ZIP-first <=3 clicks)`, () => {
    test('I2: from a decoded answer, stance = a completed script in 1 more interaction', async ({
      page,
    }) => {
      test.skip(!CORPUS_STABLE, 'corpus sits at a scoring boundary - the baked homepage could flip before the assert');
      test.skip(!anyTop, 'corpus is quiet this week - no bill card in the week to drive this path');
      await mockScriptApi(page);
      await page.goto(`${prefix}/`);

      // I1's click, replayed to reach the decoded answer I2 starts from.
      await clickFirstBillCardIn(page, 'section[aria-labelledby="top-actions"]');
      await expect(page).toHaveURL(/\/bills\//);

      // Interaction 1 of <=2: declare a stance - the script appears
      // immediately, no further navigation required. (The budget is 2 because
      // an undecided visitor may open the rail's ZIP dialog first; the
      // straight line is 1.)
      await declareStance(page, messages.bill.stance.support);
      await expectCompletedScript(page, messages.bill.scriptTitle);
    });

    test('I2: ZIP-first - find reps -> reps-page continuation -> stance = completed script in 3 clicks', async ({
      page,
    }) => {
      test.skip(!CORPUS_STABLE, 'corpus sits at a scoring boundary - the baked homepage could flip before the assert');
      test.skip(!anyTop, 'corpus is quiet this week - the reps continuation has no bill card to drive this path');
      await mockScriptApi(page);
      await page.goto(`${prefix}/`);

      // Click 1 of <=3: submit a ZIP code. The flip demoted ZipForm BY
      // POSITION only - it stays in the hero and stays page-wide-locatable
      // via getByLabel, and Playwright auto-scrolls, so the demotion cost
      // this path exactly zero clicks.
      await page.getByLabel(messages.home.zipLabel).fill(ZIP);
      await page.getByRole('button', { name: messages.home.zipCta }).click();
      await expect(page).toHaveURL(new RegExp(`/reps\\?zip=${ZIP}`));

      // The rep-lookup result is not a dead end: the continuation section
      // surfaces the same callable bills. Its copy was reviewed in the
      // truth-first copy pass and deliberately KEPT (see the note at
      // app/[locale]/reps/page.tsx) - call-forward language is earned here.
      await expect(page.getByRole('heading', { name: messages.reps.nextTitle })).toBeVisible();

      // Click 2 of <=3: a callable bill from that continuation section.
      await clickFirstBillCardIn(page, 'section[aria-labelledby="reps-next"]');
      await expect(page).toHaveURL(/\/bills\//);

      // Click 3 of <=3: declare a stance - script appears.
      await declareStance(page, messages.bill.stance.support);
      await expectCompletedScript(page, messages.bill.scriptTitle);
    });
  });

  test.describe(`${locale} locale: I3 - Quiet-week honesty`, () => {
    // When the corpus is genuinely quiet (no bill clears the "now" floor -
    // see freshness.spec.ts), I1 and I2 skip rather than run against a
    // fabricated hot week. This pins that neither entry point dead-ends even
    // then: both surfaces show the honest empty state (never a false "quiet"
    // claim - AE3) with a working "browse all bills" escape hatch that still
    // reaches a completed script, just not inside the click budgets a hot
    // week gets.
    test('I3: neither entry point dead-ends when the week is empty', async ({ page }) => {
      test.skip(!CORPUS_STABLE, 'corpus sits at a scoring boundary - the baked homepage could flip before the assert');
      test.skip(anyTop, 'corpus has bill cards in the week this run - covered by I1/I2 instead');
      await mockScriptApi(page);

      await page.goto(`${prefix}/`);
      await expect(
        page.locator('section[aria-labelledby="top-actions"]').getByRole('status')
      ).toBeVisible();
      await page.getByRole('link', { name: messageRegex(messages.home.seeAll) }).click();
      await expect(page).toHaveURL(/\/bills$/);
      await page.locator('a[href*="/bills/"]').first().click();
      await expect(page).toHaveURL(/\/bills\//);
      await declareStance(page, messages.bill.stance.support);
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
