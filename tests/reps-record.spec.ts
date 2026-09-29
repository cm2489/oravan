import { expect, test, type Page } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { districtsForZip, repsForDistrict } from '../lib/core';
import { referenceBill } from './corpus-fixtures';
import { mockScriptApi, seedZip } from './helpers';

/*
 * THE REPS TAB AS DECIDED (wireframes v2, reps.html, 2026-09-29): it opens on
 * your members, with the ZIP they came from and Change ZIP (Q8 "a"), House
 * member first; then the bills worth a call (R06); then YOUR RECORD, folded in
 * (owner, UX question Q4 "b + c"): Your calls, then what you follow and what
 * you've read as folded rows, then Erase my data (RC01–RC04). The call
 * panel's "See your record" lands on Your calls.
 *
 * Everything here is found by message key, data-* hook or id; the members are
 * read from the same data the page reads.
 */

const ZIP = '78501'; // TX-15, one House member and two senators (reps.spec.ts's fixture)
const MEMBERS = districtsForZip(ZIP).flatMap(repsForDistrict);
const REF = referenceBill();

const CALL = {
  billSlug: REF.slug,
  billLabel: 'A call row on the Reps tab',
  repBioguide: 'D000594',
  repName: 'Monica De La Cruz',
  stance: 'support',
  outcome: 'voicemail',
  at: '2026-09-25T15:00:00.000Z',
};
const READ = { billSlug: REF.slug, billLabel: 'A read row on the Reps tab', at: '2026-09-24T15:00:00.000Z' };

/** Plant the stores before the app's first paint (tests/record.spec.ts's recipe). */
async function seed(page: Page, entries: Record<string, string>) {
  await page.addInitScript((e: Record<string, string>) => {
    for (const [k, v] of Object.entries(e)) localStorage.setItem(k, v);
  }, entries);
}

const FULL = {
  'oravan.prefs': JSON.stringify({ zip: ZIP, interests: ['health'] }),
  'oravan.calls': JSON.stringify([CALL]),
  'oravan.reads': JSON.stringify([READ]),
};

/** Document order of the elements matching each selector (first match each). */
const docOrder = (page: Page, selectors: string[]) =>
  page.locator('main').evaluate((main, sels) => {
    const all = [...main.querySelectorAll('*')];
    return sels.map((s) => {
      const el = main.querySelector(s);
      return el ? all.indexOf(el) : -1;
    });
  }, selectors);

for (const [prefix, m] of [
  ['', en],
  ['/es', es],
] as const) {
  const locale = prefix ? 'es' : 'en';
  const tImpact = createTranslator({ locale, messages: m, namespace: 'impact' });
  const tReps = createTranslator({ locale, messages: m, namespace: 'reps' });

  test.describe(`the Reps tab as decided ${prefix || '/'}`, () => {
    test('members (House first), then the bills worth a call, then Your calls, the folded rows, and Erase', async ({
      page,
    }) => {
      await seed(page, FULL);
      await page.goto(`${prefix}/reps`);
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps\\?zip=${ZIP}$`));
      await expect(page.getByRole('heading', { level: 1, name: m.reps.membersHeading })).toBeVisible();

      // The ZIP it came from, "kept on this device only" (it is: it was saved
      // here), and the way to change it.
      const line = page.locator('[data-zip-line]');
      await expect(line).toContainText(tReps('zipLine', { zip: ZIP }));
      await expect(line.locator('[data-zip-kept]')).toContainText(m.reps.zipKept);
      await expect(line.getByRole('link', { name: m.reps.changeZip })).toBeVisible();

      // House member first: no bill is in context on this tab.
      const roles = await page.locator('main article [data-rep-role]').evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-rep-role'))
      );
      expect(roles[0]).toBe('representative');
      expect(roles.slice(1)).toEqual(['senator', 'senator']);
      expect(MEMBERS[0].type).toBe('rep');

      // The wireframe's order, top to bottom.
      const order = await docOrder(page, [
        'main article',
        '[data-testid="reps-continuation"]',
        '#your-calls',
        '[data-record-follows]',
        '[data-record-reads]',
        '[data-record-erase]',
      ]);
      expect(order.every((i) => i >= 0), `every part renders: ${order}`).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);

      // Your calls: the counts and the row.
      const calls = page.locator('section#your-calls');
      await expect(calls.getByRole('heading', { name: m.impact.historyTitle })).toBeVisible();
      await expect(calls.getByText(CALL.billLabel)).toBeVisible();
      await expect(calls.getByText(tImpact('voicemails', { count: 1 }), { exact: true })).toBeVisible();

      // Topics and reading are FOLDED here, and open on a tap.
      const follows = page.locator('[data-record-follows] details');
      const reads = page.locator('[data-record-reads] details');
      await expect(follows).not.toHaveAttribute('open', '');
      await expect(reads).not.toHaveAttribute('open', '');
      await expect(page.getByText(READ.billLabel)).toBeHidden();
      await expect(follows.locator('summary')).toContainText(tImpact('followCount', { count: 1 }));
      await expect(reads.locator('summary')).toContainText(tImpact('readsCount', { count: 1 }));
      await reads.locator('summary').click();
      await expect(page.getByText(READ.billLabel)).toBeVisible();

      // Erase my data, two steps, from right here.
      const erase = page.locator('[data-record-erase]');
      await expect(erase.getByRole('heading', { name: m.impact.eraseTitle })).toBeVisible();
      await erase.getByRole('button', { name: m.impact.erase }).click();
      await expect(erase.getByText(m.impact.eraseConfirm)).toBeVisible();
      await erase.getByRole('button', { name: m.impact.confirmErase }).click();
      await expect(erase.getByRole('status')).toHaveText(m.impact.erased);
      expect(
        await page.evaluate(() => ['oravan.reads', 'oravan.calls', 'oravan.prefs'].map((k) => localStorage.getItem(k)))
      ).toEqual([null, null, null]);
    });

    test('a shared /reps?zip= link keeps nothing, so it never says "kept on this device"', async ({ page }) => {
      await page.goto(`${prefix}/reps?zip=${ZIP}`);
      await expect(page.locator('[data-zip-line]')).toBeVisible();
      // Your calls is here on every visit, empty or not, so its anchor lands.
      await expect(page.locator('section#your-calls [data-record-empty]')).toContainText(m.impact.emptyTitle);
      await expect(page.locator('[data-zip-kept]')).toHaveCount(0);
    });

    test('a ZIP that matches nothing still leaves a number: the Capitol switchboard', async ({ page }) => {
      await page.goto(`${prefix}/reps?zip=00000`);
      await expect(page.getByRole('alert').filter({ hasText: m.reps.zipNotFound })).toBeVisible();
      const board = page.locator('[data-switchboard] a[href="tel:+12022243121"]');
      await expect(board).toBeVisible();
      await expect(board).toContainText(m.bill.switchboard);
      // The record still renders below: it is read from this browser.
      await expect(page.locator('section#your-calls')).toBeVisible();
    });
  });
}

/*
 * "SEE YOUR RECORD" LANDS ON YOUR CALLS (Q4 "c"). A call logged in the bill
 * page's panel, then its link: the Reps tab, the saved ZIP applied, and the
 * page at Your calls with the call just logged on it.
 */
test('the call panel\'s "See your record" lands on Your calls on the Reps tab', async ({ page }) => {
  await mockScriptApi(page);
  await page.goto(`/bills/${REF.slug}`);
  await seedZip(page, ZIP);
  await page.reload();
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(page.getByText(MEMBERS[0].name).first()).toBeVisible();
  await page.getByRole('button', { name: en.bill.outcome.contact }).first().click();
  await expect(page.getByText(en.bill.loggedFirst)).toBeVisible();

  await page.getByRole('link', { name: en.bill.viewImpact }).click();
  await expect(page).toHaveURL(new RegExp(`/reps\\?zip=${ZIP}#your-calls$`));
  const calls = page.locator('section#your-calls');
  await expect(calls).toBeInViewport();
  // The one call just logged, whichever member the panel listed first.
  await expect(calls.locator('li')).toHaveCount(1);
});

/* The same record, standalone: /record keeps answering old links, with the
   folded rows open because nothing sits above them there. */
test('/record renders the same record, rows open', async ({ page }) => {
  await seed(page, FULL);
  await page.goto('/record');
  await expect(page.getByRole('heading', { level: 1, name: en.impact.title })).toBeVisible();
  await expect(page.locator('[data-record-follows] details')).toHaveAttribute('open', '');
  await expect(page.locator('[data-record-reads] details')).toHaveAttribute('open', '');
  await expect(page.getByText(READ.billLabel)).toBeVisible();
  await expect(page.locator('section#your-calls').getByText(CALL.billLabel)).toBeVisible();
});
