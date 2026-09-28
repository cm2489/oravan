import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { billSlug, getAllBills } from '../lib/core';
import { getAllNominations, nominationSlug } from '../lib/core/nominations';
import { deriveJourney, type FloorCalendar } from '../lib/journey';
import { GLOSSARY_CATEGORIES, GLOSSARY_ENTRIES, GLOSSARY_TERM_IDS } from '../lib/glossary';
import { decodedBillSlug } from './corpus-samples';

/*
 * THE GLOSSARY, LIVE (issue #181; reworked 2026-09-28, UX inventory C05).
 *
 * The owner's note, verbatim: "I'd actually rather not click through to the
 * glossary page. Hover should still work and be quick … and clicking on the
 * word should just do the same action and not redirect." So a glossed term is
 * a button that opens its definition IN PLACE — by hover, click, tap or
 * keyboard — and never navigates. This file holds that contract on a real
 * render; the registry, copy rules and matcher are pinned without a browser
 * in tests/glossary.unit.spec.ts.
 *
 * FIXTURES ARE DERIVED FROM THE LIVE CORPUS, never hardcoded slugs; each
 * derived case skips itself, with the reason, when the corpus stops offering
 * it.
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
 * HOVER A TERM, ONCE THE PAGE HAS STOPPED MOVING. globals.css sets
 * `scroll-behavior: smooth`, so Playwright's own scroll-into-view GLIDES, and
 * a page still gliding under a stationary pointer drags the term out from
 * under it — correct product behaviour, false failure here.
 */
async function settle(page: Page, term: Locator) {
  await term.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
}

async function hoverTerm(page: Page, term: Locator) {
  await settle(page, term);
  await term.hover();
}

/** The definition a term owns, located through the ARIA wiring rather than a
 *  class — if the wiring is wrong, every assertion here fails, which is the
 *  point. Polls, because hover opens after a deliberate dwell. */
async function boxOf(page: Page, term: Locator) {
  await expect(term, 'the term never expanded').toHaveAttribute('aria-expanded', 'true');
  const id = await term.getAttribute('aria-controls');
  expect(id, 'an open term names its panel').toBeTruthy();
  return page.locator(`[id="${id}"]`);
}

/** This term's own panel is gone — others may legitimately be open (Tab
 *  from one term focuses, and so opens, the next). */
async function expectClosed(page: Page, term: Locator) {
  await expect(term).toHaveAttribute('aria-expanded', 'false');
  await expect(term).not.toHaveAttribute('aria-describedby', /./);
  const id = await term.getAttribute('data-glossary-term');
  await expect(page.locator(`[data-glossary-panel="${id}"]`)).toHaveCount(0);
}

/** Focus a term the way the keyboard does (programmatic focus in WebKit is
 *  :focus-visible, which is what the popover gates focus-opening on). */
async function focusTerm(term: Locator) {
  await term.evaluate((el) => (el as HTMLElement).focus());
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
    const terms = messages.glossary.terms as Record<string, { term: string; body: string }>;
    for (const id of GLOSSARY_TERM_IDS) {
      // The anchor: anything anyone has ever pasted resolves here.
      const section = page.locator(`[id="${id}"]`);
      await expect(section, `#${id} is missing`).toHaveCount(1);
      await expect(section.getByRole('heading', { level: 3 })).toHaveText(terms[id].term);
      await expect(section.getByText(terms[id].body, { exact: true })).toHaveCount(1);
    }
  });

  test(`${locale}: every entry links the official source it is based on`, async ({ page }) => {
    await page.goto(`${prefix}/glossary`);
    for (const e of GLOSSARY_ENTRIES) {
      const link = page.locator(`[id="${e.id}"] a[href="${e.source}"]`);
      await expect(link, `${e.id} has no source link`).toHaveCount(1);
      const site = new URL(e.source).hostname.replace(/^www\./, '');
      await expect(link).toHaveText(messages.glossary.sourceLabel.replace('{site}', site));
    }
  });

  test(`${locale}: the index jumps to each section, in order`, async ({ page }) => {
    await page.goto(`${prefix}/glossary`);
    const nav = page.getByRole('navigation', { name: messages.glossary.indexLabel });
    await expect(nav.getByRole('link')).toHaveCount(GLOSSARY_CATEGORIES.length);
    const categories = messages.glossary.categories as Record<string, string>;
    for (const c of GLOSSARY_CATEGORIES) {
      await expect(nav.getByRole('link', { name: categories[c], exact: true })).toHaveAttribute(
        'href',
        `#section-${c}`
      );
      await expect(page.locator(`[id="section-${c}"]`)).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 2, name: categories[c], exact: true })).toHaveCount(
        1
      );
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

test('the footer Glossary link is reachable from a bill page', async ({ page }) => {
  await page.goto(`/bills/${decodedBillSlug()}`);
  const link = page.locator('footer').getByRole('link', { name: en.common.footer.glossary });
  await expect(link).toHaveAttribute('href', '/glossary');
  await link.scrollIntoViewIfNeeded();
  await link.click();
  await expect(page).toHaveURL(/\/glossary$/);
});

/* ------------------------------------------------------------------ *
 * 2 · The in-place definition
 *
 * Driven on /questions, whose "How Big Questions get made" rule 2 is the one
 * place hand-authored copy wraps "cloture" and "the Senate Executive
 * Calendar" — two terms in one sentence, which is also what the one-open-
 * at-a-time rule needs.
 * ------------------------------------------------------------------ */
test.describe('the in-place definition', () => {
  const clotureText = /<cloture>(.*?)<\/cloture>/.exec(en.moments.howMadeRule2)![1];
  const cloture = (page: Page) => page.locator('[data-glossary-term="cloture"]');
  const calendar = (page: Page) => page.locator('[data-glossary-term="executive-calendar"]');

  test('the term is a button that starts closed, never a link to the glossary', async ({
    page,
  }) => {
    await page.goto('/questions#how');
    const term = cloture(page);
    await expect(term).toHaveCount(1);
    await expect(page.getByRole('button', { name: clotureText, exact: true })).toHaveCount(1);
    await expectClosed(page, term);
    // The owner's words: clicking "should … not redirect". Nothing inline
    // links into the glossary page any more.
    await expect(page.locator('main a[href*="/glossary"]')).toHaveCount(0);
  });

  test('hovering opens the definition quickly, with the same words the page prints', async ({
    page,
  }) => {
    await page.goto('/questions#how');
    const term = cloture(page);
    await hoverTerm(page, term);
    const started = Date.now();
    const box = await boxOf(page, term);
    await expect(box).toBeVisible({ timeout: 1000 });
    // The dwell is 130ms; a second is a generous ceiling for a loaded runner,
    // and still a fraction of the old 200ms-plus-navigation path.
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(box).toContainText(en.glossary.terms.cloture.body);
    await expect(box).toContainText(en.glossary.terms.cloture.term);
  });

  test('clicking the term opens the same definition in place and does not navigate', async ({
    page,
  }) => {
    await page.goto('/questions#how');
    const before = page.url();
    const term = cloture(page);
    await settle(page, term);
    await term.click();
    const box = await boxOf(page, term);
    await expect(box).toContainText(en.glossary.terms.cloture.body);
    await page.waitForTimeout(300);
    expect(page.url(), 'a click must never take the reader away').toBe(before);
  });

  test('a click pins it: moving the pointer away leaves it open', async ({ page }) => {
    await page.goto('/questions#how');
    const term = cloture(page);
    await settle(page, term);
    await term.click();
    const box = await boxOf(page, term);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(600); // well past the close grace
    await expect(box).toBeVisible();
  });

  test('a second click on the term closes it, and so does a click anywhere else', async ({
    page,
  }) => {
    await page.goto('/questions#how');
    const term = cloture(page);
    await settle(page, term);
    await term.click();
    await boxOf(page, term);
    await term.click();
    await expectClosed(page, term);

    await term.click();
    await boxOf(page, term);
    await page.getByRole('heading', { name: en.moments.howMadeHeading }).click();
    await expectClosed(page, term);
  });

  test('a tap on a phone opens it in place, and a second tap closes it', async ({ page }, info) => {
    test.skip(!info.project.use.hasTouch, 'touch is a phone project behaviour');
    await page.goto('/questions#how');
    const before = page.url();
    const term = cloture(page);
    await settle(page, term);
    await term.tap();
    const box = await boxOf(page, term);
    await expect(box).toContainText(en.glossary.terms.cloture.body);
    expect(page.url()).toBe(before);
    await term.tap();
    await expectClosed(page, term);
  });

  test('keyboard: focus opens it, Escape closes it and keeps focus, Tab moves on', async ({
    page,
  }) => {
    await page.goto('/questions#how');
    const term = cloture(page);
    await focusTerm(term);
    await expect(term).toBeFocused();
    const box = await boxOf(page, term);
    await expect(box).toContainText(en.glossary.terms.cloture.body);

    await page.keyboard.press('Escape');
    await expectClosed(page, term);
    await expect(term, 'dismissing must not relocate the caret').toBeFocused();

    // Enter opens it again (and pins it).
    await page.keyboard.press('Enter');
    await boxOf(page, term);
    // Tab moves on — to the next term in the sentence — and closes this one.
    await page.keyboard.press('Tab');
    await expect(term).not.toBeFocused();
    await expectClosed(page, term);
  });

  test('screen readers get the definition: expanded, controls, described-by the body', async ({
    page,
  }) => {
    await page.goto('/questions#how');
    const term = cloture(page);
    await focusTerm(term);
    const box = await boxOf(page, term);
    const described = await term.getAttribute('aria-describedby');
    expect(described).toBeTruthy();
    const body = page.locator(`[id="${described}"]`);
    await expect(body).toHaveText(en.glossary.terms.cloture.body);
    // The description is inside the panel it controls, and the panel follows
    // the term in the DOM, so reading on after expanding reaches it.
    await expect(box.locator(`[id="${described}"]`)).toHaveCount(1);
    // The accessible name stays the visible word (WCAG 2.5.3).
    await expect(term).not.toHaveAttribute('aria-label', /./);
    // Nothing to operate inside: it is a description, not a dialog.
    await expect(box.getByRole('link')).toHaveCount(0);
    await expect(box.getByRole('button')).toHaveCount(0);
  });

  test('only one definition is open at a time', async ({ page }) => {
    await page.goto('/questions#how');
    const first = cloture(page);
    const second = calendar(page);
    await settle(page, first);
    await first.click();
    await boxOf(page, first);
    // Hovered with a mouse event sent straight to it: on a phone the open box
    // can sit over the next term in the sentence, and a real pointer there
    // lands on the box (the right behaviour — the reader is reading it). The
    // rule under test is the popover's: opening another term closes the one
    // that is pinned.
    await second.evaluate((el) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new PointerEvent('pointerover', {
          bubbles: true,
          pointerType: 'mouse',
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        })
      );
    });
    await boxOf(page, second);
    await expect(first).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-glossary-panel]')).toHaveCount(1);
  });

  test('WCAG 1.4.13 Hoverable: the pointer can travel into the box without it closing', async ({
    page,
  }) => {
    await page.goto('/questions#how');
    const term = cloture(page);
    await hoverTerm(page, term);
    const box = await boxOf(page, term);
    await box.hover();
    await page.waitForTimeout(500);
    await expect(box).toBeVisible();
  });

  test('WCAG 1.4.13 Persistent: it does not time itself out', async ({ page }) => {
    await page.goto('/questions#how');
    const term = cloture(page);
    await hoverTerm(page, term);
    const box = await boxOf(page, term);
    await page.waitForTimeout(1500);
    await expect(box).toBeVisible();
  });

  test('WCAG 1.4.13 Dismissible: Escape closes a hovered box and it stays closed', async ({
    page,
  }) => {
    await page.goto('/questions#how');
    const term = cloture(page);
    await hoverTerm(page, term);
    await boxOf(page, term);
    await page.keyboard.press('Escape');
    await expectClosed(page, term);
    // The latch: with the pointer still on the term it must not spring back.
    await page.waitForTimeout(500);
    await expectClosed(page, term);
  });

  test('moving the pointer away closes a box that hover opened', async ({ page }) => {
    await page.goto('/questions#how');
    const term = cloture(page);
    await hoverTerm(page, term);
    await boxOf(page, term);
    await page.mouse.move(2, 2);
    await expectClosed(page, term);
  });

  test('the term is a 44px target without making its line taller @reflow', async ({ page }) => {
    await page.goto('/questions#how');
    const term = cloture(page);
    const box = (await term.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    // The negative block margins give the 44px back to the line: the
    // sentence's line height is what it was, so the term does not push the
    // lines around it apart.
    const lineGap = await term.evaluate((el) => {
      const cs = getComputedStyle(el);
      return parseFloat(cs.marginTop) + parseFloat(cs.marginBottom) + el.getBoundingClientRect().height;
    });
    const lineHeight = await term.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    expect(Math.abs(lineGap - lineHeight)).toBeLessThanOrEqual(1);
  });

  test('reduced motion: the box is readable the frame it opens, with nothing animating', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/questions#how');
    const term = cloture(page);
    await settle(page, term);
    await term.click();
    const box = await boxOf(page, term);
    await expect(box).toBeVisible();
    const motion = await box.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { animation: cs.animationName, transition: cs.transitionDuration };
    });
    expect(motion.animation).toBe('none');
    // globals.css's reduced-motion block pins every transition to 0.01ms; the
    // box declares none of its own. Anything over a millisecond is motion.
    const seconds = motion.transition.split(',').map((d) => parseFloat(d) * (d.trim().endsWith('ms') ? 0.001 : 1));
    expect(seconds.every((s) => s <= 0.001), motion.transition).toBe(true);
  });

  test('the Spanish definition stays in Spanish, marked as Spanish', async ({ page }) => {
    await page.goto('/es/questions#how');
    const esText = /<cloture>(.*?)<\/cloture>/.exec(es.moments.howMadeRule2)![1];
    const term = page.getByRole('button', { name: esText, exact: true });
    await expect(term).toHaveAttribute('data-glossary-term', 'cloture');
    await settle(page, term);
    await term.click();
    const box = await boxOf(page, term);
    await expect(box).toContainText(es.glossary.terms.cloture.body);
    await expect(box).toHaveAttribute('lang', 'es');
  });

  test('the /questions rule-2 sentence still reads as one sentence, terms and all', async ({
    page,
  }) => {
    await page.goto('/questions#how');
    const plain = en.moments.howMadeRule2.replace(/<\/?[a-zA-Z][\w-]*>/g, '');
    await expect(page.getByText(plain)).toBeVisible();
  });

  test('the open box lands inside the viewport on both axes @reflow', async ({ page }) => {
    await page.goto('/questions#how');
    const term = cloture(page);
    await settle(page, term);
    await term.click();
    const box = await boxOf(page, term);
    const rect = (await box.boundingBox())!;
    const view = page.viewportSize()!;
    expect(rect.x, 'box crosses the left edge').toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width, 'box crosses the right edge').toBeLessThanOrEqual(view.width);
    expect(rect.y, 'box crosses the top edge').toBeGreaterThanOrEqual(0);
    expect(rect.y + rect.height, 'box falls below the fold').toBeLessThanOrEqual(view.height);
  });

  test('an open box does not push the page sideways at 320px @reflow', async ({ page }) => {
    await page.goto('/questions#how');
    const term = cloture(page);
    await settle(page, term);
    await term.click();
    await boxOf(page, term);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, 'an open definition must never create a horizontal scrollbar').toBeLessThanOrEqual(0);
  });
});

/* ------------------------------------------------------------------ *
 * 3 · The wired surfaces that depend on live records
 * ------------------------------------------------------------------ */
test.describe('wired surfaces', () => {
  async function opens(page: Page, term: Locator, body: string) {
    await settle(page, term);
    await term.click();
    await expect(await boxOf(page, term)).toContainText(body);
  }

  test('a Senate-calendar bill opens the Legislative Calendar entry on its placement phrase', async ({
    page,
  }) => {
    const slug = billOnCalendar('senate-legislative');
    test.skip(!slug, 'no bill currently sits on the Senate Legislative Calendar');
    await page.goto(`/bills/${slug}`);
    const term = page.getByRole('button', { name: 'Senate floor calendar', exact: true });
    await expect(term).toHaveAttribute('data-glossary-term', 'legislative-calendar');
    await opens(page, term, en.glossary.terms['legislative-calendar'].body);
  });

  test('a Union Calendar bill opens the Union Calendar entry', async ({ page }) => {
    const slug = billOnCalendar('union');
    test.skip(!slug, 'no bill currently sits on the Union Calendar');
    await page.goto(`/bills/${slug}`);
    const term = page.getByRole('button', { name: 'House floor calendar', exact: true });
    await expect(term).toHaveAttribute('data-glossary-term', 'union-calendar');
    await opens(page, term, en.glossary.terms['union-calendar'].body);
  });

  test('a HOUSE Calendar bill now opens the House Calendar entry, not the Union one', async ({
    page,
  }) => {
    // Until 2026-09-28 there was no entry for this list, so the phrase stayed
    // bare rather than point at the wrong calendar. The expansion added one.
    const slug = billOnCalendar('house');
    test.skip(!slug, 'no bill currently sits on the House Calendar');
    await page.goto(`/bills/${slug}`);
    const term = page.getByRole('button', { name: 'House floor calendar', exact: true });
    await expect(term).toHaveAttribute('data-glossary-term', 'house-calendar');
    await opens(page, term, en.glossary.terms['house-calendar'].body);
  });

  for (const [status, id] of [
    ['reported', 'reported-by-committee'],
    ['exec_calendar', 'executive-calendar'],
    ['confirmed', 'confirmation'],
    ['returned', 'returned-nomination'],
  ] as const) {
    test(`a nomination at "${status}" glosses that status where it is printed`, async ({ page }) => {
      const slug = nominationAt(status);
      test.skip(!slug, `no nomination is currently at the ${status} stage`);
      await page.goto(`/nominations/${slug}`);
      const label = (en.nominations.status as Record<string, string>)[status];
      const term = page.getByRole('button', { name: label, exact: true }).first();
      await expect(term).toHaveAttribute('data-glossary-term', id);
      const terms = en.glossary.terms as Record<string, { body: string }>;
      await opens(page, term, terms[id].body);
    });
  }

  test('a status that is Oravan summarising a stage is NOT glossed', async ({ page }) => {
    const slug = nominationAt('floor');
    test.skip(!slug, 'no nomination is currently at the floor stage');
    await page.goto(`/nominations/${slug}`);
    await expect(page.getByText(en.nominations.status.floor)).toBeVisible();
    await expect(
      page.getByRole('button', { name: en.nominations.status.floor, exact: true })
    ).toHaveCount(0);
  });
});
