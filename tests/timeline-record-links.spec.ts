import { expect, test } from '@playwright/test';
import { getMoments } from '../lib/moments';
import { linkHost, timelineDays } from '../lib/moments-ui';
import { rollCallPage } from '../lib/roll-call-page';

/*
 * No built Big Question page links a roll call's DATA FILE, in either
 * language. The timeline's "Sources" row (components/MomentTimeline.tsx)
 * used to link 18 roll-call XML files on four question pages; each vote ref
 * now opens the chamber's readable page for the same roll call
 * (lib/roll-call-page.ts), and every other ref is linked as stored.
 *
 * CORPUS-ROBUST, the discipline of tests/moment-updates-page.spec.ts: every
 * expectation comes from data/moment-updates.json through the same frame
 * helper the component renders with, never from a hardcoded id or count.
 * Days that carry updates render whatever the clock says, so the Sources
 * assertions are clock-proof.
 */

const WINDOW_DAYS = 14;

/** A roll call's data file on either chamber's site, in any shape. */
const ROLL_CALL_DATA_FILE =
  /^https?:\/\/(?:www\.)?(?:clerk\.house\.gov\/evs\/|senate\.gov\/legislative\/LIS\/roll_call_votes\/).*\.xml(?:[?#].*)?$/i;

/** The same addresses anywhere in the built HTML: attribute values and the
 *  flight payload, React keys included (a key keyed by the ref shipped the
 *  data file's address even after the href was fixed). */
const ROLL_CALL_DATA_FILE_ANYWHERE =
  /https?:(?:\/|\\\/){2}(?:www\.)?(?:clerk\.house\.gov(?:\/|\\\/)evs(?:\/|\\\/)|senate\.gov(?:\/|\\\/)legislative(?:\/|\\\/)LIS(?:\/|\\\/)roll_call_votes(?:\/|\\\/))[^"'\s<>]*?\.xml/gi;

const moments = getMoments().filter((m) => m.state !== 'retired');
const LOCALES = [
  { locale: 'en', prefix: '' },
  { locale: 'es', prefix: '/es' },
] as const;

for (const { locale, prefix } of LOCALES) {
  test.describe(`question pages (${locale}): the record's readable page, never its data file`, () => {
    for (const m of moments) {
      const path = `${prefix}/questions/${m.id}`;

      test(`${m.id}: the built HTML carries no roll call's data file`, async ({ request }) => {
        const res = await request.get(path);
        expect(res.status()).toBe(200);
        const html = await res.text();
        expect(html.match(ROLL_CALL_DATA_FILE_ANYWHERE) ?? []).toEqual([]);
      });

      test(`${m.id}: every Sources link opens the ref's readable page, labelled by its host`, async ({ page }) => {
        const days = timelineDays(m.id, WINDOW_DAYS).filter((d) => !d.quiet);
        await page.goto(path);

        // No link anywhere on the page goes to a roll call's data file.
        const hrefs = await page
          .locator('a[href]')
          .evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''));
        expect(hrefs.filter((h) => ROLL_CALL_DATA_FILE.test(h))).toEqual([]);

        let readable = 0;
        for (const day of days) {
          const items = page.locator(`#moment-day-${day.day} ol > li`);
          await expect(items).toHaveCount(day.rendered.length);
          for (const [i, update] of day.rendered.entries()) {
            // The Sources row is the item's only set of new-tab links: the
            // bill citation and a correction's day link stay in the page.
            const sources = items.nth(i).locator('a[target="_blank"]');
            const want = [...new Set(update.source.refs.map(rollCallPage))];
            await expect(sources).toHaveCount(want.length);
            for (const [j, href] of want.entries()) {
              await expect(sources.nth(j)).toHaveAttribute('href', href);
              await expect(sources.nth(j)).toHaveText(linkHost(href));
              if (!update.source.refs.includes(href)) readable++;
            }
          }
        }
        test.info().annotations.push({
          type: 'readable roll-call links',
          description: `${readable} on ${path}`,
        });
      });
    }
  });
}
