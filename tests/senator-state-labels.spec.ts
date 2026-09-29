import { expect, test, type Locator } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { billSlug, districtsForZip, getAllBills, repsForDistrict } from '../lib/core';
import { settledDecision } from '../lib/journey';
import { settledVoteGroups } from '../lib/settled-votes';
import { votesCoverage, votesForBill } from '../lib/votes';
import type { Legislator } from '../lib/types';
import { billWithRollCallsOnlyIn, referenceBill } from './corpus-fixtures';
import { mockScriptApi, seedZip } from './helpers';

/*
 * WHICH STATE EACH SENATOR REPRESENTS, AS RENDERED (2026-09-29).
 *
 *   19973  crosses a state line: Delaware at-large and Maryland's 1st. Every
 *          surface lists both states' senators. Each name must carry its
 *          state as text, "Christopher A. Coons (DE)", with one line saying
 *          the reader's state decides which are theirs.
 *   10001  a split ZIP inside one state (NY-10 and NY-12): the call panel and
 *          the hub print exactly what they printed before, bare names.
 *   78501  one district (TX-15): the settled box, unchanged.
 *
 * Names come from the same lookup /api/reps runs (lib/core), and labels from
 * messages/*.json by key, so a roster change or a rewording does not redden
 * this file; only a lost label does. The rule itself is pinned for every ZIP
 * in tests/senator-state-labels.unit.spec.ts.
 */

const CROSS_STATE = '19973';
const SPLIT_IN_STATE = '10001';
const ONE_DISTRICT = '78501';

const LOCALES = [
  { locale: 'en', prefix: '', m: en },
  { locale: 'es', prefix: '/es', m: es },
] as const;

/** The members /api/reps answers for a ZIP, de-duplicated in district order. */
function membersFor(zip: string): Legislator[] {
  const seen = new Set<string>();
  return districtsForZip(zip)
    .flatMap((d) => repsForDistrict(d))
    .filter((r) => (seen.has(r.bioguide) ? false : (seen.add(r.bioguide), true)));
}
const senatorsFor = (zip: string) => membersFor(zip).filter((r) => r.type === 'sen');
const labelled = (r: Pick<Legislator, 'name' | 'state'>) => `${r.name} (${r.state})`;

/** A "(ST)" suffix: what an in-state name must not carry on the call panel. */
const STATE_SUFFIX = /\([A-Z]{2}\)\s*$/;

const BILL = `/bills/${referenceBill().slug}`;
const SENATE_BILL = billWithRollCallsOnlyIn('senate');

/** A settled bill whose record-only panel has a Senate vote group, in slug
 *  order — the group that lists the senators. */
const SETTLED_WITH_SENATE = (() => {
  const floor = votesCoverage().floor;
  return (
    getAllBills()
      .filter((b) => b.ai_sections)
      .map((b) => ({ b, slug: billSlug(b), settled: settledDecision(b) }))
      .filter(({ b, slug, settled }) =>
        settled ? settledVoteGroups(b, settled, votesForBill(slug), floor).some((g) => g.chamber === 'senate') : false
      )
      .map(({ slug }) => slug)
      .sort()[0] ?? null
  );
})();

async function sorted(rows: Locator) {
  return (await rows.allTextContents()).map((s) => s.trim()).sort();
}

for (const { locale, prefix, m } of LOCALES) {
  test(`${locale}: bill call panel, ZIP ${CROSS_STATE}: every row names its state, under the state-scoped line`, async ({
    page,
  }) => {
    await mockScriptApi(page);
    await page.goto(prefix + BILL);
    await seedZip(page, CROSS_STATE);
    await page.reload();
    await page.getByRole('radio', { name: m.bill.stance.support }).click();
    await expect(page.getByRole('textbox', { name: m.bill.scriptTitle })).toBeVisible();

    await expect(page.getByText(m.bill.callWhoMulti)).toBeVisible();
    const rows = page.locator('section[aria-labelledby="act"] [data-rep-name]');
    const members = membersFor(CROSS_STATE);
    expect(new Set(senatorsFor(CROSS_STATE).map((s) => s.state))).toEqual(new Set(['DE', 'MD']));
    await expect(rows).toHaveCount(members.length);
    expect(await sorted(rows)).toEqual(members.map(labelled).sort());

    // The senators still lead the list, as in every split ZIP.
    const senators = senatorsFor(CROSS_STATE).map(labelled);
    const first = (await rows.allTextContents()).slice(0, senators.length).map((s) => s.trim());
    expect(first.sort()).toEqual(senators.sort());
  });

  test(`${locale}: bill call panel, ZIP ${SPLIT_IN_STATE} (one state): bare names, as before`, async ({ page }) => {
    await mockScriptApi(page);
    await page.goto(prefix + BILL);
    await seedZip(page, SPLIT_IN_STATE);
    await page.reload();
    await page.getByRole('radio', { name: m.bill.stance.support }).click();
    await expect(page.getByRole('textbox', { name: m.bill.scriptTitle })).toBeVisible();

    await expect(page.getByText(m.bill.callWhoMulti)).toBeVisible();
    const rows = page.locator('section[aria-labelledby="act"] [data-rep-name]');
    const members = membersFor(SPLIT_IN_STATE);
    await expect(rows).toHaveCount(members.length);
    const texts = await sorted(rows);
    expect(texts).toEqual(members.map((r) => r.name).sort());
    for (const t of texts) expect(t).not.toMatch(STATE_SUFFIX);
  });

  test(`${locale}: call hub, ZIP ${CROSS_STATE}: each senator's state in the list and in every Senate routing line`, async ({
    page,
  }) => {
    await page.goto(`${prefix}/call`);
    await seedZip(page, CROSS_STATE);
    await page.reload();
    const reach = page.locator('[data-call-reach="ready"]');
    await expect(reach).toBeVisible();
    await expect(reach.getByText(m.bill.callWhoMulti)).toBeVisible();

    // "Who you'll reach": the role line under each name already says the
    // state as text ("Senator · DE"), for every ZIP.
    for (const s of senatorsFor(CROSS_STATE)) {
      const row = reach.locator('li').filter({ has: page.locator(`a[href="${prefix}/reps/${s.bioguide}"]`) });
      await expect(row).toContainText(`${m.reps.senator} · ${s.state}`);
    }

    // Each bill's Senate routing line, when this week has one.
    const lines = await page.locator('[data-call-routing="senate"]').allInnerTexts();
    if (lines.length === 0) {
      test.info().annotations.push({ type: 'note', description: 'no bill on the hub has the Senate as its live call today' });
    }
    for (const line of lines) {
      for (const s of senatorsFor(CROSS_STATE)) expect(line).toContain(labelled(s));
    }
  });

  test(`${locale}: call hub, ZIP ${SPLIT_IN_STATE} (one state): routing lines name senators bare, as before`, async ({
    page,
  }) => {
    await page.goto(`${prefix}/call`);
    await seedZip(page, SPLIT_IN_STATE);
    await page.reload();
    await expect(page.locator('[data-call-reach="ready"]')).toBeVisible();
    const routing = page.locator('[data-call-routing="senate"]');
    const n = await routing.count();
    test.skip(n === 0, 'no bill on the hub has the Senate as its live call today');
    for (const line of await routing.allInnerTexts()) {
      for (const s of senatorsFor(SPLIT_IN_STATE)) {
        expect(line).toContain(s.name);
        expect(line).not.toContain(labelled(s));
      }
    }
  });

  test(`${locale}: settled box, ZIP ${CROSS_STATE}: both states' senators with their state, and the line that yours are your state's`, async ({
    page,
  }) => {
    test.skip(!SETTLED_WITH_SENATE, 'no settled bill with a Senate vote in the corpus today');
    await page.goto(`${prefix}/bills/${SETTLED_WITH_SENATE}`);
    await seedZip(page, CROSS_STATE);
    await page.reload();
    const senate = page.locator('[data-settled-panel] [data-settled-vote-group="senate"]');
    await expect(senate).toBeVisible();
    const senators = senatorsFor(CROSS_STATE);
    await expect(senate.locator('[data-vote-delegate]')).toHaveCount(senators.length);
    for (const s of senators) {
      await expect(senate.locator(`[data-vote-delegate="${s.bioguide}"] a`)).toHaveText(labelled(s));
    }
    await expect(senate.locator('[data-settled-cross-state]')).toHaveText(m.bill.settled.crossState);
    // One such line in the whole panel, never under the House vote.
    await expect(page.locator('[data-settled-cross-state]')).toHaveCount(1);
  });

  test(`${locale}: settled box, ZIP ${ONE_DISTRICT} (one state): unchanged, no cross-state line`, async ({ page }) => {
    test.skip(!SETTLED_WITH_SENATE, 'no settled bill with a Senate vote in the corpus today');
    await page.goto(`${prefix}/bills/${SETTLED_WITH_SENATE}`);
    await seedZip(page, ONE_DISTRICT);
    await page.reload();
    const senate = page.locator('[data-settled-panel] [data-settled-vote-group="senate"]');
    await expect(senate).toBeVisible();
    for (const s of senatorsFor(ONE_DISTRICT)) {
      // The settled box has always printed "John Cornyn (TX)".
      await expect(senate.locator(`[data-vote-delegate="${s.bioguide}"] a`)).toHaveText(labelled(s));
    }
    await expect(page.locator('[data-settled-cross-state]')).toHaveCount(0);
    await expect(page.getByText(m.bill.settled.crossState)).toHaveCount(0);
  });

  test(`${locale}: vote strip, ZIP ${CROSS_STATE}: each senator with their state, under the state-scoped line`, async ({
    page,
  }) => {
    test.skip(!SENATE_BILL, 'no open bill with Senate-only roll calls in data/votes.json today');
    await mockScriptApi(page);
    await page.goto(`${prefix}/bills/${SENATE_BILL}`);
    await seedZip(page, CROSS_STATE);
    await page.reload();
    const strip = page.locator('[data-vote-delegation]');
    await expect(strip).toBeVisible();
    for (const s of senatorsFor(CROSS_STATE)) {
      await expect(strip.locator(`[data-vote-delegate="${s.bioguide}"] a`)).toHaveText(labelled(s));
    }
    await expect(strip).toContainText(m.votes.delegation.multiDistrict);
  });
}

test('the call panel reflows at 320px with state-labelled rows @reflow', async ({ page }) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await seedZip(page, CROSS_STATE);
  await page.reload();
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(page.locator('section[aria-labelledby="act"] [data-rep-name]').first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
