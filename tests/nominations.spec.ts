import { expect, test } from '@playwright/test';
import { getAllNominations, nominationSlug } from '../lib/core/nominations';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { mockScriptApi, seedZip } from './helpers';

/*
 * THE SENATE NOMINATION SURFACE, END TO END.
 *
 * This is the spec that answers the question N1–N3 kept deferring: is there
 * actually a call to make? The owner's ruling of 2026-08-06 was "yes there
 * should be a call to make", and until this page existed the answer in code
 * was no — /api/script 404'd on any `pn-…` slug, and nothing rendered one.
 *
 * DATA-DRIVEN, never fixture-pinned. The nominations below are picked out of
 * the committed corpus by STATUS at run time, so tomorrow's sync (which will
 * confirm some of these and open others) cannot turn this suite red for a
 * reason that has nothing to do with the code. If a status class empties out,
 * the test skips and says so rather than asserting against a record that is
 * no longer of the shape it is testing.
 */

const ALL = getAllNominations();

/** A nomination the Senate can still act on AND that carries the government's
 *  own description sentence — the only records the call path serves, since
 *  that sentence is the only thing a script is grounded in. */
const LIVE = ALL.find(
  (n) => n.status === 'exec_calendar' && n.nominee_description && n.exec_calendar_number !== null
);
/** …and one that is over. Nothing a caller says moves a confirmed nomination,
 *  so every routing claim on its page must be absent. */
const CONFIRMED = ALL.find((n) => n.status === 'confirmed' && n.nominee_description);

const liveSlug = LIVE ? nominationSlug(LIVE) : null;
const confirmedSlug = CONFIRMED ? nominationSlug(CONFIRMED) : null;

test.describe('the nomination page', () => {
  test('renders the Senate record verbatim, and says it is not rewritten', async ({ page }) => {
    test.skip(!LIVE, 'no live-and-described nomination in the current corpus');
    await page.goto(`/nominations/${liveSlug}`);

    // The headline IS the government's sentence — no decode, by design.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(LIVE!.nominee_description!);
    // …and the absence of a decode is stated, not left as a gap.
    await expect(page.getByText(en.nominations.noDecodeNote)).toBeVisible();
    // The provenance line: the citation and the derived status label, never a
    // raw enum slug (the silent failure lib/moments.ts's pins exist to stop).
    await expect(page.getByText(LIVE!.citation, { exact: false }).first()).toBeVisible();
    await expect(
      page.getByText(en.nominations.status[LIVE!.status as 'exec_calendar']).first()
    ).toBeVisible();
    // The Senate's own last action, word for word.
    await expect(page.getByText(LIVE!.last_action_text!, { exact: false })).toBeVisible();
    // And the way out to the official record.
    await expect(page.getByRole('link', { name: en.nominations.viewOfficial })).toHaveAttribute(
      'href',
      LIVE!.congress_gov_url
    );
  });

  /*
   * THE AMBER LAW. A printed Executive Calendar NUMBER earns the mark; the
   * date printed beside it earns the amber. `LIVE` is selected with a non-null
   * number precisely so this assertion is about the numbered case — the
   * unnumbered ones ("Calendar No. DESK", the Privileged Nomination section)
   * arrive as null and must show nothing at all.
   */
  test('the Executive Calendar mark prints its number, or does not appear', async ({ page }) => {
    test.skip(!LIVE, 'no live-and-described nomination in the current corpus');
    await page.goto(`/nominations/${liveSlug}`);
    await expect(
      page.getByText(`No. ${LIVE!.exec_calendar_number}`, { exact: false }).first()
    ).toBeVisible();

    const unnumbered = ALL.find(
      (n) => n.status === 'exec_calendar' && n.exec_calendar_number === null
    );
    test.skip(!unnumbered, 'corpus has no unnumbered Executive Calendar placement right now');
    await page.goto(`/nominations/${nominationSlug(unnumbered!)}`);
    // Never "Calendar No. NaN" — the whole reason execCalendarNumber() returns
    // null on "Calendar No. DESK". Regexes, not strings: getByText('NaN') is
    // case-insensitive substring matching, and it hits the "nan" inside
    // ordinary words like "governance" on any page that happens to contain one.
    await expect(page.getByText(/\bNaN\b/)).toHaveCount(0);
    await expect(page.getByText(/\bDESK\b/)).toHaveCount(0);
    // …and no numbered chip at all. The STATUS LABEL ("On the Executive
    // Calendar") is still correct on this page and still prints — that is the
    // record. What must not print is the mark that claims a number, so the
    // assertion is on the number clause and not on the phrase they share.
    await expect(page.getByText(/,\s*No\.\s*\d/)).toHaveCount(0);
  });

  /*
   * THE CALL — N3's three nomination sentences, rendered for the first time.
   * Their presence here proves the whole chain is wired: the page derived a
   * target through liveCallTargetForNomination, ActionPanel took the
   * `soleChamber` branch, and liveCallKey picked the non-relational key.
   */
  test('the Senate is the call, and the House member is demoted without being buried', async ({
    page,
  }) => {
    test.skip(!LIVE, 'no live-and-described nomination in the current corpus');
    await mockScriptApi(page);
    await page.goto(`/nominations/${liveSlug}`);
    await seedZip(page, '78501'); // TX-15: two senators + one House member
    await page.reload();
    // The rep list lives in the panel's step 2, which only renders once a
    // stance is chosen — the same order call-action.spec.ts drives.
    await page.getByRole('radio', { name: en.bill.stance.support }).click();
    await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toBeVisible();

    await expect(page.getByText(en.bill.nominationHow)).toBeVisible();
    await expect(page.getByText(en.bill.liveSenateNomination).first()).toBeVisible();
    await expect(page.getByText(en.bill.nominationHousePress).first()).toBeVisible();
    // None of the four RELATIONAL bill sentences may appear: each of them
    // implies the other chamber gets a turn, which on a nomination is false
    // forever rather than not-yet.
    for (const key of [
      'liveSenateFloor',
      'liveHouseFloor',
      'liveSenateAfterHouse',
      'liveHouseAfterSenate',
    ] as const) {
      await expect(page.getByText(en.bill[key])).toHaveCount(0);
    }

    // Demoted, never buried: senators lead, the House member keeps his row.
    const railNames = page.locator('section[aria-labelledby="act"] ul > li > p.font-bold');
    await expect(railNames).toHaveCount(3);
    await expect(railNames.nth(2)).toHaveText('Monica De La Cruz');
    const houseRow = page
      .locator('section[aria-labelledby="act"] ul > li')
      .filter({ hasText: 'Monica De La Cruz' });
    await expect(houseRow.locator('a[href^="tel:"]').first()).toHaveAttribute(
      'href',
      /^tel:\+1\d{10}$/
    );
  });

  /*
   * FUNNEL INVARIANT I2, ASKED OF A NOMINATION: from the record, a completed
   * call script in ONE more interaction. This is the mechanical answer to
   * "does a nomination Moment survive the call funnel" — funnel.spec.ts itself
   * cannot answer it, because it walks the homepage and no nomination is on it.
   */
  test('I2-shaped: one stance click completes a script', async ({ page }) => {
    test.skip(!LIVE, 'no live-and-described nomination in the current corpus');
    await mockScriptApi(page);
    await page.goto(`/nominations/${liveSlug}`);
    await seedZip(page, '78501');
    await page.reload();
    await page.getByRole('radio', { name: en.bill.stance.support }).click();
    const script = page.getByRole('textbox', { name: en.bill.scriptTitle });
    await expect(script).toBeVisible();
    await expect(script).not.toHaveValue('');
  });

  /*
   * A FINISHED NOMINATION MAKES NO CLAIM. liveCallTargetForNomination returns
   * null for confirmed/returned/withdrawn/unclassified, so the page must carry
   * none of the routing copy — the manufactured urgency this product refuses,
   * caught at the surface rather than only at the unit level.
   */
  test('a confirmed nomination never reads as a live call', async ({ page }) => {
    test.skip(!CONFIRMED, 'no confirmed-and-described nomination in the current corpus');
    await mockScriptApi(page);
    await page.goto(`/nominations/${confirmedSlug}`);
    await seedZip(page, '78501');
    await page.reload();
    await expect(page.getByText(en.nominations.status.confirmed).first()).toBeVisible();
    await page.getByRole('radio', { name: en.bill.stance.support }).click();
    await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toBeVisible();
    for (const copy of [
      en.bill.liveSenateNomination,
      en.bill.nominationHow,
      en.bill.nominationHousePress,
    ]) {
      await expect(page.getByText(copy)).toHaveCount(0);
    }
  });

  test('/es renders Spanish chrome around the English government record', async ({ page }) => {
    test.skip(!LIVE, 'no live-and-described nomination in the current corpus');
    await page.goto(`/es/nominations/${liveSlug}`);
    // The chrome is Spanish…
    await expect(page.getByText(es.nominations.noDecodeNote)).toBeVisible();
    await expect(page.getByText(es.nominations.recordHeading)).toBeVisible();
    // …and the government's own sentence stays English, which the note above
    // is what makes legible rather than broken (README, "Known v1 caveats").
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(LIVE!.nominee_description!);
  });

  /*
   * An unknown slug lands on the LOCALE'S OWN not-found page — chrome, header,
   * footer, and `lang="es"` — never the bare English root one. That is the
   * property app/[locale]/bills/[id]'s dynamicParams comment exists to protect
   * and the one a Spanish visitor following a dead link actually experiences.
   *
   * ⚠️ THE STATUS CODE IS 200, NOT 404, AND THAT IS NOT SOMETHING THIS PAGE
   * INTRODUCED. Measured on the production build of 2026-08-06, /bills/<any
   * unknown slug> answers 200 with the not-found page too — every route in this
   * app renders on demand, and notFound() inside a dynamic render does not set
   * the status here. app/[locale]/bills/[id]/page.tsx's own comment claims
   * "notFound() sends a real 404 status, never a cached 200 with the site's own
   * title", which is a shipped claim that has stopped being true site-wide.
   * It is reported rather than pinned green here: asserting 200 would make this
   * test defend the defect, and asserting 404 would fail on every route in the
   * app rather than on the one thing this spec is about.
   */
  test('an unknown nomination lands on the locale-correct not-found page', async ({ page }) => {
    await page.goto('/es/nominations/pn-0-119');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    // …and not the nomination page: no record section, no call rail.
    await expect(page.getByText(es.nominations.recordHeading)).toHaveCount(0);
  });
});

/*
 * THE ROUTE'S REFUSALS. Only the paths that never reach Anthropic are driven
 * here: a successful generation would be a real model call with real spend, and
 * this suite runs on every push. The success path is covered by the I2 test
 * above with the endpoint mocked, and the prompt itself by
 * tests/nomination-script.unit.spec.ts.
 */
test.describe('/api/script, nomination branch', () => {
  test('refuses a nomination the Senate has finished with — 422, not 404', async ({ request }) => {
    test.skip(!CONFIRMED, 'no confirmed nomination in the current corpus');
    const res = await request.post('/api/script', {
      data: { slug: confirmedSlug, stance: 'support', locale: 'en' },
    });
    expect(res.status()).toBe(422);
    expect((await res.json()).error).toBe('not_callable');
  });

  test('rejects an unrecognized audience rather than defaulting it to the Senate', async ({
    request,
  }) => {
    test.skip(!LIVE, 'no live nomination in the current corpus');
    const res = await request.post('/api/script', {
      data: { slug: liveSlug, stance: 'support', locale: 'en', audience: 'hosue' },
    });
    expect(res.status()).toBe(400);
  });

  test('a slug in neither corpus is still a 404', async ({ request }) => {
    const res = await request.post('/api/script', {
      data: { slug: 'pn-0-119', stance: 'support', locale: 'en' },
    });
    expect(res.status()).toBe(404);
  });
});
