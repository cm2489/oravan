import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { amendedSince, billSponsor, decodeSource } from '../lib/bill-provenance';
import { billSlug, getAllBills, getLegislator } from '../lib/core';
import { chamberNextMeeting, chamberSession } from '../lib/docket';
import { briefToday, meetsAfterDay } from '../lib/today';
import { votesForBill, votingMember } from '../lib/votes';

/*
 * THE 2026-09-27 COPY-TRUTH SWEEP, rendered (SY-43, SY-44, SY-33, SY-25,
 * SY-31). The helpers are pinned in tests/copy-truth.unit.spec.ts; this spec
 * pins that the pages print what they return — by message key and data-*
 * hook, never by an English literal. Every bill below is chosen from the
 * committed corpus by the same helpers the page calls, so no slug is pinned
 * and a corpus that holds no example of a case skips with a reason.
 */

const lookups = { legislator: getLegislator, formerMember: votingMember };
const decoded = getAllBills().filter((b) => b.ai_summary || b.ai_sections);
const stamped = decoded.find((b) => decodeSource(b)?.date && billSponsor(b, lookups)?.hasPage);
const unstamped = decoded.find((b) => !decodeSource(b));
const amended = decoded.find((b) => amendedSince(decodeSource(b), votesForBill(billSlug(b))));
const notAmended = decoded.find(
  (b) => decodeSource(b)?.date && !amendedSince(decodeSource(b), votesForBill(billSlug(b))),
);

test.describe('SY-33 + SY-25 on the bill page', () => {
  for (const [prefix, locale] of [
    ['', 'en'],
    ['/es', 'es'],
  ] as const) {
    test(`${locale}: sponsor links to the member page; the decode names its text version`, async ({ page }) => {
      test.skip(!stamped, 'no decoded bill in the corpus carries both a dated version stamp and a sitting sponsor');
      const slug = billSlug(stamped!);
      const sponsor = billSponsor(stamped!, lookups)!;
      const source = decodeSource(stamped!)!;
      await page.goto(`${prefix}/bills/${slug}`);

      const line = page.locator(`main header [data-sponsor="${sponsor.bioguide}"]`);
      await expect(line).toBeVisible();
      await expect(line.getByRole('link', { name: sponsor.name })).toHaveAttribute(
        'href',
        `${prefix}/reps/${sponsor.bioguide}`,
      );

      const version = page.locator(`[data-decode-source="${source.date}"]`);
      await expect(version).toBeVisible();
      // The version name is the record's own label: English verbatim on /es too.
      await expect(version.locator('[lang="en"]')).toHaveText(source.version);
    });
  }

  test('an unstamped decode prints no version line', async ({ page }) => {
    test.skip(!unstamped, 'every decoded bill in the corpus carries a version stamp');
    await page.goto(`/bills/${billSlug(unstamped!)}`);
    await expect(page.getByRole('heading', { name: en.bill.decoded, exact: true })).toBeVisible();
    await expect(page.locator('[data-decode-source]')).toHaveCount(0);
  });

  test('an amendment agreed to after the decoded text is said once, and only there', async ({ page }) => {
    test.skip(!amended, 'no stored roll call records an amendment agreed to after a decoded text');
    const hit = amendedSince(decodeSource(amended!), votesForBill(billSlug(amended!)))!;
    await page.goto(`/bills/${billSlug(amended!)}`);
    await expect(page.locator(`[data-decode-amended="${hit.date}"]`)).toHaveCount(1);
    if (notAmended) {
      await page.goto(`/bills/${billSlug(notAmended)}`);
      await expect(page.locator('[data-decode-source]')).toHaveCount(1);
      await expect(page.locator('[data-decode-amended]')).toHaveCount(0);
    }
  });
});

test.describe('SY-31 /today', () => {
  test('a chamber whose next sitting is after the brief day gets the next-meeting line', async ({ page }) => {
    const day = briefToday();
    await page.goto('/today');
    for (const chamber of ['senate', 'house'] as const) {
      const session = chamberSession(chamber);
      const nextMeeting = chamberNextMeeting(chamber);
      const li = page.locator(`li[data-chamber="${chamber}"]`);
      if (meetsAfterDay({ session, nextMeeting }, day)) {
        await expect(li).toHaveAttribute('data-meets-later', 'true');
        if (nextMeeting?.label) await expect(li.locator('[lang="en"]')).toHaveText(nextMeeting.label);
      } else {
        await expect(li).toBeVisible();
        expect(await li.getAttribute('data-meets-later')).toBeNull();
      }
    }
  });
});

test.describe('SY-43 feedback notice', () => {
  test('the partnership notice is the rewritten key, not a contact ask', async ({ page }) => {
    await page.goto('/why-call');
    const trigger = page.getByRole('button', { name: en.feedback.trigger });
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await trigger.click();
    await expect(page.locator('#feedback-notice')).toHaveText(en.feedback.notice);
    await page.getByRole('radio', { name: en.feedback.categoryPartnership }).check();
    await expect(page.locator('#feedback-notice')).toHaveText(en.feedback.noticePartnership);
  });
});

test.describe('SY-44 the /reps empty state', () => {
  for (const [prefix, m] of [
    ['', en],
    ['/es', es],
  ] as const) {
    test(`${prefix || '/en'}: no-ZIP prompt and preview caption render from their keys`, async ({ page }) => {
      await page.goto(`${prefix}/reps`);
      await expect(page.getByText(m.reps.noZip, { exact: true })).toBeVisible();
      await expect(page.getByText(m.reps.previewNote, { exact: true })).toBeVisible();
    });
  }
});
