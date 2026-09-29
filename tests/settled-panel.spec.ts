import { expect, test, type Locator } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { getBill, getLegislator } from '../lib/core';
import { settledDecision } from '../lib/journey';
import { settledDecisionDate } from '../lib/settled-votes';
import { statusBasisText } from '../lib/floor-text.mjs';
import { MEMBER_VOTES_MAX_BILLS, memberVotesByBill, votesForBill } from '../lib/votes';
import { failedVoteBill, settledBill } from './corpus-fixtures';
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
 * WHICH RECORDS COUNT AS FINISHED (owner, 2026-09-29, pick (a): "Only a law
 * or a failed final vote counts as finished. Procedural failures keep the call
 * panel, with a line saying the last attempt failed."). So this panel shows on
 * a law and on a rejected vote to pass the measure, and nowhere else; a failed
 * motion to take it up and a failed two-thirds suspension vote keep the call
 * panel, with one line above the stances (`[data-last-attempt]`).
 *
 * Most bills are picked by property from the committed corpus (tests/corpus-
 * fixtures.ts `settledBill`, which reads lib/journey.ts `settledDecision`, and
 * `failedVoteBill`, which reads `lastFailedVote`).
 * The two pages the owner reviewed are pinned by slug, each skipped with a
 * reason if its record ever gains a newer action. Copy is read by message
 * key; the panel by its data hooks. ZIP 78501 is TX-15: two senators and one
 * House member.
 */

const LAW = settledBill('law', { withVotes: true }) ?? settledBill('law');
const REJECTED = settledBill('rejected', { withVotes: true }) ?? settledBill('rejected');
const FAILED_PROCEDURES = ['proceed', 'clotureProceed', 'discharge', 'suspension'] as const;

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
 * A CONCURRENT RESOLUTION BOTH CHAMBERS AGREED TO IN ONE FORM (2026-09-29):
 * H.Con.Res. 86. The House agreed 215–208 on 2026-06-03 (roll 199); the
 * Senate agreed "without amendment" 50–48 on 2026-06-23 (record vote 184).
 * It goes to no president, so its path has ended: the record-only panel as
 * `adopted` (never as law), the Senate agreement that completed it first,
 * then the House vote; the stepper's own sentence; the "Adopted by both
 * chambers" label; and nothing to call with.
 */
const HCONRES_86 = 'hconres-86-119';
const HCONRES_86_BASIS = 'Resolution agreed to in Senate without amendment by Yea-Nay Vote. 50 - 48. Record Vote Number: 184.';

for (const { locale, prefix, t, m } of [
  { locale: 'en', prefix: '', t: tEn, m: en },
  { locale: 'es', prefix: '/es', t: tEs, m: es },
] as const) {
  test(`${locale}: H.Con.Res. 86 reads the adoption by both chambers, then the Senate vote, then the House vote, with nothing to call`, async ({
    page,
  }) => {
    const bill = getBill(HCONRES_86);
    test.skip(!bill?.status_basis_text?.startsWith(HCONRES_86_BASIS), 'H.Con.Res. 86 has a newer basis than 2026-06-23');
    const rolls = votesForBill(HCONRES_86);
    const senateRoll = rolls.find((r) => r.chamber === 'senate' && r.roll === 184)!;
    const houseRoll = rolls.find((r) => r.chamber === 'house')!;
    expect(senateRoll, 'Senate record vote 184 in data/votes.json').toBeDefined();
    expect(houseRoll, 'a House roll call on H.Con.Res. 86 in data/votes.json').toBeDefined();

    await page.goto(`${prefix}/bills/${HCONRES_86}`);
    await seedZip(page, '78501');
    await page.reload();
    const panel = page.locator(PANEL);
    await expect(panel).toHaveAttribute('data-settled-panel', 'adopted');
    await expect(panel.getByRole('heading', { name: m.bill.settled.title })).toBeVisible();

    // (1) The outcome: both chambers, the second one's date — never "law".
    const outcome = panel.locator('[data-settled-outcome]');
    await expect(outcome).toHaveText(t('bill.settled.adopted', { hasDate: 'yes', date: longDate(locale, '2026-06-23') }));
    await expect(outcome).not.toHaveText(m.bill.settled.law);

    // (2) One group per vote: the Senate agreement that completed it, then
    // the House vote, each headed by its own chamber, date and tally.
    const groups = panel.locator('[data-settled-vote-group]');
    await expect(groups).toHaveCount(2);
    expect(await groups.evaluateAll((els) => els.map((e) => e.getAttribute('data-settled-vote-group')))).toEqual([
      'senate',
      'house',
    ]);
    const senate = panel.locator('[data-settled-vote-group="senate"]');
    await expect(senate).toHaveAttribute('data-settled-vote-deciding', '');
    await expect(senate.getByRole('heading', { level: 4 })).toHaveText(
      `${t('bill.settled.voteIn', { chamber: 'senate' })} · ${shortDate(locale, '2026-06-23')} · 50–48`
    );
    const house = panel.locator('[data-settled-vote-group="house"]');
    await expect(house).not.toHaveAttribute('data-settled-vote-deciding', '');
    await expect(house.getByRole('heading', { level: 4 })).toHaveText(
      `${t('bill.settled.voteIn', { chamber: 'house' })} · ${shortDate(locale, houseRoll.date)} · ${houseRoll.totals.yea}–${houseRoll.totals.nay}`
    );
    await expect(senate.locator('[data-vote-delegate]')).toHaveCount(2);
    await expect(house.locator('[data-vote-delegate]')).toHaveCount(1);
    await expectOneChamberPerGroup(panel);
    for (const [group, roll] of [
      [senate, senateRoll],
      [house, houseRoll],
    ] as const) {
      for (const id of await listed(group)) {
        const position = (['yea', 'nay', 'present', 'notVoting'] as const).find((p) => roll.votes[p].includes(id));
        await expect(group.locator(`[data-vote-delegate="${id}"] [data-settled-position]`)).toHaveAttribute(
          'data-settled-position',
          position ?? 'none'
        );
      }
    }

    // Nothing to call with, anywhere on the page.
    await expect(page.getByRole('radio')).toHaveCount(0);
    await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
    await expect(page.locator('[data-call-cta]')).toHaveCount(0);
    await expect(page.locator('[data-floating-call]')).toHaveCount(0);
    await expect(page.locator('[data-walkthrough-disclosure]')).toHaveCount(0);
    await expect(page.locator('[data-last-attempt]')).toHaveCount(0);

    // "Where does it stand?": its path ends here — no longer "doesn't say yet
    // whether the two versions match".
    const journey = page.locator('section[aria-labelledby="journey-h"]');
    await expect(journey).toContainText(t('bill.journey.nowAdoptedBoth'));
    await expect(journey).not.toContainText(t('bill.journey.nowPassedSecond'));

    // The status label under the headline: adopted, never "Passed one chamber".
    const status = page.locator('main header p').first();
    await expect(status).toContainText(m.bills.status.adopted);
    await expect(status).not.toContainText(m.bills.status.passed_chamber);
  });
}

/*
 * A BILL BOTH CHAMBERS PASSED STILL GOES TO THE PRESIDENT (2026-09-29): H.R.
 * 4467, passed by the Senate without amendment. Its label says both chambers
 * passed it, the stepper keeps the president's step, and the call panel stays.
 */
const HR_4467 = 'hr-4467-119';

test('H.R. 4467 (passed both chambers) keeps the call panel and the president\'s step, labeled "Passed both chambers"', async ({
  page,
}) => {
  const bill = getBill(HR_4467);
  test.skip(
    !bill || bill.status !== 'passed_chamber' || statusBasisText(bill)?.startsWith('Passed Senate without amendment') !== true,
    'H.R. 4467 has a newer action than 2026-09-24'
  );
  await page.goto(`/bills/${HR_4467}`);
  await expect(page.locator(PANEL)).toHaveCount(0);
  await expect(page.locator('[aria-labelledby="act"][data-call-cta]')).toBeVisible();

  const status = page.locator('main header p').first();
  await expect(status).toContainText(en.bills.status.passed_both);
  await expect(status).not.toContainText(en.bills.status.passed_chamber);

  // The fifth step is the president's desk, and "Right now:" says it goes there.
  const journey = page.locator('section[aria-labelledby="journey-h"]');
  await expect(journey.locator('li[aria-current="step"]')).toContainText(tEn('bill.journey.stepPresident'));
  await expect(journey).toContainText(tEn('bill.journey.nowPassedBoth'));
});

/*
 * THE MEMBER PAGE READS THE SAME SENTENCE (#348's vote record): a senator who
 * voted on H.Con.Res. 86 sees its "Right now:" line say its path ends here.
 */
test('the member page\'s vote record says H.Con.Res. 86\'s path has ended, in both languages', async ({ page }) => {
  const bill = getBill(HCONRES_86);
  test.skip(!bill?.status_basis_text?.startsWith(HCONRES_86_BASIS), 'H.Con.Res. 86 has a newer basis than 2026-06-23');
  const senateRoll = votesForBill(HCONRES_86).find((r) => r.chamber === 'senate' && r.roll === 184);
  test.skip(!senateRoll, 'Senate record vote 184 is not in data/votes.json');
  // A sitting senator on that roll call whose capped vote record lists it.
  const voter = (['yea', 'nay'] as const)
    .flatMap((p) => senateRoll!.votes[p])
    .sort()
    .find(
      (id) =>
        getLegislator(id) &&
        memberVotesByBill(id)
          .slice(0, MEMBER_VOTES_MAX_BILLS)
          .some((g) => g.bill === HCONRES_86)
    );
  test.skip(!voter, 'no sitting senator lists H.Con.Res. 86 inside the capped vote record');
  for (const { prefix, t } of [
    { prefix: '', t: tEn },
    { prefix: '/es', t: tEs },
  ] as const) {
    await page.goto(`${prefix}/reps/${voter}`);
    const now = page.locator(`[data-member-vote-bill="${HCONRES_86}"] [data-member-vote-now]`);
    await expect(now).toHaveAttribute('data-member-vote-now', 'nowAdoptedBoth');
    await expect(now).toContainText(t('bill.journey.nowAdoptedBoth'));
  }
});

/*
 * A REJECTION OLDER THAN THE ROLL-CALL FILE: H.R. 2262, "Failed of
 * passage/not agreed to in House On passage Failed by the Yeas and Nays: 209 -
 * 215 (Roll no. 19)." on 2026-01-13, stored behind the House's routine
 * "Motion to reconsider laid on the table" step. So: the House group only,
 * from the record, saying why positions are not shown. (S. 2503 pinned this
 * shape until 2026-09-29, when pick (a) moved it back to the call panel.)
 */
const HR_2262 = 'hr-2262-119';
const HR_2262_BASIS =
  'Failed of passage/not agreed to in House On passage Failed by the Yeas and Nays: 209 - 215 (Roll no. 19).';

test('H.R. 2262 reads the House rejection, then the House vote only, saying the roll-call record begins after it', async ({
  page,
}) => {
  const bill = getBill(HR_2262);
  test.skip(
    bill?.status_basis_text !== HR_2262_BASIS || bill?.status_basis_date !== '2026-01-13',
    'H.R. 2262 has a newer basis than 2026-01-13'
  );
  test.skip(votesForBill(HR_2262).length > 0, 'H.R. 2262 now has a roll call in data/votes.json');

  await page.goto(`/bills/${HR_2262}`);
  await seedZip(page, '78501');
  await page.reload();
  const panel = page.locator(PANEL);
  await expect(panel).toHaveAttribute('data-settled-panel', 'rejected');
  await expect(panel.locator('[data-settled-outcome]')).toHaveText(
    tEn('bill.settled.rejected', {
      chamber: 'House',
      tally: 'yes',
      yeas: 209,
      nays: 215,
      hasDate: 'yes',
      date: longDate('en', '2026-01-13'),
    })
  );
  const groups = panel.locator('[data-settled-vote-group]');
  await expect(groups).toHaveCount(1);
  const house = panel.locator('[data-settled-vote-group="house"]');
  await expect(house).toHaveAttribute('data-settled-vote-deciding', '');
  await expect(house).toHaveAttribute('data-settled-vote-source', 'beforeFile');
  await expect(house.getByRole('heading', { level: 4 })).toHaveText(
    `${tEn('bill.settled.voteIn', { chamber: 'house' })} · ${shortDate('en', '2026-01-13')} · 209–215`
  );
  await expect(house.locator('[data-vote-delegate]')).toHaveCount(1);
  await expectOneChamberPerGroup(panel);
  await expect(house.locator('[data-settled-position]')).toHaveAttribute('data-settled-position', 'none');
  await expect(house).toContainText(tEn('bill.settled.positionNotShown'));
  // Still nothing to call with.
  await expect(page.locator('[data-call-cta]')).toHaveCount(0);
  await expect(page.locator('[data-last-attempt]')).toHaveCount(0);
});

/*
 * THE PAGES THAT LEFT THE SETTLED SET ON 2026-09-29 (pick (a)). Each keeps the
 * full call panel — stances, script, the floating call button — with one line
 * above the stances naming the failed vote from the record: the chamber, the
 * record's tally and the record's date for that action.
 *
 *   S.J.Res. 185  "Motion to proceed to consideration of measure rejected in
 *                 Senate by Yea-Nay Vote. 47 - 50. Record Vote Number: 192."
 *                 (2026-06-24)
 *   S. 2503       "On motion to suspend the rules and pass the bill Failed by
 *                 the Yeas and Nays: (2/3 required): 264 - 133 (Roll no. 72)."
 *                 (2026-02-24)
 */
const SJRES_185 = 'sjres-185-119';
const SJRES_185_TEXT =
  'Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 47 - 50. Record Vote Number: 192. (CR S3194)';
const S_2503 = 's-2503-119';
const S_2503_TEXT =
  'On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: (2/3 required): 264 - 133 (Roll no. 72).';

/** The last-attempt line sits inside the call panel, above the stance control. */
async function expectLineAboveStances(page: import('@playwright/test').Page) {
  const above = await page.locator('[aria-labelledby="act"][data-call-cta]').evaluate((panel) => {
    const line = panel.querySelector('[data-last-attempt]');
    const stances = panel.querySelector('[role="radiogroup"]');
    return !!line && !!stances && !!(line.compareDocumentPosition(stances) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(above, 'the last-attempt line reads before the stances, inside the call panel').toBe(true);
}

for (const { locale, prefix, t, m } of [
  { locale: 'en', prefix: '', t: tEn, m: en },
  { locale: 'es', prefix: '/es', t: tEs, m: es },
] as const) {
  test(`${locale}: S.J.Res. 185 (a failed motion to proceed) keeps the call panel, with the line naming the failed vote`, async ({
    page,
  }) => {
    const bill = getBill(SJRES_185);
    test.skip(bill?.last_action_text !== SJRES_185_TEXT, 'S.J.Res. 185 has a newer action than 2026-06-24');
    await page.goto(`${prefix}/bills/${SJRES_185}`);

    await expect(page.locator(PANEL)).toHaveCount(0);
    await expect(page.locator('[aria-labelledby="act"][data-call-cta]')).toBeVisible();
    await expect(page.getByRole('radio', { name: m.bill.stance.support })).toBeVisible();
    await expect(page.locator('[data-last-attempt]')).toHaveText(
      t('bill.lastAttempt', {
        procedure: 'proceed',
        chamber: 'Senate',
        tally: 'yes',
        yeas: 47,
        nays: 50,
        hasDate: 'yes',
        date: longDate(locale, '2026-06-24'),
      })
    );
    await expectLineAboveStances(page);
    // The open bill's "your members" strip is back under the vote record.
    await expect(page.locator('[data-walkthrough-disclosure]')).toHaveCount(1);
  });

  test(`${locale}: S. 2503 (a failed two-thirds vote) keeps the call panel, and the stepper says what the vote was`, async ({
    page,
  }) => {
    const bill = getBill(S_2503);
    test.skip(bill?.last_action_text !== S_2503_TEXT, 'S. 2503 has a newer action than 2026-02-24');
    await page.goto(`${prefix}/bills/${S_2503}`);

    await expect(page.locator(PANEL)).toHaveCount(0);
    await expect(page.locator('[aria-labelledby="act"][data-call-cta]')).toBeVisible();
    await expect(page.getByRole('radio', { name: m.bill.stance.support })).toBeVisible();
    await expect(page.locator('[data-last-attempt]')).toHaveText(
      t('bill.lastAttempt', {
        procedure: 'suspension',
        chamber: 'House',
        tally: 'yes',
        yeas: 264,
        nays: 133,
        hasDate: 'yes',
        date: longDate(locale, '2026-02-24'),
      })
    );
    await expectLineAboveStances(page);

    // "Where does it stand?": the vote to pass it, with the record's numbers —
    // no longer "has not agreed to take it up".
    const journey = page.locator('section[aria-labelledby="journey-h"]');
    await expect(journey).toContainText(
      t('bill.journey.nowFloorSuspensionFailed', { chamber: 'House', other: 'Senate', tally: 'yes', yeas: 264, nays: 133 })
    );
    await expect(journey).not.toContainText(t('bill.journey.nowFloorMotionFailed', { chamber: 'House' }));
  });
}

for (const procedure of FAILED_PROCEDURES) {
  test(`every ${procedure} failure in the corpus keeps the call panel with its line, and no record-only panel`, async ({
    page,
  }) => {
    const fx = failedVoteBill(procedure);
    test.skip(!fx, `no decoded ${procedure} failure in the corpus`);
    const { failed } = fx!;
    await page.goto(`/bills/${fx!.slug}`);
    await expect(page.locator(PANEL)).toHaveCount(0);
    await expect(page.locator('[aria-labelledby="act"][data-call-cta]')).toBeVisible();
    await expect(page.locator('[data-last-attempt]')).toHaveText(
      tEn('bill.lastAttempt', {
        procedure: failed.procedure,
        chamber: failed.chamber === 'house' ? 'House' : 'Senate',
        tally: failed.tally ? 'yes' : 'none',
        yeas: failed.tally?.yeas ?? 0,
        nays: failed.tally?.nays ?? 0,
        ...when('en', fx!.bill),
      })
    );
  });
}

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

test('a rejected vote: a ZIP saved in the panel shows the members in place, the deciding vote first', async ({ page }) => {
  test.skip(!REJECTED, 'no decoded rejected passage vote in the corpus');
  const decision = REJECTED!.decision;
  test.skip(decision.kind !== 'rejected', 'fixture is not a rejection');
  if (decision.kind !== 'rejected') return;
  await page.goto(`/es/bills/${REJECTED!.slug}`);
  const panel = page.locator(PANEL);
  await expect(panel).toHaveAttribute('data-settled-panel', 'rejected');
  const chamber = decision.chamber === 'house' ? 'House' : 'Senate';
  await expect(panel.locator('[data-settled-outcome]')).toHaveText(
    tEs('bill.settled.rejected', {
      chamber,
      tally: decision.tally ? 'yes' : 'none',
      yeas: decision.tally?.yeas ?? 0,
      nays: decision.tally?.nays ?? 0,
      ...when('es', REJECTED!.bill),
    })
  );

  // Saving a ZIP here resolves in place: no navigation, the members appear,
  // the deciding chamber's vote first.
  await panel.getByLabel(es.home.zipLabel).fill('78501');
  await panel.getByRole('button', { name: es.home.zipCta }).click();
  await expect(page).toHaveURL(new RegExp(`/es/bills/${REJECTED!.slug}$`));
  await expect(panel.locator('[data-settled-votes]')).toBeVisible();
  const first = panel.locator('[data-settled-vote-group]').first();
  await expect(first).toHaveAttribute('data-settled-vote-group', decision.chamber);
  await expect(first).toHaveAttribute('data-settled-vote-deciding', '');
  await expectOneChamberPerGroup(panel);
  // A settled page never prints the call panel's last-attempt line.
  await expect(page.locator('[data-last-attempt]')).toHaveCount(0);
});

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
  await expect(page.locator('[aria-labelledby="act"][data-call-cta]')).toBeVisible();
  await expect(page.getByRole('radio', { name: en.bill.stance.support })).toBeVisible();
  await expect(page.locator(PANEL)).toHaveCount(0);
  // No failed vote on the record, no last-attempt line.
  await expect(page.locator('[data-last-attempt]')).toHaveCount(0);
});
