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

    test('the call counts keep every label inside its box @reflow', async ({ page }) => {
      // Plural counts: "Conversations" / "Conversaciones" are the longest
      // single words the three boxes hold, and at 320px they used to run
      // past the box's border, under the next box (found verifying #387).
      const call = (outcome: string, day: number) => ({ ...CALL, outcome, at: `2026-09-2${day}T15:00:00.000Z` });
      await seed(page, {
        'oravan.prefs': JSON.stringify({ zip: ZIP }),
        'oravan.calls': JSON.stringify([call('contact', 1), call('contact', 2), call('voicemail', 3), call('voicemail', 4)]),
      });
      await page.goto(`${prefix}/reps?zip=${ZIP}`);
      const stats = page.locator('#your-calls [data-record-stat]');
      await expect(stats).toHaveCount(3);
      await expect(stats.nth(1).locator('dt')).toHaveText(tImpact('contacts', { count: 2 }));
      const escapes = await stats.evaluateAll((boxes) =>
        boxes.flatMap((box) => {
          const b = box.getBoundingClientRect();
          const cs = getComputedStyle(box);
          const left = b.left + parseFloat(cs.borderLeftWidth);
          const right = b.right - parseFloat(cs.borderRightWidth);
          const range = document.createRange();
          range.selectNodeContents(box.querySelector('dt')!);
          return [...range.getClientRects()]
            .filter((r) => r.left < left - 0.5 || r.right > right + 0.5)
            .map(() => box.querySelector('dt')!.textContent);
        })
      );
      expect(escapes, 'a call-count label runs past its box').toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(0);
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

/*
 * THE ZIP FIELD'S FOCUS NEVER TAKES THE PAGE AWAY FROM YOUR CALLS. With no
 * saved ZIP, bare /reps keeps its ZIP prompt, and the prompt focuses its field
 * on arrival. WebKit scrolls a focused field into view at its next rendering
 * update, after the router has already scrolled to #your-calls, so the page
 * used to land on the field at the top instead of on Your calls. With a saved
 * ZIP the same deferred scroll raced the swap to /reps?zip=, which is what
 * made the test above fail now and then (components/ZipForm.tsx). Here the
 * race is gone: the saved ZIP is cleared before the link is followed, so the
 * prompt stays and its focus lands every time.
 */
test('"See your record" lands on Your calls while the ZIP prompt takes focus', async ({ page }) => {
  await mockScriptApi(page);
  await page.goto(`/bills/${REF.slug}`);
  await seedZip(page, ZIP);
  await page.reload();
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(page.getByText(MEMBERS[0].name).first()).toBeVisible();
  await page.getByRole('button', { name: en.bill.outcome.contact }).first().click();
  await expect(page.getByText(en.bill.loggedFirst)).toBeVisible();

  // The call stays on record; only the saved ZIP goes, so /reps keeps its prompt.
  await page.evaluate(() => localStorage.removeItem('oravan.prefs'));
  await page.getByRole('link', { name: en.bill.viewImpact }).click();
  await expect(page).toHaveURL(/\/reps#your-calls$/);
  const field = page.locator('[data-zip-field]');
  await expect(field).toBeFocused();
  const calls = page.locator('section#your-calls');
  await expect(calls.locator('li')).toHaveCount(1);
  // Two rendering updates later, so a deferred scroll to the field has had
  // its chance to run.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  );
  await expect(calls).toBeInViewport();
  await expect(field).toBeFocused();
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
