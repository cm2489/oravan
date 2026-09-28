import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { settledBill } from './corpus-fixtures';
import { callableBillSlug } from './corpus-samples';
import { seedZip } from './helpers';

/*
 * NO DECISION LEFT, NO CALL APPARATUS (owner, 2026-09-28, UX question Q9
 * answered "a": "A record-only block with no numbers: 'This is law' or 'This
 * was rejected, 49–50', and how your members voted. No stance, no script.";
 * page 1, rule 6: a settled decision shows no call apparatus).
 *
 * Bills are picked by property from the committed corpus (tests/corpus-
 * fixtures.ts `settledBill`, which reads lib/journey.ts `settledDecision`),
 * never by slug. Copy is read by message key; the panel by its data hooks.
 * ZIP 78501 is TX-15: two senators and one House member.
 */

const LAW = settledBill('law', { withVotes: true }) ?? settledBill('law');
const REJECTED = settledBill('rejected', { withVotes: true }) ?? settledBill('rejected');
const MOTION = settledBill('motionFailed');

const PANEL = '[data-settled-panel]';

const tEs = createTranslator({ locale: 'es', messages: es });

for (const { locale, prefix, m } of [
  { locale: 'en', prefix: '', m: en },
  { locale: 'es', prefix: '/es', m: es },
] as const) {
  test(`${locale}: a law shows the record and nothing to call with`, async ({ page }) => {
    test.skip(!LAW, 'no decoded law in the corpus');
    await page.goto(`${prefix}/bills/${LAW!.slug}`);
    const panel = page.locator(PANEL);
    await expect(panel).toHaveAttribute('data-settled-panel', 'law');
    await expect(panel.getByRole('heading', { name: m.bill.settled.title })).toBeVisible();
    await expect(panel.locator('[data-settled-outcome]')).toHaveText(m.bill.settled.law);

    // None of the call apparatus, anywhere on the page: no stance, no script,
    // no dial, no call panel, no floating call button, no call demo.
    await expect(page.getByRole('radio')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: m.bill.scriptTitle })).toHaveCount(0);
    await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
    await expect(page.locator('[data-call-cta]')).toHaveCount(0);
    await expect(page.locator('[data-floating-call]')).toHaveCount(0);
    await expect(page.locator('[data-walkthrough-disclosure]')).toHaveCount(0);

    // With no ZIP saved, the panel asks for one to show how members voted.
    await expect(panel.getByText(m.bill.settled.needZip)).toBeVisible();
    await expect(panel.getByLabel(m.home.zipLabel)).toBeVisible();
  });
}

test('a rejected vote prints the record\'s tally, and with a ZIP shows how your members voted — in the panel only', async ({
  page,
}) => {
  test.skip(!REJECTED, 'no decoded rejected passage vote in the corpus');
  const decision = REJECTED!.decision;
  test.skip(decision.kind !== 'rejected', 'fixture is not a rejection');
  await page.goto(`/bills/${REJECTED!.slug}`);
  await seedZip(page, '78501');
  await page.reload();

  const panel = page.locator(PANEL);
  await expect(panel).toHaveAttribute('data-settled-panel', 'rejected');
  const outcome = panel.locator('[data-settled-outcome]');
  if (decision.kind === 'rejected' && decision.tally) {
    await expect(outcome).toContainText(`${decision.tally.yeas}–${decision.tally.nays}`);
  }

  // How your members voted: the members strip, inside the panel, three rows
  // — and not a second copy under the vote record.
  const strip = panel.locator('[data-vote-delegation="panel"]');
  await expect(strip).toBeVisible();
  await expect(strip.locator('[data-vote-delegate]')).toHaveCount(3);
  await expect(page.locator('[data-vote-delegation="record"]')).toHaveCount(0);
  // Names link to each member's page — where their numbers are — and the
  // panel itself prints no number.
  await expect(strip.locator('a[href*="/reps/"]')).toHaveCount(3);
  await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
  await expect(panel.getByText(en.bill.settled.needZip)).toHaveCount(0);
});

test('a failed motion says so in the stepper\'s words; a ZIP saved in the panel shows the members in place', async ({
  page,
}) => {
  test.skip(!MOTION, 'no decoded failed motion in the corpus');
  const decision = MOTION!.decision;
  test.skip(decision.kind !== 'motionFailed', 'fixture is not a failed motion');
  await page.goto(`/es/bills/${MOTION!.slug}`);
  const panel = page.locator(PANEL);
  await expect(panel).toHaveAttribute('data-settled-panel', 'motionFailed');
  // The same ICU message the page renders, with the chamber the reader chose.
  const chamber = decision.kind === 'motionFailed' && decision.chamber === 'house' ? 'House' : 'Senate';
  await expect(panel.locator('[data-settled-outcome]')).toHaveText(
    tEs('bill.settled.motionFailed', { chamber })
  );

  // Saving a ZIP here resolves in place: no navigation, the members appear.
  await panel.getByLabel(es.home.zipLabel).fill('78501');
  await panel.getByRole('button', { name: es.home.zipCta }).click();
  await expect(page).toHaveURL(new RegExp(`/es/bills/${MOTION!.slug}$`));
  const strip = panel.locator('[data-vote-delegation="panel"]');
  await expect(strip.locator('[data-vote-delegate]')).toHaveCount(3);
});

test('the record-only panel reflows at 320px with the members shown @reflow', async ({ page }) => {
  const fx = REJECTED ?? LAW;
  test.skip(!fx, 'no decoded settled bill in the corpus');
  await page.goto(`/es/bills/${fx!.slug}`);
  await seedZip(page, '78501');
  await page.reload();
  await expect(page.locator(`${PANEL} [data-vote-delegate]`).first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow, 'a settled bill page must not scroll horizontally').toBeLessThanOrEqual(0);
});

test('an open decision still gets the call panel, not the record-only one', async ({ page }) => {
  // The other side of the same reader: nothing about this page changed for a
  // bill with a decision still open.
  await page.goto(`/bills/${callableBillSlug()}`);
  await expect(page.locator('[data-call-cta]')).toBeVisible();
  await expect(page.getByRole('radio', { name: en.bill.stance.support })).toBeVisible();
  await expect(page.locator(PANEL)).toHaveCount(0);
});
