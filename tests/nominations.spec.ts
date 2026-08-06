import { expect, test, type Page } from '@playwright/test';
import { getAllNominations, nominationSlug } from '../lib/core/nominations';
import { liveCallTargetForNomination } from '../lib/journey';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { mockScriptApi, mockScriptApiFailure, seedZip } from './helpers';

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

/*
 * …and one the Senate can still act on that carries NO description sentence —
 * the 14 Foreign Service promotion lists, of which exactly one is live in the
 * corpus of 2026-08-06 (the other 13 are already confirmed and take the closed
 * path instead). The predicate is the page's own gate, `liveCallTargetForNomination`,
 * rather than a hand-listed status set: `unclassified` must NOT be picked up
 * here, because that record keeps its rail on purpose (the route's 422 refusal
 * is the honest answer there) and picking it would quietly retire the refusal
 * path this suite pins below.
 */
const NO_DESCRIPTION = ALL.find(
  (n) => !n.nominee_description && liveCallTargetForNomination(n) !== null
);

const liveSlug = LIVE ? nominationSlug(LIVE) : null;
const confirmedSlug = CONFIRMED ? nominationSlug(CONFIRMED) : null;

/** One representative of EACH terminal status the corpus actually holds. The
 *  three are different sentences ("confirmed" is a Senate vote, "returned"
 *  and "withdrawn" are not), so each is driven rather than assumed to follow
 *  from the first. */
const TERMINAL = (['confirmed', 'returned', 'withdrawn'] as const)
  .map((status) => ({ status, record: ALL.find((n) => n.status === status && n.nominee_description) }))
  .filter((x): x is { status: 'confirmed' | 'returned' | 'withdrawn'; record: (typeof ALL)[number] } =>
    Boolean(x.record)
  );

/*
 * TX-15 (78501): two senators + one House member, and — load-bearing for the
 * "no 'bill' anywhere in the rail" assertions below — not one of the three
 * offices it resolves is a legislator named Bill. A ZIP whose senator is
 * Bill Cassidy would fail those tests on a true first name.
 */
const ZIP = '78501';

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
    await seedZip(page, ZIP); // TX-15: two senators + one House member
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
   * THE HOUSE SCRIPT IS REACHABLE, AND IT IS REACHABLE FROM THE HOUSE ROW
   * (2026-08-06, the second half of the owner's ruling).
   *
   * `lib/nomination-script.ts` shipped a `house` audience, `/api/script`
   * validated it and rode it inside the cache version — and the panel asked for
   * no audience at all, so the branch was dead code. A reader told "your
   * representative can press your senators" was then handed a script that says
   * "the senator", to read to a House office. The WHY had shipped and the HOW
   * had not.
   *
   * What this pins is the whole chain in one drive: the senator request goes
   * out with `audience: 'senator'` (the default, now stated), the House row
   * carries its own control, pressing it asks for `audience: 'house'`, and the
   * two scripts coexist — the senator's is not overwritten, because the Senate
   * stays the default action and the House script is an addition to it, never a
   * mode switch.
   */
  test('the House row hands over a House-audience script, and the senator script survives it', async ({
    page,
  }) => {
    test.skip(!LIVE, 'no live-and-described nomination in the current corpus');
    const audiences: string[] = [];
    await page.route('**/api/script', (route) => {
      const body = route.request().postDataJSON() as { audience?: string };
      const audience = body.audience ?? '(none requested)';
      audiences.push(audience);
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          script:
            audience === 'house'
              ? 'HOUSE AUDIENCE DRAFT. I know the House gets no vote on this one.'
              : 'SENATOR AUDIENCE DRAFT. Please vote to confirm.',
          cached: false,
        }),
      });
    });
    await page.goto(`/nominations/${liveSlug}`);
    await seedZip(page, ZIP);
    await page.reload();
    await page.getByRole('radio', { name: en.bill.stance.support }).click();

    // `exact` on both, and it is not pedantry: the two accessible names share a
    // prefix ("Your script" / "Your script for your House member"), so
    // Playwright's default substring match resolves the senator locator to both
    // textareas the moment the House slot opens.
    const senatorScript = page.getByRole('textbox', { name: en.bill.scriptTitle, exact: true });
    await expect(senatorScript).toHaveValue(/SENATOR AUDIENCE DRAFT/);

    // The control lives IN the House member's own row — the place the reader
    // is looking when they decide to call that office — not in a chooser above
    // the stance control that would make the Senate a decision rather than the
    // default.
    const houseRow = page
      .locator('section[aria-labelledby="act"] ul > li')
      .filter({ hasText: 'Monica De La Cruz' });
    await houseRow.getByRole('button', { name: en.bill.nominationHouseScriptCta }).click();

    const houseScript = houseRow.getByRole('textbox', {
      name: en.bill.nominationHouseScriptTitle,
      exact: true,
    });
    await expect(houseScript).toHaveValue(/HOUSE AUDIENCE DRAFT/);
    // It is a draft the reader can edit before reading it aloud, like every
    // other script on this site (README design principle 5).
    await expect(houseScript).toBeEditable();
    await expect(senatorScript).toHaveValue(/SENATOR AUDIENCE DRAFT/);
    expect(audiences).toEqual(['senator', 'house']);
  });

  /*
   * …AND THE WORDS THEMSELVES NEVER HAND THE HOUSE A VOTE IT DOES NOT HAVE.
   * The test above drives mocked model output; this one drives the SHIPPED
   * static template, which is the text a reader actually gets whenever the
   * model is unreachable — the state the original defect was reproduced in.
   */
  test('the House template asks for pressure, never for a vote the House does not have', async ({
    page,
  }) => {
    test.skip(!LIVE, 'no live-and-described nomination in the current corpus');
    await mockScriptApiFailure(page, 502, { error: 'generation_failed' });
    await page.goto(`/nominations/${liveSlug}`);
    await seedZip(page, ZIP);
    await page.reload();
    await page.getByRole('radio', { name: en.bill.stance.support }).click();

    const houseRow = page
      .locator('section[aria-labelledby="act"] ul > li')
      .filter({ hasText: 'Monica De La Cruz' });
    await houseRow.getByRole('button', { name: en.bill.nominationHouseScriptCta }).click();

    const template = houseRow.getByRole('textbox', {
      name: en.bill.nominationHouseFallbackTitle,
    });
    await expect(template).toBeVisible();
    const words = await template.inputValue();
    // The one sentence that must be there: the caller says out loud that they
    // know the House has no vote, so the office knows why the call was made.
    expect(words).toContain('the House has no vote');
    expect(words).toContain('press our state');
    // And the senator template's ask must never be what a House caller reads.
    expect(words).not.toContain('asking the senator to vote');
    // Not AI, and labeled as not AI — the labeling rule cuts both ways.
    await expect(houseRow.getByText(en.bill.fallbackDisclaimer)).toBeVisible();
    await expect(houseRow.getByText(en.bill.scriptDisclaimer)).toHaveCount(0);
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
    await seedZip(page, ZIP);
    await page.reload();
    await page.getByRole('radio', { name: en.bill.stance.support }).click();
    const script = page.getByRole('textbox', { name: en.bill.scriptTitle });
    await expect(script).toBeVisible();
    await expect(script).not.toHaveValue('');
  });

  /*
   * A FINISHED NOMINATION HAS NO CALL APPARATUS AT ALL (2026-08-06 blocker 1b).
   *
   * The first version of this test asserted only that the ROUTING COPY was
   * absent — and it passed while the page below it still offered a stance
   * control, an AI script slot, a ready-made template and three dials on a
   * nomination the Senate confirmed 18 months earlier. Absence of the routing
   * sentence was never the property that mattered; absence of the ACTION was.
   *
   * The bill path's own precedent for a terminal state is a plain past-tense
   * sentence that says what happened (lib/journey.ts's nowSigned / nowVetoed,
   * with showTrailer false — the forward-looking apparatus turns off and the
   * record speaks). This is that, applied where the call would have been.
   */
  for (const { status, record } of TERMINAL) {
    test(`a ${status} nomination offers no script and no stance control, and says what happened`, async ({
      page,
    }) => {
      await mockScriptApi(page);
      await page.goto(`/nominations/${nominationSlug(record)}`);
      await seedZip(page, ZIP);
      await page.reload();

      // What happened, in plain words, standing where the rail stood.
      await expect(
        page.getByRole('heading', { name: en.nominations.closedTitle })
      ).toBeVisible();
      await expect(page.getByText(en.nominations.closed[status])).toBeVisible();

      // …and NONE of the apparatus. Each of these is a separate promise the
      // page was breaking: a position to take, words to read, a fallback
      // template, and a number to dial about a decision already made.
      await expect(page.getByRole('radiogroup')).toHaveCount(0);
      await expect(page.getByRole('radio')).toHaveCount(0);
      await expect(page.getByText(en.bill.actTitle)).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: en.bill.fallbackTitle })).toHaveCount(0);
      await expect(page.getByText(en.bill.fallbackTitle)).toHaveCount(0);
      await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
      await expect(page.getByRole('button', { name: en.bill.startCall })).toHaveCount(0);

      // The routing copy stays absent too — the original assertion, kept.
      for (const copy of [
        en.bill.liveSenateNomination,
        en.bill.nominationHow,
        en.bill.nominationHousePress,
      ]) {
        await expect(page.getByText(copy)).toHaveCount(0);
      }
    });
  }

  /*
   * A RECORD WITH NO DESCRIPTION GETS NO CONTROL THAT CAN ONLY REFUSE
   * (2026-08-06, N5).
   *
   * The 14 Foreign Service promotion lists carry no description sentence, and
   * that sentence is the only thing a nomination script is ever grounded in —
   * so /api/script answers 422 for them by design. The page nonetheless offered
   * a stance control, which meant the only thing a reader could do here was
   * press a button and be told no. The panel's own rule decides it: "offering a
   * dial with nothing to say is the thing that makes a first-time caller hang
   * up" — no words, no apparatus.
   *
   * What it must NOT do is read as finished. The Senate can still act on this
   * one, and `nominations.closed.*` would be a false sentence here.
   */
  test('a nomination the record does not describe offers no stance control, no script and no dial', async ({
    page,
  }) => {
    test.skip(!NO_DESCRIPTION, 'no live description-less nomination in the current corpus');
    await mockScriptApi(page);
    await page.goto(`/nominations/${nominationSlug(NO_DESCRIPTION!)}`);
    await seedZip(page, ZIP);
    await page.reload();

    await expect(page.getByRole('heading', { name: en.nominations.noScriptTitle })).toBeVisible();
    await expect(page.getByText(en.nominations.noScriptBody)).toBeVisible();

    await expect(page.getByRole('radiogroup')).toHaveCount(0);
    await expect(page.getByRole('radio')).toHaveCount(0);
    await expect(page.getByText(en.bill.actTitle)).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: en.bill.fallbackTitle })).toHaveCount(0);
    await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: en.bill.startCall })).toHaveCount(0);

    // Live, not closed: the Senate's own record still stands on the left, and
    // none of the finished-record sentences may appear.
    await expect(page.getByText(en.nominations.recordHeading)).toBeVisible();
    await expect(page.getByText(en.nominations.closedTitle)).toHaveCount(0);
    for (const status of ['confirmed', 'returned', 'withdrawn'] as const) {
      await expect(page.getByText(en.nominations.closed[status])).toHaveCount(0);
    }
  });

  test('the same record says it in Spanish on /es', async ({ page }) => {
    test.skip(!NO_DESCRIPTION, 'no live description-less nomination in the current corpus');
    await page.goto(`/es/nominations/${nominationSlug(NO_DESCRIPTION!)}`);
    await expect(page.getByRole('heading', { name: es.nominations.noScriptTitle })).toBeVisible();
    await expect(page.getByText(es.nominations.noScriptBody)).toBeVisible();
    await expect(page.getByRole('radio')).toHaveCount(0);
  });

  test('the closed panel speaks Spanish on /es', async ({ page }) => {
    test.skip(!CONFIRMED, 'no confirmed-and-described nomination in the current corpus');
    await page.goto(`/es/nominations/${confirmedSlug}`);
    await expect(page.getByRole('heading', { name: es.nominations.closedTitle })).toBeVisible();
    await expect(page.getByText(es.nominations.closed.confirmed)).toBeVisible();
    await expect(page.getByRole('radio')).toHaveCount(0);
  });

  /*
   * THE FALLBACK TEMPLATE IS KIND-AWARE (2026-08-06 blocker 1a).
   *
   * `bill.fallbackScript.*` says "this bill" / "este proyecto de ley", and the
   * panel seeded it on every nomination whose script request failed — a
   * nomination called a bill, in a script written for the reader to say out
   * loud. The assertion is deliberately made over the WHOLE rail rather than
   * over the textarea alone: `bill.generating1` ("Reading the bill so you
   * don't have to…") carried the same lie one state earlier, and a
   * textarea-only test would have shipped past it.
   */
  for (const { locale, prefix, messages, word } of [
    { locale: 'en', prefix: '', messages: en, word: /\bbills?\b/i },
    { locale: 'es', prefix: '/es', messages: es, word: /\bproyectos?\b/i },
  ] as const) {
    test(`${locale}: nothing in a nomination's call rail calls it a bill`, async ({ page }) => {
      test.skip(!LIVE, 'no live-and-described nomination in the current corpus');
      // A 502 is the path that seeds the fallback template — the exact state
      // the reproduction hit with the API unmocked.
      await mockScriptApiFailure(page, 502, { error: 'generation_failed' });
      await page.goto(`${prefix}/nominations/${liveSlug}`);
      await seedZip(page, ZIP);
      await page.reload();
      await page.getByRole('radio', { name: messages.bill.stance.support }).click();

      const template = page.getByRole('textbox', { name: messages.bill.fallbackTitle });
      await expect(template).toBeVisible();
      // The words the caller would actually say.
      expect(await template.inputValue()).not.toMatch(word);

      // The House row's own script is opened here rather than in a test of its
      // own, so its strings — a CTA, a title and a three-stance template, in
      // both languages — are inside the rail sweep below. They are the newest
      // copy on this surface and therefore the likeliest to reintroduce the
      // word.
      await page
        .getByRole('button', { name: messages.bill.nominationHouseScriptCta })
        .first()
        .click();
      await expect(
        page.getByRole('textbox', { name: messages.bill.nominationHouseFallbackTitle })
      ).toBeVisible();
      // …and every other string in the rail, including the collapsed
      // both-sides ghost templates (textContent, not innerText, so a closed
      // <details> is still read).
      const rail = page.locator('section[aria-labelledby="act"]');
      expect(await rail.evaluate((el) => el.textContent ?? '')).not.toMatch(word);
    });
  }

  /*
   * THE REFUSAL IS NOT A FAILURE (2026-08-06 blocker 2). The route answers 422
   * `not_callable` when it has DECIDED there is no call to make; the panel
   * could not tell that from an outage and told the reader to try again, with
   * a ready-made template underneath. Nothing had gone wrong, and both of
   * those were false.
   */
  test('a 422 not_callable reads as a refusal — no retry, no template, no dial', async ({
    page,
  }) => {
    test.skip(!LIVE, 'no live-and-described nomination in the current corpus');
    await mockScriptApiFailure(page, 422, { error: 'not_callable' });
    await page.goto(`/nominations/${liveSlug}`);
    await seedZip(page, ZIP);
    await page.reload();
    await page.getByRole('radio', { name: en.bill.stance.support }).click();

    await expect(page.getByText(en.bill.scriptNotCallable)).toBeVisible();
    // Not the outage message, and not its retry affordance.
    await expect(page.getByText(en.bill.scriptError)).toHaveCount(0);
    await expect(page.getByText(en.bill.rateLimited)).toHaveCount(0);
    await expect(page.getByRole('button', { name: en.bill.retry })).toHaveCount(0);
    // And no template: handing over words to read is exactly the thing the
    // route just refused to do.
    await expect(page.getByText(en.bill.fallbackTitle)).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: en.bill.fallbackTitle })).toHaveCount(0);
    await expect(page.locator('section[aria-labelledby="act"] a[href^="tel:"]')).toHaveCount(0);
  });

  /*
   * …AND THE GENUINE FAILURE PATH IS UNTOUCHED. "Couldn't draft a script right
   * now" is the correct sentence for its own case, and the template it hands
   * over is the right answer to an outage — it just has to be the right
   * template. Both halves are asserted here so a future refusal branch cannot
   * quietly swallow the outage branch.
   */
  test('a 5xx still reads as transient, with a retry and a nomination-worded template', async ({
    page,
  }) => {
    test.skip(!LIVE, 'no live-and-described nomination in the current corpus');
    await mockScriptApiFailure(page, 502, { error: 'generation_failed' });
    await page.goto(`/nominations/${liveSlug}`);
    await seedZip(page, ZIP);
    await page.reload();
    await page.getByRole('radio', { name: en.bill.stance.support }).click();

    await expect(page.getByText(en.bill.scriptError)).toBeVisible();
    await expect(page.getByRole('button', { name: en.bill.retry })).toBeVisible();
    await expect(page.getByText(en.bill.scriptNotCallable)).toHaveCount(0);
    const template = page.getByRole('textbox', { name: en.bill.fallbackTitle });
    await expect(template).toBeVisible();
    expect(await template.inputValue()).toContain('nomination before the Senate');
    // The dial comes back with it — an outage must never take the phones down
    // (funnel invariant I2, and the reason the fallback exists at all).
    await expect(
      page.locator('section[aria-labelledby="act"] a[href^="tel:"]').first()
    ).toBeVisible();
  });

  test('a 429 still rate-limits, and seeds the nomination template', async ({ page }) => {
    test.skip(!LIVE, 'no live-and-described nomination in the current corpus');
    await mockScriptApiFailure(page, 429, { error: 'rate_limited', retryAfterSec: 480 });
    await page.goto(`/nominations/${liveSlug}`);
    await seedZip(page, ZIP);
    await page.reload();
    await page.getByRole('radio', { name: en.bill.stance.support }).click();

    await expect(page.getByText(en.bill.rateLimited)).toBeVisible();
    await expect(page.getByText(en.bill.scriptNotCallable)).toHaveCount(0);
    const template = page.getByRole('textbox', { name: en.bill.fallbackTitle });
    await expect(template).toBeVisible();
    expect(await template.inputValue()).toContain('nomination before the Senate');
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
  /*
   * ── THE SHARE CARD MAY NOT PROMISE A CALL THE PAGE DOES NOT HAVE ─────────
   *
   * generateMetadata returned `nominations.metaDescription` — "…and the call
   * that goes with it" — unconditionally, on 686 of the corpus's 857 records
   * where the page below carries no dial, no stance control and no script.
   * `robots: { index: cited }` limits SEARCH exposure and touches nothing
   * else: this string is what a link preview and a share card render, on every
   * paste into a message or a post, indexed or not.
   */
  const metaDescription = (page: Page) =>
    page.locator('meta[name="description"]').getAttribute('content');

  test('a live, described nomination keeps the description that promises a call', async ({
    page,
  }) => {
    test.skip(!LIVE, 'no live-and-described nomination in the current corpus');
    await page.goto(`/nominations/${liveSlug}`);
    expect(await metaDescription(page)).toBe(en.nominations.metaDescription);
  });

  for (const { status } of TERMINAL) {
    test(`a ${status} nomination's share card promises no call`, async ({ page }) => {
      const record = TERMINAL.find((x) => x.status === status)!.record;
      await page.goto(`/nominations/${nominationSlug(record)}`);
      const description = await metaDescription(page);
      expect(
        description,
        'the finished record must not be shared as "…and the call that goes with it"'
      ).not.toBe(en.nominations.metaDescription);
      expect(description).toBe(en.nominations.metaDescriptionNoCall);
    });
  }

  test('a record with no description promises no call either, in both languages', async ({
    page,
  }) => {
    test.skip(!NO_DESCRIPTION, 'no live description-less nomination in the current corpus');
    const slug = nominationSlug(NO_DESCRIPTION!);
    await page.goto(`/nominations/${slug}`);
    expect(await metaDescription(page)).not.toBe(en.nominations.metaDescription);
    expect(await metaDescription(page)).toBe(en.nominations.metaDescriptionNoCall);

    await page.goto(`/es/nominations/${slug}`);
    expect(await metaDescription(page)).not.toBe(es.nominations.metaDescription);
    expect(await metaDescription(page)).toBe(es.nominations.metaDescriptionNoCall);
  });

  /*
   * ── NO COPY ON THIS PAGE MAY ASSERT A LAYOUT ─────────────────────────────
   *
   * `nominations.noScriptBody` ended "…is beside this, in full" (ES: "está al
   * lado, completo"). Below 62rem the desk grid collapses to ONE column and
   * the record renders ABOVE the panel, so the sentence was false on every
   * phone — the majority reading. The fix is not a better spatial word; it is
   * a sentence that does not depend on where the browser put things.
   *
   * Both halves are asserted, because either alone is weak: the geometry proves
   * an adjacency claim would be false, and the vocabulary sweep proves none is
   * being made.
   */
  test('the no-script panel makes no claim about where the record sits', async ({ page }) => {
    test.skip(!NO_DESCRIPTION, 'no live description-less nomination in the current corpus');
    const slug = nominationSlug(NO_DESCRIPTION!);
    // Comfortably under the 62rem (992px) breakpoint where the desk collapses.
    await page.setViewportSize({ width: 800, height: 900 });
    await page.goto(`/nominations/${slug}`);

    const record = page.getByRole('heading', { name: en.nominations.recordHeading });
    const panel = page.getByRole('heading', { name: en.nominations.noScriptTitle });
    const recordBox = (await record.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    // Stacked, not side by side: the record ends above where the panel starts.
    expect(recordBox.y + recordBox.height).toBeLessThan(panelBox.y);

    for (const [lang, body] of [
      ['en', en.nominations.noScriptBody],
      ['es', es.nominations.noScriptBody],
    ] as const) {
      expect(
        body,
        `${lang}: this sentence renders in one column on a phone, so it may not place the record`
      ).not.toMatch(/beside|alongside|next to|to the (left|right)|al lado|a la (izquierda|derecha)/i);
    }
  });

  /*
   * ── THE "NOTHING BELOW IS OURS" CLAIM WAS FALSE, AND THE FIX IS PRECISION ─
   *
   * `nominations.recordLede` read "Nothing below was written or rewritten by
   * Oravan." Everything between it and the bottom of that column contradicts
   * it: the Executive Calendar chip, both <dt> labels, the staleness note and
   * the data-as-of line are Oravan's own English, and the dates are formatted
   * by us (in Spanish on /es, so not even the government's characters). The
   * TRUE and worth-saying claim — the Senate's action text is reproduced word
   * for word — is what the lede now makes.
   *
   * So the test asserts the contradiction is real, then asserts the sentence
   * no longer denies it.
   */
  test('the record lede does not deny authorship of the chrome it sits above', async ({ page }) => {
    test.skip(!LIVE, 'no live-and-described nomination in the current corpus');
    await page.goto(`/nominations/${liveSlug}`);

    const lede = page.getByText(en.nominations.recordLede);
    await expect(lede).toBeVisible();
    const ledeBox = (await lede.boundingBox())!;

    // Oravan-authored English, rendered BELOW that sentence — the labels come
    // straight out of messages/en.json, so their authorship is not arguable.
    for (const label of [en.nominations.receivedLabel, en.nominations.lastActionLabel]) {
      const el = page.getByText(label, { exact: true }).first();
      await expect(el).toBeVisible();
      expect((await el.boundingBox())!.y, `"${label}" must sit below the lede`).toBeGreaterThan(
        ledeBox.y
      );
    }

    for (const [lang, text] of [
      ['en', en.nominations.recordLede],
      ['es', es.nominations.recordLede],
    ] as const) {
      expect(
        text,
        `${lang}: the section below carries Oravan's own labels, notes and date formatting`
      ).not.toMatch(/nothing below|nada de lo que sigue|nada de lo siguiente/i);
    }
  });

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
