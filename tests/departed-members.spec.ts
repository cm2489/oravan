import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import legislatorsJson from '../data/legislators.json';
import zipDistricts from '../data/zip-districts.json';
import bills from '../data/bills.json';
import { NEW_MEMBER_LINE_KEY, REVIEW_ENV, newCongressReview } from '../lib/departed-members';
import { CONGRESS } from '../lib/congress.mjs';
import { allRollCalls } from '../lib/votes';
import { billSlug } from '../lib/core';
import type { Bill, Legislator } from '../lib/types';

/*
 * Members after a new Congress begins (stage 5, lib/departed-members.ts),
 * through the built site.
 *
 * TODAY (every build, CI included): nothing has switched. A member who left
 * mid-Congress still has no page, a member with no stored vote keeps
 * today's line, and no page carries either new line.
 *
 * REVIEW (a local build made with ORAVAN_REVIEW_NEW_CONGRESS, which refuses
 * to run under CI or a deploy): the members it names as departed have record
 * pages with no way to call, are absent from the ZIP lookup, and roll-call
 * lists and sponsor lines link to them; the members it names as new show the
 * approved line. These tests skip in any other build.
 */

const ROSTER = legislatorsJson as Legislator[];
const ZIPS = zipDistricts as Record<string, { state: string; district: number }[]>;
const review = newCongressReview(process.env, CONGRESS);
// components/RepCard.tsx repRoleKey, restated so this file imports no component.
const DELEGATE_STATES = new Set(['DC', 'PR', 'GU', 'VI', 'AS', 'MP']);
const roleKey = (m: Legislator) =>
  m.type === 'sen' ? 'senator' : DELEGATE_STATES.has(m.state) ? 'delegate' : 'representative';

test.describe('today: nothing has switched', () => {
  test.skip(review !== null, 'review build');

  test('a member who left mid-Congress still has no page', async ({ request }) => {
    expect((await request.get('/reps/C001078')).status()).toBe(404);
  });

  test("a member with no stored vote keeps today's line, and no page shows a new one", async ({ page }) => {
    for (const id of ['N000147', 'D000594', 'C000127']) {
      await page.goto(`/reps/${id}`);
      await expect(page.locator('[data-departed-served]')).toHaveCount(0);
      await expect(page.locator('[data-member-votes-none-yet]')).toHaveCount(0);
    }
    await page.goto('/reps/N000147'); // a delegate: no stored floor vote
    await expect(page.locator('[data-member-votes-none]')).toHaveCount(1);
  });
});

test.describe('review: the day after the switch', () => {
  test.skip(review === null, `needs a local build made with ${REVIEW_ENV}`);
  const departed = review ? [...review.departed] : [];
  const newMembers = review ? [...review.newMembers] : [];
  const member = (id: string) => ROSTER.find((l) => l.bioguide === id)!;

  for (const [prefix, messages] of [['', en], ['/es', es]] as const) {
    test(`a departed member's page is a record with no way to call (${prefix || '/'})`, async ({ page }) => {
      for (const id of departed) {
        const m = member(id);
        const res = await page.goto(`${prefix}/reps/${id}`);
        expect(res?.status()).toBe(200);
        await expect(page.locator('h1')).toHaveText(m.name);
        const former = messages.rep.formerRole[roleKey(m)];
        await expect(page).toHaveTitle(new RegExp(`^${m.name}, ${former} · `));
        await expect(page.getByText(former, { exact: true })).toHaveCount(1);
        await expect(page.getByRole('link', { name: messages.rep.crumbRecord })).toHaveAttribute('href', `${prefix}/reps`);
        await expect(page.getByRole('link', { name: messages.rep.crumb, exact: true })).toHaveCount(0);
        const chamber = messages.rep.departedChamber[m.type === 'sen' ? 'senate' : 'house'];
        await expect(page.locator('[data-departed-served]')).toHaveText(
          messages.rep.departedServed.replace('{chamber}', chamber),
        );
        await expect(page.locator('[data-member-votes]')).toHaveCount(1);
        await expect(page.locator('#rep-contact')).toHaveCount(0);
        await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
        await expect(page.getByText(messages.rep.contactHeading)).toHaveCount(0);
        const html = await page.content();
        for (const phone of [m.phone, ...m.offices.map((o) => o.phone)].filter(Boolean)) {
          expect(html, `${id} page carries ${phone}`).not.toContain(String(phone));
        }
        if (m.url) expect(html).not.toContain(m.url);
      }
    });

    test(`a new member's page shows the approved line (${prefix || '/'})`, async ({ page }) => {
      for (const id of newMembers) {
        await page.goto(`${prefix}/reps/${id}`);
        await expect(page.locator('[data-member-votes-none-yet]')).toHaveText(messages.rep[NEW_MEMBER_LINE_KEY]);
        await expect(page.locator('[data-member-vote-bill], [data-member-votes-none]')).toHaveCount(0);
        // Still a sitting member: the call column stays.
        await expect(page.locator('#rep-contact')).toHaveCount(1);
      }
    });
  }

  test('a departed member is absent from the ZIP lookup', async ({ request }) => {
    for (const id of departed) {
      const m = member(id);
      const zip = Object.keys(ZIPS).find((z) =>
        ZIPS[z].length === 1 && ZIPS[z][0].state === m.state && (m.type === 'sen' || ZIPS[z][0].district === m.district),
      )!;
      const res = await request.post('/api/reps', { data: { zip } });
      expect(res.status()).toBe(200);
      expect(await res.text(), `ZIP ${zip}`).not.toContain(id);
    }
  });

  test('roll-call lists and sponsor lines link to a departed member, and the link resolves', async ({ request }) => {
    for (const id of departed) {
      const roll = allRollCalls().find((r) => Object.values(r.votes).some((ids) => ids.includes(id)))!;
      const list = await (await request.get(`/votes/${roll.id}.json`)).text();
      expect(list).toContain(`"${id}"`);
      expect((await request.get(`/reps/${id}`)).status()).toBe(200);
      const sponsored = (bills as unknown as Bill[]).find((b) => b.sponsor_bioguide_id === id);
      if (!sponsored) continue;
      const slug = billSlug(sponsored);
      const html = await (await request.get(`/bills/${slug}`)).text();
      expect(html, slug).toMatch(new RegExp(`data-sponsor="${id}"[^]*?href="/reps/${id}"`));
    }
  });
});
