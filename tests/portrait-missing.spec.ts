import { expect, test, type Locator, type Page } from '@playwright/test';
import missingJson from '../data/portrait-missing.json';
import legislators from '../data/legislators.json';
import zipDistricts from '../data/zip-districts.json';
import { mockScriptApi, seedZip } from './helpers';
import type { Legislator } from '../lib/types';

/*
 * A SITTING MEMBER WHOSE PHOTO IS MISSING AT THE SOURCE SHOWS THE INITIALS,
 * NEVER A BROKEN-IMAGE MARK (the member page, the lookup's member cards).
 *
 * The members are read from data/portrait-missing.json itself, never named,
 * so this keeps holding as the portrait mirror job changes the list: one
 * House member and one senator when the list has them. Both languages run;
 * the three browser projects give 1280 (desktop), 390 (mobile) and, because
 * of the tag, 320. The rule is held by tests/portrait-missing.unit.spec.ts.
 *
 * Every <img> on the page must be loaded (complete, naturalWidth > 0): a
 * photo that fails would leave a broken one. The other members on the page
 * keep their real photo, fetched through the site's own image proxy.
 */

const ROSTER = legislators as Legislator[];
const ZIPS = zipDistricts as Record<string, { state: string; district: number }[]>;
const MISSING = new Set(Object.keys(missingJson as Record<string, unknown>));
const SITTING_MISSING = ROSTER.filter((l) => MISSING.has(l.bioguide));
const PICKS = [
  SITTING_MISSING.find((l) => l.type === 'rep'),
  SITTING_MISSING.find((l) => l.type === 'sen'),
].filter((l): l is Legislator => Boolean(l));

const initialsOf = (l: Legislator) => `${l.first[0]}${l.last[0]}`.toUpperCase();

/** A ZIP that touches the member's seat: a ZIP wholly inside it when one exists. */
function zipFor(l: Legislator): string | undefined {
  const touches = (z: string) =>
    ZIPS[z].some((d) => d.state === l.state && (l.type === 'sen' || d.district === l.district));
  return Object.keys(ZIPS).find((z) => ZIPS[z].length === 1 && touches(z)) ?? Object.keys(ZIPS).find(touches);
}

/** No image on the page is broken or still loading. */
async function expectNoBrokenImage(page: Page) {
  await page.waitForLoadState('load');
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          for (const img of Array.from(document.images)) img.loading = 'eager';
          return Array.from(document.images).map((i) => i.complete && i.naturalWidth > 0);
        }),
      { timeout: 20_000 },
    )
    .not.toContain(false);
}

/** The initials stand alone in the frame: visible, in a neutral box (rule 3), no photo inside. */
async function expectInitialsAlone(frame: Locator, l: Legislator) {
  await expect(frame.locator('img')).toHaveCount(0);
  const initials = frame.getByText(initialsOf(l), { exact: true });
  await expect(initials).toBeVisible();
  const box = await frame.evaluate((el) => {
    const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const text = el.firstElementChild as HTMLElement;
    return { bg: parse(getComputedStyle(el).backgroundColor), ink: parse(getComputedStyle(text).color) };
  });
  // No party-coded colour (hard rule 3): the frame and its letters are ink-and-paper neutrals.
  for (const rgb of [box.bg, box.ink]) expect(Math.max(...rgb) - Math.min(...rgb)).toBeLessThanOrEqual(20);
}

test.describe('sitting members whose photo is missing at the source', () => {
  test('the record names at least one sitting member, or these tests prove nothing', () => {
    expect(PICKS.length).toBeGreaterThan(0);
  });

  for (const [prefix, lang] of [['', 'en'], ['/es', 'es']] as const) {
    for (const l of PICKS) {
      test(`@reflow ${lang}: the page of a ${l.type === 'sen' ? 'senator' : 'representative'} on the list shows the initials and no broken image`, async ({
        page,
      }) => {
        const res = await page.goto(`${prefix}/reps/${l.bioguide}`);
        expect(res?.status(), l.bioguide).toBe(200);
        await expect(page.locator('h1')).toHaveText(l.name);
        const frame = page.locator('header').filter({ has: page.locator('h1') }).locator('span.relative').first();
        await expectInitialsAlone(frame, l);
        await expectNoBrokenImage(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      });

      test(`@reflow ${lang}: the lookup card of a ${l.type === 'sen' ? 'senator' : 'representative'} on the list shows the initials and no broken image`, async ({
        page,
      }) => {
        const zip = zipFor(l);
        test.skip(!zip, `no ZIP in the map touches ${l.state}-${l.district}`);
        // Anything this page might call is stubbed; the lookup itself is the site's own route.
        await mockScriptApi(page);
        await page.route('**/api/district', (route) => route.abort());
        await page.goto(`${prefix}/privacy`);
        await seedZip(page, zip!);
        await page.goto(`${prefix}/reps`);
        const card = page.locator('article').filter({ has: page.getByRole('link', { name: l.name, exact: true }) });
        await expect(card).toHaveCount(1);
        await expectInitialsAlone(card.locator('span.relative').first(), l);
        await expectNoBrokenImage(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      });
    }
  }
});
