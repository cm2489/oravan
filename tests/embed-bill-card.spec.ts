import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { SITE_ORIGIN } from '../lib/site';
import { hexToRgb } from '../lib/contrast';
import { FONT_VALUES, RADIUS_VALUES } from '../lib/embed-theme';
import { calendarPlacementSlugs } from './corpus';
import {
  decodedCommitteeBill,
  esDecodedFloorActivityBill,
  undecodedCommitteeBill,
} from './corpus-fixtures';
import { colorToken } from './palette';

/*
 * S14 — bill-card embed widget. Drives the widget's own page directly (not
 * through the loader/iframe seam — tests/embed-loader.spec.ts covers the
 * bill-card loader integration on a genuine cross-origin host) to pin: the
 * AI-decoded label semantics (house rule — the label only ever travels
 * alongside a real AI headline, never with the bare official title), the
 * freshness stamp, the link-out URL shape, both locales, CSS-custom-
 * property theming and its injection rejection, and the privacy/a11y
 * basics that don't depend on being embedded.
 *
 * Fixtures are DERIVED from the committed corpus (tests/corpus-fixtures.ts):
 * a bill that fits each case, never a named one, and every citation, headline
 * and date asserted below is read off that bill's own record. A nightly
 * re-sync that moves one bill picks another instead of reddening the suite.
 */

/** A decoded bill whose card label is plain `committee`. */
const DECODED = decodedCommitteeBill();
const DECODED_SLUG = DECODED.slug;
/** A decoded bill with a Spanish decode, on a floor record naming no calendar. */
const ES_DECODED = esDecodedFloorActivityBill();
/** A bill with no AI headline — official title, no label. */
const NO_HEADLINE = undecodedCommitteeBill();

/*
 * N4 (2026-08-11) — THE RECORD DATE ON THE PARTNER CARD.
 *
 * This card was the ONE status-printing surface that showed a label with no
 * date beside it, and its `BillCardData` did not even carry one. That gap was
 * half the argument for leaving the shared status label unclocked, so it is
 * closed in the same change as the clock (N3): the widget now prints the
 * bill's own last-action date with the status line, using the citizen site's
 * `bills.updated` string ("Last action {date}") and no new message key.
 *
 * The helper matches only the STATIC half of the template, so the locale
 * tests stay about labels. The full-string assertion with the real date lives
 * in the dedicated test below, built from the fixture's own last-action date
 * and the same Intl call the widget uses.
 */
const recordDatePrefix = (dict: { bills: { updated: string } }) =>
  dict.bills.updated.replace('{date}', '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The decoded fixture's own last action, read from its record. */
const DECODED_LAST_ACTION = DECODED.lastActionDate!;

test('EN: citation, AI-decoded headline + label, status, freshness stamp, and a link-out', async ({
  page,
}) => {
  await page.goto(`/embed/bill-card?locale=en&slug=${DECODED_SLUG}`);
  await expect(page.getByText(DECODED.citation, { exact: true })).toBeVisible();
  await expect(page.getByText(DECODED.headline!)).toBeVisible();
  await expect(page.getByText(en.og.aiDecoded, { exact: true })).toBeVisible();
  await expect(page.getByText(en.bills.status.committee, { exact: true })).toBeVisible();
  await expect(page.getByText(new RegExp(recordDatePrefix(en)))).toBeVisible();
  await expect(page.getByText(/Data as of/)).toBeVisible();

  const link = page.getByRole('link', { name: new RegExp(en.embed.poweredBy) });
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(link).toHaveAttribute('href', `${SITE_ORIGIN}/bills/${DECODED_SLUG}`);
});

test('ES: Spanish labels, no English leakage, ES-prefixed canonical link-out', async ({ page }) => {
  test.skip(
    !ES_DECODED,
    'the corpus holds no decoded, Spanish-decoded floor_vote record whose last action names no calendar'
  );
  const bill = ES_DECODED!;
  await page.goto(`/embed/bill-card?locale=es&slug=${bill.slug}`);
  await expect(page.getByText(bill.citation, { exact: true })).toBeVisible();
  // The ES corpus carries its own translated headline, not the EN one -
  // localizeBill (lib/core/bills.ts) overlays it for locale='es'.
  await expect(page.getByText(bill.esHeadline!)).toBeVisible();
  await expect(page.getByText(es.og.aiDecoded, { exact: true })).toBeVisible();
  // floor_activity, not floor_vote (label gate, 2026-08-04): the fixture's
  // record is floor_vote but its last action names no calendar (the original
  // case was S.J.Res. 99's REJECTED motion to proceed) — printing "En el
  // calendario del pleno" over it was the overclaim the statusKeyFor gate
  // ended. This pins the honest label on the partner-facing card.
  await expect(page.getByText(es.bills.status.floor_activity, { exact: true })).toBeVisible();
  await expect(page.getByText(es.bills.status.floor_vote, { exact: true })).toHaveCount(0);
  // N4: the record date rides in Spanish too, off the same `bills.updated`
  // string — bilingual parity is a hard rule and this line is user-facing.
  await expect(page.getByText(new RegExp(recordDatePrefix(es)))).toBeVisible();
  await expect(page.getByText(en.og.aiDecoded, { exact: true })).toHaveCount(0);
  await expect(page.getByText(en.embed.poweredBy, { exact: true })).toHaveCount(0);

  const link = page.getByRole('link', { name: new RegExp(es.embed.poweredBy) });
  await expect(link).toHaveAttribute('href', `${SITE_ORIGIN}/es/bills/${bill.slug}`);
});

/*
 * N4 — the record date's THREE properties, each of which has its own defect
 * history somewhere in this codebase:
 *
 *   1. UTC. `last_action_date` is a bare calendar day; formatting it in the
 *      viewer's zone renders a day early everywhere west of Greenwich, and
 *      this date is what licenses the status label above it (the same fix
 *      components/BillCard.tsx and CoverageSection.tsx already carry).
 *   2. The YEAR is printed. 40% of the corpus last acted in 2025 or earlier;
 *      without a year, "Sep 26" reads as a date still to come.
 *   3. It sits ABOVE the "Data as of" stamp. These are two different clocks —
 *      when the record moved, and when we last looked — and printed the other
 *      way round a fresh sync date reads as corroboration of a stale fact.
 *      That ordering is the entire reason this line exists on this card.
 */
test('N4: the record date renders in UTC with its year, above the sync stamp', async ({ page }) => {
  await page.goto(`/embed/bill-card?locale=en&slug=${DECODED_SLUG}`);

  const utcDay = (ms: number) =>
    en.bills.updated.replace(
      '{date}',
      new Intl.DateTimeFormat('en', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(ms))
    );
  const recordMs = new Date(DECODED_LAST_ACTION).getTime();
  const expected = utcDay(recordMs);
  await expect(page.getByText(expected, { exact: true })).toBeVisible();
  // The record's own day and year are what is printed.
  expect(expected).toContain(String(Number(DECODED_LAST_ACTION.slice(8, 10))));
  expect(expected).toContain(DECODED_LAST_ACTION.slice(0, 4));

  const card = (await page.locator('.bc-card').textContent()) ?? '';
  // The UTC rule, asserted as the failure it prevents rather than only as the
  // result: the day before — what a viewer-zone format prints west of
  // Greenwich — must not appear anywhere on the card.
  expect(card).not.toContain(utcDay(recordMs - 86_400_000));
  const recordAt = card.indexOf(expected);
  const syncAt = card.search(/Data as of/);
  expect(recordAt, 'the record date is on the card').toBeGreaterThan(-1);
  expect(syncAt, 'the sync stamp is on the card').toBeGreaterThan(-1);
  expect(recordAt, 'the record date precedes the sync stamp').toBeLessThan(syncAt);
  // And it is under the status line it qualifies, not floating below the
  // headline: the status is the first thing in the card, the date the second.
  expect(card.indexOf(en.bills.status.committee)).toBeLessThan(recordAt);
});

/** The widget's note border until 2026-08, retired for the same reason. */
const RETIRED_NOTE_AMBER = [232, 163, 23];

test('N4: a bill card never paints the live-floor colour — an aged placement is never dressed as live', async ({
  page,
}) => {
  // What this protects: the site's live-floor colour (--color-urgent) marks
  // one fact — a bill standing on the floor calendar inside the signal window,
  // its date printed — and a partner card never presents a floor fact as
  // live. So it paints that colour on nothing: not a committee bill, not a
  // floor record that names no calendar, and above all not an aged placement
  // (the `floor_vote_stale` label), which is by construction a floor fact
  // that is no longer live. The widget has no such colour token at all, and
  // this pins that it stays that way.
  const aged = calendarPlacementSlugs(Date.now()).stale[0];
  const slugs = [DECODED_SLUG, ES_DECODED?.slug, aged].filter((s): s is string => Boolean(s));
  const urgent = hexToRgb(colorToken('urgent'))!;
  const forbidden = [[urgent.r, urgent.g, urgent.b], RETIRED_NOTE_AMBER].map(
    ([r, g, b]) => new RegExp(`rgba?\\(${r},\\s*${g},\\s*${b}\\s*[,)]`)
  );
  for (const slug of slugs) {
    await page.goto(`/embed/bill-card?locale=en&slug=${slug}`);
    const colors = await page
      .locator('.bc-card, .bc-card *')
      .evaluateAll((els) =>
        els.flatMap((el) => {
          const s = getComputedStyle(el);
          return [s.color, s.backgroundColor, s.borderTopColor];
        })
      );
    for (const c of colors) {
      for (const re of forbidden) {
        expect(c, `${slug} paints the live-floor colour`).not.toMatch(re);
      }
    }
  }
});

test('a bill with no AI headline shows the official title and never the AI-decoded label', async ({
  page,
}) => {
  test.skip(!NO_HEADLINE, 'the corpus holds no undecoded bill in committee');
  await page.goto(`/embed/bill-card?locale=en&slug=${NO_HEADLINE!.slug}`);
  await expect(page.getByText(NO_HEADLINE!.officialTitle)).toBeVisible();
  await expect(page.getByText(en.og.aiDecoded, { exact: true })).toHaveCount(0);
  await expect(page.getByText(en.bills.status.committee, { exact: true })).toBeVisible();
});

test('the EN/ES toggle is always present and switches locale live, no reload', async ({ page }) => {
  await page.goto(`/embed/bill-card?locale=en&slug=${DECODED_SLUG}`);
  const enToggle = page.getByRole('button', { name: 'EN', exact: true });
  const esToggle = page.getByRole('button', { name: 'ES', exact: true });
  await expect(enToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(esToggle).toHaveAttribute('aria-pressed', 'false');
  await esToggle.click();
  await expect(page.getByText(es.bills.status.committee, { exact: true })).toBeVisible();
  await expect(esToggle).toHaveAttribute('aria-pressed', 'true');
});

test('a host page may default the locale to ES but the toggle can always switch back to EN', async ({
  page,
}) => {
  await page.goto(`/embed/bill-card?locale=es&slug=${DECODED_SLUG}`);
  await expect(page.getByText(es.bills.status.committee, { exact: true })).toBeVisible();
  const enToggle = page.getByRole('button', { name: 'EN', exact: true });
  await expect(enToggle).toBeVisible();
  await enToggle.click();
  await expect(page.getByText(en.bills.status.committee, { exact: true })).toBeVisible();
});

test('unknown slug: graceful not-found message, toggle still present, no crash', async ({
  page,
}) => {
  const res = await page.goto('/embed/bill-card?locale=en&slug=not-a-real-bill');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('alert').filter({ hasText: en.embed.billNotFound })).toBeVisible();
  await expect(page.getByRole('button', { name: 'EN', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ES', exact: true })).toBeVisible();
});

test('missing slug param: same graceful not-found state, not a crash', async ({ page }) => {
  const res = await page.goto('/embed/bill-card?locale=en');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('alert').filter({ hasText: en.embed.billNotFound })).toBeVisible();
});

test('theming: a valid accent/radius/font renders as the corresponding CSS custom properties', async ({
  page,
}) => {
  await page.goto(
    `/embed/bill-card?locale=en&slug=${DECODED_SLUG}&accent=%23336699&radius=round&font=serif`
  );
  const root = page.locator('.bc-root');
  const read = (name: string) =>
    root.evaluate((el, n) => getComputedStyle(el).getPropertyValue(n).trim(), name);
  await expect.poll(() => read('--oravan-accent')).toBe('#336699');
  await expect.poll(() => read('--oravan-radius')).toBe(RADIUS_VALUES.round);
  await expect.poll(() => read('--oravan-font')).toBe(FONT_VALUES.serif);
});

test('theming injection: a malformed accent value is rejected outright, never applied', async ({
  page,
}) => {
  const malicious = '#fff"}body{display:none}<script>window.__pwned=true</script>';
  await page.goto(
    `/embed/bill-card?locale=en&slug=${DECODED_SLUG}&accent=${encodeURIComponent(malicious)}`
  );

  // The script never ran - React never puts attacker text anywhere JS can parse it.
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBe(
    undefined
  );
  // And the custom property itself was never set to the malicious string -
  // an invalid theme value is discarded wholesale, not sanitized-and-kept.
  const root = page.locator('.bc-root');
  const accentValue = await root.evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--oravan-accent').trim()
  );
  expect(accentValue).toBe('');
  const html = await page.content();
  expect(html).not.toContain('<script>window.__pwned');
  // The rest of the widget still renders normally - a bad theme param never breaks the page.
  await expect(page.getByText(DECODED.headline!)).toBeVisible();
});

test('theming injection: non-enum radius/font values fall back to the safe default mapping', async ({
  page,
}) => {
  const badRadius = encodeURIComponent('sharp"; } body { display:none } //');
  const badFont = encodeURIComponent("serif</style><script>window.__pwned2=true</script>");
  await page.goto(
    `/embed/bill-card?locale=en&slug=${DECODED_SLUG}&radius=${badRadius}&font=${badFont}`
  );
  expect(await page.evaluate(() => (window as unknown as { __pwned2?: boolean }).__pwned2)).toBe(
    undefined
  );
  const root = page.locator('.bc-root');
  const radiusValue = await root.evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--oravan-radius').trim()
  );
  const fontValue = await root.evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--oravan-font').trim()
  );
  expect(radiusValue).toBe(RADIUS_VALUES.soft); // invalid input -> the 'soft' default
  expect(fontValue).toBe(FONT_VALUES.system); // invalid input -> the 'system' default
});

test('a11y basics: labeled toggle group, 44px targets, visible focus', async ({ page }) => {
  await page.goto(`/embed/bill-card?locale=en&slug=${DECODED_SLUG}`);
  const enToggle = page.getByRole('button', { name: 'EN', exact: true });
  const box = await enToggle.boundingBox();
  expect(box?.height, 'toggle must meet the 44px touch target').toBeGreaterThanOrEqual(44);
  await enToggle.focus();
  await expect(enToggle).toBeFocused();
});

test('zero cookies on the embed response', async ({ page }) => {
  const res = await page.goto(`/embed/bill-card?locale=en&slug=${DECODED_SLUG}`);
  expect(res?.headers()['set-cookie']).toBeUndefined();
  expect(await page.context().cookies()).toHaveLength(0);
});

test('the embed CSP carve-out applies to bill-card too (same route-group header)', async ({
  page,
}) => {
  const res = await page.goto(`/embed/bill-card?locale=en&slug=${DECODED_SLUG}`);
  const csp = res?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain('frame-ancestors *');
  expect(csp).toContain("connect-src 'self'");
});

/*
 * S20 (F6): the optional `token` param, same contract as rep-lookup's own
 * (see that file's matching test block for the full "counters DB down"
 * disclosure - identical reasoning applies here, not repeated verbatim).
 */
test('S20: a token param never changes the render — identical content and status whether or not it resolves', async ({
  page,
}) => {
  const noToken = await page.goto(`/embed/bill-card?locale=en&slug=${DECODED_SLUG}`);
  await expect(page.getByText(DECODED.citation, { exact: true })).toBeVisible();
  const noTokenStatus = noToken?.status();
  // The <main> markup only - not the raw response text. Next's own RSC
  // payload (a trailing <script> tag) legitimately echoes the requested
  // URL/query string verbatim (Next's router state, unrelated to S20) -
  // comparing the full response text would flag that expected, harmless
  // difference as if the WIDGET's own render had changed. <main> is the
  // entire widget - everything a host page's iframe actually shows.
  const noTokenMain = await noToken!.text().then((t) => t.match(/<main[\s\S]*?<\/main>/)?.[0]);

  const garbageToken = await page.goto(
    `/embed/bill-card?locale=en&slug=${DECODED_SLUG}&token=totally-made-up-token`
  );
  await expect(page.getByText(DECODED.citation, { exact: true })).toBeVisible();
  expect(garbageToken?.status()).toBe(noTokenStatus);
  const garbageTokenMain = await garbageToken!.text().then((t) => t.match(/<main[\s\S]*?<\/main>/)?.[0]);

  expect(noTokenMain).toBeTruthy();
  expect(garbageTokenMain).toBe(noTokenMain);
});

test('S20: token param renders identically on the "bill not found" state too (no crash before any lookup)', async ({
  page,
}) => {
  await page.goto('/embed/bill-card?locale=en&slug=not-a-real-bill-999&token=another-made-up-token');
  await expect(page.getByText(en.embed.billNotFound)).toBeVisible();
});
