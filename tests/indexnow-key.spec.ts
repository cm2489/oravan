import { expect, test } from '@playwright/test';
import { getAllBills, billSlug, getAllLegislators } from '../lib/core';
import { getMoments } from '../lib/moments';
import { SITE_ORIGIN } from '../lib/site';
import { INDEXNOW_KEY, LOCALES, localizedUrl } from '../scripts/indexnow-urls.mjs';

/*
 * THE INDEXNOW PING, AGAINST THE PRODUCTION BUILD (the 2026-09-27 audit,
 * SY-19). The unit spec (tests/indexnow.unit.spec.ts) pins the mapping; this
 * file pins the two things only a running server can show:
 *
 *   1. The ownership file is really served at /<key>.txt - verbatim, as plain
 *      text, with no locale redirect and no cookie. If it is not, every ping
 *      is refused (403) and the nightly step says so in a warning nobody reads.
 *   2. The URLs the ping builds are, character for character, the ones the
 *      built sitemap.xml lists - so a crawler told "this changed" is pointed
 *      at the same URL it already knows.
 */

test('the IndexNow key file is served at the site root, verbatim', async ({ request }) => {
  const res = await request.get(`/${INDEXNOW_KEY}.txt`, { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  // The body IS the key, byte for byte - which also rules out an HTML page
  // (a 404 shell, a locale redirect target) being served in its place.
  expect(await res.text()).toBe(INDEXNOW_KEY);
  // A static file under the site-wide zero-cookie claim like everything else.
  expect(res.headers()['set-cookie']).toBeUndefined();
});

test('the URLs the ping sends are the ones sitemap.xml lists', async ({ request }) => {
  const res = await request.get('/sitemap.xml');
  expect(res.status()).toBe(200);
  const body = await res.text();

  const question = getMoments().find((m) => m.state !== 'retired');
  const hrefs = [
    '/',
    '/bills',
    '/today',
    '/questions',
    `/bills/${billSlug(getAllBills()[0])}`,
    `/reps/${getAllLegislators()[0].bioguide}`,
    ...(question ? [`/questions/${question.id}`] : []),
  ];
  for (const href of hrefs) {
    for (const locale of LOCALES) {
      expect(body, `${locale} ${href}`).toContain(`<loc>${localizedUrl(SITE_ORIGIN, locale, href)}</loc>`);
    }
  }
});
