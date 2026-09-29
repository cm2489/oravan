import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

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
 * message keys, so the heading copy is not pinned here. Data-driven: the page
 * skips cleanly when a quiet week leaves nothing to feature. The homepage
 * drops the crowned bill from the band, so the rendered page decides.
 *
 * The homepage is the only page that carries the band since 2026-09-28, when
 * the owner cut it from /bills (UX inventory B05). /bills used to be the
 * stricter half of this file: it rendered the band exactly when
 * getNewsBills(locale, 6) had cards, so there a missing band FAILED rather
 * than skipped. Bring /bills back into PAGES, with that check, if the band
 * returns to it.
 */

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
  { locale: 'en', paths: ['/'], messages: en, other: es },
  { locale: 'es', paths: ['/es'], messages: es, other: en },
] as const;

for (const { locale, paths, messages, other } of PAGES) {
  for (const path of paths) {
    test(`${path}: every news card states its reason, in ${locale}`, async ({ page }) => {
      await page.goto(path);
      const band = page.locator('[data-news-band]');
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
