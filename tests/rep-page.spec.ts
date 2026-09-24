import { expect, test, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import {
  billSlug,
  getBillsSponsoredBy,
  getLegislator,
  getVacancies,
  senatorsForState,
  vacancySlug,
} from '../lib/core';

/*
 * The per-member page, /reps/[bioguide] (plan item C2). Three shapes: a House
 * member, a senator, and a vacant seat (keyed on the seat - a vacancy has no
 * bioguide). Corpus-coupled the same way reps.spec.ts is: the members are
 * named by bioguide, and every count is recomputed from lib/core at assert
 * time so a nightly sync that adds a sponsored bill cannot break this file.
 *
 * The funnel invariants for this surface live in tests/funnel.spec.ts
 * ("member page"), beside the others, not here.
 */

const HOUSE = 'D000594'; // Monica De La Cruz, TX-15 (also reps.spec.ts's ZIP 78501 fixture)
const SENATOR = 'C000127'; // Maria Cantwell, WA

const LOCALES = [
  { prefix: '', messages: en },
  { prefix: '/es', messages: es },
] as const;

/** Every visible interactive target inside <main> is at least 44px tall. */
async function expectTouchTargets(page: Page) {
  const small = await page.locator('main').evaluate((main) => {
    const out: string[] = [];
    for (const el of main.querySelectorAll<HTMLElement>('a[href], button, summary')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // inside a closed <details>
      if (r.height < 44) out.push(`${el.tagName} "${el.textContent?.trim().slice(0, 40)}" ${r.height}px`);
    }
    return out;
  });
  expect(small, 'WCAG 2.5.8 / CLAUDE.md: 44px touch targets').toEqual([]);
}

/** The page's outline and control counts: identical across locales, or a
 *  string somewhere is hardcoded or missing in one language. */
async function structure(page: Page) {
  const main = page.locator('main');
  return {
    h1: await main.locator('h1').count(),
    h2: await main.locator('h2').count(),
    h3: await main.locator('h3').count(),
    tel: await main.locator('a[href^="tel:"]').count(),
    bills: await main.locator('a[href*="/bills/"]').count(),
  };
}

for (const { prefix, messages } of LOCALES) {
  test.describe(`member page ${prefix || '/'}`, () => {
    test('House member: name, seat, party as text, the dial, sponsored bills', async ({ page }) => {
      const rep = getLegislator(HOUSE)!;
      await page.goto(`${prefix}/reps/${HOUSE}`);
      await expect(page.getByRole('heading', { level: 1, name: rep.name })).toBeVisible();
      const meta = page.locator('main header p').first();
      await expect(meta).toContainText(messages.reps.representative);
      await expect(meta).toContainText(
        messages.reps.party[rep.party as 'Democrat' | 'Republican' | 'Independent']
      );
      await expect(meta).toContainText(`${rep.state}`);

      // The call apparatus: the same dial and local numbers the lookup renders.
      await expect(page.getByRole('heading', { name: messages.rep.contactHeading })).toBeVisible();
      const dial = page.locator(`a[href="tel:+1${rep.phone!.replace(/\D/g, '')}"]`);
      await expect(dial).toBeVisible();
      await expect(dial).toContainText(messages.reps.dcOffice);
      await expect(page.getByText(messages.reps.localOffices, { exact: false }).first()).toBeVisible();

      const sponsored = getBillsSponsoredBy(HOUSE);
      await expect(page.getByRole('heading', { name: messages.rep.sponsoredHeading })).toBeVisible();
      if (sponsored.length > 0) {
        await expect(page.getByText(messages.rep.aiNote, { exact: true })).toBeVisible();
        await expect(page.locator(`main a[href$="/bills/${billSlug(sponsored[0])}"]`)).toBeVisible();
      }

      await expectTouchTargets(page);
    });

    test('senator: role, both counts, dial', async ({ page }) => {
      const sen = getLegislator(SENATOR)!;
      await page.goto(`${prefix}/reps/${SENATOR}`);
      await expect(page.getByRole('heading', { level: 1, name: sen.name })).toBeVisible();
      await expect(page.locator('main header p').first()).toContainText(messages.reps.senator);
      await expect(page.locator('main a[href^="tel:"]').first()).toBeVisible();
      const sponsored = getBillsSponsoredBy(SENATOR).length;
      // Six cards open, the rest folded into one disclosure (links inside a
      // closed <details> still exist in the DOM).
      await expect(page.locator('main section[aria-labelledby="rep-sponsored"] a[href*="/bills/"]')).toHaveCount(
        sponsored
      );
      await expectTouchTargets(page);
    });

    test('vacant seat: says so, never names anyone, hands over the senators', async ({ page }) => {
      const seat = getVacancies()[0];
      test.skip(!seat, 'no vacant House seat in the roster this run');
      await page.goto(`${prefix}/reps/${vacancySlug(seat)}`);
      await expect(page.getByText(messages.reps.vacantSeat, { exact: true })).toBeVisible();
      await expect(page.getByText(messages.reps.vacantSeatBody)).toBeVisible();
      await expect(page.getByText(/special election|elecci[oó]n especial/i)).toHaveCount(0);
      for (const s of senatorsForState(seat.state)) {
        await expect(page.getByRole('heading', { name: s.name })).toBeVisible();
      }
      await expect(page.locator('main a[href^="tel:"]')).not.toHaveCount(0);
      await expectTouchTargets(page);
    });

    test('unknown id is a real 404', async ({ page }) => {
      const res = await page.goto(`${prefix}/reps/Z999999`);
      expect(res?.status()).toBe(404);
    });
  });
}

test('both locales render the same structure (no string lives in only one language)', async ({ page }) => {
  for (const id of [HOUSE, SENATOR, getVacancies()[0] ? vacancySlug(getVacancies()[0]) : HOUSE]) {
    await page.goto(`/reps/${id}`);
    const enShape = await structure(page);
    await page.goto(`/es/reps/${id}`);
    const esShape = await structure(page);
    expect(esShape, id).toEqual(enShape);
    // No English page copy on the Spanish page.
    for (const key of ['contactHeading', 'sponsoredHeading', 'crumb'] as const) {
      await expect(page.getByText(en.rep[key], { exact: true })).toHaveCount(0);
    }
  }
});
