import { expect, test, type Locator, type Page } from '@playwright/test';
import en from '../messages/en.json';

/*
 * GLOSSARY WIRING, ASSERTED ON THE RENDERED PAGE.
 *
 * Two things tests/glossary.unit.spec.ts used to prove by reading source files
 * as strings — that app/[locale]/page.tsx contained the literal
 * `term: glossaryTag('pro-forma-session')`, and that GlossaryTerm.tsx never
 * contained `aria-expanded`. A source scan goes red when the same promise is
 * kept with different code, and stays green when the promise breaks somewhere
 * the scan does not look. These read what a reader actually gets.
 */

/*
 * THE RECESS NOTE ON / (owner ruling A-3, 2026-08-15). On the one crownless
 * week the record can explain — both chambers out, each with a next meeting
 * on file, the digest dated — the homepage's week note says so, and its
 * "pro forma session" phrase links to the glossary entry that explains why a
 * bill cannot be called up at one. `home.weekNoteRecess` opens a `<term>` tag
 * in both languages (pinned in tests/glossary.unit.spec.ts); a call site that
 * stops handing next-intl a handler for it loses the link.
 *
 * WHEN THIS RUNS. The page is built from the committed floor data, so the note
 * is the recess variant only in a week that really is one. `data-week-note`
 * names which variant rendered, so every other week this skips with the reason
 * rather than passing over nothing. The hook itself is asserted every run: a
 * page that stops marking its note would otherwise skip forever.
 *
 * A CROWNED WEEK HAS NO NOTE (owner, UX inventory H13 "cut", 2026-09-28): the
 * green-panel explainer was the note's crowned-week wording, so the note now
 * renders exactly when the green panel (`[data-crown]`) does not. That pairing
 * is what is asserted every run.
 */
for (const [locale, path] of [
  ['en', '/'],
  ['es', '/es'],
] as const) {
  test(`${locale}: the recess note on / links "pro forma session" to its glossary entry`, async ({
    page,
  }) => {
    await page.goto(path);
    const week = page.locator('[data-front-door="week"]');
    const crowned = (await week.locator('[data-crown]').count()) > 0;
    const note = page.locator('[data-week-note]');
    await expect(note, 'a week note exactly when there is no green panel').toHaveCount(crowned ? 0 : 1);
    test.skip(crowned, 'a crowned week in the committed floor data — no week note, so no pro forma sentence');
    const variant = await note.getAttribute('data-week-note');
    expect(['recess', 'standard'], `unknown data-week-note value: ${variant}`).toContain(variant);
    test.skip(
      variant !== 'recess',
      'not a recess week in the committed floor data — the note has no pro forma sentence to link'
    );
    const link = note.locator('a[href$="#pro-forma-session"]');
    await expect(link).toHaveCount(1);
    await expect(link).toBeVisible();
  });
}

/*
 * A GLOSSED TERM IS A LINK, NEVER A DISCLOSURE (2026-08-12 redesign, owner
 * review of PR #217). Activating the term navigates to its entry, so
 * `aria-expanded` on it would promise a screen reader a panel that toggles in
 * place. tests/glossary.spec.ts holds the rest of the hovercard contract
 * (link target, aria-describedby only while open, hover / focus / Escape,
 * touch never opens); this is the one clause it did not assert.
 */
test.describe('a glossed term is a link, never a disclosure', () => {
  // The words `moments.howMadeRule2` wraps in its <cloture> tag, read by key.
  const TERM_TEXT = /<cloture>(.*?)<\/cloture>/.exec(en.moments.howMadeRule2)![1];
  const termLink = (page: Page): Locator =>
    page.getByRole('link', { name: TERM_TEXT, exact: true });

  test('no aria-expanded on the term, closed or open', async ({ page }) => {
    await page.goto('/questions#how');
    const link = termLink(page);
    await expect(link).toHaveAttribute('href', /\/glossary#cloture$/);
    await expect(link).not.toHaveAttribute('aria-expanded');

    // Open it the way a keyboard user does, then look again.
    await link.focus();
    await expect(link, 'focus opens the description').toHaveAttribute('aria-describedby', /./);
    await expect(link).not.toHaveAttribute('aria-expanded');
  });
});
