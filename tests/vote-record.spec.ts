import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { rollCallPage } from '../lib/roll-call-page';
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
 *
 * THE MEMBER LIST IS FETCHED (2026-09-29). The page prints every roll call's
 * question, result, tally, date and official record, and the strip's
 * positions; the member-by-member list under "How members voted" is one static
 * file per roll call (/votes/<id>.json, app/votes/[file]/route.ts), fetched
 * from this site when the disclosure opens. The specs below pin both halves:
 * what the server HTML carries and does not, the fetch on open in both
 * languages and by keyboard, the no-JavaScript fallback, and that every built
 * file matches data/votes.json.
 *
 * THE OFFICIAL RECORD LINK (2026-09-29) opens the chamber's readable page for
 * the roll call (lib/roll-call-page.ts), never the XML data file stored as
 * `source`: clerk.house.gov/Votes/<year><roll> for the House, the .htm beside
 * the .xml on senate.gov. The no-JavaScript line links the same page.
 */

interface RollCall {
  id: string;
  chamber: 'house' | 'senate';
  date: string;
  roll: number;
  question: string;
  result: string;
  bill: string;
  source: string;
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

/** Each chamber's readable roll-call page, as lib/roll-call-page.ts builds it. */
const READABLE = {
  house: /^https:\/\/clerk\.house\.gov\/Votes\/\d{4}[1-9]\d*$/,
  senate: /^https:\/\/www\.senate\.gov\/legislative\/LIS\/roll_call_votes\/vote\d{4}\/vote_\d{3}_\d_\d{5}\.htm$/,
} as const;
/** A link to a roll call's XML data file, on either chamber's site. */
const DATA_FILE_LINK =
  'a[href^="https://clerk.house.gov/evs/"], a[href^="https://www.senate.gov/legislative/LIS/roll_call_votes/"][href$=".xml"]';
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

/** The bill with the most stored roll calls: the page this weight fix is for. */
function mostVotedBill(): string {
  const counts = new Map<string, number>();
  for (const r of VOTES.rollCalls) counts.set(r.bill, (counts.get(r.bill) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/** "Yea (264)" in the page's language, built from the message itself. */
function groupLabel(m: typeof en | typeof es, p: (typeof POSITIONS)[number], count: number): string {
  return m.votes.group.replace('{position}', m.votes.position[p]).replace('{count}', String(count));
}

/** Every request for a roll-call member file in the page's life, as paths. */
function memberFileRequests(page: Page): string[] {
  const hits: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith('/votes/')) hits.push(url.pathname);
  });
  return hits;
}

async function height(el: Locator): Promise<number> {
  return (await el.boundingBox())?.height ?? 0;
}

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

    test('the fold-out fetches its list when opened: every member, grouped by position, each linking to their page', async ({ page }) => {
      test.skip(!HOUSE_BILL, 'no bill with House-only roll calls in data/votes.json today');
      const r = newestFirst(HOUSE_BILL!)[0];
      const fetched = memberFileRequests(page);
      await page.goto(`${prefix}/bills/${HOUSE_BILL}`);
      const fold = page.locator('[data-vote-record] [data-vote-roll]').first().locator('[data-vote-members]');
      const summary = fold.locator('summary');
      expect(await height(summary), '44px touch target on the fold-out control').toBeGreaterThanOrEqual(44);
      // Contains, not equals: the +/– glyphs sit inside the summary, aria-hidden.
      await expect(summary).toContainText(m.votes.membersToggle);

      // Nothing is fetched, and no list is in the page, until it opens.
      await page.waitForLoadState('networkidle');
      expect(fetched, 'no member file before a fold-out is opened').toEqual([]);
      await expect(page.locator('[data-vote-group]')).toHaveCount(0);

      await summary.click();
      await expect(fold).toHaveAttribute('data-vote-members-state', 'ready');
      for (const p of POSITIONS) {
        const group = fold.locator(`[data-vote-group="${p}"]`);
        if (r.votes[p].length === 0) {
          await expect(group).toHaveCount(0);
          continue;
        }
        await expect(group).toBeVisible();
        await expect(group.getByRole('heading', { level: 4 })).toHaveText(groupLabel(m, p, r.votes[p].length));
        const links = group.getByRole('link');
        await expect(links).toHaveCount(r.votes[p].length);
        const hrefs = await links.evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
        const ids = hrefs.map((h) => h.split('/').pop());
        expect(new Set(ids)).toEqual(new Set(r.votes[p]));
        for (const h of hrefs) expect(h).toMatch(new RegExp(`^${prefix}/reps/[A-Z]\\d{6}$`));
        expect(await height(links.first()), '44px touch target on a member link').toBeGreaterThanOrEqual(44);
      }
      // Group order is the record's: Yea, Nay, Present, Not voting.
      const order = await fold
        .locator('[data-vote-group]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-vote-group')));
      expect(order).toEqual(POSITIONS.filter((p) => r.votes[p].length > 0));
      // The fallback line gives way to the list, and the status line is quiet.
      await expect(fold.locator('[data-vote-members-fallback]')).toHaveCount(0);
      await expect(fold.locator('[data-vote-members-status]')).toHaveText('');

      // One request, to this site, for this roll call; closing and reopening
      // does not ask again.
      await summary.click();
      await summary.click();
      await expect(fold.locator('[data-vote-group]').first()).toBeVisible();
      expect(fetched).toEqual([`/votes/${r.id}.json`]);
    });

    test('keyboard: Tab reaches the fold-out with a visible ring, Enter opens it, and Tab walks into the list', async ({ page }) => {
      test.skip(!HOUSE_BILL, 'no bill with House-only roll calls in data/votes.json today');
      const r = newestFirst(HOUSE_BILL!)[0];
      await page.goto(`${prefix}/bills/${HOUSE_BILL}`);
      await page.waitForLoadState('networkidle');
      const roll = page.locator('[data-vote-record] [data-vote-roll]').first();
      const fold = roll.locator('[data-vote-members]');
      const summary = fold.locator('summary');

      // Start on the roll call's own official-record link, the control just
      // before the fold-out, and Tab once.
      await roll.locator(`a[href="${rollCallPage(r.source)}"]`).first().focus();
      await page.keyboard.press('Tab');
      await expect(summary).toBeFocused();
      const ring = await summary.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          focusVisible: el.matches(':focus-visible'),
          outline: cs.outlineStyle !== 'none' ? parseFloat(cs.outlineWidth) : 0,
        };
      });
      expect(ring.focusVisible, 'the fold-out control is :focus-visible from the keyboard').toBe(true);
      // globals.css draws a 3px `--focus` ring; anything thinner is a regression.
      expect(ring.outline).toBeGreaterThanOrEqual(3);

      await page.keyboard.press('Enter');
      await expect(fold).toHaveAttribute('data-vote-members-state', 'ready');
      const firstGroup = POSITIONS.find((p) => r.votes[p].length > 0)!;
      // Every project here is WebKit, which (like Safari by default) leaves
      // links out of the plain Tab order; Option+Tab is how a Safari keyboard
      // user reaches a link, so that is the key this walk presses.
      await page.keyboard.press('Alt+Tab');
      const first = fold.locator(`[data-vote-group="${firstGroup}"] a`).first();
      await expect(first).toBeFocused();
      expect(await height(first)).toBeGreaterThanOrEqual(44);
    });

    test('the page HTML carries every roll call\'s record, and no member-by-member list', async ({ request }) => {
      const bill = mostVotedBill();
      const rolls = newestFirst(bill);
      const res = await request.get(`${prefix}/bills/${bill}`);
      expect(res.status()).toBe(200);
      const html = await res.text();
      const count = (needle: string) => html.split(needle).length - 1;

      // Every roll call is printed: its card, its four totals, its record
      // link, and a closed fold-out whose fallback names the official record.
      expect(count('data-vote-roll="')).toBe(rolls.length);
      expect(count('data-vote-total="')).toBe(rolls.length * POSITIONS.length);
      expect(count('data-vote-members-fallback=')).toBe(rolls.length);
      const missing = rolls.filter(
        (r) => !html.includes(`data-vote-roll="${r.id}"`) || !html.includes(`href="${rollCallPage(r.source)}"`)
      );
      expect(missing.map((r) => r.id)).toEqual([]);
      // No link on the page opens a roll call's data file.
      const raw = rolls.filter((r) => html.includes(`href="${r.source}"`));
      expect(raw.map((r) => r.id)).toEqual([]);
      expect(html).toContain(m.votes.membersOnRecord);

      // The list itself is not.
      expect(count('data-vote-group=')).toBe(0);

      // A weight floor for the regression this replaced: printed, the lists
      // cost about 84 kB of HTML per roll call on this page (3.95 MB for 47,
      // measured 2026-09-29). 25 kB per roll call is well above what the
      // record itself costs and well below any printed list of a chamber.
      expect(html.length / rolls.length, `${bill}: HTML bytes per roll call`).toBeLessThan(25_000);
    });

    for (const chamber of ['house', 'senate'] as const) {
      test(`${chamber}: every card's "Official record" opens the chamber's readable page, not the data file`, async ({ page }) => {
        const bill = chamber === 'house' ? HOUSE_BILL : SENATE_BILL;
        test.skip(!bill, `no bill with ${chamber}-only roll calls in data/votes.json today`);
        const rolls = newestFirst(bill!);
        await page.goto(`${prefix}/bills/${bill}`);
        await expect(page.locator('[data-vote-record] [data-vote-roll]')).toHaveCount(rolls.length);
        // Every card, the folded "earlier votes" ones too: the card's own
        // link is its direct child; the no-JavaScript line sits in the
        // fold-out below it.
        for (const r of rolls) {
          const link = page.locator(`[data-vote-roll="${r.id}"] > a[target="_blank"]`);
          await expect(link).toHaveText(m.votes.source);
          await expect(link).toHaveAttribute('href', rollCallPage(r.source));
          await expect(link).toHaveAttribute('href', READABLE[chamber]);
          await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        }
        const first = page.locator(`[data-vote-roll="${rolls[0].id}"] > a[target="_blank"]`);
        expect(await height(first), '44px touch target on the record link').toBeGreaterThanOrEqual(44);
        await expect(page.locator(DATA_FILE_LINK)).toHaveCount(0);
      });
    }
  });
}

test('a list that fails to load says so, keeps the official record, and retries on request', async ({ page }) => {
  test.skip(!HOUSE_BILL, 'no bill with House-only roll calls in data/votes.json today');
  const r = newestFirst(HOUSE_BILL!)[0];
  await page.route('**/votes/*.json', (route) => route.abort());
  await page.goto(`/bills/${HOUSE_BILL}`);
  await page.waitForLoadState('networkidle');
  const fold = page.locator('[data-vote-record] [data-vote-roll]').first().locator('[data-vote-members]');
  await fold.locator('summary').click();
  await expect(fold).toHaveAttribute('data-vote-members-state', 'error');
  await expect(fold.getByRole('status')).toHaveText(en.votes.membersError);
  await expect(fold.locator('[data-vote-members-fallback] a')).toHaveAttribute('href', rollCallPage(r.source));
  const retry = fold.getByRole('button', { name: en.votes.membersRetry });
  expect(await height(retry)).toBeGreaterThanOrEqual(44);

  await page.unroute('**/votes/*.json');
  await retry.click();
  await expect(fold).toHaveAttribute('data-vote-members-state', 'ready');
  await expect(fold.locator('[data-vote-group]').first()).toBeVisible();
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  for (const { locale, prefix, m } of LOCALES) {
    test(`the fold-out still opens, and points to the official record (${locale})`, async ({ page }) => {
      test.skip(!HOUSE_BILL, 'no bill with House-only roll calls in data/votes.json today');
      const r = newestFirst(HOUSE_BILL!)[0];
      await page.goto(`${prefix}/bills/${HOUSE_BILL}`);
      const fold = page.locator('[data-vote-record] [data-vote-roll]').first().locator('[data-vote-members]');
      await fold.locator('summary').click();
      const fallback = fold.locator('[data-vote-members-fallback]');
      await expect(fallback).toBeVisible();
      await expect(fallback).toContainText(m.votes.membersOnRecord);
      const link = fallback.getByRole('link', { name: m.votes.source });
      await expect(link).toHaveAttribute('href', rollCallPage(r.source));
      await expect(link).toHaveAttribute('href', READABLE.house);
      expect(await height(link)).toBeGreaterThanOrEqual(44);
      await expect(fold.locator('[data-vote-group]')).toHaveCount(0);
    });
  }
});

test.describe('the roll-call member files', () => {
  test('every stored roll call has its file, and each matches data/votes.json', async ({ request }) => {
    const misses: string[] = [];
    const rolls = VOTES.rollCalls;
    for (let i = 0; i < rolls.length; i += 25) {
      await Promise.all(
        rolls.slice(i, i + 25).map(async (r) => {
          const res = await request.get(`/votes/${r.id}.json`);
          if (res.status() !== 200) {
            misses.push(`${r.id}: HTTP ${res.status()}`);
            return;
          }
          if (!/^application\/json/.test(res.headers()['content-type'] ?? '')) misses.push(`${r.id}: content-type`);
          if (res.headers()['set-cookie']) misses.push(`${r.id}: sets a cookie`);
          const body = (await res.json()) as {
            id: string;
            groups: { position: (typeof POSITIONS)[number]; members: [string, string, string][] }[];
          };
          if (body.id !== r.id) misses.push(`${r.id}: id ${body.id}`);
          const want = POSITIONS.filter((p) => r.votes[p].length > 0);
          if (body.groups.map((g) => g.position).join() !== want.join()) misses.push(`${r.id}: groups`);
          for (const g of body.groups) {
            const ids = g.members.map(([id]) => id).sort();
            const record = [...r.votes[g.position]].sort();
            if (ids.join() !== record.join()) misses.push(`${r.id} ${g.position}: members differ from the record`);
          }
        })
      );
    }
    expect(misses).toEqual([]);
  });

  test('a roll call the build did not write is a 404, and the files keep the site-wide frame lock', async ({ request }) => {
    expect((await request.get('/votes/h-0-0-0.json')).status()).toBe(404);
    const res = await request.get(`/votes/${VOTES.rollCalls[0].id}.json`);
    expect(res.headers()['content-security-policy'] ?? '').toContain("frame-ancestors 'self'");
  });
});

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
    // The strip's positions are server-rendered into the page: with every
    // roll-call member file blocked, it still prints them, and never asks.
    const files = memberFileRequests(page);
    await page.route('**/votes/*.json', (route) => route.abort());
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
    expect(files, 'the strip reads no roll-call member file').toEqual([]);
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
