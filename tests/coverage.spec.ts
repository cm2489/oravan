import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import coverageData from '../data/coverage.json';
import { coverageTier, getCoverage } from '../lib/coverage';
import { COVERAGE_AGE_NOTE_DAYS, freshnessAgeDays } from '../lib/freshness-state';

/*
 * Data-driven: the nightly sync rewrites data/coverage.json, so the suite finds
 * its fixtures from whatever's baked in — a bill the section shows, a one-sided
 * bill (shown WITH a disclaimer), and a too-thin/no-coverage bill (no section).
 * Tier logic itself is covered exhaustively in coverage.unit.spec.ts.
 */
const slugs = Object.keys(coverageData).filter((k) => !k.startsWith('_'));
const shownSlug = slugs.find((s) => getCoverage(s).length > 0);
const oneSidedSlug = slugs.find((s) => coverageTier(getCoverage(s)) === 'one_sided');
const thinSlug = slugs.find((s) => getCoverage(s).length === 0); // stored but < 2 outlets

/* Age fixtures for the "state the age of what you're showing" pair. The bill
 * page prints a "Data as of" stamp that tracks the Congress.gov BILL sync
 * ~20 lines above this section; nothing in that stamp is about these
 * articles, so the section has to state its own age. Data-driven like the
 * rest of this file: the nightly sync rewrites the corpus, and every one of
 * these ages moves with it. */
function newestPublishedAt(slug: string): string | null {
  const dates = getCoverage(slug)
    .map((a) => a.publishedAt)
    .filter((d): d is string => Boolean(d))
    .sort();
  return dates.at(-1) ?? null;
}
const datedSlugs = slugs.filter((s) => newestPublishedAt(s) !== null);
const staleSlug = datedSlugs.find((s) => freshnessAgeDays(newestPublishedAt(s)!) > COVERAGE_AGE_NOTE_DAYS);
const recentSlug = datedSlugs.find((s) => freshnessAgeDays(newestPublishedAt(s)!) <= COVERAGE_AGE_NOTE_DAYS);

const section = (page: import('@playwright/test').Page) =>
  page.locator('section[aria-labelledby="coverage-heading"]');

test('a bill with coverage renders the Read section', async ({ page }) => {
  test.skip(!shownSlug, 'no showable coverage in current data');
  await page.goto(`/bills/${shownSlug}`);
  await expect(section(page).getByRole('heading', { name: "How it's being covered" })).toBeVisible();
  await expect(section(page).getByRole('listitem').first()).toBeVisible();
  await expect(section(page).getByText(/labels describe the news outlet/)).toBeVisible();
});

test('snippet preview toggles open (keyboard/touch path)', async ({ page }) => {
  test.skip(!shownSlug, 'no showable coverage in current data');
  await page.goto(`/bills/${shownSlug}`);
  const button = section(page).getByRole('button', { name: 'Preview' }).first();
  test.skip((await button.count()) === 0, 'current coverage has no article snippets');
  // Toggling needs React attached — retry-guard against the hydration race.
  await expect(async () => {
    if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true', { timeout: 500 });
  }).toPass({ timeout: 10_000 });
  const panelId = await button.getAttribute('aria-controls');
  await expect(page.locator(`#${panelId}`)).toBeVisible();
});

/*
 * constitution-02 (pre-launch audit 2026-07-25): the snippet used to render as
 * a bare paragraph of page body copy, so a third-party line like "Let's keep
 * the pressure on" read as Oravan's own sentence on a nonpartisan surface.
 * It is the outlet's voice and must be set as the outlet's voice: a real
 * blockquote, real quotation marks, the outlet named beside the sentence.
 */
for (const { locale, prefix, messages } of [
  { locale: 'en', prefix: '', messages: en },
  { locale: 'es', prefix: '/es', messages: es },
] as const) {
  test(`${locale}: a snippet is quoted and attributed — the outlet's voice, never the page's`, async ({
    page,
  }) => {
    test.skip(!shownSlug, 'no showable coverage in current data');
    await page.goto(`${prefix}/bills/${shownSlug}`);
    const button = section(page).getByRole('button', { name: messages.coverage.preview }).first();
    test.skip((await button.count()) === 0, 'current coverage has no article snippets');

    const panelId = await button.getAttribute('aria-controls');
    const quote = page.locator(`#${panelId}`);
    // textContent, not innerText: the panel is hover/disclosure-revealed, and
    // the markup is what this test is about, not its visibility.
    expect(await quote.evaluate((el) => el.tagName)).toBe('BLOCKQUOTE');
    await expect(quote).toHaveAttribute('cite', /^https?:\/\//);

    // The marks come from the message file, so each language quotes in its own
    // typography ("…" in English, «…» in Spanish) and the test cannot drift
    // from the copy.
    const [open, close] = messages.coverage.snippetQuote.split('{text}');
    const body = (await quote.textContent())?.trim() ?? '';
    expect(body.startsWith(open), `snippet must open with ${open}: ${body.slice(0, 40)}`).toBe(true);
    expect(body).toContain(close);

    const cite = quote.locator('cite');
    await expect(cite).toHaveCount(1);
    const attribution = (await cite.textContent())?.trim() ?? '';
    const dash = messages.coverage.snippetAttribution.split('{source}')[0].trim();
    expect(attribution.startsWith(dash)).toBe(true);
    expect(attribution.length).toBeGreaterThan(dash.length); // an outlet is named
  });
}

test('the section states the age of what it is showing, in both languages', async ({ page }) => {
  test.skip(!datedSlugs[0], 'no dated coverage in current data');
  const slug = datedSlugs[0];
  const newest = newestPublishedAt(slug)!;
  for (const { prefix, messages } of [
    { prefix: '', messages: en },
    { prefix: '/es', messages: es },
  ] as const) {
    await page.goto(`${prefix}/bills/${slug}`);
    const line = section(page).locator(`time[datetime="${newest}"]`);
    await expect(line).toHaveCount(1);
    // The label sits with the date, so a reader can't mistake it for the
    // page's sync stamp.
    await expect(section(page).getByText(messages.coverage.newestLabel)).toBeVisible();
  }
});

test('coverage older than the age window carries the caveat; recent coverage does not', async ({
  page,
}) => {
  test.skip(!staleSlug && !recentSlug, 'no dated coverage in current data');
  if (staleSlug) {
    await page.goto(`/bills/${staleSlug}`);
    // Hydration-gated on purpose (StalenessNote's pattern): a clock verdict
    // baked into an SSG page freezes at deploy time. So wait for React.
    await expect(section(page).getByText(en.coverage.ageNote)).toBeVisible({ timeout: 10_000 });
  }
  if (recentSlug) {
    await page.goto(`/bills/${recentSlug}`);
    await expect(section(page).locator('time').first()).toBeVisible();
    // Give hydration the same window before asserting the absence.
    await page.waitForTimeout(1000);
    await expect(section(page).getByText(en.coverage.ageNote)).toHaveCount(0);
  }
});

test('one-sided coverage is shown WITH a disclaimer (not hidden)', async ({ page }) => {
  test.skip(!oneSidedSlug, 'no one-sided coverage in current data');
  await page.goto(`/bills/${oneSidedSlug}`);
  await expect(section(page).getByRole('heading', { name: "How it's being covered" })).toBeVisible();
  await expect(section(page).getByText(/one side of the spectrum/)).toBeVisible();
});

test('too-thin coverage renders no section', async ({ page }) => {
  test.skip(!thinSlug, 'no sub-threshold coverage in current data');
  await page.goto(`/bills/${thinSlug}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); // page rendered (not 404)
  await expect(section(page)).toHaveCount(0);
});
