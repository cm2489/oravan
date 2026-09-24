import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { chamberNextMeeting, chamberSession } from '../lib/docket';
import { briefToday, briefWindow, shiftDate } from '../lib/today';
import type { VotesFile } from '../lib/types';

/*
 * /today — the daily brief (plan item C3). Every expectation below is derived
 * from the same committed files the page reads, so the spec tracks the data
 * rather than pinning a day that will scroll out of the window.
 */

const VOTES = JSON.parse(readFileSync(join(process.cwd(), 'data/votes.json'), 'utf8')) as VotesFile;
const CHECKED = JSON.parse(
  readFileSync(join(process.cwd(), 'data/floor-signals-checked.json'), 'utf8'),
) as { in_session?: Record<string, string> };

const voteDates = new Set(VOTES.rollCalls.map((r) => r.date));
/** A dated brief shows its own day and the day before. */
const showsVotes = (date: string) => voteDates.has(date) || voteDates.has(shiftDate(date, -1));

const dates = briefWindow();
const withVotes = dates.find(showsVotes);
const withoutVotes = dates.find((d) => !showsVotes(d));

/** The page's own text with every `lang="en"` island (record quotes) removed. */
async function localizedText(page: Page): Promise<string> {
  return page.locator('main').evaluate((main) => {
    const clone = main.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[lang="en"]').forEach((n) => n.remove());
    return clone.textContent ?? '';
  });
}

test.describe('/today', () => {
  for (const [prefix, messages] of [
    ['', en],
    ['/es', es],
  ] as const) {
    test(`renders in ${prefix || '/en'} with its heading and the data stamps`, async ({ page }) => {
      const res = await page.goto(`${prefix}/today`);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(messages.today.title);
      await expect(page.locator('[data-stamps]')).toContainText(messages.today.stampsLead);
    });
  }

  test('the chamber line matches floor-signals-checked.json', async ({ page }) => {
    await page.goto('/today');
    for (const chamber of ['senate', 'house'] as const) {
      const session = chamberSession(chamber);
      // The page decays to `unknown` when the schedule file is more than 48h
      // old; otherwise it states the checked file's verdict.
      const expected = session === 'unknown' ? 'unknown' : CHECKED.in_session?.[chamber];
      await expect(page.locator(`li[data-chamber="${chamber}"]`)).toHaveAttribute('data-session', expected!);
    }
  });

  test("recess mode prints the Daily Digest's next-meeting line verbatim, in both languages", async ({ page }) => {
    const out = (['senate', 'house'] as const).filter(
      (c) => chamberSession(c) === 'out_of_session' && chamberNextMeeting(c)?.label,
    );
    test.skip(out.length === 0, 'neither chamber is out of session with a printed next meeting in the committed data');
    for (const prefix of ['', '/es']) {
      await page.goto(`${prefix}/today`);
      for (const c of out) {
        const line = page.locator(`li[data-chamber="${c}"]`);
        await expect(line.locator('[lang="en"]')).toHaveText(chamberNextMeeting(c)!.label!);
        // Never the word the record does not carry.
        await expect(line).not.toContainText(/recess|receso/i);
      }
    }
  });

  test('a vote block appears for a date with a roll call, and not for one without', async ({ page }) => {
    test.skip(!withVotes || !withoutVotes, 'the window holds no contrasting pair of dates');
    await page.goto(`/today/${withVotes}`);
    await expect(page.locator('[data-block="votes"]').first()).toBeVisible();
    // Every roll call links to its bill: the truth half, one click from a decoded answer.
    const billLinks = page.locator('[data-block="votes"] a[href*="/bills/"]');
    expect(await billLinks.count()).toBeGreaterThan(0);

    await page.goto(`/today/${withoutVotes}`);
    await expect(page.locator('[data-block="votes"]')).toHaveCount(0);
  });

  test('a roll-call bill link reaches the bill page', async ({ page }) => {
    test.skip(!withVotes, 'no roll call inside the window');
    await page.goto(`/today/${withVotes}`);
    const link = page.locator('[data-block="votes"] a[href*="/bills/"]').first();
    const href = await link.getAttribute('href');
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('dated permalinks exist for the last 14 days, and older dates 404', async ({ request }) => {
    expect(dates).toHaveLength(14);
    expect(dates[0]).toBe(briefToday());
    for (const date of dates) {
      expect((await request.get(`/today/${date}`)).status(), date).toBe(200);
      expect((await request.get(`/es/today/${date}`)).status(), `es ${date}`).toBe(200);
    }
    const older = shiftDate(dates[dates.length - 1], -1);
    expect((await request.get(`/today/${older}`)).status()).toBe(404);
    expect((await request.get(`/es/today/${older}`)).status()).toBe(404);
    expect((await request.get('/today/not-a-date')).status()).toBe(404);
    // One day past today is not a permalink either.
    expect((await request.get(`/today/${shiftDate(dates[0], 1)}`)).status()).toBe(404);
  });

  test('no English interface copy leaks into /es', async ({ page }) => {
    // Every English string of the brief's own namespace, cut at its
    // placeholders and tags into fragments long enough to be distinctive.
    const fragments = Object.values(en.today)
      .flatMap((s) => s.split(/\{[^}]*\}|<[^>]*>|\{|\}/))
      .map((s) => s.trim())
      .filter((s) => s.length >= 12);
    for (const path of ['/es/today', ...(withVotes ? [`/es/today/${withVotes}`] : [])]) {
      await page.goto(path);
      const text = await localizedText(page);
      for (const f of fragments) expect(text, `${path} carries English: "${f}"`).not.toContain(f);
    }
  });

  test('every link and control on the brief clears the 44px touch floor @reflow', async ({ page }) => {
    for (const path of ['/today', ...(withVotes ? [`/today/${withVotes}`] : [])]) {
      await page.goto(path);
      // Inline glossary terms inside a sentence are exempt (WCAG 2.5.8).
      const links = page.locator('main a:visible');
      const count = await links.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        const link = links.nth(i);
        const inChamberLine = await link.evaluate((el) => Boolean(el.closest('[data-chamber]')));
        if (inChamberLine) continue;
        const box = await link.boundingBox();
        expect(box?.height, `${path}: ${await link.textContent()}`).toBeGreaterThanOrEqual(44);
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    }
  });
});
