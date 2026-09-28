import { expect, test, type Locator, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { billSlug, getAllBills, localizeBill } from '../lib/core';
import { votesForBill } from '../lib/votes';
import type { GlossaryTermId } from '../lib/glossary';
import { splitGlossaryTerms, type GlossaryLocale } from '../lib/glossary-match';

/*
 * GLOSSARY WIRING, ASSERTED ON THE RENDERED PAGE.
 *
 * What a reader actually gets where terms are wired or marked automatically.
 * Every fixture is derived from the committed corpus with the same matcher
 * the page uses (lib/glossary-match.ts), and skips with its reason when the
 * corpus stops offering one.
 */

const firstTerm = (text: string, locale: GlossaryLocale): GlossaryTermId | null => {
  const hit = splitGlossaryTerms(text, locale, new Set()).find((p) => typeof p !== 'string');
  return hit && typeof hit !== 'string' ? hit.id : null;
};

/** The first decoded bill whose "What it does" answer carries a term, in the
 *  given language, and the term it carries. */
function decodedWithTerm(locale: GlossaryLocale): { slug: string; id: GlossaryTermId } | null {
  for (const raw of getAllBills()) {
    const bill = localizeBill(raw, locale);
    const what = bill.ai_sections?.what;
    if (!what) continue;
    if (locale === 'es' && what === raw.ai_sections?.what) continue; // untranslated
    const id = firstTerm(what, locale);
    if (id) return { slug: billSlug(raw), id };
  }
  return null;
}

/** The first bill with a stored roll call whose question carries a term. */
function voteWithTerm(): { slug: string; id: GlossaryTermId } | null {
  for (const raw of getAllBills()) {
    const slug = billSlug(raw);
    for (const r of votesForBill(slug)) {
      const id = firstTerm(r.question, 'en');
      if (id) return { slug, id };
    }
  }
  return null;
}

async function openByClick(page: Page, term: Locator) {
  await term.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500); // smooth scroll settles first
  await term.click();
  await expect(term).toHaveAttribute('aria-expanded', 'true');
  return page.locator(`[id="${await term.getAttribute('aria-controls')}"]`);
}

/** No term is ever marked inside a heading or a link, anywhere in <main>. */
async function expectNoTermInHeadingsOrLinks(page: Page) {
  await expect(
    page.locator('main :is(h1, h2, h3, h4, h5, h6, a) [data-glossary-term]')
  ).toHaveCount(0);
}

/*
 * THE RECESS NOTE ON / (owner ruling A-3, 2026-08-15). On the one crownless
 * week the record can explain, the homepage's week note says so, and its
 * "pro forma session" phrase opens the entry that explains why a bill cannot
 * be called up at one. `data-week-note` names which variant rendered, so every
 * other week this skips with the reason; the hook itself is asserted every run.
 */
for (const [locale, path, messages] of [
  ['en', '/', en],
  ['es', '/es', es],
] as const) {
  test(`${locale}: the recess note on / opens "pro forma session" in place`, async ({ page }) => {
    await page.goto(path);
    const note = page.locator('[data-week-note]');
    await expect(note, 'the week note carries its data-week-note hook').toHaveCount(1);
    const variant = await note.getAttribute('data-week-note');
    expect(['recess', 'standard'], `unknown data-week-note value: ${variant}`).toContain(variant);
    test.skip(
      variant !== 'recess',
      'not a recess week in the committed floor data — the note has no pro forma sentence to mark'
    );
    const term = note.locator('[data-glossary-term="pro-forma-session"]');
    await expect(term).toHaveCount(1);
    const box = await openByClick(page, term);
    await expect(box).toContainText(messages.glossary.terms['pro-forma-session'].body);
  });
}

/*
 * A GLOSSED TERM IS A DISCLOSURE NOW (2026-09-28). It used to be a link, and
 * `aria-expanded` on a link would have promised a panel that toggles in place.
 * Now the term IS a button that toggles a panel in place, so the state is
 * honest and required.
 */
test('a glossed term is a button whose aria-expanded tracks the panel', async ({ page }) => {
  await page.goto('/questions#how');
  const term = page.locator('[data-glossary-term="cloture"]');
  await expect(term).toHaveJSProperty('tagName', 'BUTTON');
  await expect(term).toHaveAttribute('type', 'button');
  await expect(term).toHaveAttribute('aria-expanded', 'false');
  await openByClick(page, term);
  await term.click();
  await expect(term).toHaveAttribute('aria-expanded', 'false');
});

/* ------------------------------------------------------------------ *
 * Decoded text — terms already in the answers open in place
 * ------------------------------------------------------------------ */
for (const [locale, prefix] of [
  ['en', ''],
  ['es', '/es'],
] as const) {
  test(`${locale}: a term in a decoded answer opens its definition, once per answer`, async ({
    page,
  }) => {
    const sample = decodedWithTerm(locale);
    test.skip(!sample, `no decoded bill's answer carries a glossary term in ${locale}`);
    const { slug, id } = sample!;
    await page.goto(`${prefix}/bills/${slug}`);
    const decoded = page.locator('section[aria-labelledby="decoded"]');
    const term = decoded.locator(`[data-glossary-term="${id}"]`).first();
    await expect(term).toBeVisible();
    const terms = (locale === 'en' ? en : es).glossary.terms as Record<string, { body: string }>;
    const box = await openByClick(page, term);
    await expect(box).toContainText(terms[id].body);
    await expect(box).toHaveAttribute('lang', locale);

    // At most once per term per answer.
    const counts = await decoded.locator('section').evaluateAll((sections) =>
      sections.map((s) => {
        const ids = [...s.querySelectorAll('[data-glossary-term]')].map((el) =>
          el.getAttribute('data-glossary-term')
        );
        return ids.length - new Set(ids).size;
      })
    );
    expect(counts.every((dupes) => dupes === 0), 'a term repeated inside one answer').toBe(true);
    await expectNoTermInHeadingsOrLinks(page);
  });
}

/* ------------------------------------------------------------------ *
 * The record's own vote lines — English on both locales
 * ------------------------------------------------------------------ */
test('a term in a roll call question opens its definition, and the record text is unchanged', async ({
  page,
}) => {
  const sample = voteWithTerm();
  test.skip(!sample, 'no stored roll call question carries a glossary term');
  const { slug, id } = sample!;
  await page.goto(`/bills/${slug}`);
  const question = page.locator('[data-vote-question]').filter({
    has: page.locator(`[data-glossary-term="${id}"]`),
  });
  const term = question.locator(`[data-glossary-term="${id}"]`).first();
  await expect(term).toBeVisible();
  const box = await openByClick(page, term);
  const terms = en.glossary.terms as Record<string, { body: string }>;
  await expect(box).toContainText(terms[id].body);
  await expectNoTermInHeadingsOrLinks(page);
});

test('on /es the record stays English and the definition opens in Spanish', async ({ page }) => {
  const sample = voteWithTerm();
  test.skip(!sample, 'no stored roll call question carries a glossary term');
  const { slug, id } = sample!;
  await page.goto(`/es/bills/${slug}`);
  const term = page.locator(`[data-vote-question] [data-glossary-term="${id}"]`).first();
  // The words are the record's, inside its lang="en" line.
  await expect(term.locator('xpath=ancestor::*[@lang][1]')).toHaveAttribute('lang', 'en');
  const box = await openByClick(page, term);
  const terms = es.glossary.terms as Record<string, { body: string }>;
  await expect(box).toContainText(terms[id].body);
  // …and the definition is marked Spanish, so it is not read in an English voice.
  await expect(box).toHaveAttribute('lang', 'es');
});

test('the vote tally labels open their entries', async ({ page }) => {
  const withVotes = getAllBills()
    .map(billSlug)
    .find((slug) => votesForBill(slug).length > 0);
  test.skip(!withVotes, 'no bill has a stored roll call');
  await page.goto(`/bills/${withVotes}`);
  const tally = page.locator('[data-vote-roll]').first().locator('dl').nth(1);
  const yea = tally.locator('[data-glossary-term="yea-and-nay"]');
  await expect(yea).toHaveText(en.votes.position.yea);
  await expect(tally.locator('[data-glossary-term="not-voting"]')).toHaveText(en.votes.position.notVoting);
  const box = await openByClick(page, yea);
  await expect(box).toContainText(en.glossary.terms['yea-and-nay'].body);
});
