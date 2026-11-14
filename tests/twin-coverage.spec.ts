import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import billsData from '../data/bills.json';
import coverageData from '../data/coverage.json';
import relatedBills from '../data/related-bills.json';
import { twinsOf } from '../lib/related-bills.mjs';
import { coverageForBillPage, getCoverageWithTwins } from '../lib/coverage';
import { getMomentsForBill } from '../lib/moments';
import { formatCitation } from '../lib/format';

/*
 * A twin's article, shown under the bill as it is (owner, 2026-11-13, his
 * card on a bill's twin: "Yes, show it under the bill as it is."). The rule is
 * pinned on fixtures in twin-coverage.unit.spec.ts; this is a real bill page.
 *
 * The bill is found in the data BY KIND, never by name: a bill whose box lists
 * at least one article stored only under a bill the record calls identical to
 * it (data/related-bills.json). Until the nightly has read the record for a
 * bill with such a twin, the data holds none, and the test skips with the
 * reason.
 */
const cov = coverageData as unknown as Record<string, { url: string }[]>;
const slugs = Object.keys(cov).filter((k) => !k.startsWith('_'));
const PAGES = new Set(
  (billsData as { bill_type: string; bill_number: number; congress_number: number }[]).map(
    (b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`
  )
);

type Pick = { slug: string; twin: string; url: string; source: string; lean: keyof typeof en.coverage.lean };
function pick(): Pick | null {
  // Every bill page, not only bills with their own stored coverage: a twin's
  // articles can give a bill its first box.
  const candidates = new Set<string>(slugs);
  for (const s of slugs) for (const t of twinsOf(relatedBills, s)) candidates.add(t);
  // Only bills with a page: the record can name an identical bill the corpus
  // does not hold.
  for (const s of [...candidates].sort().filter((x) => PAGES.has(x))) {
    const { articles, twins } = getCoverageWithTwins(s);
    const shown = coverageForBillPage(articles, getMomentsForBill(s).length > 0);
    if (shown.length === 0 || twins.length === 0) continue;
    const own = new Set((cov[s] ?? []).map((a) => a.url));
    const a = shown.find((x) => !own.has(x.url));
    if (!a) continue;
    const twin = twins.find((t) => (cov[t] ?? []).some((x) => x.url === a.url))!;
    return { slug: s, twin, url: a.url, source: a.source, lean: a.lean ?? 'unrated' };
  }
  return null;
}
const found = pick();

const box = (page: import('@playwright/test').Page) => page.locator('section[aria-labelledby="coverage-heading"]');
const citationOf = (slug: string) => {
  const m = slug.match(/^([a-z]+)-(\d+)-\d+$/)!;
  return formatCitation(m[1], Number(m[2]));
};

/** A colour a reader could take for a party: a saturated red or blue. */
function partyCoded(rgb: string): boolean {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m) return false;
  if (m[4] !== undefined && Number(m[4]) === 0) return false; // transparent
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => Number(v) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return false;
  const sat = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const red = h >= 340 || h <= 15;
  const blue = h >= 200 && h <= 250;
  return sat > 0.35 && (red || blue);
}

for (const { prefix, messages } of [
  { prefix: '', messages: en },
  { prefix: '/es', messages: es },
] as const) {
  test(`${prefix || '/en'}: a twin's article is listed under the bill, as it is, with its outlet and lean`, async ({
    page,
  }) => {
    test.skip(!found, 'no bill in the current data lists an article stored only under its record twin');
    const { slug, twin, url, source, lean } = found!;
    await page.route('**/api/script**', (r) => r.fulfill({ status: 204, body: '' }));
    await page.route('**/api/district**', (r) => r.fulfill({ status: 204, body: '' }));
    await page.goto(`${prefix}/bills/${slug}`);

    const section = box(page);
    await expect(section.getByRole('heading', { name: messages.coverage.heading })).toBeVisible();
    // The intro says whose coverage it is, naming the twin by its citation.
    await expect(section.getByText(citationOf(twin), { exact: false }).first()).toBeVisible();

    const row = section.getByRole('listitem').filter({ has: page.locator(`a[href="${url}"]`) });
    await expect(row).toHaveCount(1);
    await expect(row.getByText(source, { exact: true }).first()).toBeVisible();
    await expect(row.getByText(messages.coverage.lean[lean], { exact: true })).toBeVisible();

    // No party colour anywhere in the row.
    const colours = await row.evaluate((li) =>
      [li, ...li.querySelectorAll('*')].flatMap((el) => {
        const cs = getComputedStyle(el);
        return [cs.color, cs.backgroundColor, cs.borderTopColor, cs.fill];
      })
    );
    const bad = colours.filter(partyCoded);
    expect(bad, `party-coded colours in the row: ${bad.join(', ')}`).toEqual([]);
  });
}
