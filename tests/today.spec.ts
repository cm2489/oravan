import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { chamberNextMeeting, chamberSession } from '../lib/docket';
import { rollCallPage } from '../lib/roll-call-page';
import { briefDays, briefToday, briefWindow, buildBrief, dayCountParts, shiftDate } from '../lib/today';
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

/** A brief whose two days are both empty: the quiet state (funnel I3). */
const isQuiet = (date: string) => {
  const b = buildBrief(date);
  return b.questions.length === 0 && b.days.every((d) => d.rollCalls.length === 0 && d.moved.length === 0);
};
const quiet = dates.find(isQuiet);
/** A past dated brief with something on it (the newest date is /today itself). */
const busyPast = dates.slice(1).find((d) => !isQuiet(d));

/** A row's count words, exactly as the page composes them. */
function rowCounts(locale: 'en' | 'es', date: string): string {
  const t = createTranslator({ locale, messages: locale === 'en' ? en : es, namespace: 'today' });
  const summary = briefDays().find((x) => x.date === date)!;
  const parts = dayCountParts(summary);
  return parts.length > 0 ? parts.map((p) => t(p.key, { count: p.count })).join(' · ') : t('dayNoRecord');
}

/** True when `a` comes before `b` in the document. */
async function precedes(page: Page, a: string, b: string): Promise<boolean> {
  return page.evaluate(
    ([sa, sb]) => {
      const x = document.querySelector(sa);
      const y = document.querySelector(sb);
      return Boolean(x && y && x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
    },
    [a, b] as const,
  );
}

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

  test('a roll call\'s record link opens the chamber\'s readable page, not the data file', async ({ page }) => {
    // Prefer a day whose brief shows both chambers' roll calls.
    const shown = (d: string) => VOTES.rollCalls.filter((r) => r.date === d || r.date === shiftDate(d, -1));
    const date =
      dates.find((d) => new Set(shown(d).map((r) => r.chamber)).size === 2) ?? withVotes;
    test.skip(!date, 'no roll call inside the window');
    const readable = new Map(shown(date!).map((r) => [rollCallPage(r.source), r]));
    await page.goto(`/today/${date}`);
    const links = page.locator('[data-block="votes"] a[target="_blank"]');
    expect(await links.count()).toBeGreaterThan(0);
    const hrefs = await links.evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
    for (const href of hrefs) {
      const r = readable.get(href);
      expect(r, `${href} is a stored roll call's readable page`).toBeTruthy();
      expect(href).toMatch(
        r!.chamber === 'house'
          ? /^https:\/\/clerk\.house\.gov\/Votes\/\d{4}[1-9]\d*$/
          : /^https:\/\/www\.senate\.gov\/legislative\/LIS\/roll_call_votes\/vote\d{4}\/vote_\d{3}_\d_\d{5}\.htm$/
      );
    }
    await expect(page.locator('main a[href$=".xml"][href*="roll"]')).toHaveCount(0);
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
    for (const path of [
      '/es/today',
      ...(withVotes ? [`/es/today/${withVotes}`] : []),
      ...(quiet ? [`/es/today/${quiet}`] : []),
    ]) {
      await page.goto(path);
      const text = await localizedText(page);
      for (const f of fragments) expect(text, `${path} carries English: "${f}"`).not.toContain(f);
    }
  });

  test('every link and control on the brief clears the 44px touch floor @reflow', async ({ page }) => {
    for (const path of ['/today', ...(withVotes ? [`/today/${withVotes}`] : []), ...(quiet ? [`/today/${quiet}`] : [])]) {
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
  // ── The decided structure (wireframes v2, today.html, 2026-09-29) ──────────

  test('the same-day facts come first: chambers, then the floor schedule, then the record', async ({ page }) => {
    await page.goto('/today');
    const record = (await page.locator('[data-day]').count()) > 0 ? '[data-day]' : '[data-record-empty]';
    expect(await precedes(page, '[aria-labelledby="today-chambers"]', record)).toBe(true);
    if ((await page.locator('[data-block="schedule"]').count()) > 0) {
      expect(await precedes(page, '[aria-labelledby="today-chambers"]', '[data-block="schedule"]')).toBe(true);
      expect(await precedes(page, '[data-block="schedule"]', record)).toBe(true);
    }
    // The per-source stamp line stays, after the record.
    expect(await precedes(page, record, '[data-stamps]')).toBe(true);
  });

  for (const [prefix, locale] of [
    ['', 'en'],
    ['/es', 'es'],
  ] as const) {
    test(`${prefix || '/en'}: "Other days" lists every permalink with its own counts`, async ({ page }) => {
      // Today, a past day with record, and a quiet past day: the list is the
      // same window on each, with only the current row moving.
      for (const date of [...new Set([dates[0], busyPast, quiet].filter((d): d is string => Boolean(d)))]) {
        await page.goto(date === dates[0] ? `${prefix}/today` : `${prefix}/today/${date}`);
        const nav = page.locator('nav[data-days]');
        await expect(nav.getByRole('heading', { level: 2 })).toHaveText(
          (locale === 'en' ? en : es).today.navLabel,
        );
        const rows = nav.locator('a[data-day-row]');
        await expect(rows).toHaveCount(dates.length);
        for (const [i, d] of dates.entries()) {
          const row = rows.nth(i);
          await expect(row).toHaveAttribute('data-day-row', d);
          // The newest date is the brief itself, so its row goes to /today.
          const href = await row.getAttribute('href');
          expect(href, d).toMatch(i === 0 ? /\/today$/ : new RegExp(`/today/${d}$`));
          await expect(row).toContainText(rowCounts(locale, d));
          if (d === date) await expect(row).toHaveAttribute('aria-current', 'page');
          else expect(await row.getAttribute('aria-current'), d).toBeNull();
        }
      }
    });
  }

  test('a quiet brief says so in a status line and links to the latest day with record', async ({ page }) => {
    test.skip(!quiet, 'every date in the window has something on the record');
    const brief = buildBrief(quiet!);
    for (const [prefix, messages] of [
      ['', en],
      ['/es', es],
    ] as const) {
      await page.goto(`${prefix}/today/${quiet}`);
      const empty = page.locator('[data-record-empty]');
      await expect(empty.getByRole('heading', { level: 2 })).toHaveText(messages.today.recordHeading);
      await expect(empty.getByRole('status')).toBeVisible();
      await expect(page.locator('[data-day]')).toHaveCount(0);
      const way = empty.locator('a[data-latest-record]');
      if (brief.latestRecord === null) {
        await expect(way).toHaveCount(0);
        continue;
      }
      await expect(way).toHaveAttribute('data-latest-record', brief.latestRecord);
      await way.click();
      await expect(page).toHaveURL(
        brief.latestRecord === dates[0] ? new RegExp(`${prefix}/today$`) : new RegExp(`/today/${brief.latestRecord}$`),
      );
      // It lands on a day with something to read, not another quiet line.
      await expect(page.locator('[data-record-empty]')).toHaveCount(0);
      await expect(page.locator('[data-day]').first()).toBeVisible();
    }
  });

  test('the day list is a rail beside the brief on a wide screen, and follows it on a phone', async ({ page }) => {
    await page.goto('/today');
    const h1 = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
    const nav = (await page.locator('nav[data-days]').boundingBox())!;
    const width = page.viewportSize()!.width;
    if (width >= 992) {
      // 62rem, the bill page's desk breakpoint: the rail sits to the right,
      // level with the title.
      expect(nav.x).toBeGreaterThan(h1.x + 300);
      expect(Math.abs(nav.y - h1.y)).toBeLessThan(40);
    } else {
      const lastSection = (await page.locator('main section').last().boundingBox())!;
      expect(nav.y).toBeGreaterThanOrEqual(lastSection.y + lastSection.height);
    }
  });
});
