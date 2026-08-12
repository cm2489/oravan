import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { billSlug, getAllBills } from '../lib/core';
import { getAllNominations, nominationSlug } from '../lib/core/nominations';
import { deriveJourney, type FloorCalendar } from '../lib/journey';
import { GLOSSARY_TERM_IDS } from '../lib/glossary';

/*
 * THE PROCEDURAL GLOSSARY, LIVE (issue #181).
 *
 * The registry, the copy constraints and the EN/ES tag parity are pinned
 * without a browser in tests/glossary.unit.spec.ts. What needs a real render
 * is everything this file covers: that the page exists in both locales with
 * every anchor a glossed term points at, and that the hovercard honours the
 * a11y contract the issue made a condition of shipping one at all —
 * "keyboard-reachable and screen-reader-sane" — which after the 2026-08-12
 * redesign means WCAG 1.4.13's three clauses in full.
 *
 * FIXTURES ARE DERIVED FROM THE LIVE CORPUS, never hardcoded slugs: the bills
 * file moves nightly, and a spec pinned to a slug that leaves the floor-vote
 * band goes red on an unrelated PR. Each derived case skips itself when the
 * corpus stops offering it, and says so.
 */

const LOCALES = [
  ['en', '', en],
  ['es', '/es', es],
] as const;

/** The first bill whose record put it on the named calendar. */
function billOnCalendar(which: FloorCalendar): string | null {
  for (const bill of getAllBills()) {
    if (deriveJourney(bill).floorCalendar === which) return billSlug(bill);
  }
  return null;
}

/** The first nomination sitting at the named status. */
function nominationAt(status: string): string | null {
  for (const nomination of getAllNominations()) {
    if (nomination.status === status) return nominationSlug(nomination);
  }
  return null;
}

/*
 * HOVER A TERM, ONCE THE PAGE HAS STOPPED MOVING.
 *
 * globals.css sets `scroll-behavior: smooth`, so Playwright's own
 * scroll-into-view before a hover GLIDES — and a page still gliding under a
 * stationary pointer drags the term out from under it, which fires
 * pointerleave and closes the box. That is correct product behaviour (the
 * pointer really is no longer on the term) and a false failure in a test that
 * meant to measure something else, so the scroll is settled first.
 */
async function hoverTerm(page: Page, link: Locator) {
  await link.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await link.hover();
}

/** The box a term owns, located through the ARIA wiring rather than a class —
 *  if `aria-describedby` is wrong, every assertion here fails, which is the
 *  point. Polls, because the box opens after a deliberate hover delay. */
async function boxOf(page: Page, link: Locator) {
  await expect(link, 'no aria-describedby — the box never opened').toHaveAttribute(
    'aria-describedby',
    /./
  );
  const id = await link.getAttribute('aria-describedby');
  return page.locator(`[id="${id}"]`);
}

/* ------------------------------------------------------------------ *
 * 1 · The page
 * ------------------------------------------------------------------ */
for (const [locale, prefix, messages] of LOCALES) {
  test(`${locale}: the glossary page renders one h1 and every term as a section`, async ({
    page,
  }) => {
    await page.goto(`${prefix}/glossary`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(messages.glossary.title);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

    for (const id of GLOSSARY_TERM_IDS) {
      const terms = messages.glossary.terms as Record<string, { term: string; body: string }>;
      // The anchor: every glossed term in the product links here, and so
      // does anything anyone has ever pasted.
      await expect(page.locator(`#${id}`), `#${id} is missing`).toHaveCount(1);
      await expect(
        page.getByRole('heading', { name: terms[id].term, exact: true })
      ).toHaveCount(1);
      await expect(page.getByText(terms[id].body)).toBeVisible();
    }
  });

  test(`${locale}: every index link resolves to a section on this page`, async ({ page }) => {
    await page.goto(`${prefix}/glossary`);
    const nav = page.getByRole('navigation', { name: messages.glossary.indexLabel });
    await expect(nav.getByRole('link')).toHaveCount(GLOSSARY_TERM_IDS.length);
    for (const id of GLOSSARY_TERM_IDS) {
      await expect(nav.locator(`a[href="#${id}"]`)).toHaveCount(1);
    }
  });

  test(`${locale}: no horizontal overflow on the glossary page @reflow`, async ({ page }) => {
    await page.goto(`${prefix}/glossary`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `${prefix}/glossary must not scroll horizontally`).toBeLessThanOrEqual(0);
  });
}

test('a term anchor lands on that term, not the top of the page', async ({ page }) => {
  await page.goto('/glossary#reported-by-committee');
  await expect(page.locator('#reported-by-committee')).toBeInViewport();
});

test('the footer Glossary link is reachable from a bill page, not just the homepage', async ({
  page,
}) => {
  await page.goto('/bills/hr-1787-119');
  const link = page.locator('footer').getByRole('link', { name: en.common.footer.glossary });
  await expect(link).toHaveAttribute('href', '/glossary');
  await link.scrollIntoViewIfNeeded();
  await link.click();
  await expect(page).toHaveURL(/\/glossary$/);
});

/* ------------------------------------------------------------------ *
 * 2 · The hovercard's a11y contract
 *
 * Driven on /questions, whose "How Big Questions get made" rule 2 is the one
 * place in the product where "cloture" was already written into hand-authored
 * copy — the occurrence the issue opened on.
 *
 * REDESIGNED 2026-08-12 (owner review of PR #217): the term is a LINK to its
 * glossary entry, and the explainer arrives on hover or focus instead of on a
 * click. So the contract these tests hold it to changed with it — from
 * disclosure semantics (aria-expanded, click to toggle) to WCAG 1.4.13's three
 * clauses for content on hover or focus: dismissible, hoverable, persistent.
 * ------------------------------------------------------------------ */
test.describe('the in-place hovercard', () => {
  const TERM = 'cloture';

  const termLink = (page: Page, name = TERM) =>
    page.getByRole('link', { name, exact: true });

  test('the term is a link to its own glossary entry, and starts describing nothing', async ({
    page,
  }) => {
    await page.goto('/questions#how');
    const link = termLink(page);
    await expect(link).toHaveAttribute('href', '/glossary#cloture');
    // A dangling aria-describedby is worse than none: it points a screen
    // reader at an element that does not exist.
    await expect(link).not.toHaveAttribute('aria-describedby', /./);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
  });

  test('clicking the term navigates to its entry — "they can still click in"', async ({ page }) => {
    await page.goto('/questions#how');
    await termLink(page).click();
    await expect(page).toHaveURL(/\/glossary#cloture$/);
    await expect(page.locator('#cloture')).toBeInViewport();
  });

  test('hovering opens the box, and the box carries the explainer', async ({ page }) => {
    await page.goto('/questions#how');
    const link = termLink(page);
    await hoverTerm(page, link);
    const box = await boxOf(page, link);
    await expect(box).toBeVisible();
    // The SAME string the page prints — one explainer per term per language,
    // so a short version cannot drift from the long one.
    await expect(box).toContainText(en.glossary.terms.cloture.body);
  });

  test('the box holds no link of its own — the term is the link now', async ({ page }) => {
    // Two links to one anchor is what the redesign removed, and content
    // reachable only by pointer travel would be a trap for anyone who cannot
    // travel. A description with nothing to operate is the honest wiring.
    await page.goto('/questions#how');
    const link = termLink(page);
    await hoverTerm(page, link);
    const box = await boxOf(page, link);
    await expect(box.getByRole('link')).toHaveCount(0);
    await expect(box.getByRole('button')).toHaveCount(0);
  });

  test('keyboard focus opens it — a keyboard user never loses the explainer', async ({ page }) => {
    await page.goto('/questions#how');
    const link = termLink(page);
    // Focus arrives by keyboard, so the browser treats it as :focus-visible —
    // which is what the component gates on, deliberately, so a mouse click on
    // its way to navigating does not flash a box.
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('a')].find((a) => a.textContent?.trim() === 'cloture');
      (el as HTMLElement).focus();
    });
    await expect(link).toBeFocused();
    const box = await boxOf(page, link);
    await expect(box).toContainText(en.glossary.terms.cloture.body);
  });

  test('WCAG 1.4.13 Hoverable: the pointer can travel into the box without it closing', async ({
    page,
  }) => {
    await page.goto('/questions#how');
    const link = termLink(page);
    await hoverTerm(page, link);
    const box = await boxOf(page, link);
    await box.hover();
    // Well past the close grace period: if crossing the gap had closed it, or
    // if it closed on arrival, this is where that shows.
    await page.waitForTimeout(500);
    await expect(box).toBeVisible();
    await expect(link).toHaveAttribute('aria-describedby', /./);
  });

  test('WCAG 1.4.13 Persistent: it does not time itself out', async ({ page }) => {
    await page.goto('/questions#how');
    const link = termLink(page);
    await hoverTerm(page, link);
    const box = await boxOf(page, link);
    await page.waitForTimeout(1500);
    await expect(box).toBeVisible();
  });

  test('WCAG 1.4.13 Dismissible: Escape closes it without moving the pointer, and it stays closed', async ({
    page,
  }) => {
    await page.goto('/questions#how');
    const link = termLink(page);
    await hoverTerm(page, link);
    await boxOf(page, link);
    await page.keyboard.press('Escape');
    await expect(link).not.toHaveAttribute('aria-describedby', /./);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    // The latch: with the pointer still sitting on the term, it must not
    // spring straight back — otherwise "dismissible" means nothing.
    await page.waitForTimeout(500);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
  });

  test('Escape leaves focus exactly where it was', async ({ page }) => {
    await page.goto('/questions#how');
    const link = termLink(page);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('a')].find((a) => a.textContent?.trim() === 'cloture');
      (el as HTMLElement).focus();
    });
    await boxOf(page, link);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expect(link, 'dismissing a description must not relocate the caret').toBeFocused();
  });

  test('moving the pointer away closes it', async ({ page }) => {
    await page.goto('/questions#how');
    const link = termLink(page);
    await hoverTerm(page, link);
    await boxOf(page, link);
    await page.getByRole('heading', { name: en.moments.howMadeHeading }).hover();
    await expect(link).not.toHaveAttribute('aria-describedby', /./);
  });

  test('a touch pointer never opens a box — it navigates instead', async ({ page }) => {
    /*
     * A touch device HAS no hover, and the two-tap workaround breaks the one
     * interaction a phone user already understands. The component gates its
     * pointer handlers on `pointerType === 'mouse'`; this fires the synthetic
     * enter a touch produces and proves nothing opens.
     */
    await page.goto('/questions#how');
    const link = termLink(page);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('a')].find((a) => a.textContent?.trim() === 'cloture')!;
      const r = el.getBoundingClientRect();
      for (const type of ['pointerover', 'pointerenter']) {
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: type === 'pointerover',
            pointerType: 'touch',
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
          })
        );
      }
    });
    await page.waitForTimeout(600); // well past HOVER_OPEN_MS
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    // The one thing a tap DOES do still works.
    await expect(link).toHaveAttribute('href', '/glossary#cloture');
  });

  test('the Spanish hovercard stays in Spanish and links inside /es', async ({ page }) => {
    await page.goto('/es/questions#how');
    // The ES sentence's own wording for the term, not a translated English one.
    const link = termLink(page, 'solicitud de cierre de debate');
    // A locale-relative href through the i18n Link — an absolute one would
    // drop a Spanish reader onto the English page.
    await expect(link).toHaveAttribute('href', '/es/glossary#cloture');
    await hoverTerm(page, link);
    const box = await boxOf(page, link);
    await expect(box).toContainText(es.glossary.terms.cloture.body);
  });

  test('the /questions rule-2 sentence still reads as one sentence, tags and all', async ({
    page,
  }) => {
    // The tags are markup, not a rewrite: with the links stripped the list
    // item must still be the sentence the ES reviewer and the moment-scaffold
    // gate both read.
    await page.goto('/questions#how');
    const plain = en.moments.howMadeRule2.replace(/<\/?[a-zA-Z][\w-]*>/g, '');
    await expect(page.getByText(plain)).toBeVisible();
  });

  test('the open box lands inside the viewport on both axes @reflow', async ({ page }) => {
    // It is viewport-positioned and measured, so "inside the viewport" is the
    // whole contract: a box clipped at the right edge is unreadable, and one
    // that opens below the fold on a phone is worse — the thumb bar sits on
    // top of it by design.
    await page.goto('/questions#how');
    const link = termLink(page);
    await hoverTerm(page, link);
    const box = await boxOf(page, link);
    const rect = (await box.boundingBox())!;
    const view = page.viewportSize()!;
    expect(rect.x, 'box crosses the left edge').toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width, 'box crosses the right edge').toBeLessThanOrEqual(view.width);
    expect(rect.y, 'box crosses the top edge').toBeGreaterThanOrEqual(0);
    expect(rect.y + rect.height, 'box falls below the fold').toBeLessThanOrEqual(view.height);
  });

  test('the hovercard does not push the page sideways at 320px @reflow', async ({ page }) => {
    await page.goto('/questions#how');
    const link = termLink(page);
    await hoverTerm(page, link);
    await boxOf(page, link);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, 'an open hovercard must never create a horizontal scrollbar').toBeLessThanOrEqual(
      0
    );
  });
});

/* ------------------------------------------------------------------ *
 * 3 · The wiring sites that depend on live records
 * ------------------------------------------------------------------ */
test.describe('wired surfaces', () => {
  test('a Senate-calendar bill links its placement phrase to the Legislative Calendar entry', async ({
    page,
  }) => {
    const slug = billOnCalendar('senate-legislative');
    test.skip(!slug, 'no bill currently sits on the Senate Legislative Calendar');
    await page.goto(`/bills/${slug}`);
    const link = page.getByRole('link', { name: 'Senate floor calendar', exact: true });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', '/glossary#legislative-calendar');
    await hoverTerm(page, link);
    await expect(await boxOf(page, link)).toContainText(
      en.glossary.terms['legislative-calendar'].body
    );
  });

  test('a Union Calendar bill links to the Union Calendar entry', async ({ page }) => {
    const slug = billOnCalendar('union');
    test.skip(!slug, 'no bill currently sits on the Union Calendar');
    await page.goto(`/bills/${slug}`);
    const link = page.getByRole('link', { name: 'House floor calendar', exact: true });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', '/glossary#union-calendar');
    await hoverTerm(page, link);
    await expect(await boxOf(page, link)).toContainText(en.glossary.terms['union-calendar'].body);
  });

  test('a HOUSE Calendar bill gets the same sentence and NO link — there is no entry for it', async ({
    page,
  }) => {
    // The truth clause. The House keeps two calendars; the first batch of
    // terms covers the Union Calendar only, so a "Placed on the House
    // Calendar" record renders the identical sentence with no trigger rather
    // than a link to an entry about a different list.
    const slug = billOnCalendar('house');
    test.skip(!slug, 'no bill currently sits on the House Calendar');
    await page.goto(`/bills/${slug}`);
    await expect(page.getByText('floor calendar')).not.toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'House floor calendar', exact: true })
    ).toHaveCount(0);
  });

  test('a nomination reported by committee glosses that status where it is printed', async ({
    page,
  }) => {
    const slug = nominationAt('reported');
    test.skip(!slug, 'no nomination is currently at the reported stage');
    await page.goto(`/nominations/${slug}`);
    const link = page.getByRole('link', { name: en.nominations.status.reported, exact: true });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', '/glossary#reported-by-committee');
    await hoverTerm(page, link);
    await expect(await boxOf(page, link)).toContainText(
      en.glossary.terms['reported-by-committee'].body
    );
  });

  test('a nomination on the Executive Calendar glosses that status too', async ({ page }) => {
    const slug = nominationAt('exec_calendar');
    test.skip(!slug, 'no nomination is currently on the Executive Calendar');
    await page.goto(`/nominations/${slug}`);
    const link = page.getByRole('link', { name: en.nominations.status.exec_calendar, exact: true });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', '/glossary#executive-calendar');
    await hoverTerm(page, link);
    await expect(await boxOf(page, link)).toContainText(
      en.glossary.terms['executive-calendar'].body
    );
  });

  test('a status that is Oravan summarising a stage is NOT glossed', async ({ page }) => {
    // "Senate floor activity" is our sentence about where a record stands, not
    // the Senate's name for a procedure. A trigger there would promise an
    // explainer for a thing that has no entry, which is how a glossary starts
    // meaning nothing.
    const slug = nominationAt('floor');
    test.skip(!slug, 'no nomination is currently at the floor stage');
    await page.goto(`/nominations/${slug}`);
    await expect(page.getByText(en.nominations.status.floor)).toBeVisible();
    await expect(
      page.getByRole('link', { name: en.nominations.status.floor, exact: true })
    ).toHaveCount(0);
  });
});
