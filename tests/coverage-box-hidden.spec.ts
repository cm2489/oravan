import { expect, test } from '@playwright/test';
import { COVERAGE_BOX_ON } from '../lib/coverage-switch';
import en from '../messages/en.json';
import es from '../messages/es.json';
import coverageData from '../data/coverage.json';
import { coverageForBillPage, coverageTier, getCoverageWithTwins } from '../lib/coverage';
import { getMomentsForBill } from '../lib/moments';

/*
 * The "Read" coverage box on a bill page (owner, 2026-11-13: "hide the box on
 * non-Big-Question bills when it shows only one side"; his 2026-09-28 ruling
 * that a Big Question bill keeps its box stands). The rule itself is pinned on
 * fixtures in coverage-box-visibility.unit.spec.ts; this is a real page from
 * each case, found in the data BY KIND, so no bill id is written down and a
 * night's data change cannot break it. A kind the data does not hold today
 * skips with the reason.
 */
const slugs = Object.keys(coverageData).filter((k) => !k.startsWith('_'));
const isVehicle = (s: string) => getMomentsForBill(s).length > 0;
// The set the page decides on: own articles plus the record twins' (owner,
// 2026-11-13; lib/coverage.ts, getCoverageWithTwins).
const tierOf = (s: string) => {
  const a = getCoverageWithTwins(s).articles;
  return a.length ? coverageTier(a) : 'none';
};
const hasTwins = (s: string) =>
  coverageForBillPage(getCoverageWithTwins(s).articles, isVehicle(s)).length > 0 && getCoverageWithTwins(s).twins.length > 0;

const hiddenSlug = slugs.find((s) => tierOf(s) === 'one_sided' && !isVehicle(s));
const vehicleOneSidedSlug = slugs.find((s) => tierOf(s) === 'one_sided' && isVehicle(s));
const twoSidedSlug = slugs.find((s) => tierOf(s) === 'cross' && !isVehicle(s));

const box = (page: import('@playwright/test').Page) =>
  page.locator('section[aria-labelledby="coverage-heading"]');

/* THE SWITCH (lib/coverage-switch.ts; owner, 2026-11-25, "Remove it everywhere
 * for now"). Every test that expects the box skips while COVERAGE_BOX_ON is
 * false and runs again, unchanged, the day it is set back to true; the
 * "switched off" test(s) below assert the opposite and skip once it is on. */
const BOX_OFF = 'the coverage box is switched off (lib/coverage-switch.ts, owner 2026-11-25); runs again when COVERAGE_BOX_ON is true';

for (const { prefix, messages } of [
  { prefix: '', messages: en },
  { prefix: '/es', messages: es },
] as const) {
  test(`${prefix || '/en'}: a non-Big-Question bill with one-sided coverage shows no coverage box`, async ({
    page,
  }) => {
    // Absent whether the switch is on (the one-side rule) or off (the switch).
    test.skip(!hiddenSlug, 'no one-sided bill outside the Big Questions in the current data');
    await page.goto(`${prefix}/bills/${hiddenSlug}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); // rendered, not a 404
    await expect(box(page)).toHaveCount(0);
    // No leftover heading, note or anchor that pointed at the box.
    await expect(page.getByRole('heading', { name: messages.coverage.heading })).toHaveCount(0);
    await expect(page.getByText(messages.coverage.oneSidedNote)).toHaveCount(0);
    await expect(page.getByText(messages.coverage.oneSidedNoteTwins)).toHaveCount(0);
    await expect(page.locator('#coverage-heading, [href="#coverage-heading"]')).toHaveCount(0);
    // And not in the prerendered HTML either (what a crawler or a no-JS reader gets).
    const html = await (await page.request.get(`${prefix}/bills/${hiddenSlug}`)).text();
    expect(html).not.toContain('coverage-heading');
  });
}

test('a Big Question bill with one-sided coverage still shows the box, with its note', async ({ page }) => {
  test.skip(!COVERAGE_BOX_ON, BOX_OFF);
  test.skip(!vehicleOneSidedSlug, 'no one-sided Big Question bill in the current data');
  await page.goto(`/bills/${vehicleOneSidedSlug}`);
  await expect(box(page).getByRole('heading', { name: en.coverage.heading })).toBeVisible();
  const note = hasTwins(vehicleOneSidedSlug!) ? en.coverage.oneSidedNoteTwins : en.coverage.oneSidedNote;
  await expect(box(page).getByText(note)).toBeVisible();
});

test('a non-Big-Question bill with coverage from both sides still shows the box, with no one-side note', async ({
  page,
}) => {
  test.skip(!COVERAGE_BOX_ON, BOX_OFF);
  test.skip(!twoSidedSlug, 'no two-sided bill outside the Big Questions in the current data');
  await page.goto(`/bills/${twoSidedSlug}`);
  await expect(box(page).getByRole('heading', { name: en.coverage.heading })).toBeVisible();
  await expect(box(page).getByRole('listitem').first()).toBeVisible();
  await expect(box(page).getByText(en.coverage.oneSidedNote)).toHaveCount(0);
  await expect(box(page).getByText(en.coverage.oneSidedNoteTwins)).toHaveCount(0);
});

test('switched off — neither a one-sided Big Question bill nor a two-sided bill shows the box', async ({ page }) => {
  test.skip(COVERAGE_BOX_ON, 'the coverage box is switched on');
  const kinds = [vehicleOneSidedSlug, twoSidedSlug].filter((s): s is string => Boolean(s));
  test.skip(kinds.length === 0, 'neither kind is in the current data');
  for (const slug of kinds) {
    await page.goto(`/bills/${slug}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(box(page)).toHaveCount(0);
    await expect(page.getByText(en.coverage.oneSidedNote)).toHaveCount(0);
    await expect(page.getByText(en.coverage.oneSidedNoteTwins)).toHaveCount(0);
    await expect(page.getByText(en.coverage.leanNote)).toHaveCount(0);
  }
});
