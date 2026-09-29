import { expect, test, type Page } from '@playwright/test';
import { getVacancies, vacancySlug } from '../lib/core';

/*
 * THE MEMBER CARDS' NAME LINKS ARE 44px BOXES (rule 7, 2026-09-29).
 *
 * A member's name on a card (components/RepCard.tsx) and a vacant seat's
 * heading (components/VacantSeatCard.tsx) each link to that member's or
 * seat's page. Neither is a link inline in a sentence, so neither is exempt
 * from the 44px floor. Until 2026-09-29 each link's box was its 28px line,
 * and an ::after overlay made up the rest of the hit area. A sweep that
 * measures boxes, which is tests/bill-a11y.spec.ts's method and
 * docs/accessibility.md's (`min-h-11`), read them as 28px. Now the link's own
 * box is the target.
 *
 * This spec measures boxes only, never a hit test, and checks four things:
 *   1. every name link is at least 44x44;
 *   2. the whole box answers a tap: the top and bottom rows of the box hit
 *      the link itself, so no neighbour is painted over any of it;
 *   3. the type is the type it was: 21px (text-xl), weight 800, underlined;
 *   4. every other control on a card passes the same box sweep as the bill
 *      page, with the local-offices list opened so its numbers count too.
 *
 * Tagged @reflow, because at 320px a long name wraps to two lines and the
 * box has to grow with it rather than clip it.
 */

const LOCALES = ['', '/es'] as const;
const HOUSE_ZIP = '78501'; // TX-15 (tests/reps.spec.ts's fixture)
const VACANT_ZIP = '33313'; // FL-20 while it is vacant (tests/rep-page.spec.ts's fixture)
const fl20 = getVacancies().find((v) => v.state === 'FL' && v.district === 20);

const NAME_LINKS = '[data-rep-name-link], [data-seat-name-link]';

interface NameLink {
  text: string;
  width: number;
  height: number;
  topHits: boolean;
  bottomHits: boolean;
  fontSize: string;
  fontWeight: string;
  underline: boolean;
}

async function nameLinks(page: Page): Promise<NameLink[]> {
  return page.locator('main').evaluate((main, sel) => {
    const out: NameLink[] = [];
    for (const el of main.querySelectorAll<HTMLElement>(sel)) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const x = r.left + Math.min(r.width / 2, 20);
      const hits = (y: number) => {
        const hit = document.elementFromPoint(x, y);
        return !!hit && (hit === el || el.contains(hit));
      };
      out.push({
        text: (el.textContent ?? '').trim(),
        width: r.width,
        height: r.height,
        topHits: hits(r.top + 1),
        bottomHits: hits(r.bottom - 1),
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        underline: cs.textDecorationLine.includes('underline'),
      });
    }
    return out;
  }, NAME_LINKS);
}

/** tests/bill-a11y.spec.ts's box sweep, scoped to the member cards. */
async function smallCardTargets(page: Page): Promise<string[]> {
  return page.locator('main').evaluate((main, sel) => {
    for (const d of main.querySelectorAll('article details')) (d as HTMLDetailsElement).open = true;
    const cards = [...main.querySelectorAll('article')].filter((a) => a.querySelector(sel));
    const blockOf = (el: Element) => {
      let n: Element | null = el.parentElement;
      while (n && getComputedStyle(n).display.startsWith('inline')) n = n.parentElement;
      return n;
    };
    const out: string[] = [];
    for (const card of cards) {
      for (const el of card.querySelectorAll('a[href], button, summary, [role="button"]')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.width >= 44 && r.height >= 44) continue;
        if (getComputedStyle(el).display === 'inline') {
          const text = (el.textContent ?? '').trim();
          const around = (blockOf(el)?.textContent ?? '').replace(text, '').trim();
          if (around.length > 0) continue; // inline inside a sentence: exempt
        }
        out.push(`${el.tagName} "${(el.textContent ?? '').trim().slice(0, 40)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return out;
  }, NAME_LINKS);
}

function expectNameLinks(links: NameLink[], expected: number) {
  expect(links.length, 'name links on the page').toBe(expected);
  for (const l of links) {
    expect(l.height, `"${l.text}" box height`).toBeGreaterThanOrEqual(44);
    expect(l.width, `"${l.text}" box width`).toBeGreaterThanOrEqual(44);
    expect(l.topHits, `"${l.text}": the top of its box is covered by something else`).toBe(true);
    expect(l.bottomHits, `"${l.text}": the bottom of its box is covered by something else`).toBe(true);
    expect(l.fontSize, `"${l.text}" type size`).toBe('21px');
    expect(l.fontWeight, `"${l.text}" type weight`).toBe('800');
    expect(l.underline, `"${l.text}" is underlined`).toBe(true);
  }
}

for (const prefix of LOCALES) {
  test(`${prefix}/reps?zip=${HOUSE_ZIP}: the three name links are 44px boxes @reflow`, async ({ page }) => {
    await page.goto(`${prefix}/reps?zip=${HOUSE_ZIP}`);
    await expect(page.locator('[data-rep-name-link]')).toHaveCount(3);
    expectNameLinks(await nameLinks(page), 3);
    expect(await smallCardTargets(page), 'card controls under 44px').toEqual([]);
  });

  test(`${prefix}/reps?zip=${VACANT_ZIP}: the vacant seat's link is a 44px box too @reflow`, async ({ page }) => {
    test.skip(!fl20, 'FL-20 is no longer vacant, so ZIP 33313 has no vacant card');
    await page.goto(`${prefix}/reps?zip=${VACANT_ZIP}`);
    await expect(page.locator('[data-seat-name-link]')).toHaveCount(1);
    await expect(page.locator('[data-rep-name-link]')).toHaveCount(2);
    expectNameLinks(await nameLinks(page), 3);
    expect(await smallCardTargets(page), 'card controls under 44px').toEqual([]);
  });

  test(`${prefix}/reps/<vacant seat>: the state's senators' name links are 44px boxes`, async ({ page }) => {
    test.skip(!fl20, 'FL-20 is no longer vacant');
    await page.goto(`${prefix}/reps/${vacancySlug(fl20!)}`);
    // The seat page's own card carries no link; the senators' cards do.
    await expect(page.locator('[data-seat-name-link]')).toHaveCount(0);
    await expect(page.locator('[data-rep-name-link]')).toHaveCount(2);
    expectNameLinks(await nameLinks(page), 2);
    expect(await smallCardTargets(page), 'card controls under 44px').toEqual([]);
  });
}
