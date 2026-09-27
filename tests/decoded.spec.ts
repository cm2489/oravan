import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { passageSlugs } from './corpus';
import {
  billEndingAt,
  jointResolutionToPresident,
  referenceBill,
  signedBill,
} from './corpus-fixtures';
import { messagePattern } from './message-pattern';

// A-plus decoded structure: TL;DR + sections + computed journey.
//
// Every sentence below is read from messages/*.json by key and every bill is
// asked of the corpus by property (tests/corpus-fixtures.ts) — so a wording
// change or a nightly re-sync moves these tests only when the promise moves.

const LOCALES = [
  { locale: 'en', prefix: '', messages: en },
  { locale: 'es', prefix: '/es', messages: es },
] as const;

const journeyT = (locale: 'en' | 'es') =>
  createTranslator({ locale, messages: locale === 'en' ? en : es, namespace: 'bill.journey' });

// The five questions a fully decoded bill answers, in the page's own keys.
const SECTIONS = ['what', 'who', 'why', 'cost', 'journey'] as const;

for (const { locale, prefix, messages: m } of LOCALES) {
  test(`${locale}: a fully decoded bill answers all five questions and says where it stands now`, async ({
    page,
  }) => {
    const ref = referenceBill(); // decoded in both languages, cost included; in committee
    const t = journeyT(locale);
    await page.goto(`${prefix}/bills/${ref.slug}`);
    for (const key of SECTIONS) {
      await expect(page.getByRole('heading', { name: m.bill.sec[key] })).toBeVisible();
    }
    // TL;DR strip with computed meta: one question per heading above.
    await expect(page.getByText(messagePattern(m.bill.tldrMeta, { count: SECTIONS.length }))).toBeVisible();
    // In committee: the stepper note names the chamber the record puts it in.
    await expect(page.getByText(t('now'))).toBeVisible();
    await expect(page.getByText(t('nowCommittee', { chamber: ref.chamber }))).toBeVisible();
  });
}

test('signed bill shows a completed journey', async ({ page }) => {
  const law = signedBill();
  test.skip(!law, 'no signed bill in the corpus today');
  const t = journeyT('en');
  await page.goto(`/bills/${law!.slug}`);
  await expect(page.getByText(t('law'))).toBeVisible();
  await expect(page.getByText(t('nowSigned'))).toBeVisible();
});

/*
 * THE PASSAGE SENTENCE, ON BOTH SIDES OF THE CLOCK (N5, 2026-08-12).
 *
 * This used to be one test pinned to s-2280-119 asserting "it passed the
 * Senate and now goes to the House" as a literal. That bill's passage is dated
 * 2026-04-29, so the day deriveJourney's passage branch was clocked the page
 * started reading the stale sentence and the literal was asserting copy the
 * site no longer prints. The bill is not the point — the sentence is — so both
 * tests now ask the corpus for a record on the side they are testing
 * (tests/corpus.ts `passageSlugs`, skew-guarded in both directions).
 */
test('a Senate bill whose passage has gone quiet says so, and claims nothing about this week', async ({ page }) => {
  const { stale } = passageSlugs(Date.now(), 'senate');
  test.skip(stale.length === 0, 'no aged Senate-origin passage in the corpus today');
  const t = journeyT('en');
  await page.goto(`/bills/${stale[0]}`);
  // The journey still starts in the Senate — the clock moves the tense, never
  // the position.
  await expect(page.getByText(t('stepCommittee', { chamber: 'Senate' }))).toBeVisible();
  await expect(page.getByText(t('nowPassedStale', { chamber: 'Senate' }))).toBeVisible();
  // The claim the ruling removed must be gone from the page entirely.
  await expect(page.getByText(t('nowPassed', { chamber: 'Senate', other: 'House' }))).toHaveCount(0);
});

test('a Senate bill that JUST cleared the chamber still names where it goes next', async ({ page }) => {
  // The fresh side legitimately empties over a recess — Congress can go a
  // fortnight without passing anything — so this skips with a reason rather
  // than reddening CI on a quiet week. The fresh branch is pinned
  // unconditionally by fixture in tests/journey.unit.spec.ts.
  const { fresh } = passageSlugs(Date.now(), 'senate');
  test.skip(fresh.length === 0, 'no Senate-origin passage inside the signal window today');
  const t = journeyT('en');
  await page.goto(`/bills/${fresh[0]}`);
  await expect(page.getByText(t('stepCommittee', { chamber: 'Senate' }))).toBeVisible();
  await expect(page.getByText(t('nowPassed', { chamber: 'Senate', other: 'House' }))).toBeVisible();
});

/*
 * A CONCURRENT RESOLUTION NEVER VISITS THE PRESIDENT.
 *
 * hconres/sconres are not presented under Article I §7 — both chambers adopt
 * the text and that is the end of it. The stepper printed "President's desk"
 * on all six of them until 2026-08-09, in both languages, under a header that
 * promises it cannot hallucinate procedure. The fixture is any concurrent
 * resolution whose trailer is still ahead, so the sentence that denies
 * presentment renders too; the predicate itself is pinned corpus-wide in
 * tests/bill-journey.unit.spec.ts.
 *
 * NEITHER DOES A PROPOSED CONSTITUTIONAL AMENDMENT.
 *
 * Article V: two thirds of both chambers propose, three quarters of the
 * states ratify, the President never signs and cannot veto. The stepper
 * promised a President's desk on all 16 of the corpus's amendment proposals
 * until 2026-08-12 — the class the concurrent-resolution fix named as its
 * known limit and declined to guess at. Same fixture shape: an Article V
 * proposal with its trailer still ahead.
 */
const ENDINGS = [
  {
    ending: 'bothChambers',
    step: 'stepBothChambers',
    trailer: 'backTrailerBothChambers',
    what: 'a concurrent resolution ends at adoption, not the President',
  },
  {
    ending: 'states',
    step: 'stepStates',
    trailer: 'backTrailerStates',
    what: 'an Article V amendment proposal ends at the states, not the President',
  },
] as const;

for (const { ending, step, trailer, what } of ENDINGS) {
  for (const { locale, prefix } of LOCALES) {
    test(`${locale}: ${what}`, async ({ page }) => {
      const fx = billEndingAt(ending);
      test.skip(!fx, `no ${ending} vehicle with its trailer ahead in the corpus today`);
      const t = journeyT(locale);
      await page.goto(`${prefix}/bills/${fx!.slug}`);
      await expect(page.getByText(t(step))).toBeVisible();
      await expect(page.getByText(t('stepPresident'))).toHaveCount(0);
      await expect(page.getByText(t(trailer, { chamber: fx!.chamber, other: fx!.other }))).toBeVisible();
    });
  }
}

/* An ORDINARY joint resolution — a CRA disapproval — genuinely is presented,
 * so the title heuristic above must leave its own vehicle type alone. */
test('an ordinary joint resolution still ends at the President', async ({ page }) => {
  const fx = jointResolutionToPresident();
  test.skip(!fx, 'no presented joint resolution in the corpus today');
  const t = journeyT('en');
  await page.goto(`/bills/${fx!.slug}`);
  await expect(page.getByText(t('stepPresident'))).toBeVisible();
  await expect(page.getByText(t('stepStates'))).toHaveCount(0);
});

test('an ordinary bill still ends at the President', async ({ page }) => {
  const ref = referenceBill();
  const t = journeyT('en');
  await page.goto(`/bills/${ref.slug}`);
  await expect(page.getByText(t('stepPresident'))).toBeVisible();
  await expect(page.getByText(t('backTrailer', { chamber: ref.chamber, other: ref.other }))).toBeVisible();
});
