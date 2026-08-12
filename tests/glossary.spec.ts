import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
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
 * every anchor a popover points at, and that the popover honours the a11y
 * contract the issue made a condition of shipping one at all —
 * "keyboard-reachable and screen-reader-sane".
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

/** The panel a trigger owns, located through the ARIA wiring rather than a
 *  class — if `aria-describedby` is wrong, every assertion here fails, which
 *  is the point. */
async function panelOf(page: Page, triggerName: string) {
  const trigger = page.getByRole('button', { name: triggerName, exact: true });
  const id = await trigger.getAttribute('aria-describedby');
  expect(id, `${triggerName}: no aria-describedby while open`).toBeTruthy();
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
      // The anchor: a popover's "Full glossary →" and anything anyone has
      // pasted resolves to exactly this id.
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
 * 2 · The popover's a11y contract
 *
 * Driven on /questions, whose "How Big Questions get made" rule 2 is the one
 * place in the product where "cloture" was already written into hand-authored
 * copy — the occurrence the issue opened on.
 * ------------------------------------------------------------------ */
test.describe('the in-place popover', () => {
  const TRIGGER = 'cloture';

  test('is a disclosure button that starts closed and describes nothing yet', async ({ page }) => {
    await page.goto('/questions#how');
    const trigger = page.getByRole('button', { name: TRIGGER, exact: true });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // A dangling aria-describedby is worse than none: it points a screen
    // reader at an element that does not exist.
    await expect(trigger).not.toHaveAttribute('aria-describedby', /./);
    await expect(page.getByText(en.glossary.terms.cloture.body)).toHaveCount(0);
  });

  test('opens on click, carries the explainer, and links to its own anchor', async ({ page }) => {
    await page.goto('/questions#how');
    const trigger = page.getByRole('button', { name: TRIGGER, exact: true });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const panel = await panelOf(page, TRIGGER);
    await expect(panel).toBeVisible();
    // The SAME string the page prints — one explainer per term per language,
    // so a short version cannot drift from the long one.
    await expect(panel).toContainText(en.glossary.terms.cloture.body);
    await expect(panel.getByRole('link')).toHaveAttribute('href', '/glossary#cloture');
  });

  test('opens from the keyboard with Enter and with Space', async ({ page }) => {
    await page.goto('/questions#how');
    const trigger = page.getByRole('button', { name: TRIGGER, exact: true });
    await trigger.focus();
    await expect(trigger).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await page.keyboard.press('Space');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  test('Escape closes it AND hands focus back to the trigger', async ({ page }) => {
    // The clause that decides whether this is usable by keyboard at all: a
    // dismissal that drops focus at the top of the document costs the reader
    // their place in the sentence they were reading.
    await page.goto('/questions#how');
    const trigger = page.getByRole('button', { name: TRIGGER, exact: true });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
  });

  test('focus inside the panel keeps it open; focus leaving closes it without stealing focus back', async ({
    page,
  }) => {
    /*
     * The reason this is a disclosure and not a tooltip: the panel holds a
     * LINK, and a tooltip may never do that — a user cannot move into
     * something that vanishes when they leave the trigger.
     *
     * Focus is moved with .focus() rather than Tab on purpose. WebKit's
     * default "Tab highlights each item" preference decides whether Tab even
     * STOPS on a link, so a Tab-based assertion would be testing the browser's
     * settings, not this component's contract.
     */
    await page.goto('/questions#how');
    const trigger = page.getByRole('button', { name: TRIGGER, exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const panel = await panelOf(page, TRIGGER);

    await panel.getByRole('link').focus();
    await expect(panel.getByRole('link')).toBeFocused();
    await expect(trigger, 'focus inside the panel must not close it').toHaveAttribute(
      'aria-expanded',
      'true'
    );

    // Focus leaving the wrapper closes it — and does NOT yank focus back,
    // which would drop the reader wherever they came from.
    const other = page.getByRole('button', { name: 'Senate Executive Calendar', exact: true });
    await other.focus();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(other).toBeFocused();
  });

  test('a click outside closes it', async ({ page }) => {
    await page.goto('/questions#how');
    const trigger = page.getByRole('button', { name: TRIGGER, exact: true });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('heading', { name: en.moments.howMadeHeading }).click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('a second click on the trigger closes it again', async ({ page }) => {
    await page.goto('/questions#how');
    const trigger = page.getByRole('button', { name: TRIGGER, exact: true });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('the Spanish popover stays in Spanish and links inside /es', async ({ page }) => {
    await page.goto('/es/questions#how');
    // The ES sentence's own wording for the term, not a translated English one.
    const trigger = page.getByRole('button', {
      name: 'solicitud de cierre de debate',
      exact: true,
    });
    await trigger.click();
    const panel = page.locator(`[id="${await trigger.getAttribute('aria-describedby')}"]`);
    await expect(panel).toContainText(es.glossary.terms.cloture.body);
    // A locale-relative href through the i18n Link — an absolute one would
    // drop a Spanish reader onto the English page.
    await expect(panel.getByRole('link')).toHaveAttribute('href', '/es/glossary#cloture');
    await expect(panel.getByRole('link')).toContainText(es.glossary.fullGlossary);
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

  test('the open panel lands inside the viewport on both axes @reflow', async ({ page }) => {
    // It is viewport-positioned and measured, so "inside the viewport" is the
    // whole contract: a panel clipped at the right edge is unreadable, and one
    // that opens below the fold on a phone is worse — the thumb bar sits on
    // top of it by design.
    await page.goto('/questions#how');
    await page.getByRole('button', { name: TRIGGER, exact: true }).click();
    const panel = await panelOf(page, TRIGGER);
    const box = (await panel.boundingBox())!;
    const view = page.viewportSize()!;
    expect(box.x, 'panel crosses the left edge').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'panel crosses the right edge').toBeLessThanOrEqual(view.width);
    expect(box.y, 'panel crosses the top edge').toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, 'panel falls below the fold').toBeLessThanOrEqual(view.height);
  });

  test('the popover does not push the page sideways at 320px @reflow', async ({ page }) => {
    await page.goto('/questions#how');
    await page.getByRole('button', { name: TRIGGER, exact: true }).click();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, 'an open popover must never create a horizontal scrollbar').toBeLessThanOrEqual(
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
    const trigger = page.getByRole('button', { name: 'Senate floor calendar', exact: true });
    await expect(trigger).toHaveCount(1);
    await trigger.click();
    const panel = await panelOf(page, 'Senate floor calendar');
    await expect(panel.getByRole('link')).toHaveAttribute('href', '/glossary#legislative-calendar');
  });

  test('a Union Calendar bill links to the Union Calendar entry', async ({ page }) => {
    const slug = billOnCalendar('union');
    test.skip(!slug, 'no bill currently sits on the Union Calendar');
    await page.goto(`/bills/${slug}`);
    const trigger = page.getByRole('button', { name: 'House floor calendar', exact: true });
    await expect(trigger).toHaveCount(1);
    await trigger.click();
    const panel = await panelOf(page, 'House floor calendar');
    await expect(panel.getByRole('link')).toHaveAttribute('href', '/glossary#union-calendar');
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
      page.getByRole('button', { name: 'House floor calendar', exact: true })
    ).toHaveCount(0);
  });

  test('a nomination reported by committee glosses that status where it is printed', async ({
    page,
  }) => {
    const slug = nominationAt('reported');
    test.skip(!slug, 'no nomination is currently at the reported stage');
    await page.goto(`/nominations/${slug}`);
    const trigger = page.getByRole('button', {
      name: en.nominations.status.reported,
      exact: true,
    });
    await expect(trigger).toHaveCount(1);
    await trigger.click();
    const panel = await panelOf(page, en.nominations.status.reported);
    await expect(panel).toContainText(en.glossary.terms['reported-by-committee'].body);
    await expect(panel.getByRole('link')).toHaveAttribute(
      'href',
      '/glossary#reported-by-committee'
    );
  });

  test('a nomination on the Executive Calendar glosses that status too', async ({ page }) => {
    const slug = nominationAt('exec_calendar');
    test.skip(!slug, 'no nomination is currently on the Executive Calendar');
    await page.goto(`/nominations/${slug}`);
    const trigger = page.getByRole('button', {
      name: en.nominations.status.exec_calendar,
      exact: true,
    });
    await expect(trigger).toHaveCount(1);
    await trigger.click();
    const panel = await panelOf(page, en.nominations.status.exec_calendar);
    await expect(panel.getByRole('link')).toHaveAttribute('href', '/glossary#executive-calendar');
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
      page.getByRole('button', { name: en.nominations.status.floor, exact: true })
    ).toHaveCount(0);
  });
});
