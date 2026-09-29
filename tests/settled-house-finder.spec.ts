import { expect, test, type Locator, type Page } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { districtsForZip, getBill, repsForDistrict } from '../lib/core';
import type { RollCall } from '../lib/types';
import { votesForBill } from '../lib/votes';
import { seedZip } from './helpers';

/*
 * FIND YOUR HOUSE MEMBER'S VOTE, VERSION B — the street-address finder in the
 * settled panel's House group.
 *
 * The owner, 2026-09-29, reviewing the settled box on /bills/hconres-89-119
 * with a ZIP that spans more than one House district: "Great edge case on the
 * house district/zip situation here. This would be a use of a subtle yellow
 * button (I know color comes later) but there should be a way for them to find
 * those votes in this box here. Can you build that for me? Mock up two
 * versions of how this could look."
 *
 * The case: H.Con.Res. 89 (the Senate rejected it 49–50 on Sep 24, 2026; the
 * House vote, roll 282, was Jul 23, 2026, 214–208) with ZIP 77484, which spans
 * TX-8, TX-10 and TX-38. /api/district is mocked at the browser (the pattern
 * of tests/district.spec.ts), so no test calls the Census geocoder. Copy is
 * read by message key; the finder by its data hooks.
 */

const HCONRES_89 = 'hconres-89-119';
const HCONRES_89_TEXT = 'Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.';
const SPLIT_ZIP = '77484';
const ADDRESS = '421 Example Rd';

const PANEL = '[data-settled-panel]';
const HOUSE = '[data-settled-vote-group="house"]';

const tEn = createTranslator({ locale: 'en', messages: en });
const tEs = createTranslator({ locale: 'es', messages: es });

/** The House roll call the group prints, and each member's listed position. */
const houseRoll = (): RollCall | undefined => votesForBill(HCONRES_89).find((r) => r.chamber === 'house');
const positionIn = (roll: RollCall, id: string) =>
  (['yea', 'nay', 'present', 'notVoting'] as const).find((p) => roll.votes[p].includes(id)) ?? null;

/** The House member of one of 77484's districts, from the roster. */
const memberOf = (district: number) =>
  repsForDistrict({ state: 'TX', district }).find((r) => r.type === 'rep')!;

function skipUnlessOwnerCase() {
  const bill = getBill(HCONRES_89);
  test.skip(bill?.last_action_text !== HCONRES_89_TEXT, 'H.Con.Res. 89 has a newer action than 2026-09-24');
  test.skip(!houseRoll(), 'the House roll call on H.Con.Res. 89 is not in data/votes.json');
  test.skip(districtsForZip(SPLIT_ZIP).length < 2, `${SPLIT_ZIP} no longer spans more than one district`);
}

function mockDistrictApi(page: Page, response: { status: number; body: Record<string, unknown> }) {
  const requests: { method: string; url: string; postData: string | null }[] = [];
  page.route('**/api/district', (route) => {
    requests.push({ method: route.request().method(), url: route.request().url(), postData: route.request().postData() });
    return route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) });
  });
  return requests;
}

async function openBillWithZip(page: Page, prefix: string, zip: string) {
  await page.goto(`${prefix}/bills/${HCONRES_89}`);
  await seedZip(page, zip);
  await page.reload();
  await expect(page.locator(`${PANEL} [data-settled-votes]`)).toBeVisible();
}

/** Every control inside `scope` under 44px tall or wide (bill-a11y.spec.ts's rule). */
async function smallTargets(scope: Locator) {
  return scope.evaluate((root) => {
    const out: string[] = [];
    for (const el of root.querySelectorAll('a[href], button, input:not([type="hidden"])')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width >= 44 && r.height >= 44) continue;
      out.push(`${el.tagName} "${(el.textContent ?? '').trim().slice(0, 40)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
}

/** Focus `el` by keyboard (Shift+Tab away, Tab back), so :focus-visible is real. */
async function keyboardFocus(page: Page, el: Locator) {
  await el.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(el).toBeFocused();
  const ring = await el.evaluate((a) => {
    const cs = getComputedStyle(a);
    return { visible: a.matches(':focus-visible'), width: cs.outlineStyle !== 'none' ? parseFloat(cs.outlineWidth) : 0 };
  });
  expect(ring.visible, ':focus-visible').toBe(true);
  expect(ring.width, 'the 3px focus ring').toBeGreaterThanOrEqual(3);
}

for (const { locale, prefix, t } of [
  { locale: 'en', prefix: '', t: tEn },
  { locale: 'es', prefix: '/es', t: tEs },
] as const) {
  test(`${locale}: split ZIP — the amber button opens the address field in the box, and a matched address shows one member beside their recorded vote`, async ({
    page,
  }) => {
    skipUnlessOwnerCase();
    const requests = mockDistrictApi(page, { status: 200, body: { state: 'TX', district: 10 } });
    await openBillWithZip(page, prefix, SPLIT_ZIP);
    const panel = page.locator(PANEL);
    const house = panel.locator(HOUSE);
    const finder = house.locator('[data-house-finder]');

    // At rest: one line saying the address decides, and the amber button. No
    // House member is listed yet — the ZIP alone cannot say which is yours.
    await expect(finder).toHaveAttribute('data-house-finder', 'closed');
    await expect(finder).toContainText(t('bill.houseFinder.split', { count: districtsForZip(SPLIT_ZIP).length }));
    await expect(house.locator('[data-vote-delegate]')).toHaveCount(0);
    const open = finder.getByRole('button', { name: t('bill.houseFinder.open') });
    await expect(open).toBeVisible();
    // The senators are unaffected: both, under the Senate vote.
    await expect(panel.locator('[data-settled-vote-group="senate"] [data-vote-delegate]')).toHaveCount(2);

    // A subtle amber fill (a light `urgent`, never solid), ink text, 44px.
    const look = await open.evaluate((b) => {
      const cs = getComputedStyle(b);
      return { bg: cs.backgroundColor, radius: cs.borderTopLeftRadius, height: b.getBoundingClientRect().height };
    });
    expect(look.bg, 'the button has a fill').not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
    expect(look.radius).toBe('8px');
    expect(look.height).toBeGreaterThanOrEqual(44);
    expect(await smallTargets(house), 'finder controls under 44px, closed').toEqual([]);

    // Keyboard: the button takes a visible focus ring and opens on Enter; the
    // field it opens takes focus.
    await keyboardFocus(page, open);
    await page.keyboard.press('Enter');
    await expect(finder).toHaveAttribute('data-house-finder', 'asking');
    const field = finder.getByLabel(t('reps.addressLabel'));
    await expect(field).toBeFocused();
    await expect(finder.getByText(t('reps.refinePrivacy'))).toBeVisible();
    expect(await smallTargets(house), 'finder controls under 44px, asking').toEqual([]);

    // Typed and submitted from the keyboard.
    await page.keyboard.type(ADDRESS);
    await page.keyboard.press('Enter');

    // The answer: exactly one House member, the one for TX-10, beside the
    // position roll 282 lists for them — and focus lands on the answer.
    const answer = finder.locator('[data-house-finder-answer="seat"]');
    await expect(answer).toBeVisible();
    await expect(answer).toBeFocused();
    await expect(answer).toContainText(t('bill.houseFinder.found', { district: 'TX-10' }));
    const rows = house.locator('[data-vote-delegate]');
    await expect(rows).toHaveCount(1);
    const member = memberOf(10);
    await expect(rows).toHaveAttribute('data-vote-delegate', member.bioguide);
    const position = positionIn(houseRoll()!, member.bioguide);
    await expect(rows.locator('[data-settled-position]')).toHaveAttribute('data-settled-position', position ?? 'none');
    await expect(rows).toContainText(position ? t(`votes.position.${position}`) : t('bill.settled.noRecordedVote'));
    await expect(rows.getByRole('link', { name: `${member.name} (TX-10)` })).toHaveAttribute(
      'href',
      `${prefix}/reps/${member.bioguide}`
    );
    expect(await smallTargets(house), 'finder controls under 44px, answered').toEqual([]);

    // Privacy: one POST, the address in its body only; the page URL and the
    // browser's storage never hold the address or the derived district.
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].postData).toContain(ADDRESS);
    expect(requests[0].url).not.toContain('Example');
    expect(page.url()).not.toMatch(/Example|district=/);
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    expect(stored).not.toContain('Example');
    expect(stored).not.toContain('TX-10');

    // A way to change it: the field again, focused, empty.
    await finder.getByRole('button', { name: t('bill.houseFinder.change') }).click();
    await expect(finder.getByLabel(t('reps.addressLabel'))).toBeFocused();
    await expect(finder.getByLabel(t('reps.addressLabel'))).toHaveValue('');
  });

  test(`${locale}: split ZIP — when the address check fails, every district's member is listed beside their vote, with a line saying why`, async ({
    page,
  }) => {
    skipUnlessOwnerCase();
    mockDistrictApi(page, { status: 502, body: { error: 'unavailable' } });
    await openBillWithZip(page, prefix, SPLIT_ZIP);
    const house = page.locator(`${PANEL} ${HOUSE}`);
    const finder = house.locator('[data-house-finder]');

    await finder.getByRole('button', { name: t('bill.houseFinder.open') }).click();
    await finder.getByLabel(t('reps.addressLabel')).fill(ADDRESS);
    await finder.getByRole('button', { name: t('reps.refineCta') }).click();

    const fallback = finder.locator('[data-house-finder-fallback="unavailable"]');
    await expect(fallback).toBeVisible();
    await expect(fallback).toBeFocused();
    const districts = districtsForZip(SPLIT_ZIP);
    await expect(fallback).toContainText(
      t('bill.houseFinder.fallback', { reason: 'unavailable', count: districts.length, zip: SPLIT_ZIP })
    );
    // One row per district, in district order, each beside its own position.
    const rows = house.locator('[data-vote-delegate]');
    await expect(rows).toHaveCount(districts.length);
    const order = [...districts].sort((a, b) => a.district - b.district);
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-house-seat')))).toEqual(
      order.map((d) => `${d.state}-${d.district}`)
    );
    for (const d of order) {
      const member = memberOf(d.district);
      const row = house.locator(`[data-vote-delegate="${member.bioguide}"]`);
      const position = positionIn(houseRoll()!, member.bioguide);
      await expect(row.locator('[data-settled-position]')).toHaveAttribute('data-settled-position', position ?? 'none');
    }
    expect(await smallTargets(house), 'finder controls under 44px, fallback').toEqual([]);

    // And the address can be tried again.
    await finder.getByRole('button', { name: t('bill.houseFinder.tryAgain') }).click();
    await expect(finder.getByLabel(t('reps.addressLabel'))).toBeFocused();
  });

  test(`${locale}: with no ZIP saved the settled panel is unchanged — the ZIP prompt, and no finder`, async ({ page }) => {
    skipUnlessOwnerCase();
    await page.goto(`${prefix}/bills/${HCONRES_89}`);
    const panel = page.locator(PANEL);
    await expect(panel.getByText(t('bill.settled.needZip'))).toBeVisible();
    await expect(panel.getByLabel(t('home.zipLabel'))).toBeVisible();
    await expect(panel.locator('[data-settled-votes]')).toHaveCount(0);
    await expect(page.locator('[data-house-finder]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: t('bill.houseFinder.open') })).toHaveCount(0);
  });
}

test('an address that is not found keeps the field, says so, and offers every member instead', async ({ page }) => {
  skipUnlessOwnerCase();
  mockDistrictApi(page, { status: 404, body: { error: 'not_found' } });
  await openBillWithZip(page, '', SPLIT_ZIP);
  const finder = page.locator(`${PANEL} ${HOUSE} [data-house-finder]`);
  await finder.getByRole('button', { name: tEn('bill.houseFinder.open') }).click();
  await finder.getByLabel(tEn('reps.addressLabel')).fill('9999 Nowhere Xyzzy Lane');
  await finder.getByRole('button', { name: tEn('reps.refineCta') }).click();

  await expect(finder.getByRole('alert')).toContainText(tEn('bill.houseFinder.notFound'));
  await expect(finder.getByLabel(tEn('reps.addressLabel'))).toHaveAttribute('aria-invalid', 'true');
  await finder.getByRole('button', { name: tEn('bill.houseFinder.showAll') }).click();
  await expect(finder.locator('[data-house-finder-fallback="chosen"]')).toBeVisible();
  await expect(finder.locator('[data-vote-delegate]')).toHaveCount(districtsForZip(SPLIT_ZIP).length);
});

test('Cancel closes the field and hands focus back to the amber button', async ({ page }) => {
  skipUnlessOwnerCase();
  await openBillWithZip(page, '', SPLIT_ZIP);
  const finder = page.locator(`${PANEL} ${HOUSE} [data-house-finder]`);
  await finder.getByRole('button', { name: tEn('bill.houseFinder.open') }).click();
  await finder.getByRole('button', { name: tEn('bill.houseFinder.cancel') }).click();
  await expect(finder).toHaveAttribute('data-house-finder', 'closed');
  await expect(finder.getByRole('button', { name: tEn('bill.houseFinder.open') })).toBeFocused();
});

test('an address the ZIP map does not expect names its district and links to /reps, which trusts the address', async ({
  page,
}) => {
  skipUnlessOwnerCase();
  mockDistrictApi(page, { status: 200, body: { state: 'TX', district: 7 } });
  await openBillWithZip(page, '', SPLIT_ZIP);
  const finder = page.locator(`${PANEL} ${HOUSE} [data-house-finder]`);
  await finder.getByRole('button', { name: tEn('bill.houseFinder.open') }).click();
  await finder.getByLabel(tEn('reps.addressLabel')).fill(ADDRESS);
  await finder.getByRole('button', { name: tEn('reps.refineCta') }).click();

  const answer = finder.locator('[data-house-finder-answer="outside"]');
  await expect(answer).toContainText(tEn('bill.houseFinder.outside', { district: 'TX-7', zip: SPLIT_ZIP }));
  await expect(answer.locator('[data-vote-delegate]')).toHaveCount(0);
  await expect(answer.getByRole('link', { name: tEn('bill.houseFinder.outsideLink', { district: 'TX-7' }) })).toHaveAttribute(
    'href',
    `/reps?zip=${SPLIT_ZIP}&district=TX-7`
  );
});

test('a single-district ZIP never shows the finder: its one House member is listed as before', async ({ page }) => {
  skipUnlessOwnerCase();
  await openBillWithZip(page, '', '78501');
  const house = page.locator(`${PANEL} ${HOUSE}`);
  await expect(house.locator('[data-vote-delegate]')).toHaveCount(1);
  await expect(page.locator('[data-house-finder]')).toHaveCount(0);
});

test('the finder, open, reflows at 320px with no horizontal scroll @reflow', async ({ page }) => {
  skipUnlessOwnerCase();
  await openBillWithZip(page, '', SPLIT_ZIP);
  const finder = page.locator(`${PANEL} ${HOUSE} [data-house-finder]`);
  await finder.getByRole('button', { name: tEn('bill.houseFinder.open') }).click();
  await expect(finder.getByLabel(tEn('reps.addressLabel'))).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0);
  expect(await smallTargets(page.locator(`${PANEL} ${HOUSE}`)), 'finder controls under 44px at 320').toEqual([]);
});
