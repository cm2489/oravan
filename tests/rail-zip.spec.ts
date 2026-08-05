import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { mockScriptApi } from './helpers';

/*
 * "The panel scrolls · the call stays" — and so does a ZIP submit (2026-08,
 * panel-navigation fix). The ZipForm instances INSIDE the bill page's call
 * panel (the rail's no-ZIP block and the call dialog's never-a-dead-end
 * block) resolve in place: submit saves the ZIP, the reps load into the
 * panel, and the freshly generated script — which lives only in component
 * state — survives. Navigation to /reps remains the home hero's and the
 * /reps page's own behavior (funnel I2 pins it), never this panel's.
 *
 * Fixtures proven by tests/reps.spec.ts: 78501 = a normal single-district
 * TX ZIP (Monica De La Cruz), 00000 = valid shape but unmatched, 33313 =
 * FL-20, a genuinely vacant House seat.
 *
 * LOCATOR SCOPING: while the dialog is open, the rail and the dialog each
 * mount a ZipForm and (in the new states) duplicate loading/not-found copy —
 * the exact e2e trap ActionPanel's own dialog comment documents. Every
 * locator here is scoped to the dialog or left rail-only (dialog closed).
 */

const BILL = '/bills/sjres-99-119'; // same stable slug flow/es-parity/call-action pin

for (const locale of ['en', 'es'] as const) {
  test(`${locale}: rail ZIP submit stays on the bill page — script intact, reps load in-panel`, async ({
    page,
  }) => {
    const messages = locale === 'en' ? en : es;
    await mockScriptApi(page);
    await page.goto(locale === 'es' ? '/es' + BILL : BILL); // deliberately NO seedZip

    await page.getByRole('radio', { name: messages.bill.stance.support }).click();
    const textarea = page.getByRole('textbox', { name: messages.bill.scriptTitle });
    await expect(textarea).toHaveValue(/MOCKED SCRIPT BODY/);

    // Submit a ZIP in the rail's own form (dialog closed: single instance).
    await page.getByLabel(messages.home.zipLabel).fill('78501');
    await page.getByRole('button', { name: messages.home.zipCta }).click();

    // The promise: reps arrive IN the panel, the URL never changes, and the
    // script draft is not destroyed by a navigation.
    await expect(page.getByText('Monica De La Cruz')).toBeVisible();
    await expect(page.locator('a[href^="tel:"]').first()).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${BILL.replace(/\//g, '\\/')}`));
    await expect(textarea).toHaveValue(/MOCKED SCRIPT BODY/);
  });
}

test('dialog ZIP submit (the P0): the mode stays open, script visible, dial links appear in-dialog', async ({
  page,
}) => {
  await mockScriptApi(page);
  await page.goto(BILL); // NO seedZip
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toBeVisible();
  await page.getByRole('button', { name: en.bill.startCall }).click();

  const dialog = page.getByRole('dialog', { name: en.bill.callTitle });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(en.home.zipLabel)).toBeVisible();

  // Fix the missing ZIP without leaving the mode.
  await dialog.getByLabel(en.home.zipLabel).fill('78501');
  await dialog.getByRole('button', { name: en.home.zipCta }).click();

  // The mode survives its own ZIP submit: still open, still on the bill
  // page, script still there, and the dial links land inside the dialog.
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('a[href^="tel:"]').first()).toBeVisible();
  await expect(dialog.getByText(/MOCKED SCRIPT BODY/)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(BILL.replace(/\//g, '\\/')));
});

test('unmatched ZIP in the rail: the /reps failure register in-panel, recoverable in place', async ({
  page,
}) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toBeVisible();

  await page.getByLabel(en.home.zipLabel).fill('00000');
  await page.getByRole('button', { name: en.home.zipCta }).click();

  // The honest not-found block (this used to be a silently empty rail):
  // role=alert with the /reps copy, still on the bill page, form re-shown.
  await expect(page.getByRole('alert').filter({ hasText: en.reps.zipNotFound })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(BILL.replace(/\//g, '\\/')));

  // Recovery proven: correct the ZIP right there.
  await page.getByLabel(en.home.zipLabel).fill('78501');
  await page.getByRole('button', { name: en.home.zipCta }).click();
  await expect(page.getByText('Monica De La Cruz')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(BILL.replace(/\//g, '\\/')));
});

test('reps lookup failure in the rail: Failure + retry recovers without leaving the page', async ({
  page,
}) => {
  await mockScriptApi(page);
  let repCalls = 0;
  await page.route('**/api/reps*', (route) => {
    repCalls += 1;
    if (repCalls === 1) {
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
    }
    return route.continue();
  });
  await page.goto(BILL);
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toBeVisible();

  await page.getByLabel(en.home.zipLabel).fill('78501');
  await page.getByRole('button', { name: en.home.zipCta }).click();

  await expect(page.getByRole('alert').filter({ hasText: en.bill.repsError })).toBeVisible();
  await page.getByRole('button', { name: en.bill.retry }).click();
  await expect(page.getByText('Monica De La Cruz')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(BILL.replace(/\//g, '\\/')));
});

/*
 * Split ZIP in the rail (2026-08-04 walkthrough P1): 10001 spans NY-10
 * (Goldman) and NY-12 (Nadler), so four names render — and the old copy
 * said "your three" with no "which one is mine?" help, while the call
 * dialog led with a House member who may not be the caller's own. The
 * multi-district line owns the count, the senators lead the list, and the
 * existing /reps refinement flow is offered from the panel itself.
 */
test('split ZIP (10001): honest multi-district copy, senators lead, refinement offered', async ({
  page,
}) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toBeVisible();

  await page.getByLabel(en.home.zipLabel).fill('10001');
  await page.getByRole('button', { name: en.home.zipCta }).click();

  // Never "your three" over four names.
  await expect(page.getByText(en.bill.callWhoMulti)).toBeVisible();
  await expect(page.getByText(en.bill.callWho, { exact: true })).toHaveCount(0);

  // Four rows, with BOTH ambiguous House members demoted below the two
  // certainly-yours senators.
  const rowNames = page.locator('section[aria-labelledby="act"] ul > li > p.font-bold');
  await expect(rowNames).toHaveCount(4);
  const names = await rowNames.allTextContents();
  expect(names.findIndex((n) => /Goldman|Nadler/.test(n))).toBeGreaterThanOrEqual(2);

  // The refinement hand-off: the same ?zip flow /reps already owns.
  const refine = page.getByRole('link', { name: en.bill.refineDistrictCta }).first();
  await expect(refine).toBeVisible();
  await expect(refine).toHaveAttribute('href', /\/reps\?zip=10001/);

  // The dial moment carries the same disambiguation: the dialog's first
  // dial link is a senator, and the note + refinement render in-mode.
  await page.getByRole('button', { name: en.bill.startCall }).click();
  const dialog = page.getByRole('dialog', { name: en.bill.callTitle });
  await expect(dialog.getByText(en.bill.callWhoMulti)).toBeVisible();
  await expect(dialog.getByRole('link', { name: en.bill.refineDistrictCta })).toBeVisible();
  await expect(dialog.locator('a[href^="tel:"]').first()).not.toContainText(/Goldman|Nadler/);
});

test('vacant seat (FL-20) via the rail: vacancy named, senators still dialable, no departed member', async ({
  page,
}) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toBeVisible();

  await page.getByLabel(en.home.zipLabel).fill('33313');
  await page.getByRole('button', { name: en.home.zipCta }).click();

  await expect(page.getByText(en.reps.vacantSeat, { exact: true })).toBeVisible();
  await expect(page.getByText('Rick Scott')).toBeVisible();
  await expect(page.getByText('Ashley Moody')).toBeVisible();
  await expect(page.locator('a[href^="tel:"]').first()).toBeVisible();
  await expect(page.getByText('Cherfilus-McCormick')).toHaveCount(0);
});

/*
 * Two 2026-08 benchmark gates in one flow. (1) Enter submits the rail ZIP
 * form — a silent Enter at the moment of highest intent is the exact
 * failure this gate exists to prevent. (2) Chamber-aware routing (lib/journey.ts
 * liveCallTarget): S.J.Res. 99's floor activity sits in the Senate (the CR
 * S-page in its own last action), so the live-call line names the senators
 * and they lead the list — the House member keeps her dial, demoted never
 * buried.
 */
test('Enter submits the rail ZIP form, and chamber routing names the senators as the live call', async ({
  page,
}) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toBeVisible();

  await page.getByLabel(en.home.zipLabel).fill('78501');
  await page.getByLabel(en.home.zipLabel).press('Enter');

  await expect(page.getByText('Monica De La Cruz')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(BILL.replace(/\//g, '\\/')));

  await expect(page.getByText(en.bill.liveSenateFloor)).toBeVisible();
  const firstRow = page.locator('section[aria-labelledby="act"] ul > li > p.font-bold').first();
  await expect(firstRow).not.toHaveText('Monica De La Cruz');
});

/*
 * 2026-08 mockup picks (owner: A1/B1/C1/D1/E1). The three that live on this
 * page's rail are pinned here; A1 is pinned in landing.spec.
 */

test('C1 provenance ritual: one fixed-order metadata line under the h1 — citation, gated status, latest action, the AI label', async ({
  page,
}) => {
  await page.goto(BILL);
  const header = page.locator('main header');
  await expect(header.getByText('S.J.Res. 99')).toBeVisible();
  // The status fragment routes through statusKeyFor: S.J.Res. 99 carries
  // floor ACTIVITY, so the ritual may never print "On the floor calendar".
  await expect(header.getByText(en.bills.status.floor_activity, { exact: true })).toBeVisible();
  await expect(header.getByText(en.bills.status.floor_vote, { exact: true })).toHaveCount(0);
  await expect(header.getByText(new RegExp(en.bill.lastAction))).toBeVisible();
  // Funnel invariant I1's own string, in its first-contact position.
  await expect(header.getByText(en.bill.aiLabel, { exact: true })).toBeVisible();
});

test("D1 both-sides ghosts: the unselected stances' templates render collapsed — the UI certifies no house position", async ({
  page,
}) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toBeVisible();

  const summaryFor = (s: string) => en.bill.ghostSummary.replace('{stance}', s);
  await expect(page.getByText(summaryFor(en.bill.stance.oppose))).toBeVisible();
  await expect(page.getByText(summaryFor(en.bill.stance.undecided))).toBeVisible();
  // Never a ghost of the stance already open above it.
  await expect(page.getByText(summaryFor(en.bill.stance.support))).toHaveCount(0);

  // Expanding shows the STATIC template (citation interpolated) and never
  // the AI disclaimer — the label may not ride non-AI text.
  const ghost = page.locator('details', { hasText: summaryFor(en.bill.stance.oppose) }).first();
  await ghost.locator('summary').click();
  await expect(ghost.getByText(/S\.J\.Res\. 99/)).toBeVisible();
  await expect(ghost.getByText(en.bill.scriptDisclaimer)).toHaveCount(0);
});

test('E1 scroll hint: rides the fade while the rail overflows unscrolled, retires on the first scroll', async ({
  page,
  isMobile,
}) => {
  test.skip(!!isMobile, 'the rail only scrolls internally on the desk layout');
  await mockScriptApi(page);
  await page.goto(BILL);
  // The hint's real window: a stance just picked, the script mounted, the
  // ZIP block now below the rail's fold — BEFORE any in-panel interaction.
  // (A ZIP submit would end the window on purpose: filling the field
  // scrolls it into view, and the post-submit focus move scrolls again —
  // either genuine scroll retires the hint, which is the design.)
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toBeVisible();

  const rail = page.locator('section[aria-labelledby="act"]');
  const scrollBody = rail.locator('[class*="overflow-y-auto"]').first();
  const overflows = await scrollBody.evaluate((el) => el.scrollHeight - el.clientHeight > 40);
  test.skip(!overflows, 'panel content fits this viewport — nothing to hint');

  const hint = rail.getByText(`↓ ${en.bill.railMoreHint}`);
  await expect(hint).toBeVisible();
  await scrollBody.evaluate((el) => el.scrollTo({ top: 200 }));
  await expect(hint).toBeHidden();
});
