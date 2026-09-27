import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { billWithRollCallsOnlyIn } from './corpus-fixtures';
import { seedZip } from './helpers';
import { messagePattern } from './message-pattern';

/*
 * THE VOTE RECORD on the bill page (plan item C1b): components/VoteRecord.tsx
 * and its client strip components/VoteDelegation.tsx.
 *
 * Every expected number is read from data/votes.json at test time, never
 * restated here, so the nightly sync can move the file without this spec
 * going stale. Every label is read from messages/*.json by key. The bills are
 * chosen by what they exercise (tests/corpus-fixtures.ts), never named:
 *   SENATE_BILL  roll calls in the Senate only
 *   HOUSE_BILL   roll calls in the House only
 * and the no-votes bill is computed: the first corpus bill with none.
 *
 * ZIP 05401 (Burlington, VT) is a single at-large district, so the call rail
 * resolves exactly three members and the strip has no split-ZIP branch to take.
 */

interface RollCall {
  id: string;
  chamber: 'house' | 'senate';
  date: string;
  roll: number;
  question: string;
  result: string;
  bill: string;
  totals: Record<'yea' | 'nay' | 'present' | 'notVoting', number>;
  votes: Record<'yea' | 'nay' | 'present' | 'notVoting', string[]>;
}

const read = (f: string) => JSON.parse(readFileSync(join(process.cwd(), f), 'utf8'));
const VOTES = read('data/votes.json') as { rollCalls: RollCall[] };
const POSITIONS = ['yea', 'nay', 'present', 'notVoting'] as const;

function newestFirst(bill: string): RollCall[] {
  return VOTES.rollCalls
    .filter((r) => r.bill === bill)
    .sort((a, b) => b.date.localeCompare(a.date) || a.chamber.localeCompare(b.chamber) || b.roll - a.roll);
}

const SENATE_BILL = billWithRollCallsOnlyIn('senate');
const HOUSE_BILL = billWithRollCallsOnlyIn('house');
const ZIP = '05401';

function noVotesBill(): string {
  const bills = read('data/bills.json') as
    | { bill_type: string; bill_number: string | number; congress_number: string | number }[]
    | { bills: { bill_type: string; bill_number: string | number; congress_number: string | number }[] };
  const list = Array.isArray(bills) ? bills : bills.bills;
  const voted = new Set(VOTES.rollCalls.map((r) => r.bill));
  const slug = list
    .map((b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase())
    .find((s) => !voted.has(s));
  if (!slug) throw new Error('every corpus bill has a vote — pick the no-votes case another way');
  return slug;
}

const LOCALES = [
  { locale: 'en', prefix: '', m: en },
  { locale: 'es', prefix: '/es', m: es },
] as const;

for (const { locale, prefix, m } of LOCALES) {
  test.describe(`vote record (${locale})`, () => {
    test('a bill with votes renders the block with the record\'s own tallies', async ({ page }) => {
      test.skip(!SENATE_BILL, 'no bill with Senate-only roll calls in data/votes.json today');
      const rolls = newestFirst(SENATE_BILL!);
      expect(rolls.length).toBeGreaterThan(0);
      await page.goto(`${prefix}/bills/${SENATE_BILL}`);
      const block = page.locator('[data-vote-record]');
      await expect(block.getByRole('heading', { level: 2, name: m.votes.heading })).toBeVisible();
      await expect(block.getByText(messagePattern(m.votes.coverage))).toBeVisible();

      const first = block.locator('[data-vote-roll]').first();
      for (const p of POSITIONS) {
        await expect(first.locator(`[data-vote-total="${p}"]`)).toHaveText(String(rolls[0].totals[p]));
      }
      await expect(first.locator('[data-vote-question]')).toHaveText(rolls[0].question);
      await expect(first.locator('[data-vote-result]')).toHaveText(rolls[0].result);
    });

    test('the question and result stay the record\'s English, under the "as recorded" label', async ({ page }) => {
      test.skip(!SENATE_BILL, 'no bill with Senate-only roll calls in data/votes.json today');
      const rolls = newestFirst(SENATE_BILL!);
      await page.goto(`${prefix}/bills/${SENATE_BILL}`);
      const first = page.locator('[data-vote-record] [data-vote-roll]').first();
      await expect(first.locator('[data-vote-as-recorded]')).toHaveText(m.votes.asRecorded);
      const q = first.locator('[data-vote-question]');
      await expect(q).toHaveAttribute('lang', 'en');
      await expect(q).toHaveText(rolls[0].question);
      const result = first.locator('[data-vote-result]');
      await expect(result).toHaveAttribute('lang', 'en');
      await expect(result).toHaveText(rolls[0].result);
    });

    test('a bill with no stored roll call renders no vote heading at all', async ({ page }) => {
      await page.goto(`${prefix}/bills/${noVotesBill()}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('[data-vote-record]')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: m.votes.heading })).toHaveCount(0);
    });

    test('the fold-out lists every member, grouped by position, each linking to their page', async ({ page }) => {
      test.skip(!HOUSE_BILL, 'no bill with House-only roll calls in data/votes.json today');
      const r = newestFirst(HOUSE_BILL!)[0];
      await page.goto(`${prefix}/bills/${HOUSE_BILL}`);
      const fold = page.locator('[data-vote-record] [data-vote-roll]').first().locator('[data-vote-members]');
      const summary = fold.locator('summary');
      const box = await summary.boundingBox();
      expect(box!.height, '44px touch target on the fold-out control').toBeGreaterThanOrEqual(44);

      await summary.click();
      for (const p of POSITIONS) {
        const group = fold.locator(`[data-vote-group="${p}"]`);
        if (r.votes[p].length === 0) {
          await expect(group).toHaveCount(0);
          continue;
        }
        await expect(group).toBeVisible();
        const links = group.getByRole('link');
        await expect(links).toHaveCount(r.votes[p].length);
        const hrefs = await links.evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
        const ids = hrefs.map((h) => h.split('/').pop());
        expect(new Set(ids)).toEqual(new Set(r.votes[p]));
        for (const h of hrefs) expect(h).toMatch(new RegExp(`^${prefix}/reps/[A-Z]\\d{6}$`));
      }
      // Group order is the record's: Yea, Nay, Present, Not voting.
      const order = await fold
        .locator('[data-vote-group]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-vote-group')));
      expect(order).toEqual(POSITIONS.filter((p) => r.votes[p].length > 0));
    });
  });
}

/** Every request in the page's life that carries the ZIP anywhere. */
function zipRequests(page: Page): Request[] {
  const hits: Request[] = [];
  page.on('request', (req) => {
    const body = req.postData() ?? '';
    const headers = JSON.stringify(req.headers());
    if (req.url().includes(ZIP) || body.includes(ZIP) || headers.includes(ZIP)) hits.push(req);
  });
  return hits;
}

test.describe('your members strip', () => {
  test('renders nothing when no ZIP is saved', async ({ page }) => {
    test.skip(!SENATE_BILL, 'no bill with Senate-only roll calls in data/votes.json today');
    await page.goto(`/bills/${SENATE_BILL}`);
    await expect(page.locator('[data-vote-record]')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-vote-delegation]')).toHaveCount(0);
  });

  test('with a saved ZIP, shows each member\'s position and adds no request of its own', async ({ page }) => {
    test.skip(!SENATE_BILL, 'no bill with Senate-only roll calls in data/votes.json today');
    const r = newestFirst(SENATE_BILL!)[0];
    expect(r.chamber).toBe('senate');
    await page.goto(`/bills/${SENATE_BILL}`);
    await seedZip(page, ZIP);
    const hits = zipRequests(page);
    await page.reload();

    const strip = page.locator('[data-vote-delegation]');
    await expect(strip).toBeVisible();
    await expect(strip.locator('[data-vote-delegate]')).toHaveCount(3);
    for (const id of r.votes.nay) {
      const row = strip.locator(`[data-vote-delegate="${id}"]`);
      if ((await row.count()) === 0) continue;
      await expect(row).toContainText(en.votes.position.nay);
    }
    const senators = strip
      .locator('[data-vote-delegate]')
      .filter({ hasText: messagePattern(en.votes.delegation.onSenateVote) });
    await expect(senators).toHaveCount(2);
    await expect(strip).toContainText(messagePattern(en.votes.delegation.noHouseVote));
    await expect(strip).toContainText(en.votes.delegation.note);

    // The only request that has ever carried this ZIP is the call rail's own
    // pre-existing /api/reps lookup — the strip reads that answer from memory.
    await page.waitForLoadState('networkidle');
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(new URL(h.url()).pathname).toBe('/api/reps');
    expect(hits.length, 'the strip must not add a second lookup').toBe(1);
  });

  test('House roll call: the House member\'s position, the senators say there is no Senate vote', async ({ page }) => {
    test.skip(!HOUSE_BILL, 'no bill with House-only roll calls in data/votes.json today');
    const r = newestFirst(HOUSE_BILL!)[0];
    expect(r.chamber).toBe('house');
    await page.goto(`/es/bills/${HOUSE_BILL}`);
    await seedZip(page, ZIP);
    await page.reload();
    const strip = page.locator('[data-vote-delegation]');
    await expect(strip).toBeVisible();
    await expect(
      strip.locator('[data-vote-delegate]').filter({ hasText: messagePattern(es.votes.delegation.onHouseVote) })
    ).toHaveCount(1);
    await expect(strip.getByText(messagePattern(es.votes.delegation.noSenateVote))).toHaveCount(2);
    await expect(strip).toContainText(es.votes.delegation.note);
  });

  test('with the call rail\'s lookup blocked, the strip stays empty and makes no lookup of its own', async ({ page }) => {
    test.skip(!SENATE_BILL, 'no bill with Senate-only roll calls in data/votes.json today');
    await page.goto(`/bills/${SENATE_BILL}`);
    await seedZip(page, ZIP);
    await page.route('**/api/reps**', (route) => route.abort());
    const hits = zipRequests(page);
    await page.reload();
    await expect(page.locator('[data-vote-record]')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-vote-delegation]')).toHaveCount(0);
    for (const h of hits) expect(new URL(h.url()).pathname).toBe('/api/reps');
  });
});
