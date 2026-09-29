import { expect, test, type Locator } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { billSlug, getAllBills } from '../lib/core';
import { lawRecord } from '../lib/law-record';
import { getLiveMoments, vehicleKind } from '../lib/moments';
import { statusWord } from '../lib/status-word';
import type { Bill, VotePosition } from '../lib/types';
import { MEMBER_VOTES_MAX_BILLS, memberVotesByBill } from '../lib/votes';

/*
 * THE MEMBER PAGE AS DECIDED (wireframes v2, member.html, 2026-09-29): the
 * member's numbers, then How they voted as bill cards, then the bills they
 * sponsor. Each card carries ONE status word from a closed set (Open, Law,
 * Agreed to, Rejected, Vetoed — lib/status-word.ts, pinned bill by bill in
 * tests/member-status.unit.spec.ts), the Big Question it belongs to, the
 * record's own line behind a finished word, and its vote with "Yea", "Nay"
 * and "concurrent resolution" glossed in place. The All / Big Questions
 * filter (M05) is HTML and CSS only.
 *
 * Every expectation is recomputed from lib/ at assert time and read by
 * message key and data-* hook, so a nightly that adds a roll call cannot
 * break this file.
 */

const HOUSE = 'D000594'; // Monica De La Cruz, TX-15
const SENATOR = 'C000127'; // Maria Cantwell, WA
const SHOWN_VOTES = 5;

const LOCALES = [
  { prefix: '', locale: 'en', messages: en },
  { prefix: '/es', locale: 'es', messages: es },
] as const;

const bySlug = new Map<string, Bill>(getAllBills().map((b) => [billSlug(b), b]));

/** The Big Question each bill is a vehicle of, by the page's own rule. */
const questionOf = (lang: 'en' | 'es') => {
  const map = new Map<string, string>();
  for (const m of getLiveMoments()) {
    for (const v of m.vehicles) {
      if (vehicleKind(v) === 'bill' && !map.has(v.slug)) map.set(v.slug, m.name[lang]);
    }
  }
  return map;
};

const POSITION_TERM: Record<VotePosition, string> = {
  yea: 'yea-and-nay',
  nay: 'yea-and-nay',
  present: 'present-vote',
  notVoting: 'not-voting',
};

const longDate = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(iso)
  );

const ids = (loc: Locator) => loc.evaluateAll((els) => els.map((e) => e.getAttribute('data-member-vote-bill') ?? e.getAttribute('data-member-vote-bq-bill')));

for (const { prefix, locale, messages } of LOCALES) {
  const tRep = createTranslator({ locale, messages, namespace: 'rep' });
  const questions = questionOf(locale);

  test.describe(`member page as decided ${prefix || '/'}`, () => {
    test('numbers first, then How they voted, then the bills they sponsor', async ({ page }) => {
      await page.goto(`${prefix}/reps/${SENATOR}`);
      const order = await page.locator('main').evaluate((main) => {
        const at = (sel: string) => {
          const el = main.querySelector(sel);
          return el ? [...main.querySelectorAll('*')].indexOf(el) : -1;
        };
        return [at('#rep-contact'), at('#rep-votes'), at('#rep-sponsored')];
      });
      expect(order.every((i) => i >= 0), 'all three sections render').toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      // Crumb: the Reps tab's own title, "Your members".
      await expect(page.getByRole('link', { name: messages.rep.crumb })).toBeVisible();
    });

    for (const id of [SENATOR, HOUSE]) {
      test(`${id}: one status word per card, from the record; the record line behind a finished word`, async ({
        page,
      }) => {
        const groups = memberVotesByBill(id).slice(0, MEMBER_VOTES_MAX_BILLS);
        test.skip(groups.length === 0, 'the record lists this member on no stored roll call');
        await page.goto(`${prefix}/reps/${id}`);
        const cards = page.locator('[data-member-votes] [data-member-vote-bill]');
        await expect(cards).toHaveCount(groups.length);

        const printed = await cards.evaluateAll((els) =>
          els.map((e) => ({
            bill: e.getAttribute('data-member-vote-bill'),
            words: [...e.querySelectorAll('[data-member-bill-word]')].map((w) => ({
              word: w.getAttribute('data-member-bill-word'),
              text: w.textContent,
            })),
            now: e.querySelectorAll('[data-member-vote-now]').length,
            law: e.querySelector('[data-member-vote-law]')?.textContent ?? null,
            question: e.querySelector('[data-member-vote-question-name]')?.textContent?.replace(/^\s*·\s*/, '') ?? null,
          }))
        );
        expect(printed).toEqual(
          groups.map((g) => {
            const bill = bySlug.get(g.bill)!;
            const word = statusWord(bill);
            const law = lawRecord(bill);
            const name = questions.get(g.bill);
            return {
              bill: g.bill,
              words: [{ word, text: messages.bills.statusWord[word] }],
              now: word === 'rejected' || word === 'vetoed' || word === 'agreed' ? 1 : 0,
              law:
                word === 'law' && law?.date
                  ? tRep('votesLaw', { date: longDate(locale, law.date), law: law.number ?? 'none' })
                  : null,
              question: name ? tRep('votesBigQuestion', { name }) : null,
            };
          })
        );
      });

      test(`${id}: Yea, Nay and "concurrent resolution" are glossed where they appear`, async ({ page }) => {
        const groups = memberVotesByBill(id).slice(0, MEMBER_VOTES_MAX_BILLS);
        test.skip(groups.length === 0, 'the record lists this member on no stored roll call');
        await page.goto(`${prefix}/reps/${id}`);
        const cards = page.locator('[data-member-votes] [data-member-vote-bill]');
        // Every card glosses its position word: it is the card's first term.
        const terms = await cards.evaluateAll((els) =>
          els.map((e) => e.querySelector('[data-member-vote-position] [data-glossary-term]')?.getAttribute('data-glossary-term') ?? null)
        );
        expect(terms).toEqual(groups.map((g) => POSITION_TERM[g.votes[0].position]));

        // The record's own "Concurrent Resolution" is glossed inside its line.
        const concurrent = groups.filter((g) => /\bconcurrent resolution\b/i.test(g.votes[0].rollCall.question));
        for (const g of concurrent) {
          await expect(
            page.locator(
              `[data-member-vote-bill="${g.bill}"] [data-member-vote-question] [data-glossary-term="concurrent-resolution"]`
            )
          ).toHaveCount(1);
        }

        // It opens in place, with the page's own definition, and navigates nowhere.
        const first = cards.first().locator('[data-member-vote-position] [data-glossary-term]');
        const term = POSITION_TERM[groups[0].votes[0].position];
        const url = page.url();
        await first.click();
        const panel = page.locator(`[data-glossary-panel="${term}"]`);
        await expect(panel).toBeVisible();
        await expect(panel).toContainText(
          (messages.glossary.terms as Record<string, { body: string }>)[term].body
        );
        expect(page.url()).toBe(url);
      });
    }

    test('the All / Big Questions filter shows only the Big Question cards, and back', async ({ page }) => {
      const groups = memberVotesByBill(SENATOR);
      const bq = groups.filter((g) => questions.has(g.bill)).map((g) => g.bill);
      test.skip(bq.length === 0, 'this senator voted on no Big Question vehicle this run');
      await page.goto(`${prefix}/reps/${SENATOR}`);
      const section = page.locator('[data-member-votes]');
      const filter = section.locator('[data-member-votes-filter]');
      await expect(filter).toBeVisible();
      const all = filter.getByRole('radio', { name: tRep('votesFilterAll', { count: groups.length }) });
      const bigQ = filter.getByRole('radio', { name: tRep('votesFilterBigQuestions', { count: bq.length }) });
      await expect(all).toBeChecked();

      const visible = section.locator('[data-member-vote-bill]:visible, [data-member-vote-bq-bill]:visible');
      const open = groups.slice(0, SHOWN_VOTES).map((g) => g.bill);
      expect(await ids(visible)).toEqual(open);

      await bigQ.check();
      expect(await ids(visible)).toEqual(bq);
      // The fold and the past-the-cap line step aside under the filter.
      await expect(section.locator('[data-member-votes-all]')).toBeHidden();

      await all.check();
      expect(await ids(visible)).toEqual(open);
    });

    test('no horizontal overflow with the Big Questions filter on @reflow', async ({ page }) => {
      await page.goto(`${prefix}/reps/${SENATOR}`);
      const bigQ = page.locator('#member-votes-bq');
      test.skip((await bigQ.count()) === 0, 'no Big Question vehicle in this record');
      await bigQ.check();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow, `${prefix}/reps/${SENATOR} must not scroll horizontally`).toBeLessThanOrEqual(0);
    });
  });
}
