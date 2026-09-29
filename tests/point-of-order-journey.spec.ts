import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { getBill } from '../lib/core';

/*
 * S.J.RES. 98: "WHERE DOES IT STAND?" SAYS WHAT THE RECORD SAYS (2026-09-29).
 *
 * The record's last action, verbatim (2026-01-14): "Point of order that the
 * measure is not entitled to expedited procedures under 50 U.S.C. 1546(a)
 * raised against the measure agreed to in Senate by Yea-Nay Vote. 50 - 50.
 * Record Vote Number: 9."
 *
 * Before this change, the stepper read "it's moving on the floor — the
 * official record hasn't said yet which chamber acts next. If the House
 * changes it, it goes back to the Senate before reaching the president." Both
 * sentences were wrong: nothing is moving, the record names the chamber, and
 * the House never received the resolution. The stepper now says the Senate
 * upheld a point of order against it, with the record's tally and date, and
 * prints no trailer. The call panel stays (owner's pick (a), 2026-09-29: "Only
 * a law or a failed final vote counts as finished"). A point of order is
 * procedural.
 *
 * Copy is read by message key, and the bill is skipped with a reason if its
 * record ever gains a newer action. The pure derivation is pinned in
 * tests/point-of-order-status.unit.spec.ts.
 */

const SJRES_98 = 'sjres-98-119';
const SJRES_98_TEXT =
  'Point of order that the measure is not entitled to expedited procedures under 50 U.S.C. 1546(a) raised against the measure agreed to in Senate by Yea-Nay Vote. 50 - 50. Record Vote Number: 9.';

/** The page's long date format (components/BillJourney.tsx): long month, UTC. */
const longDate = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(iso)
  );

for (const { locale, prefix, messages } of [
  { locale: 'en', prefix: '', messages: en },
  { locale: 'es', prefix: '/es', messages: es },
] as const) {
  const t = createTranslator({ locale, messages, namespace: 'bill.journey' });

  test(`${locale}: S.J.Res. 98's stepper says the Senate upheld a point of order against it, and nothing about the House`, async ({
    page,
  }) => {
    const bill = getBill(SJRES_98);
    test.skip(bill?.last_action_text !== SJRES_98_TEXT, 'S.J.Res. 98 has a newer action than 2026-01-14');
    await page.goto(`${prefix}/bills/${SJRES_98}`);

    const journey = page.locator('section[aria-labelledby="journey-h"]');
    const sentence = t('nowPointOfOrderUpheld', {
      chamber: 'Senate',
      tally: 'yes',
      yeas: 50,
      nays: 50,
      hasDate: 'yes',
      date: longDate(locale, '2026-01-14'),
    });
    // The words a reader sees, whole: a sentence split by the glossary link
    // on "point of order" still reads as one line of text.
    await expect(journey).toContainText(sentence);

    // Neither of the two sentences it used to print.
    await expect(journey).not.toContainText(t('nowFloorActivityNeutral'));
    await expect(journey).not.toContainText(t('backTrailer', { chamber: 'Senate', other: 'House' }));

    // The term is glossed in place, as elsewhere on the strip, under its own
    // entry and in the page's language.
    const term = journey.locator('[data-glossary-term="point-of-order"]');
    await expect(term).toHaveCount(1);
    await expect(term).toHaveText(messages.glossary.terms['point-of-order'].term, { ignoreCase: true });

    // The Senate vote step is where it stands.
    await expect(journey.locator('li[aria-current="step"]')).toContainText(t('stepVote', { chamber: 'Senate' }));

    // The call panel stays: a point of order is procedural, so this is no
    // finished decision, and no "last attempt" line is printed for it.
    await expect(page.locator('[data-settled-panel]')).toHaveCount(0);
    await expect(page.locator('[aria-labelledby="act"][data-call-cta]')).toBeVisible();
    await expect(page.locator('[data-last-attempt]')).toHaveCount(0);
  });
}

/*
 * THE MEMBER PAGE PRINTS THE SAME SENTENCE, NEVER ITS KEY (2026-09-29). The
 * member page's vote card builds its "Right now:" line from the same message.
 * That message opens {hasDate}, and when components/MemberVotes.tsx did not
 * pass it, next-intl could not format the sentence and printed the raw key
 * ("bill.journey.nowPointOfOrderUpheld") on every senator's page that shows
 * S.J.Res. 98. Read with textContent, because the card may sit under a
 * closed "Show all".
 */
for (const { locale, prefix } of [
  { locale: 'en', prefix: '' },
  { locale: 'es', prefix: '/es' },
] as const) {
  test(`${locale}: a senator's member page shows S.J.Res. 98's sentence, never a raw message key`, async ({ page }) => {
    const bill = getBill(SJRES_98);
    test.skip(bill?.last_action_text !== SJRES_98_TEXT, 'S.J.Res. 98 has a newer action than 2026-01-14');
    // A000382 voted on S.J.Res. 98 and its page showed the raw key live on 2026-09-29.
    await page.goto(`${prefix}/reps/A000382`);
    const text = (await page.locator('main').textContent()) ?? '';
    expect(text, 'no member-page line may print a raw journey key').not.toContain('bill.journey.');
    expect(text).toContain(locale === 'en' ? 'upheld a point of order against it' : 'aceptó una cuestión de orden en su contra');
  });
}
