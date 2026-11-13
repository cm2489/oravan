import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import legislatorsJson from '../data/legislators.json';
import departedJson from '../data/departed-members.json';
import zipDistricts from '../data/zip-districts.json';
import bills from '../data/bills.json';
import {
  NEW_MEMBER_LINE_KEY,
  REVIEW_ENV,
  departedWithPage,
  memberTurnover,
  newCongressReview,
  servedLine,
} from '../lib/departed-members';
import { CONGRESS, CONGRESS_POLICY } from '../lib/congress.mjs';
import { allRollCalls } from '../lib/votes';
import { billSlug, portraitKnownMissing } from '../lib/core';
import type { Bill, DepartedMember, Legislator } from '../lib/types';

/*
 * Members who left, through the built site (lib/departed-members.ts).
 *
 * EVERY BUILD, CI included: the 16 members who left the 119th Congress
 * mid-term (data/departed-members.json, owner's ruling of 2026-11-13) have
 * record pages with their own last day and no way to call, are absent from
 * the ZIP lookup, and roll-call lists and sponsor lines link to them. Before
 * the switch, no page carries the new-member line.
 *
 * REVIEW (a local build made with ORAVAN_REVIEW_NEW_CONGRESS, which refuses
 * to run under CI or a deploy): the members it names as departed get the
 * switch-day record page; the members it names as new show the new-member
 * line. These tests skip in any other build.
 */

const ROSTER = legislatorsJson as Legislator[];
const DEPARTED = departedJson as DepartedMember[];
// The records the rule gives a page (lib/departed-members.ts), whatever the
// file holds: never a count of today's data (3rd review).
const PAGED = departedWithPage(DEPARTED, new Set(ROSTER.map((l) => l.bioguide)), CONGRESS_POLICY);
const UNPAGED = DEPARTED.filter((d) => !PAGED.some((p) => p.bioguide === d.bioguide));
const ZIPS = zipDistricts as Record<string, { state: string; district: number }[]>;
const review = newCongressReview(process.env, CONGRESS);
// components/RepCard.tsx repRoleKey, restated so this file imports no component.
const DELEGATE_STATES = new Set(['DC', 'PR', 'GU', 'VI', 'AS', 'MP']);
const roleKey = (m: Pick<Legislator, 'type' | 'state'>) =>
  m.type === 'sen' ? 'senator' : DELEGATE_STATES.has(m.state) ? 'delegate' : 'representative';
type Messages = typeof en;

/** What one record page must show, whoever it is for. */
interface Rec {
  bioguide: string;
  name: string;
  type: 'sen' | 'rep';
  state: string;
  district: number | null;
  /** Numbers and site the page must never carry. */
  phones: string[];
  url: string | null;
  served: (messages: Messages, lang: 'en' | 'es') => string;
}

const chamberOf = (r: Pick<Rec, 'type'>, messages: Messages) =>
  messages.rep.departedChamber[r.type === 'sen' ? 'senate' : 'house'];

/** A record from data/departed-members.json: the dated line, the day as the
 *  page prints it (long month, UTC). */
const fromData = (d: DepartedMember): Rec => ({
  ...d,
  phones: [],
  url: null,
  served: (messages, lang) =>
    servedLine(d, memberTurnover(CONGRESS_POLICY)).key === 'departedServed'
      ? messages.rep.departedServed.replace('{chamber}', chamberOf(d, messages))
      : messages.rep.departedServedOn.replace('{chamber}', chamberOf(d, messages)).replace(
          '{date}',
          new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(
            new Date(`${d.served_until}T00:00:00Z`),
          ),
        ),
});

/** A sitting member the review build treats as departed: the switch-day line. */
const fromReview = (m: Legislator): Rec => ({
  ...m,
  phones: [m.phone, ...m.offices.map((o) => o.phone)].filter((p): p is string => Boolean(p)),
  served: (messages) => messages.rep.departedServed.replace('{chamber}', chamberOf(m, messages)),
});

async function checkRecordPage(page: Page, prefix: string, messages: Messages, lang: 'en' | 'es', r: Rec) {
  const res = await page.goto(`${prefix}/reps/${r.bioguide}`);
  expect(res?.status(), r.bioguide).toBe(200);
  await expect(page.locator('h1')).toHaveText(r.name);
  const former = messages.rep.formerRole[roleKey(r)];
  await expect(page).toHaveTitle(new RegExp(`^${r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, ${former} · `));
  // The role line's first chunk ("Former Representative ·").
  await expect(page.locator('header p > span').first()).toHaveText(new RegExp(`^${former}\\s*·`));
  await expect(page.getByRole('link', { name: messages.rep.crumbRecord })).toHaveAttribute('href', `${prefix}/reps`);
  await expect(page.getByRole('link', { name: messages.rep.crumb, exact: true })).toHaveCount(0);
  await expect(page.locator('[data-departed-served]')).toHaveText(r.served(messages, lang));
  await expect(page.locator('[data-member-votes]')).toHaveCount(1);
  await expect(page.locator('#rep-contact')).toHaveCount(0);
  await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
  await expect(page.getByText(messages.rep.contactHeading)).toHaveCount(0);
  const html = await page.content();
  for (const phone of r.phones) expect(html, `${r.bioguide} page carries ${phone}`).not.toContain(phone);
  if (r.url) expect(html).not.toContain(r.url);
  // Nothing runs past the edge (hard rule 7), the long Spanish role included.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const roleLineEnds = await page
    .locator('header p > span')
    .evaluateAll((spans) => spans.slice(0, 3).map((el) => el.getBoundingClientRect().right));
  const width = page.viewportSize()!.width;
  for (const right of roleLineEnds) expect(right).toBeLessThanOrEqual(width);
  // The portrait loads, or, when the source has no photo (data/portrait-
  // missing.json), the initials stand alone: never an image that fails.
  const frame = page.locator('header').filter({ has: page.locator('h1') }).locator('span.relative').first();
  if (portraitKnownMissing(r.bioguide)) {
    await expect(frame.locator('img')).toHaveCount(0);
    await expect(frame).toContainText(/^[A-Z]{1,2}$/);
  } else {
    const img = frame.locator('img');
    await expect(img).toHaveCount(1);
    await img.scrollIntoViewIfNeeded();
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 15_000 })
      .toBe(true);
  }
}

async function checkAbsentFromLookup(request: APIRequestContext, r: Rec) {
  const zip = Object.keys(ZIPS).find(
    (z) => ZIPS[z].length === 1 && ZIPS[z][0].state === r.state && (r.type === 'sen' || ZIPS[z][0].district === r.district),
  );
  expect(zip, `a ZIP inside ${r.state}-${r.district}`).toBeTruthy();
  const res = await request.post('/api/reps', { data: { zip } });
  expect(res.status()).toBe(200);
  expect(await res.text(), `ZIP ${zip}`).not.toContain(r.bioguide);
}

async function checkLinksResolve(request: APIRequestContext, id: string) {
  const roll = allRollCalls().find((r) => Object.values(r.votes).some((ids) => ids.includes(id)));
  if (!roll) {
    // A delegate, or a member sworn in after the last stored roll call, is
    // on no roll-call list, so nothing here links to them. Their sponsor
    // line is not checked either: lib/bill-provenance.ts names a former
    // member only from the vote roster, so a departed member on no roll
    // call is not named in a sponsor line at all (a known gap). Their page
    // is still checked.
    expect((await request.get(`/reps/${id}`)).status()).toBe(200);
    test.info().annotations.push({
      type: 'skipped',
      description: `${id} is on no stored roll call: no roll-call list or sponsor line links to them, so only their page is checked`,
    });
    return;
  }
  const list = await (await request.get(`/votes/${roll.id}.json`)).text();
  expect(list).toContain(`"${id}"`);
  expect((await request.get(`/reps/${id}`)).status()).toBe(200);
  const sponsored = (bills as unknown as Bill[]).find((b) => b.sponsor_bioguide_id === id);
  if (!sponsored) return;
  const slug = billSlug(sponsored);
  const html = await (await request.get(`/bills/${slug}`)).text();
  expect(html, slug).toMatch(new RegExp(`data-sponsor="${id}"[^]*?href="/reps/${id}"`));
}

test.describe('members who left this Congress (every build)', () => {
  for (const [prefix, messages, lang] of [['', en, 'en'], ['/es', es, 'es']] as const) {
    test(`each record with a page shows their own last day and no way to call (${prefix || '/'}) @reflow`, async ({ page }) => {
      for (const d of PAGED) await checkRecordPage(page, prefix, messages, lang, fromData(d));
    });
  }

  test('a record without a page (no official day yet) is "not found", outside the sitemap, with no sponsor link', async ({ request }) => {
    const sitemap = await (await request.get('/sitemap.xml')).text();
    for (const d of UNPAGED) {
      for (const prefix of ['', '/es']) {
        expect((await request.get(`${prefix}/reps/${d.bioguide}`)).status(), `${prefix}/reps/${d.bioguide}`).toBe(404);
      }
      expect(sitemap).not.toContain(`/reps/${d.bioguide}<`);
      const sponsored = (bills as unknown as Bill[]).find((b) => b.sponsor_bioguide_id === d.bioguide);
      if (sponsored) {
        const html = await (await request.get(`/bills/${billSlug(sponsored)}`)).text();
        expect(html).not.toContain(`href="/reps/${d.bioguide}"`);
      }
    }
  });

  test('none is in the ZIP lookup for the seat they held', async ({ request }) => {
    for (const d of DEPARTED) await checkAbsentFromLookup(request, fromData(d));
  });

  test('roll-call lists and sponsor lines link to those with a page, and the links resolve', async ({ request }) => {
    for (const d of PAGED) await checkLinksResolve(request, d.bioguide);
  });
});

test.describe('today: the switch has not happened', () => {
  test.skip(review !== null, 'review build');

  test("a member with no stored vote keeps today's line, and no page shows the new-member line", async ({ page }) => {
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

  for (const [prefix, messages, lang] of [['', en, 'en'], ['/es', es, 'es']] as const) {
    test(`a departed member's page is a record with no way to call (${prefix || '/'}) @reflow`, async ({ page }) => {
      for (const id of departed) await checkRecordPage(page, prefix, messages, lang, fromReview(member(id)));
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
    for (const id of departed) await checkAbsentFromLookup(request, fromReview(member(id)));
  });

  test('roll-call lists and sponsor lines link to a departed member, and the link resolves', async ({ request }) => {
    for (const id of departed) await checkLinksResolve(request, id);
  });
});
