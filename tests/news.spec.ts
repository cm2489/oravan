import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { getNewsBills } from '../lib/core';
import { stableAcross } from './corpus';

/*
 * The "In the news" band. Selection and captions are unit-tested in
 * tests/news-band.unit.spec.ts (the conversation lamp and its fallback); here
 * we confirm, wherever the band renders, that EVERY CARD SAYS WHY IT IS
 * THERE in the page's own language. Under the conversation lamp that is a
 * counted caption — outlets across the spectrum this week, or congress.gov's
 * own most-viewed list; in the fallback it is the outlet-count cue the band
 * has always carried. Either is a reason; a card with neither is the failure
 * this file exists to catch.
 *
 * The band is found by its `[data-news-band]` hook and the reasons by their
 * message keys, so neither the heading copy nor which page carries the band
 * is pinned here. Data-driven: each page skips cleanly when a quiet week
 * leaves nothing to feature there. On /bills the data decides: that page
 * renders the band exactly when getNewsBills has something to feature, so
 * there a band that should exist and cannot be found FAILS rather than skips
 * (a lost hook must not read as a quiet week). The homepage also drops the
 * crowned bill from the band, so there the rendered page decides.
 */

/** /bills renders the band iff getNewsBills(locale, 6) is non-empty. */
const bandDueOnBills = (at: number) => getNewsBills('en', 6, at).length > 0;
const BILLS_BAND_STABLE = stableAcross(bandDueOnBills);
const BILLS_BAND_DUE = bandDueOnBills(Date.now());

const NUMBER = '\\d[\\d,.\\u00a0\\u202f]*';

/** A message template as a regex that matches any rendering of it:
 *  `{x, plural, one {…} other {…}}` becomes an alternation of its branches
 *  (with `#` as a number), and a bare `{x}` matches any text. */
function templatePattern(template: string): string {
  let out = '';
  let i = 0;
  const closing = (s: string, open: number) => {
    let depth = 0;
    for (let j = open; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) return j;
    }
    throw new Error(`unbalanced braces in message template: ${s}`);
  };
  while (i < template.length) {
    const ch = template[i];
    if (ch === '{') {
      const end = closing(template, i);
      const inner = template.slice(i + 1, end);
      const branching = inner.match(/^\s*\w+\s*,\s*(?:plural|select|selectordinal)\s*,([\s\S]*)$/);
      if (branching) {
        const branches: string[] = [];
        const body = branching[1];
        for (let k = body.indexOf('{'); k !== -1; k = body.indexOf('{', closing(body, k) + 1)) {
          branches.push(templatePattern(body.slice(k + 1, closing(body, k))));
        }
        out += `(?:${branches.join('|')})`;
      } else if (/^\s*\w+\s*,\s*number/.test(inner)) {
        out += NUMBER;
      } else {
        out += '.+?';
      }
      i = end + 1;
    } else if (ch === '#') {
      out += NUMBER;
      i++;
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return out;
}

/** Every reason a card may give, by key: the lamp's four captions and the
 *  fallback's outlet count. */
function reasonRegex(messages: typeof en | typeof es): RegExp {
  const n = messages.news;
  return new RegExp(
    [
      n.captionCorroborated,
      n.captionCorroboratedCenter,
      n.captionMostViewed,
      n.captionMostViewedThisWeek,
      n.sources,
    ]
      .map(templatePattern)
      .join('|')
  );
}

const PAGES = [
  { locale: 'en', paths: ['/', '/bills'], messages: en, other: es },
  { locale: 'es', paths: ['/es', '/es/bills'], messages: es, other: en },
] as const;

for (const { locale, paths, messages, other } of PAGES) {
  for (const path of paths) {
    test(`${path}: every news card states its reason, in ${locale}`, async ({ page }) => {
      await page.goto(path);
      const band = page.locator('[data-news-band]');
      if (path.endsWith('/bills') && BILLS_BAND_STABLE && BILLS_BAND_DUE) {
        await expect(band, 'getNewsBills has cards to feature, so /bills renders the band').toHaveCount(1);
      }
      test.skip((await band.count()) === 0, `no news-lens coverage on ${path} in current data`);

      // Every card is a link through to a bill, and the band has at least one.
      const cards = band.locator('a[href*="/bills/"]');
      expect(await cards.count(), 'a rendered band carries at least one card').toBeGreaterThan(0);

      const texts = await cards.allTextContents();
      const reason = reasonRegex(messages);
      const withoutReason = texts.filter((t) => !reason.test(t));
      expect(withoutReason, 'cards with no reason caption from the news.* key set').toEqual([]);

      // Bilingual parity: a caption is a user-facing string, so no card (and
      // nothing else in the band) may state its reason in the other language.
      const foreign = reasonRegex(other);
      expect(foreign.test((await band.textContent()) ?? ''), 'a reason stated in the other language').toBe(false);
    });
  }
}
