import { expect, test, type Locator, type Page } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { getBill, getLegislator } from '../lib/core';
import { CRS_WAR_POWERS_REPORT, adoptedConcurrentReading } from '../lib/concurrent-explainer';
import { MEMBER_VOTES_MAX_BILLS, memberVotesByBill, votesForBill } from '../lib/votes';

/*
 * THE EXPLAINER ON THE REAL PAGES (owner, 2026-09-29, reviewing #368: "What
 * is a concurrent resolution? Add to glossary. We are still at war and this
 * didn't stop the president. It's now September and this passed in June.
 * This needs more explaination because it's confusing.").
 *
 * VERSION 2: the general sentence visible, the War Powers detail folded.
 * Wherever H.Con.Res. 86's adopted line is printed — the record-only panel on
 * its bill page, its card on /questions/iran-war-powers, a member page's
 * "Right now:" line — the explainer follows it: the general sentence with
 * "concurrent resolution" opening its glossary entry in place, then a
 * disclosure, "Does this bind the president?", holding the War Powers detail
 * quoting the Congressional Research Service and the report linked, and the
 * AI label. The
 * rejected concurrent resolutions (H.Con.Res. 89 and 38) carry the term, so
 * a reader learns what kind of measure failed, and no explainer.
 *
 * The words themselves are pinned in tests/concurrent-explainer.unit.spec.ts.
 */

const HCONRES_86 = 'hconres-86-119';
const EXPLAINER = '[data-concurrent-explainer]';

const LOCALES = [
  { locale: 'en', prefix: '', m: en, t: createTranslator({ locale: 'en', messages: en }) },
  { locale: 'es', prefix: '/es', m: es, t: createTranslator({ locale: 'es', messages: es }) },
] as const;

/** A message's words with its rich-text tags stripped. */
const plain = (s: string) => s.replace(/<\/?[a-z]+>/gi, '');

/** "at war" and its Spanish forms: a claim the record does not hold. */
const AT_WAR = /\bat war\b|\ben guerra\b/i;

async function openTerm(page: Page, term: Locator) {
  await term.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await term.click();
  await expect(term).toHaveAttribute('aria-expanded', 'true');
  return page.locator(`[id="${await term.getAttribute('aria-controls')}"]`);
}

/** Everything version 2 promises inside one explainer. */
async function expectFullExplainer(page: Page, explainer: Locator, l: (typeof LOCALES)[number]) {
  await expect(explainer).toHaveAttribute('data-concurrent-explainer', 'war-powers-5c');
  await expect(explainer).toBeVisible();

  // (1) The general sentence, whole and visible.
  await expect(explainer.locator('[data-concurrent-general]')).toHaveText(plain(l.m.bill.concurrent.general));
  // …with the term opening its own glossary entry, in the page's language.
  const term = explainer.locator('[data-glossary-term="concurrent-resolution"]');
  await expect(term).toHaveCount(1);
  const box = await openTerm(page, term);
  await expect(box).toContainText(l.m.glossary.terms['concurrent-resolution'].body);
  await expect(box).toHaveAttribute('lang', l.locale);
  await page.keyboard.press('Escape');

  // (2) Version 2: the War Powers detail is folded under a neutral question,
  // closed on arrival, and opens from its 44px summary.
  const disclosure = explainer.locator('details[data-concurrent-disclosure]');
  await expect(disclosure).toHaveCount(1);
  await expect(disclosure).not.toHaveAttribute('open');
  const summary = disclosure.locator('summary');
  // The +/– box is aria-hidden: the summary's name is the question alone.
  await expect(summary).toHaveAccessibleName(l.m.bill.concurrent.bindsQuestion);
  await expect(summary).toContainText(l.m.bill.concurrent.bindsQuestion);
  const warPowers = explainer.locator('[data-concurrent-war-powers]');
  await expect(warPowers).toBeHidden();
  const summaryBox = await summary.boundingBox();
  expect(summaryBox!.height).toBeGreaterThanOrEqual(44);
  await summary.click();
  await expect(disclosure).toHaveAttribute('open', '');
  // …holding the War Powers detail, the CRS's two words quoted in English.
  await expect(warPowers).toBeVisible();
  await expect(warPowers).toContainText('INS v. Chadha');
  const quote = warPowers.locator('q[lang="en"]');
  await expect(quote).toHaveText('constitutionally suspect');

  // (3) The source, linked: the CRS report on congress.gov, in a new tab.
  const source = explainer.locator('a[data-concurrent-source="crs"]');
  await expect(source).toBeVisible();
  await expect(source).toHaveAttribute('href', CRS_WAR_POWERS_REPORT.url);
  await expect(source).toHaveAttribute('target', '_blank');
  await expect(source).toHaveAttribute('rel', /noopener/);
  await expect(source).toContainText(CRS_WAR_POWERS_REPORT.number);
  await expect(source.locator('cite[lang="en"]')).toHaveText(CRS_WAR_POWERS_REPORT.title);
  // Rule 7: a 44px target.
  const box44 = await source.boundingBox();
  expect(box44!.height).toBeGreaterThanOrEqual(44);

  // (4) The AI label.
  await expect(explainer.locator('[data-concurrent-ai-note]')).toHaveText(l.m.bill.concurrent.aiNote);

  // Nothing the record does not hold.
  expect(await explainer.innerText()).not.toMatch(AT_WAR);
}

for (const l of LOCALES) {
  test(`${l.locale}: H.Con.Res. 86's record-only panel explains what an adopted concurrent resolution can and cannot do`, async ({
    page,
  }) => {
    const bill = getBill(HCONRES_86);
    test.skip(!bill || adoptedConcurrentReading(bill)?.warPowers5c !== true, 'H.Con.Res. 86 is no longer an adopted 5(c) resolution');
    await page.goto(`${l.prefix}/bills/${HCONRES_86}`);
    const panel = page.locator('[data-settled-panel="adopted"]');
    await expect(panel).toBeVisible();
    // The outcome sentence, then the explainer right under it, in the panel.
    await expect(panel.locator('[data-settled-outcome]')).toHaveText(
      l.t('bill.settled.adopted', {
        hasDate: 'yes',
        date: new Intl.DateTimeFormat(l.locale, {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone: 'UTC',
        }).format(new Date('2026-06-23')),
      })
    );
    const explainer = panel.locator(EXPLAINER);
    await expect(explainer).toHaveCount(1);
    await expectFullExplainer(page, explainer, l);
    expect(await panel.innerText()).not.toMatch(AT_WAR);

    // The header names the kind of measure, with the same entry.
    const kind = page.locator('main header [data-measure-kind="concurrent-resolution"]');
    await expect(kind).toContainText(l.m.glossary.terms['concurrent-resolution'].term);
    const kindBox = await openTerm(page, kind.locator('[data-glossary-term="concurrent-resolution"]'));
    await expect(kindBox).toContainText(l.m.glossary.terms['concurrent-resolution'].body);
  });

  for (const slug of ['hconres-89-119', 'hconres-38-119']) {
    test(`${l.locale}: ${slug}, a rejected concurrent resolution, names its kind with the glossary term and carries no explainer`, async ({
      page,
    }) => {
      const bill = getBill(slug);
      test.skip(!bill, `${slug} is not in the corpus`);
      await page.goto(`${l.prefix}/bills/${slug}`);
      const kind = page.locator('main header [data-measure-kind="concurrent-resolution"]');
      await expect(kind).toBeVisible();
      const box = await openTerm(page, kind.locator('[data-glossary-term="concurrent-resolution"]'));
      await expect(box).toContainText(l.m.glossary.terms['concurrent-resolution'].body);
      await expect(page.locator(EXPLAINER)).toHaveCount(0);
    });
  }

  test(`${l.locale}: H.Con.Res. 86's Big Question card carries the explainer, and no other card does`, async ({ page }) => {
    const bill = getBill(HCONRES_86);
    test.skip(!bill || adoptedConcurrentReading(bill)?.warPowers5c !== true, 'H.Con.Res. 86 is no longer an adopted 5(c) resolution');
    await page.goto(`${l.prefix}/questions/iran-war-powers`);
    // The vehicle card: the page itself is an <article> too, so the card is
    // the one with no <article> inside it.
    const card = page
      .locator('article')
      .filter({ has: page.locator(`h3 a[href$="/bills/${HCONRES_86}"]`) })
      .filter({ hasNot: page.locator('article') });
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
    await expectFullExplainer(page, card.locator(EXPLAINER), l);
    await expect(page.locator(EXPLAINER)).toHaveCount(1);
  });
}

test('a member page\'s "Right now:" line for H.Con.Res. 86 carries the explainer, in both languages', async ({ page }) => {
  const senateRoll = votesForBill(HCONRES_86).find((r) => r.chamber === 'senate' && r.roll === 184);
  test.skip(!senateRoll, 'Senate record vote 184 is not in data/votes.json');
  // A sitting senator on that roll call whose capped vote record lists it.
  const voter = (['yea', 'nay'] as const)
    .flatMap((p) => senateRoll!.votes[p])
    .sort()
    .find(
      (id) =>
        getLegislator(id) &&
        memberVotesByBill(id)
          .slice(0, MEMBER_VOTES_MAX_BILLS)
          .some((g) => g.bill === HCONRES_86)
    );
  test.skip(!voter, 'no sitting senator lists H.Con.Res. 86 inside the capped vote record');
  for (const l of LOCALES) {
    await page.goto(`${l.prefix}/reps/${voter}`);
    const row = page.locator(`[data-member-vote-bill="${HCONRES_86}"]`);
    await expect(row.locator('[data-member-vote-now]')).toHaveAttribute('data-member-vote-now', 'nowAdoptedBoth');
    // Past the first rows the record folds under "Show all": open it.
    if (!(await row.isVisible())) await page.locator('[data-member-votes-all] > summary').click();
    await expect(row).toBeVisible();
    await expectFullExplainer(page, row.locator(EXPLAINER), l);
    // One explainer on screen: only H.Con.Res. 86 is an adopted concurrent
    // resolution. (Since 2026-09-29 the "Big Questions" filter's own short
    // list repeats a folded Big Question card, hidden until that filter is
    // picked — components/MemberVotes.tsx — so the page may hold a second,
    // undisplayed copy; what a reader sees is one.)
    await expect(page.locator(`${EXPLAINER}:visible`)).toHaveCount(1);
  }
});
