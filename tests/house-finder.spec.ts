import { expect, test, type Locator, type Page } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { billSlug, districtsForZip, getAllBills, getBill, repsForDistrict, vacancyForDistrict } from '../lib/core';
import { settledDecision } from '../lib/journey';
import { settledVoteGroups } from '../lib/settled-votes';
import { votesCoverage, votesForBill } from '../lib/votes';
import { seedZip } from './helpers';

/*
 * THE SPLIT-ZIP HOUSE FINDER, VERSION A, on the page the owner reviewed
 * (owner, 2026-09-29, the settled box on /bills/hconres-89-119 with a split
 * ZIP: "This would be a use of a subtle yellow button (I know color comes
 * later) but there should be a way for them to find those votes in this box
 * here. Can you build that for me? Mock up two versions of how this could
 * look.").
 *
 * With a saved ZIP that spans more than one House district, the House vote
 * group keeps its line ("can't say which House member is yours") and gains
 * one button. Opening it lists every House member whose district touches the
 * ZIP, each labeled with the district and their position on that House roll
 * call — from data/votes.json and nothing else — under a line saying one of
 * them is yours. No address is asked, nothing is sent, the URL does not move.
 *
 * H.Con.Res. 89 passed the House (roll 282, 2026-07-23, 214–208) and the
 * Senate rejected it (record vote 244, 2026-09-24, 49–50); ZIP 77484 spans
 * three Texas districts. Pinned by slug, skipped with a reason if the record
 * moves on. Copy is read by message key; the finder by its data hooks.
 */

const HCONRES_89 = 'hconres-89-119';
const SPLIT_ZIP = '77484';
const PANEL = '[data-settled-panel]';

const HOUSE_ROLL = votesForBill(HCONRES_89).find((r) => r.chamber === 'house' && r.roll === 282);
const HCONRES_SETTLED = (() => {
  const b = getBill(HCONRES_89);
  return !!b && settledDecision(b) !== null;
})();

const tEn = createTranslator({ locale: 'en', messages: en });
const tEs = createTranslator({ locale: 'es', messages: es });

/** "TX-8" for every House district a ZIP touches, sorted as the finder sorts. */
function seatsFor(zip: string): string[] {
  return districtsForZip(zip)
    .slice()
    .sort((a, b) => a.state.localeCompare(b.state) || a.district - b.district)
    .map((d) => `${d.state}-${d.district}`);
}

function skipUnlessOwnerPage() {
  test.skip(!HCONRES_SETTLED, 'H.Con.Res. 89 is no longer settled in the committed record');
  test.skip(!HOUSE_ROLL, 'House roll 282 on H.Con.Res. 89 is not in data/votes.json');
}

async function openWithZip(page: Page, path: string, zip: string) {
  await page.goto(path);
  await seedZip(page, zip);
  await page.reload();
  const house = page.locator(`${PANEL} [data-settled-vote-group="house"]`);
  await expect(house).toBeVisible();
  return house;
}

async function toggleOf(house: Locator) {
  const toggle = house.locator('[data-house-finder-toggle]');
  await expect(toggle).toBeVisible();
  return toggle;
}

for (const { locale, prefix, t } of [
  { locale: 'en', prefix: '', t: tEn },
  { locale: 'es', prefix: '/es', t: tEs },
] as const) {
  test(`${locale}: a split ZIP on H.Con.Res. 89 — one button in the House group, then every district's member and their vote`, async ({
    page,
  }) => {
    skipUnlessOwnerPage();
    const house = await openWithZip(page, `${prefix}/bills/${HCONRES_89}`, SPLIT_ZIP);

    // At rest: the line that says why no single member is shown, and the
    // button naming the ZIP, collapsed. No member row yet.
    await expect(house.getByText(t('bill.settled.multiDistrict'))).toBeVisible();
    const toggle = await toggleOf(house);
    await expect(toggle).toHaveText(t('bill.settled.finderShow', { zip: SPLIT_ZIP }));
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const list = house.locator('[data-house-finder-list]');
    await expect(list).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-controls', (await list.getAttribute('id'))!);

    // 44px, the control radius, ink text.
    const box = (await toggle.boundingBox())!;
    expect(box.height, 'the finder button is 44px tall').toBeGreaterThanOrEqual(44);

    // Next's <Link> may prefetch the pages the new rows link to; that is the
    // router, not the finder. What must not happen is a call to the API or
    // anything posted.
    const url = page.url();
    const sent: string[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'GET' || new URL(r.url()).pathname.startsWith('/api/')) sent.push(`${r.method()} ${r.url()}`);
    });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(list).toBeVisible();

    // One line: split between N districts, one of these is yours.
    const seats = seatsFor(SPLIT_ZIP);
    const vacant = districtsForZip(SPLIT_ZIP).some((d) => vacancyForDistrict(d));
    await expect(list.locator('[data-house-finder-split]')).toHaveText(
      t('bill.settled.finderSplit', { count: seats.length, vacant: vacant ? 'yes' : 'no' })
    );

    // Every district, in order, each with its label, its member and the
    // position roll 282 lists for them — or "No recorded vote".
    const rows = list.locator('[data-house-finder-row]');
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-house-finder-row')))).toEqual(seats);
    for (const seat of seats) {
      const [state, n] = seat.split('-');
      const row = list.locator(`[data-house-finder-row="${seat}"]`);
      await expect(row).toContainText(t('bill.settled.finderDistrict', { state, district: n }));
      const member = repsForDistrict({ state, district: Number(n) }).find((l) => l.type === 'rep');
      if (!member) {
        await expect(row).toContainText(t('bill.settled.finderVacant'));
        continue;
      }
      await expect(row).toHaveAttribute('data-finder-member', member.bioguide);
      await expect(row.getByRole('link', { name: member.name })).toHaveAttribute(
        'href',
        `${prefix}/reps/${member.bioguide}`
      );
      const position = (['yea', 'nay', 'present', 'notVoting'] as const).find((p) =>
        HOUSE_ROLL!.votes[p].includes(member.bioguide)
      );
      await expect(row.locator('[data-settled-position]')).toHaveAttribute(
        'data-settled-position',
        position ?? 'none'
      );
      await expect(row).toContainText(position ? t(`votes.position.${position}`) : t('bill.settled.noRecordedVote'));
    }

    // The optional street-address path is a link to /reps, never a field here.
    await expect(list.locator('input, form')).toHaveCount(0);
    await expect(list.locator('[data-house-finder-refine]')).toHaveAttribute(
      'href',
      `${prefix}/reps?zip=${SPLIT_ZIP}`
    );

    // Opening it sent nothing and moved nothing.
    expect(sent, 'opening the finder calls no API and posts nothing').toEqual([]);
    expect(page.url()).toBe(url);

    // The Senate group is unchanged: senators only, never a House member.
    const senate = page.locator(`${PANEL} [data-settled-vote-group="senate"]`);
    await expect(senate.locator('[data-house-finder-toggle]')).toHaveCount(0);
    expect(await senate.locator('[data-vote-delegate]').count()).toBeGreaterThan(0);

    // And still nothing to call with.
    await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
  });

  test(`${locale}: the finder works from the keyboard, with a visible focus ring`, async ({ page }) => {
    skipUnlessOwnerPage();
    const house = await openWithZip(page, `${prefix}/bills/${HCONRES_89}`, SPLIT_ZIP);
    const toggle = await toggleOf(house);

    // Start the keyboard walk at the House group's heading, then Tab.
    await house.getByRole('heading', { level: 4 }).evaluate((h) => {
      h.setAttribute('tabindex', '-1');
      (h as HTMLElement).focus();
    });
    await page.keyboard.press('Tab');
    await expect(toggle).toBeFocused();
    const ring = await toggle.evaluate((b) => {
      const cs = getComputedStyle(b);
      return {
        focusVisible: b.matches(':focus-visible'),
        outline: cs.outlineStyle !== 'none' ? parseFloat(cs.outlineWidth) : 0,
      };
    });
    expect(ring.focusVisible, 'the finder button is :focus-visible').toBe(true);
    expect(ring.outline, 'the site\'s 3px focus ring').toBeGreaterThanOrEqual(3);

    // Enter opens it; focus stays on the button.
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
    // Into the list: the first member's name. WebKit, like Safari, leaves
    // links out of plain Tab by default and reaches them with Option-Tab
    // (probed 2026-09-29: plain Tab went on to the next button on the page).
    await page.keyboard.press('Alt+Tab');
    const firstLink = house.locator('[data-house-finder-row]').first().getByRole('link');
    await expect(firstLink).toBeFocused();
    // Back, and Space closes it.
    await page.keyboard.press('Shift+Tab');
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(house.locator('[data-house-finder-list]')).toBeHidden();
  });
}

test('every control the finder adds has a 44px hit box', async ({ page }) => {
  skipUnlessOwnerPage();
  const house = await openWithZip(page, `/bills/${HCONRES_89}`, SPLIT_ZIP);
  await (await toggleOf(house)).click();
  const small = await house.locator('[data-house-finder]').evaluate((root) =>
    [...root.querySelectorAll('a[href], button')]
      .map((el) => ({ text: (el.textContent ?? '').trim().slice(0, 40), h: el.getBoundingClientRect().height }))
      .filter((c) => c.h < 44)
  );
  expect(small, 'finder controls under 44px').toEqual([]);
});

test('a vacant seat in the split ZIP is its own row, and the line says one of these seats is yours', async ({
  page,
}) => {
  skipUnlessOwnerPage();
  // ZIP 33060 spans FL-20 (vacant in the committed data) and FL-23.
  test.skip(!vacancyForDistrict({ state: 'FL', district: 20 }), 'FL-20 is no longer vacant');
  const house = await openWithZip(page, `/es/bills/${HCONRES_89}`, '33060');
  await (await toggleOf(house)).click();
  const list = house.locator('[data-house-finder-list]');
  await expect(list.locator('[data-house-finder-split]')).toHaveText(
    tEs('bill.settled.finderSplit', { count: 2, vacant: 'yes' })
  );
  const fl20 = list.locator('[data-house-finder-row="FL-20"]');
  await expect(fl20.getByRole('link', { name: es.bill.settled.finderVacant })).toHaveAttribute(
    'href',
    '/es/reps/fl-20'
  );
  await expect(fl20.locator('[data-settled-position]')).toHaveCount(0);
  await expect(list.locator('[data-house-finder-row="FL-23"] [data-settled-position]')).toHaveCount(1);
});

test('a single-district ZIP keeps its one House member and gets no finder', async ({ page }) => {
  skipUnlessOwnerPage();
  // ZIP 78501 is TX-15 only.
  const house = await openWithZip(page, `/bills/${HCONRES_89}`, '78501');
  await expect(house.locator('[data-vote-delegate]')).toHaveCount(1);
  await expect(house.locator('[data-house-finder-toggle]')).toHaveCount(0);
  await expect(house.getByText(en.bill.settled.multiDistrict)).toHaveCount(0);
});

test('with no ZIP saved the panel is unchanged: one line, the form, and no finder', async ({ page }) => {
  skipUnlessOwnerPage();
  await page.goto(`/bills/${HCONRES_89}`);
  const panel = page.locator(PANEL);
  await expect(panel.getByText(en.bill.settled.needZip)).toBeVisible();
  await expect(panel.getByLabel(en.home.zipLabel)).toBeVisible();
  await expect(panel.locator('[data-settled-votes]')).toHaveCount(0);
  await expect(panel.locator('[data-house-finder]')).toHaveCount(0);
});

/*
 * A House vote whose positions the file does not hold — a voice vote, or one
 * older than the roll-call file — has no votes to find, so a button promising
 * them would not be true. The group keeps its line and its note instead.
 */
const NO_POSITIONS = (() => {
  const floor = votesCoverage().floor;
  for (const b of getAllBills()) {
    if (!b.ai_sections) continue;
    const settled = settledDecision(b);
    if (!settled) continue;
    const slug = billSlug(b);
    const house = settledVoteGroups(b, settled, votesForBill(slug), floor).find((g) => g.chamber === 'house');
    if (house && house.source !== 'rollCall') return { slug, source: house.source };
  }
  return null;
})();

test('a House vote with no positions in the file offers no finder — the note says why', async ({ page }) => {
  test.skip(!NO_POSITIONS, 'no settled bill whose House vote lacks positions in the file');
  const house = await openWithZip(page, `/bills/${NO_POSITIONS!.slug}`, SPLIT_ZIP);
  await expect(house).toHaveAttribute('data-settled-vote-source', NO_POSITIONS!.source);
  await expect(house.getByText(en.bill.settled.multiDistrict)).toBeVisible();
  await expect(house.locator('[data-house-finder-toggle]')).toHaveCount(0);
});

test('the open finder reflows at 320px @reflow', async ({ page }) => {
  skipUnlessOwnerPage();
  const house = await openWithZip(page, `/es/bills/${HCONRES_89}`, SPLIT_ZIP);
  await (await toggleOf(house)).click();
  await expect(house.locator('[data-house-finder-list]')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow, 'the open finder must not scroll the page sideways').toBeLessThanOrEqual(0);
});
