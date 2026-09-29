import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { getBill } from '../lib/core';
import { partyTotalsLine, type PartyTotalsT } from '../lib/party-totals';
import { votesForBill } from '../lib/votes';
import { seedZip } from './helpers';

/*
 * THE COUNT BY PARTY ON THE PAGE (the owner's card l12, 2026-09-29: "Show me
 * these. I don't see them."). One line of text under each roll call's tally
 * in the vote record, and under each vote group's heading in the settled box.
 * The expected text is lib/party-totals.ts `partyTotalsLine` over the real
 * messages and the roll call's own `totalsByParty`, so a line that drops a
 * group, reorders it or loses a count fails here.
 *
 * H.Con.Res. 89 is the page the owner reviewed for the settled box (House
 * roll 282, 2026-07-23, 214–208; Senate record vote 244, 2026-09-24, 49–50).
 * ZIP 78501 is TX-15: two senators and one House member.
 */

const HCONRES_89 = 'hconres-89-119';
const HCONRES_89_TEXT = 'Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.';
const VISIBLE = 3; // components/VoteRecord.tsx: the newest three roll calls show without a click

const translator = (locale: 'en' | 'es'): PartyTotalsT => {
  const t = createTranslator({ locale, messages: locale === 'en' ? en : es, namespace: 'partyTotals' });
  return (key, values) => t(key, values);
};

for (const { locale, prefix } of [
  { locale: 'en', prefix: '' },
  { locale: 'es', prefix: '/es' },
] as const) {
  test(`${locale}: the vote record prints each roll call's count by party right under its tally, in ink`, async ({ page }) => {
    const t = translator(locale);
    const rolls = votesForBill(HCONRES_89);
    expect(rolls.length, 'roll calls on H.Con.Res. 89 in data/votes.json').toBeGreaterThan(0);
    await page.goto(`${prefix}/bills/${HCONRES_89}`);

    for (const r of rolls.slice(0, VISIBLE)) {
      const card = page.locator(`[data-vote-roll="${r.id}"]`);
      const line = card.locator('[data-vote-party-totals]');
      await expect(line).toHaveText(partyTotalsLine(r.totalsByParty, t));
      await expect(line).toBeVisible();
      // Directly under the tally, before the tie-breaker and the source link.
      const afterTally = await line.evaluate((el) => el.previousElementSibling?.tagName === 'DL');
      expect(afterTally, `${r.id}: the line follows the tally`).toBe(true);
      // Same ink as the tally's numbers: no hue, whichever party leads.
      const [lineColor, tallyColor] = await Promise.all([
        line.evaluate((el) => getComputedStyle(el).color),
        card.locator('[data-vote-total="yea"]').evaluate((el) => getComputedStyle(el).color),
      ]);
      expect(lineColor, `${r.id}: the count by party is ink, like the tally`).toBe(tallyColor);
    }
  });

  test(`${locale}: the settled box prints the count by party under each vote group's heading`, async ({ page }) => {
    const bill = getBill(HCONRES_89);
    test.skip(bill?.last_action_text !== HCONRES_89_TEXT, 'H.Con.Res. 89 has a newer action than 2026-09-24');
    const t = translator(locale);
    const rolls = votesForBill(HCONRES_89);
    const senateRoll = rolls.find((r) => r.chamber === 'senate' && r.roll === 244)!;
    const houseRoll = rolls.find((r) => r.chamber === 'house')!;

    await page.goto(`${prefix}/bills/${HCONRES_89}`);
    await seedZip(page, '78501');
    await page.reload();
    const panel = page.locator('[data-settled-panel]');
    await expect(panel.locator('[data-settled-votes]')).toBeVisible();

    for (const [chamber, r] of [
      ['senate', senateRoll],
      ['house', houseRoll],
    ] as const) {
      const group = panel.locator(`[data-settled-vote-group="${chamber}"]`);
      const line = group.locator('[data-vote-party-totals]');
      await expect(line).toHaveText(partyTotalsLine(r.totalsByParty, t));
      const afterHeading = await line.evaluate((el) => el.previousElementSibling?.tagName === 'H4');
      expect(afterHeading, `${chamber}: the line sits under the group heading`).toBe(true);
    }
  });
}

test('@reflow the count by party wraps at 320px: no sideways scroll on the bill page', async ({ page }) => {
  await page.goto(`/bills/${HCONRES_89}`);
  await expect(page.locator('[data-vote-party-totals]').first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
