import { expect, test } from '@playwright/test';
// Relative import of the plain .mjs module - same pattern as
// tests/verify-salt.unit.spec.ts importing lib/salt.mjs: the logic tested
// here is exactly what scripts/check-redistricting-watch.mjs runs weekly
// against the live RDH sitemap.
import {
  RDH_STATE_SITEMAP_URL,
  parseStateSitemap,
  diffWatch,
  isStructuralFailure,
} from '../lib/redistricting-watch.mjs';

/*
 * Pins the RDH monitoring tripwire (S24, §9.1(f) item 3): a tracked state's
 * lastmod moving must be FLAGGED, an unchanged lastmod must stay SILENT, and
 * a total-parse-failure shape must be treated as a structural failure, not
 * "nothing changed." Fixture XML mirrors a real fetch of
 * https://redistrictingdatahub.org/state-sitemap.xml (verified live
 * 2026-07-06 via direct curl - see docs/solutions/
 * two-clock-district-boundaries.md), including states this repo doesn't
 * track, to prove the diff only reacts to tracked entries.
 */

function sitemapFixture(entries: Array<{ slug: string; lastmod: string }>): string {
  const urls = entries
    .map(
      ({ slug, lastmod }) =>
        `\t<url>\n\t\t<loc>https://redistrictingdatahub.org/state/${slug}/</loc>\n\t\t<lastmod>${lastmod}</lastmod>\n\t</url>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
}

function watchEntry(overrides: Partial<{ rdh_url: string; rdh_lastmod: string }> = {}) {
  return {
    status: 'locked',
    note: 'fixture entry',
    rdh_url: 'https://redistrictingdatahub.org/state/texas/',
    rdh_lastmod: '2026-04-02T19:29:36+00:00',
    verified: '2026-07-06',
    ...overrides,
  };
}

test.describe('RDH_STATE_SITEMAP_URL', () => {
  test('points at the verified real sitemap, not the un-fed "What\'s New" page', () => {
    expect(RDH_STATE_SITEMAP_URL).toBe('https://redistrictingdatahub.org/state-sitemap.xml');
  });
});

test.describe('parseStateSitemap', () => {
  test('extracts slug -> lastmod for every /state/{slug}/ entry', () => {
    const xml = sitemapFixture([
      { slug: 'texas', lastmod: '2026-04-02T19:29:36+00:00' },
      { slug: 'north-carolina', lastmod: '2026-04-02T16:34:57+00:00' },
    ]);
    const result = parseStateSitemap(xml);
    expect(result.get('texas')).toBe('2026-04-02T19:29:36+00:00');
    expect(result.get('north-carolina')).toBe('2026-04-02T16:34:57+00:00');
    expect(result.size).toBe(2);
  });

  test('ignores non-state entries (e.g. /state/national/) without erroring', () => {
    const xml = sitemapFixture([
      { slug: 'national', lastmod: '2026-03-04T17:11:41+00:00' },
      { slug: 'texas', lastmod: '2026-04-02T19:29:36+00:00' },
    ]);
    const result = parseStateSitemap(xml);
    expect(result.get('national')).toBe('2026-03-04T17:11:41+00:00');
    expect(result.get('texas')).toBe('2026-04-02T19:29:36+00:00');
  });

  test('empty or unrelated XML yields an empty map, not a crash', () => {
    expect(parseStateSitemap('<urlset></urlset>').size).toBe(0);
    expect(parseStateSitemap('').size).toBe(0);
  });
});

test.describe('diffWatch', () => {
  test('a changed lastmod is FLAGGED', () => {
    const committed = { TX: watchEntry({ rdh_lastmod: '2026-04-02T19:29:36+00:00' }) };
    const fresh = new Map([['texas', '2026-08-01T00:00:00+00:00']]);
    const { changed, missing } = diffWatch(committed, fresh);
    expect(changed).toEqual([
      {
        state: 'TX',
        prevLastmod: '2026-04-02T19:29:36+00:00',
        newLastmod: '2026-08-01T00:00:00+00:00',
        url: 'https://redistrictingdatahub.org/state/texas/',
      },
    ]);
    expect(missing).toEqual([]);
  });

  test('an unchanged lastmod stays SILENT', () => {
    const committed = { TX: watchEntry({ rdh_lastmod: '2026-04-02T19:29:36+00:00' }) };
    const fresh = new Map([['texas', '2026-04-02T19:29:36+00:00']]);
    const { changed, missing } = diffWatch(committed, fresh);
    expect(changed).toEqual([]);
    expect(missing).toEqual([]);
  });

  test('multiple tracked states: only the changed one is reported, untouched ones stay silent', () => {
    const committed = {
      TX: watchEntry({ rdh_url: 'https://redistrictingdatahub.org/state/texas/', rdh_lastmod: 'A' }),
      CA: watchEntry({ rdh_url: 'https://redistrictingdatahub.org/state/california/', rdh_lastmod: 'B' }),
    };
    const fresh = new Map([
      ['texas', 'A'], // unchanged
      ['california', 'B-new'], // changed
    ]);
    const { changed, missing } = diffWatch(committed, fresh);
    expect(changed.map((c) => c.state)).toEqual(['CA']);
    expect(missing).toEqual([]);
  });

  test('a tracked state absent from the fresh fetch is reported as missing, not silently unchanged', () => {
    const committed = { LA: watchEntry({ rdh_url: 'https://redistrictingdatahub.org/state/louisiana/' }) };
    const fresh = new Map([['texas', '2026-04-02T19:29:36+00:00']]); // no louisiana entry at all
    const { changed, missing } = diffWatch(committed, fresh);
    expect(changed).toEqual([]);
    expect(missing).toEqual(['LA']);
  });
});

test.describe('isStructuralFailure', () => {
  test('every tracked state missing = structural failure', () => {
    expect(isStructuralFailure(['TX', 'CA', 'LA'], 3)).toBe(true);
  });

  test('some (not all) tracked states missing = real news, not a structural failure', () => {
    expect(isStructuralFailure(['LA'], 3)).toBe(false);
  });

  test('nothing missing = not a structural failure', () => {
    expect(isStructuralFailure([], 3)).toBe(false);
  });

  test('a zero-state watch file is never "anomalous" (nothing to be missing from)', () => {
    expect(isStructuralFailure([], 0)).toBe(false);
  });
});
