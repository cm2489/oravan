import { expect, test, type Locator } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { getBill, getLegislator } from '../lib/core';
import { settledDecision } from '../lib/journey';
import { settledDecisionDate } from '../lib/settled-votes';
import { votesCoverage, votesForBill } from '../lib/votes';
import { settledBill } from './corpus-fixtures';
import { callableBillSlug } from './corpus-samples';
import { seedZip } from './helpers';

/*
 * NO DECISION LEFT, NO CALL APPARATUS (owner, 2026-09-28, UX question Q9
 * answered "a": "A record-only block with no numbers: 'This is law' or 'This
 * was rejected, 49–50', and how your members voted. No stance, no script.";
 * page 1, rule 6: a settled decision shows no call apparatus).
 *
 * ONE ORDER, ONE CHAMBER PER LIST (owner, 2026-09-28, reviewing
 * /bills/hconres-89-119: "It's talking about the Senate but in the 'no call to
 * make' box it talks about the House vote and then says the senators
 * underneath this. That doesn't make sense and is confusing."). The outcome
 * first, then one group per vote, the deciding vote first, each member only
 * under a vote their own chamber held.
 *
 * Most bills are picked by property from the committed corpus (tests/corpus-
 * fixtures.ts `settledBill`, which reads lib/journey.ts `settledDecision`).
 * The two pages the owner reviewed are pinned by slug, each skipped with a
 * reason if its record ever gains a newer action. Copy is read by message
 * key; the panel by its data hooks. ZIP 78501 is TX-15: two senators and one
 * House member.
 */

const LAW = settledBill('law', { withVotes: true }) ?? settledBill('law');
const REJECTED = settledBill('rejected', { withVotes: true }) ?? settledBill('rejected');
const MOTION = settledBill('motionFailed');
const SUSPENSION = settledBill('suspensionFailed');

const PANEL = '[data-settled-panel]';

const tEn = createTranslator({ locale: 'en', messages: en });
const tEs = createTranslator({ locale: 'es', messages: es });

/** The page's own date formats (app/[locale]/bills/[id]/page.tsx fmtDate / fmtShort). */
const longDate = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(iso)
  );
const shortDate = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(iso)
  );

/** The outcome sentence's date arguments for a bill, as the page passes them. */
function when(locale: string, bill: Parameters<typeof settledDecisionDate>[0]) {
  const iso = settledDecisionDate(bill);
  return { hasDate: iso ? 'yes' : 'none', date: iso ? longDate(locale, iso) : '' };
}

/** The bioguide ids listed in a vote group, in order. */
const listed = (group: Locator) =>
  group.locator('[data-vote-delegate]').evaluateAll((els) => els.map((e) => e.getAttribute('data-vote-delegate')!));

/** Every group lists only members of its own chamber. */
async function expectOneChamberPerGroup(panel: Locator) {
  for (const [chamber, type] of [
    ['senate', 'sen'],
    ['house', 'rep'],
  ] as const) {
    const group = panel.locator(`[data-settled-vote-group="${chamber}"]`);
    if ((await group.count()) === 0) continue;
    for (const id of await listed(group)) {
      expect(getLegislator(id)?.type, `${id} listed under the ${chamber} vote`).toBe(type);
    }
  }
}

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

    // With no ZIP saved, the panel asks for one — one line and the form — and
    // lists no vote group.
    await expect(panel.getByText(m.bill.settled.needZip)).toBeVisible();
    await expect(panel.getByLabel(m.home.zipLabel)).toBeVisible();
    await expect(panel.locator('[data-settled-votes]')).toHaveCount(0);
  });
}

/*
 * THE PAGE THE OWNER REVIEWED: H.Con.Res. 89 passed the House (roll 282,
 * 2026-07-23, 214–208), then the Senate rejected it (record vote 244,
 * 2026-09-24, 49–50).
 */
const HCONRES_89 = 'hconres-89-119';
const HCONRES_89_TEXT = 'Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.';

for (const { locale, prefix, t } of [
  { locale: 'en', prefix: '', t: tEn },
  { locale: 'es', prefix: '/es', t: tEs },
] as const) {
  test(`${locale}: H.Con.Res. 89 reads the Senate outcome, then the Senate vote with your senators, then the House vote with your House member`, async ({
    page,
  }) => {
    const bill = getBill(HCONRES_89);
    test.skip(bill?.last_action_text !== HCONRES_89_TEXT, 'H.Con.Res. 89 has a newer action than 2026-09-24');
    const rolls = votesForBill(HCONRES_89);
    const senateRoll = rolls.find((r) => r.chamber === 'senate' && r.roll === 244)!;
    const houseRoll = rolls.find((r) => r.chamber === 'house')!;
    expect(senateRoll, 'Senate record vote 244 in data/votes.json').toBeDefined();
    expect(houseRoll, 'a House roll call on H.Con.Res. 89 in data/votes.json').toBeDefined();

    await page.goto(`${prefix}/bills/${HCONRES_89}`);
    await seedZip(page, '78501');
    await page.reload();
    const panel = page.locator(PANEL);
    await expect(panel).toHaveAttribute('data-settled-panel', 'rejected');

    // (1) The outcome, one sentence: the deciding chamber, tally and date.
    await expect(panel.locator('[data-settled-outcome]')).toHaveText(
      t('bill.settled.rejected', {
        chamber: 'Senate',
        tally: 'yes',
        yeas: 49,
        nays: 50,
        hasDate: 'yes',
        date: longDate(locale, '2026-09-24'),
      })
    );

    // (2) How your members voted, after the outcome in reading order.
    const votes = panel.locator('[data-settled-votes]');
    await expect(votes.getByRole('heading', { level: 3 })).toHaveText(t('bill.settled.membersHeading'));
    const outcomeFirst = await panel.evaluate((el) => {
      const outcome = el.querySelector('[data-settled-outcome]');
      const members = el.querySelector('[data-settled-votes]');
      return !!outcome && !!members && !!(outcome.compareDocumentPosition(members) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(outcomeFirst, 'the outcome reads before the members').toBe(true);

    // The Senate vote first — it decided the measure — then the House vote.
    const groups = panel.locator('[data-settled-vote-group]');
    await expect(groups).toHaveCount(2);
    expect(await groups.evaluateAll((els) => els.map((e) => e.getAttribute('data-settled-vote-group')))).toEqual([
      'senate',
      'house',
    ]);

    const senate = panel.locator('[data-settled-vote-group="senate"]');
    await expect(senate).toHaveAttribute('data-settled-vote-deciding', '');
    await expect(senate.getByRole('heading', { level: 4 })).toHaveText(
      `${t('bill.settled.voteIn', { chamber: 'senate' })} · ${shortDate(locale, '2026-09-24')} · 49–50`
    );
    await expect(senate.locator('time')).toHaveAttribute('datetime', '2026-09-24');

    const house = panel.locator('[data-settled-vote-group="house"]');
    await expect(house).not.toHaveAttribute('data-settled-vote-deciding', '');
    await expect(house.getByRole('heading', { level: 4 })).toHaveText(
      `${t('bill.settled.voteIn', { chamber: 'house' })} · ${shortDate(locale, houseRoll.date)} · ${houseRoll.totals.yea}–${houseRoll.totals.nay}`
    );
    await expect(house.locator('time')).toHaveAttribute('datetime', houseRoll.date);

    // Your two senators under the Senate vote, your House member under the
    // House vote — never mixed.
    await expect(senate.locator('[data-vote-delegate]')).toHaveCount(2);
    await expect(house.locator('[data-vote-delegate]')).toHaveCount(1);
    await expectOneChamberPerGroup(panel);

    // Each beside the position the record lists for them on that roll call,
    // or "No recorded vote" when it lists none.
    for (const [group, roll] of [
      [senate, senateRoll],
      [house, houseRoll],
    ] as const) {
      for (const id of await listed(group)) {
        const row = group.locator(`[data-vote-delegate="${id}"]`);
        const position = (['yea', 'nay', 'present', 'notVoting'] as const).find((p) => roll.votes[p].includes(id));
        await expect(row.locator('[data-settled-position]')).toHaveAttribute('data-settled-position', position ?? 'none');
        await expect(row).toContainText(
          position ? t(`votes.position.${position}`) : t('bill.settled.noRecordedVote')
        );
      }
    }

    // Still nothing to call with, and no second members strip on the page.
    await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
    await expect(page.locator('[data-vote-delegation]')).toHaveCount(0);
    await expect(panel.getByText(t('bill.settled.needZip'))).toHaveCount(0);
  });
}

/*
 * THE OTHER PAGE THE OWNER REVIEWED: S. 2503, a failed two-thirds vote in
 * the House on 2026-02-24 (roll 72, 264–133) — older than the roll-call
 * file's floor, and with no Senate roll call in the file. So: the House group
 * only, from the record, saying why positions are not shown.
 */
const S_2503 = 's-2503-119';
const S_2503_TEXT =
  'On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: (2/3 required): 264 - 133 (Roll no. 72).';

test('S. 2503 reads the House outcome, then the House vote only, saying the roll-call record begins after it', async ({
  page,
}) => {
  const bill = getBill(S_2503);
  test.skip(bill?.last_action_text !== S_2503_TEXT, 'S. 2503 has a newer action than 2026-02-24');
  test.skip(votesForBill(S_2503).length > 0, 'S. 2503 now has a roll call in data/votes.json');
  const floor = votesCoverage().floor;

  await page.goto(`/bills/${S_2503}`);
  await seedZip(page, '78501');
  await page.reload();
  const panel = page.locator(PANEL);
  await expect(panel).toHaveAttribute('data-settled-panel', 'suspensionFailed');
  await expect(panel.locator('[data-settled-outcome]')).toHaveText(
    tEn('bill.settled.suspensionFailed', {
      chamber: 'House',
      tally: 'yes',
      yeas: 264,
      nays: 133,
      hasDate: 'yes',
      date: longDate('en', '2026-02-24'),
    })
  );

  const groups = panel.locator('[data-settled-vote-group]');
  await expect(groups).toHaveCount(1);
  const house = panel.locator('[data-settled-vote-group="house"]');
  await expect(house).toHaveAttribute('data-settled-vote-deciding', '');
  await expect(house).toHaveAttribute('data-settled-vote-source', 'beforeFile');
  await expect(house.getByRole('heading', { level: 4 })).toHaveText(
    `${tEn('bill.settled.voteIn', { chamber: 'house' })} · ${shortDate('en', '2026-02-24')} · 264–133`
  );
  // Your House member, saying plainly the position is not shown, and why.
  await expect(house.locator('[data-vote-delegate]')).toHaveCount(1);
  await expectOneChamberPerGroup(panel);
  await expect(house.locator('[data-settled-position]')).toHaveAttribute('data-settled-position', 'none');
  await expect(house).toContainText(tEn('bill.settled.positionNotShown'));
  await expect(house).toContainText(tEn('bill.settled.beforeFileNote', { floor: longDate('en', floor) }));
  // No Senate vote on it in the file, so no senators' line.
  await expect(panel.locator('[data-settled-vote-group="senate"]')).toHaveCount(0);
  await expect(panel.locator('[data-vote-delegate]')).toHaveCount(1);
});

test('a rejected vote prints the record\'s tally, and with a ZIP lists members by vote — in the panel only', async ({
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

  // How your members voted: inside the panel, the deciding chamber's group
  // first — and not a second copy under the vote record.
  const votes = panel.locator('[data-settled-votes]');
  await expect(votes).toBeVisible();
  const first = panel.locator('[data-settled-vote-group]').first();
  await expect(first).toHaveAttribute('data-settled-vote-group', decision.kind === 'rejected' ? decision.chamber : '');
  await expect(first).toHaveAttribute('data-settled-vote-deciding', '');
  await expectOneChamberPerGroup(panel);
  await expect(page.locator('[data-vote-delegation]')).toHaveCount(0);
  // Names link to each member's page — where their numbers are — and the
  // panel itself prints no number.
  const rows = votes.locator('[data-vote-delegate]');
  expect(await rows.count()).toBeGreaterThan(0);
  await expect(votes.locator('a[href*="/reps/"]')).toHaveCount(await rows.count());
  await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
  await expect(panel.getByText(en.bill.settled.needZip)).toHaveCount(0);
});

test('a failed motion says so in the stepper\'s words, with its date; a ZIP saved in the panel shows the members in place', async ({
  page,
}) => {
  test.skip(!MOTION, 'no decoded failed motion in the corpus');
  const decision = MOTION!.decision;
  test.skip(decision.kind !== 'motionFailed', 'fixture is not a failed motion');
  await page.goto(`/es/bills/${MOTION!.slug}`);
  const panel = page.locator(PANEL);
  await expect(panel).toHaveAttribute('data-settled-panel', 'motionFailed');
  // The same ICU message the page renders, with the chamber the reader chose
  // and the record's date for the action.
  const chamber = decision.kind === 'motionFailed' && decision.chamber === 'house' ? 'House' : 'Senate';
  await expect(panel.locator('[data-settled-outcome]')).toHaveText(
    tEs('bill.settled.motionFailed', { chamber, ...when('es', MOTION!.bill) })
  );

  // Saving a ZIP here resolves in place: no navigation, the members appear,
  // the deciding chamber's vote first.
  await panel.getByLabel(es.home.zipLabel).fill('78501');
  await panel.getByRole('button', { name: es.home.zipCta }).click();
  await expect(page).toHaveURL(new RegExp(`/es/bills/${MOTION!.slug}$`));
  await expect(panel.locator('[data-settled-votes]')).toBeVisible();
  const first = panel.locator('[data-settled-vote-group]').first();
  await expect(first).toHaveAttribute('data-settled-vote-group', decision.kind === 'motionFailed' ? decision.chamber : '');
  await expect(first).toHaveAttribute('data-settled-vote-deciding', '');
  await expectOneChamberPerGroup(panel);
});

for (const { locale, prefix, t } of [
  { locale: 'en', prefix: '', t: tEn },
  { locale: 'es', prefix: '/es', t: tEs },
] as const) {
  test(`${locale}: a failed two-thirds vote says it was a vote to pass that fell short, not a failed motion`, async ({
    page,
  }) => {
    test.skip(!SUSPENSION, 'no decoded failed two-thirds vote in the corpus');
    const decision = SUSPENSION!.decision;
    test.skip(decision.kind !== 'suspensionFailed', 'fixture is not a failed two-thirds vote');
    if (decision.kind !== 'suspensionFailed') return;
    await page.goto(`${prefix}/bills/${SUSPENSION!.slug}`);
    const panel = page.locator(PANEL);
    await expect(panel).toHaveAttribute('data-settled-panel', 'suspensionFailed');
    const chamber = decision.chamber === 'house' ? 'House' : 'Senate';
    const outcome = panel.locator('[data-settled-outcome]');
    await expect(outcome).toHaveText(
      t('bill.settled.suspensionFailed', {
        chamber,
        tally: decision.tally ? 'yes' : 'none',
        yeas: decision.tally?.yeas ?? 0,
        nays: decision.tally?.nays ?? 0,
        ...when(locale, SUSPENSION!.bill),
      })
    );
    await expect(outcome).not.toHaveText(t('bill.settled.motionFailed', { chamber, ...when(locale, SUSPENSION!.bill) }));
    // Still a settled page: nothing to call with.
    await expect(page.locator('[data-call-cta]')).toHaveCount(0);
    await expect(page.locator('[data-floating-call]')).toHaveCount(0);
  });
}

test('the record-only panel reflows at 320px with the members shown @reflow', async ({ page }) => {
  // H.Con.Res. 89 while it is settled: its panel carries two vote groups.
  const hconres = getBill(HCONRES_89);
  const fx = hconres && settledDecision(hconres) ? { slug: HCONRES_89 } : (REJECTED ?? LAW);
  test.skip(!fx, 'no decoded settled bill in the corpus');
  await page.goto(`/es/bills/${fx!.slug}`);
  await seedZip(page, '78501');
  await page.reload();
  await expect(page.locator(`${PANEL} [data-settled-votes]`)).toBeVisible();
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
