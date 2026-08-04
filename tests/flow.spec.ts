import { expect, test, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { mockScriptApi, seedZip } from './helpers';

const BILL = '/bills/sjres-99-119';
const BILL_SLUG = 'sjres-99-119';

test('full flow: stance, script, outcome, impact, delete', async ({ page }) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await seedZip(page, '78501');
  await page.reload();

  // Stance -> mocked script appears, editable
  await page.getByRole('radio', { name: 'I support it' }).click();
  const textarea = page.getByRole('textbox', { name: 'Your script' });
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveValue(/MOCKED SCRIPT BODY/);
  await textarea.fill('My edited script.');

  // Switching stance does not destroy the edit
  await page.getByRole('radio', { name: 'I oppose it' }).click();
  await expect(textarea).toHaveValue(/MOCKED SCRIPT BODY/);
  await page.getByRole('radio', { name: 'I support it' }).click();
  await expect(textarea).toHaveValue('My edited script.');

  // Call section: reps render with tel links
  await expect(page.getByText('Monica De La Cruz')).toBeVisible();
  expect(await page.locator('a[href^="tel:"]').count()).toBeGreaterThan(0);

  // Outcome: selected state + upsert (change, not duplicate)
  await page.getByRole('button', { name: 'Left a voicemail' }).first().click();
  await expect(
    page.getByRole('button', { name: 'Left a voicemail' }).first()
  ).toHaveAttribute('aria-pressed', 'true');
  // First-call milestone fires inline, adjacent to the tapped chip
  await expect(page.getByText(/your first call/i)).toBeVisible();

  await page.getByRole('button', { name: 'Spoke to someone' }).first().click();
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
    page.locator('section[aria-labelledby="history"]').getByText('S.J.Res. 99', { exact: false })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Delete this record' }).click();
  await expect(page.getByText('No calls logged yet')).toBeVisible();
});

test('call mode shows nudge, script, and dial buttons; Escape closes', async ({ page }) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await seedZip(page, '78501');
  await page.reload();
  await page.getByRole('radio', { name: 'I support it' }).click();
  await page.getByRole('button', { name: 'Start the call' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Fresh profile: the first-call after-hours nudge shows
  await expect(dialog.getByText('Your first call?')).toBeVisible();
  await expect(dialog.getByText(/MOCKED SCRIPT BODY/)).toBeVisible();
  expect(await dialog.locator('a[href^="tel:"]').count()).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('script failure shows a retry that recovers', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/script', (route) => {
    calls++;
    if (calls === 1) return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"generation_failed"}' });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ script: 'RECOVERED SCRIPT', cached: false }) });
  });
  await page.goto(BILL);
  await page.getByRole('radio', { name: "I'm concerned" }).click();
  // Next.js's route announcer is also role=alert - filter to ours
  await expect(page.getByRole('alert').filter({ hasText: /try again/i })).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('textbox', { name: 'Your script' })).toHaveValue('RECOVERED SCRIPT');
});

test('spanish bill page serves translated decoded content', async ({ page }) => {
  await page.goto('/es' + BILL);
  await expect(page.getByRole('heading', { name: 'En claro' })).toBeVisible();
  await expect(page.locator('main')).toContainText(/El Congreso|El Senado|La Cámara|regla/i);
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
 * The ES headline literal is the same fixture tests/embed-bill-card.spec.ts
 * pins for this slug — a corpus refresh that breaks one breaks both.
 */
test('a bill read in ENGLISH prints its SPANISH headline on /es/record', async ({ page }) => {
  await visitAndWaitForReceipt(page, BILL); // the EN page
  await page.goto('/es' + '/record');
  const reads = page.locator('section[aria-labelledby="reads"]');
  await expect(reads.locator(`a[href$="/bills/${BILL_SLUG}"]`)).toContainText(
    'El Senado busca restablecer'
  );
  // And back on the EN record, the same row prints English.
  await page.goto('/record');
  await expect(
    page
      .locator('section[aria-labelledby="reads"]')
      .locator(`a[href$="/bills/${BILL_SLUG}"]`)
  ).not.toContainText('El Senado');
});

test('legacy rows without bilingual labels still print their stored label on /es/record', async ({
  page,
}) => {
  await page.goto('/es/record');
  await page.evaluate(() => {
    localStorage.setItem(
      'oravan.calls',
      JSON.stringify([
        {
          billSlug: 'sjres-99-119',
          billLabel: 'S.J.Res. 99 · legacy stored label',
          repBioguide: 'D000399',
          repName: 'Monica De La Cruz',
          stance: 'support',
          outcome: 'contact',
          at: '2026-07-01T12:00:00.000Z',
        },
      ])
    );
  });
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
    await page.evaluate(() => {
      localStorage.setItem('oravan.prefs', JSON.stringify({ zip: '78501', interests: ['health'] }));
      localStorage.setItem(
        'oravan.calls',
        JSON.stringify([
          {
            billSlug: 'sjres-99-119',
            billLabel: 'S.J.Res. 99',
            repBioguide: 'D000399',
            repName: 'Monica De La Cruz',
            stance: 'support',
            outcome: 'contact',
            at: '2026-07-01T12:00:00.000Z',
          },
        ])
      );
    });
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
