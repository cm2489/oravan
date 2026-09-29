import { expect, test, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { referenceBill } from './corpus-fixtures';
import { mockScriptApi, seedZip } from './helpers';

/*
 * The bill page's call flow, end to end, and the civic record it writes.
 *
 * Controls and copy are found by message key; the bill is the corpus's
 * reference fixture (tests/corpus-fixtures.ts) — decoded, in committee, with
 * Spanish of its own. Any bill with a call panel would do, so the spec asks
 * for one by property rather than naming whichever the last sync left behind.
 * ZIP 78501 is TX-15 (Monica De La Cruz), the fixture tests/reps.spec.ts
 * proves.
 */
const REF = referenceBill();
const BILL_SLUG = REF.slug;
const BILL = `/bills/${BILL_SLUG}`;

test('full flow: stance, script, outcome, impact, delete', async ({ page }) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await seedZip(page, '78501');
  await page.reload();

  // Stance -> mocked script appears, editable
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  const textarea = page.getByRole('textbox', { name: en.bill.scriptTitle });
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveValue(/MOCKED SCRIPT BODY/);
  await textarea.fill('My edited script.');

  // Switching stance does not destroy the edit
  await page.getByRole('radio', { name: en.bill.stance.oppose }).click();
  await expect(textarea).toHaveValue(/MOCKED SCRIPT BODY/);
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(textarea).toHaveValue('My edited script.');

  // Call section: reps render with tel links
  await expect(page.getByText('Monica De La Cruz')).toBeVisible();
  expect(await page.locator('a[href^="tel:"]').count()).toBeGreaterThan(0);

  // Outcome: selected state + upsert (change, not duplicate)
  await page.getByRole('button', { name: en.bill.outcome.voicemail }).first().click();
  await expect(
    page.getByRole('button', { name: en.bill.outcome.voicemail }).first()
  ).toHaveAttribute('aria-pressed', 'true');
  // First-call milestone fires inline, adjacent to the tapped chip
  await expect(page.getByText(en.bill.loggedFirst)).toBeVisible();

  await page.getByRole('button', { name: en.bill.outcome.contact }).first().click();
  const calls = await page.evaluate(() => JSON.parse(localStorage.getItem('oravan.calls') ?? '[]'));
  expect(calls).toHaveLength(1);
  expect(calls[0].outcome).toBe('contact');

  // The civic record shows the call; per-record delete empties that list.
  // Scoped to the calls section on purpose: since the record also carries a
  // reading history, this same bill now appears twice on the page — once as
  // "you read it", once as "you called about it" — and a page-wide text
  // match would be ambiguous about which one it proved.
  await page.goto('/record');
  await expect(
    page.locator('section[aria-labelledby="history"]').getByText(REF.citation, { exact: false })
  ).toBeVisible();
  await page.getByRole('button', { name: en.impact.deleteRecord }).click();
  await expect(page.getByText(en.impact.emptyTitle)).toBeVisible();
});

test('the call panel shows the nudge, the script and the dial buttons inline — one route, no dialog', async ({ page }) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await seedZip(page, '78501');
  await page.reload();
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  const panel = page.locator('section[aria-labelledby="act"]');
  // Fresh profile: the first-call after-hours nudge shows, in the panel.
  // exact: the why-call link below it starts with a similar phrase.
  await expect(panel.getByText(en.bill.firstCallTitle, { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toHaveValue(/MOCKED SCRIPT BODY/);
  await expect(panel.locator('a[href^="tel:"]').first()).toBeVisible();
  // The "Start the call" dialog is gone (owner, 2026-09-28, Q5 "a").
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('script failure shows a retry that recovers', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/script', (route) => {
    calls++;
    if (calls === 1) return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"generation_failed"}' });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ script: 'RECOVERED SCRIPT', cached: false }) });
  });
  await page.goto(BILL);
  await page.getByRole('radio', { name: en.bill.stance.undecided }).click();
  // Next.js's route announcer is also role=alert - filter to ours, and the
  // retry has to live inside it.
  const failure = page.getByRole('alert').filter({ hasText: en.bill.scriptError });
  await expect(failure).toBeVisible();
  await failure.getByRole('button', { name: en.bill.retry }).click();
  await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toHaveValue('RECOVERED SCRIPT');
});

test('spanish bill page serves translated decoded content', async ({ page }) => {
  await page.goto('/es' + BILL);
  await expect(page.getByRole('heading', { name: es.bill.decoded })).toBeVisible();
  // The Spanish decode itself (data/bills-es.json through lib/core), not the
  // English one wearing Spanish chrome.
  await expect(page.locator('main')).toContainText(REF.es.ai_sections!.what);
});

/*
 * THE CIVIC RECORD (repositioning spec §4). /record stopped being a call
 * scoreboard: reading a bill now leaves a row of its own, alongside the
 * topics you follow and above the calls you made.
 *
 * The load-bearing claim under test is not "the list renders" — it is that
 * the new store is ERASABLE BY THE SAME BUTTON as everything else. A store
 * the erase path forgets about is a private-by-design product quietly
 * keeping a political reading list, so the localStorage key itself is
 * asserted gone rather than the UI merely looking empty.
 */
const readCount = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('oravan.reads') ?? '[]').length);

/** ReadReceipt writes from an effect, so the row exists after hydration, not
 *  after navigation — poll rather than assume the two coincide. */
async function visitAndWaitForReceipt(page: Page, url: string) {
  await page.goto(url);
  await expect.poll(() => readCount(page)).toBe(1);
}

/*
 * Write-time bilingual labels (2026-08-04 walkthrough P1): /es/record used
 * to print stored English titles verbatim for interactions made on EN pages
 * — a bilingual-parity breach on the surface meant to celebrate the user's
 * history. Both locales' labels are captured when the row is written (the
 * record's contents are never resolved over the network — they are private
 * to the device), so the record prints in whichever language it is read in.
 * Both headlines are read from the fixture (data/bills.json and its Spanish
 * overlay), so a re-decode moves the expectation along with the page.
 */
test('a bill read in ENGLISH prints its SPANISH headline on /es/record', async ({ page }) => {
  await visitAndWaitForReceipt(page, BILL); // the EN page
  await page.goto('/es' + '/record');
  const reads = page.locator('section[aria-labelledby="reads"]');
  await expect(reads.locator(`a[href$="/bills/${BILL_SLUG}"]`)).toContainText(REF.es.ai_headline!);
  // And back on the EN record, the same row prints English.
  await page.goto('/record');
  const enRow = page
    .locator('section[aria-labelledby="reads"]')
    .locator(`a[href$="/bills/${BILL_SLUG}"]`);
  await expect(enRow).toContainText(REF.bill.ai_headline!);
  await expect(enRow).not.toContainText(REF.es.ai_headline!);
});

test('legacy rows without bilingual labels still print their stored label on /es/record', async ({
  page,
}) => {
  await page.goto('/es/record');
  await page.evaluate(
    ({ slug, label }) => {
      localStorage.setItem(
        'oravan.calls',
        JSON.stringify([
          {
            billSlug: slug,
            billLabel: label,
            repBioguide: 'D000399',
            repName: 'Monica De La Cruz',
            stance: 'support',
            outcome: 'contact',
            at: '2026-07-01T12:00:00.000Z',
          },
        ])
      );
    },
    { slug: BILL_SLUG, label: `${REF.citation} · legacy stored label` }
  );
  await page.reload();
  await expect(
    page.locator('section[aria-labelledby="history"]').getByText('legacy stored label', { exact: false })
  ).toBeVisible();
});

for (const locale of ['en', 'es'] as const) {
  const m = locale === 'en' ? en : es;
  const at = (path: string) => (locale === 'es' ? '/es' + path : path);

  test(`${locale}: reading a bill records it on the civic record, and its row deletes on its own`, async ({
    page,
  }) => {
    await visitAndWaitForReceipt(page, at(BILL));
    await page.goto(at('/record'));

    const reads = page.locator('section[aria-labelledby="reads"]');
    await expect(page.getByRole('heading', { name: m.impact.readsTitle })).toBeVisible();
    // The row links back to the bill it records.
    await expect(reads.locator(`a[href$="/bills/${BILL_SLUG}"]`)).toBeVisible();
    // Device-only, said out loud — bills.interestsNote's phrasing, for reads.
    await expect(reads.getByText(m.impact.readsNote)).toBeVisible();

    // Per-item delete: this row only, and it leaves the store behind it.
    await reads.getByRole('button', { name: m.impact.deleteRead }).click();
    await expect(page.getByRole('heading', { name: m.impact.readsTitle })).toHaveCount(0);
    expect(await readCount(page)).toBe(0);
  });

  test(`${locale}: erase-everything clears the reading history with the rest, and says so first`, async ({
    page,
  }) => {
    await visitAndWaitForReceipt(page, at(BILL));
    // A full profile: ZIP + a followed topic + a logged call + the read above.
    await page.evaluate(
      ({ slug, label }) => {
        localStorage.setItem('oravan.prefs', JSON.stringify({ zip: '78501', interests: ['health'] }));
        localStorage.setItem(
          'oravan.calls',
          JSON.stringify([
            {
              billSlug: slug,
              billLabel: label,
              repBioguide: 'D000399',
              repName: 'Monica De La Cruz',
              stance: 'support',
              outcome: 'contact',
              at: '2026-07-01T12:00:00.000Z',
            },
          ])
        );
      },
      { slug: BILL_SLUG, label: REF.citation }
    );
    await page.goto(at('/record'));

    // All three sections are present, in the spec's order.
    await expect(page.getByRole('heading', { name: m.impact.followTitle })).toBeVisible();
    await expect(page.getByRole('heading', { name: m.impact.readsTitle })).toBeVisible();
    await expect(page.getByRole('heading', { name: m.impact.historyTitle })).toBeVisible();

    // The confirm names what it is about to erase — reading history included.
    await page.getByRole('button', { name: m.impact.erase }).click();
    await expect(page.getByText(m.impact.eraseConfirm)).toBeVisible();
    await page.getByRole('button', { name: m.impact.confirmErase }).click();

    await expect(page.getByRole('status').filter({ hasText: m.impact.erased })).toBeVisible();
    // The keys themselves, not the rendering: every store this app writes.
    expect(
      await page.evaluate(() =>
        ['oravan.reads', 'oravan.calls', 'oravan.prefs'].map((k) => localStorage.getItem(k))
      )
    ).toEqual([null, null, null]);
  });
}
