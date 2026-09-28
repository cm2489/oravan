import { expect, test, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import {
  billSlug,
  getBillsSponsoredBy,
  getLegislator,
  getVacancies,
  senatorsForState,
  vacancySlug,
} from '../lib/core';
import { memberVotesByBill } from '../lib/votes';
import { mockScriptApi } from './helpers';
import { referenceBill } from './corpus-fixtures';

/*
 * The per-member page, /reps/[bioguide] (plan item C2). Three shapes: a House
 * member, a senator, and a vacant seat (keyed on the seat - a vacancy has no
 * bioguide). Corpus-coupled the same way reps.spec.ts is: the members are
 * named by bioguide, and every count is recomputed from lib/core at assert
 * time so a nightly sync that adds a sponsored bill cannot break this file.
 *
 * The funnel invariants for this surface live in tests/funnel.spec.ts
 * ("member page"), beside the others, not here.
 */

const HOUSE = 'D000594'; // Monica De La Cruz, TX-15 (also reps.spec.ts's ZIP 78501 fixture)
const SENATOR = 'C000127'; // Maria Cantwell, WA

const LOCALES = [
  { prefix: '', messages: en },
  { prefix: '/es', messages: es },
] as const;

/**
 * The height of an element's real HIT AREA, measured by hit-testing rather
 * than read off its box: a name link's 44px target is an ::after overlay (see
 * components/RepCard.tsx), which the box does not include. Scrolls the target
 * to the middle of the viewport, then walks its centre column 1px at a time
 * and counts the pixels whose topmost element is the target or inside it.
 */
function hitHeight(el: HTMLElement): number {
  // 'instant': the site sets scroll-behavior: smooth, and a smooth scroll
  // would still be moving while the probe below reads coordinates.
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const cx = r.left + Math.min(r.width / 2, 20);
  let hits = 0;
  for (let y = Math.floor(r.top - 40); y <= Math.ceil(r.bottom + 40); y++) {
    const hit = document.elementFromPoint(cx, y);
    if (hit && (hit === el || el.contains(hit))) hits++;
  }
  return hits;
}

/** Every visible interactive target inside <main> is at least 44px tall. */
async function expectTouchTargets(page: Page) {
  const small = await page.locator('main').evaluate((main, hitHeightSrc) => {
    const measure = new Function(`return (${hitHeightSrc})`)() as (el: HTMLElement) => number;
    const out: string[] = [];
    for (const el of main.querySelectorAll<HTMLElement>('a[href], button, summary')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // inside a closed <details>
      if (r.height >= 44) continue;
      const h = measure(el);
      if (h < 44) out.push(`${el.tagName} "${el.textContent?.trim().slice(0, 40)}" hit ${h}px`);
    }
    return out;
  }, hitHeight.toString());
  expect(small, 'WCAG 2.5.8 / CLAUDE.md: 44px touch targets').toEqual([]);
}

/** The page's outline and control counts: identical across locales, or a
 *  string somewhere is hardcoded or missing in one language. */
async function structure(page: Page) {
  const main = page.locator('main');
  return {
    h1: await main.locator('h1').count(),
    h2: await main.locator('h2').count(),
    h3: await main.locator('h3').count(),
    tel: await main.locator('a[href^="tel:"]').count(),
    bills: await main.locator('a[href*="/bills/"]').count(),
  };
}

for (const { prefix, messages } of LOCALES) {
  test.describe(`member page ${prefix || '/'}`, () => {
    test('House member: name, seat, party as text, the dial, sponsored bills', async ({ page }) => {
      const rep = getLegislator(HOUSE)!;
      await page.goto(`${prefix}/reps/${HOUSE}`);
      await expect(page.getByRole('heading', { level: 1, name: rep.name })).toBeVisible();
      const meta = page.locator('main header p').first();
      await expect(meta).toContainText(messages.reps.representative);
      await expect(meta).toContainText(
        messages.reps.party[rep.party as 'Democrat' | 'Republican' | 'Independent']
      );
      await expect(meta).toContainText(`${rep.state}`);

      // The call apparatus: the same dial and local numbers the lookup renders.
      await expect(page.getByRole('heading', { name: messages.rep.contactHeading })).toBeVisible();
      const dial = page.locator(`a[href="tel:+1${rep.phone!.replace(/\D/g, '')}"]`);
      await expect(dial).toBeVisible();
      await expect(dial).toContainText(messages.reps.dcOffice);
      await expect(page.getByText(messages.reps.localOffices, { exact: false }).first()).toBeVisible();

      const sponsored = getBillsSponsoredBy(HOUSE);
      await expect(page.getByRole('heading', { name: messages.rep.sponsoredHeading })).toBeVisible();
      if (sponsored.length > 0) {
        await expect(page.getByText(messages.rep.aiNote, { exact: true })).toBeVisible();
        // Scoped to the section: the member may also have voted on a bill
        // they sponsor, and "How they voted" links to it too.
        await expect(
          page.locator(`main section[aria-labelledby="rep-sponsored"] a[href$="/bills/${billSlug(sponsored[0])}"]`)
        ).toBeVisible();
      }

      await expectTouchTargets(page);
    });

    test('senator: role, both counts, dial', async ({ page }) => {
      const sen = getLegislator(SENATOR)!;
      await page.goto(`${prefix}/reps/${SENATOR}`);
      await expect(page.getByRole('heading', { level: 1, name: sen.name })).toBeVisible();
      await expect(page.locator('main header p').first()).toContainText(messages.reps.senator);
      await expect(page.locator('main a[href^="tel:"]').first()).toBeVisible();
      const sponsored = getBillsSponsoredBy(SENATOR).length;
      // Six cards open, the rest folded into one disclosure (links inside a
      // closed <details> still exist in the DOM).
      await expect(page.locator('main section[aria-labelledby="rep-sponsored"] a[href*="/bills/"]')).toHaveCount(
        sponsored
      );
      await expectTouchTargets(page);
    });

    test('vacant seat: says so, never names anyone, hands over the senators', async ({ page }) => {
      const seat = getVacancies()[0];
      test.skip(!seat, 'no vacant House seat in the roster this run');
      await page.goto(`${prefix}/reps/${vacancySlug(seat)}`);
      await expect(page.getByText(messages.reps.vacantSeat, { exact: true })).toBeVisible();
      await expect(page.getByText(messages.reps.vacantSeatBody)).toBeVisible();
      await expect(page.getByText(/special election|elecci[oó]n especial/i)).toHaveCount(0);
      for (const s of senatorsForState(seat.state)) {
        await expect(page.getByRole('heading', { name: s.name })).toBeVisible();
      }
      await expect(page.locator('main a[href^="tel:"]')).not.toHaveCount(0);
      await expectTouchTargets(page);
    });

    test('unknown id is a real 404', async ({ page }) => {
      const res = await page.goto(`${prefix}/reps/Z999999`);
      expect(res?.status()).toBe(404);
    });
  });
}

test('both locales render the same structure (no string lives in only one language)', async ({ page }) => {
  for (const id of [HOUSE, SENATOR, getVacancies()[0] ? vacancySlug(getVacancies()[0]) : HOUSE]) {
    await page.goto(`/reps/${id}`);
    const enShape = await structure(page);
    await page.goto(`/es/reps/${id}`);
    const esShape = await structure(page);
    expect(esShape, id).toEqual(enShape);
    // No English page copy on the Spanish page.
    for (const key of ['contactHeading', 'sponsoredHeading', 'crumb'] as const) {
      await expect(page.getByText(en.rep[key], { exact: true })).toHaveCount(0);
    }
  }
});

/*
 * The lookup itself: every interactive control on /reps?zip=<ZIP> is a 44px
 * target, in both locales. A normal district (78501) and a vacant one (33313,
 * whose card carries the seat link). Measured the same way as the member
 * page: the box when it is already 44px tall, a hit test otherwise (the name
 * links' target is an ::after overlay the box doesn't include). This caught
 * "Change ZIP code" at 17px.
 */
for (const { prefix } of LOCALES) {
  for (const zip of ['78501', '33313']) {
    test(`every control on ${prefix}/reps?zip=${zip} is a 44px target`, async ({ page }) => {
      await page.goto(`${prefix}/reps?zip=${zip}`);
      await expectTouchTargets(page);
    });
  }
}

/*
 * The inbound path: the ZIP lookup's cards are how a visitor reaches these
 * pages. A member's name links to /reps/<bioguide> and a vacant seat's heading
 * links to /reps/<seat>, in both locales, and each is a 44px target.
 */
for (const { prefix, messages } of LOCALES) {
  test(`the lookup's card links resolve to the member and seat pages ${prefix || '/'}`, async ({ page }) => {
    const rep = getLegislator(HOUSE)!;
    await page.goto(`${prefix}/reps?zip=78501`);
    const nameLink = page.getByRole('link', { name: rep.name, exact: true });
    await expect(nameLink).toHaveAttribute('href', `${prefix}/reps/${HOUSE}`);
    expect(await nameLink.evaluate(hitHeight)).toBeGreaterThanOrEqual(44);
    await nameLink.click();
    await expect(page).toHaveURL(new RegExp(`${prefix}/reps/${HOUSE}$`));
    await expect(page.getByRole('heading', { level: 1, name: rep.name })).toBeVisible();

    const seat = getVacancies().find((v) => v.state === 'FL' && v.district === 20);
    test.skip(!seat, 'FL-20 is no longer vacant - ZIP 33313 has no vacant card to follow');
    await page.goto(`${prefix}/reps?zip=33313`);
    const seatLink = page.getByRole('link', { name: messages.reps.vacantSeat, exact: true });
    await expect(seatLink).toHaveAttribute('href', `${prefix}/reps/${vacancySlug(seat!)}`);
    expect(await seatLink.evaluate(hitHeight)).toBeGreaterThanOrEqual(44);
    await seatLink.click();
    await expect(page).toHaveURL(new RegExp(`${prefix}/reps/${vacancySlug(seat!)}$`));
    await expect(page.getByText(messages.reps.vacantSeatBody)).toBeVisible();
  });
}

/*
 * HOW THEY VOTED (owner, UX inventory R04, 2026-09-28). The member page lists
 * every bill the record names this member on, newest first, each with the
 * AI-labeled headline, their vote in the record's own word, and the bill
 * page's own "Right now:" sentence. Recomputed from lib/votes at assert time,
 * so a nightly that adds roll calls cannot break this block. Asserted by
 * message key and data-* hook only.
 */
for (const { prefix, messages } of LOCALES) {
  test.describe(`member page vote record ${prefix || '/'}`, () => {
    for (const id of [HOUSE, SENATOR]) {
      test(`${id}: every voted bill, newest first, the vote as recorded`, async ({ page }) => {
        const groups = memberVotesByBill(id);
        test.skip(groups.length === 0, 'the record lists this member on no stored roll call');
        await page.goto(`${prefix}/reps/${id}`);
        const section = page.locator('[data-member-votes]');
        await expect(section.getByRole('heading', { level: 2, name: messages.rep.votesHeading })).toBeVisible();
        await expect(section.getByText(messages.rep.votesAiNote, { exact: true })).toBeVisible();

        const rows = section.locator('[data-member-vote-bill]');
        await expect(rows).toHaveCount(groups.length);
        expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-member-vote-bill')))).toEqual(
          groups.map((g) => g.bill)
        );

        const first = rows.first();
        const newest = groups[0].votes[0];
        await expect(first.locator(`a[href$="/bills/${groups[0].bill}"]`)).toBeVisible();
        const vote = first.locator(`[data-member-vote-roll="${newest.rollCall.id}"]`);
        await expect(vote.locator('[data-member-vote-position]')).toHaveText(
          messages.votes.position[newest.position]
        );
        await expect(vote.locator('[data-member-vote-question]')).toHaveText(newest.rollCall.question);
        await expect(vote.locator(`a[href="${newest.rollCall.source}"]`)).toBeVisible();

        // Party never rides with a vote, as text or otherwise.
        const rep = getLegislator(id)!;
        const party = messages.reps.party[rep.party as 'Democrat' | 'Republican' | 'Independent'];
        if (party) await expect(section.getByText(party, { exact: true })).toHaveCount(0);

        await expectTouchTargets(page);
      });
    }

    test('no horizontal overflow with every vote row open @reflow', async ({ page }) => {
      await page.goto(`${prefix}/reps/${SENATOR}`);
      await page
        .locator('[data-member-votes]')
        .evaluate((s) => s.querySelectorAll('details').forEach((d) => (d.open = true)));
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow, `${prefix}/reps/${SENATOR} must not scroll horizontally`).toBeLessThanOrEqual(0);
    });

    test('a row\'s "Right now" sentence is the bill page\'s own', async ({ page }) => {
      await page.goto(`${prefix}/reps/${HOUSE}`);
      // The two calendar sentences carry a glossary link on the bill page,
      // whose hovercard text sits inside the same paragraph; every other key
      // reads identically on both pages.
      const now = page
        .locator(
          '[data-member-votes] [data-member-vote-now]:not([data-member-vote-now="nowFloor"]):not([data-member-vote-now="nowFloorStale"])'
        )
        .first();
      test.skip((await now.count()) === 0, 'every voted bill sits on a floor calendar this run');
      const sentence = ((await now.textContent()) ?? '').replace(/\s+/g, ' ').trim();
      const bill = await now.evaluate((el) =>
        el.closest('[data-member-vote-bill]')!.getAttribute('data-member-vote-bill')
      );
      expect(sentence.startsWith(messages.bill.journey.now)).toBe(true);
      await page.goto(`${prefix}/bills/${bill}`);
      await expect(page.locator('main')).toContainText(sentence);
    });

    test('rep cards on /reps link to the vote section', async ({ page }) => {
      await page.goto(`${prefix}/reps?zip=78501`);
      const link = page.locator(`article a[data-rep-votes-link][href="${prefix}/reps/${HOUSE}#votes"]`);
      await expect(link).toHaveText(messages.reps.seeVotes);
      expect(await link.evaluate(hitHeight)).toBeGreaterThanOrEqual(44);
      await link.click();
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps/${HOUSE}#votes$`));
      await expect(page.locator('#votes')).toBeInViewport();
    });

    test('the bill call panel links each member to their vote section', async ({ page }) => {
      await mockScriptApi(page);
      await page.goto(`${prefix}/bills/${referenceBill().slug}`);
      await page.getByRole('radio', { name: messages.bill.stance.support }).click();
      await page.getByLabel(messages.home.zipLabel).fill('78501');
      await page.getByRole('button', { name: messages.home.zipCta }).click();
      const rows = page.locator('[data-rep-name]');
      await expect(rows.first()).toBeVisible();
      const links = page.locator('[data-rep-votes-link]');
      await expect(links).toHaveCount(await rows.count());
      await expect(page.locator(`[data-rep-votes-link][href="${prefix}/reps/${HOUSE}#votes"]`)).toHaveText(
        messages.reps.seeVotes
      );
    });
  });
}
